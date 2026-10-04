import ExcelJS from 'exceljs';

import {
  businessDayKey,
  formatBusinessDayLong,
  formatBusinessDayShort,
  formatBusinessTime,
  formatDuration,
} from '@/lib/business-day';
import { formatDateRangeLabel, formatWeekday } from '@/lib/day-ranges';
import {
  autoWidth,
  // The Bread sheet's two footnotes are shared with the run workbook's Bread
  // sheet, word for word — see `lib/excel-style.ts`.
  BreadStoresNote,
  colLetter,
  CountFormat,
  downloadWorkbook,
  fitMoneyColumns,
  infoBanner,
  InkColor,
  MoneyFormat,
  moneyTextLength,
  MutedColor,
  NoteFont,
  outlineRange,
  PercentFormat,
  sheetRef,
  styleHeaderRow,
  styleTotalRow,
  UnsoldNotes,
  VoidFont,
} from '@/lib/excel-style';
import type {
  PeriodBreadRow,
  PeriodDayRow,
  PeriodExpenseItem,
  PeriodGroupRow,
  PeriodRunRow,
  PeriodStoreRow,
  PeriodSummary,
  PeriodReceiptItem,
} from '@/lib/period-summary';
import { paymentLabel } from '@/lib/payment-methods';
import { describeRunEnd, runAgentNames, runEndDay } from '@/lib/runs';

/**
 * The period workbook — a range of business days as eight sheets.
 *
 * The run export answers "what happened on this trip". This one answers the
 * questions a *month* gets asked, and they are different questions: which truck
 * is ahead, which bread nobody is buying, which
 * store has stopped ordering, and how much of the money is still out there.
 * None of those can be read off one run, and none of them were answerable on
 * this dashboard before.
 *
 * The reading and the arithmetic are `lib/period-summary.ts`; this file only
 * lays them out, and makes no network calls at all. The house style — navy
 * headers, indigo frames, peso format, money-column sizing — is
 * `lib/excel-style.ts`, shared with the run workbook so the two look like one
 * system when they end up in the same folder.
 *
 * ## What each sheet is for
 *
 * | Sheet | The question |
 * | --- | --- |
 * | Summary | How did we do? |
 * | Breakdown | What shape was the period (by day)? Which truck performed (by truck)? |
 * | Bread | What moved, and what does it earn? |
 * | Stores | Who buys and who owes? |
 * | Collected | How did the money come in? |
 * | Expenses | What did it cost? |
 * | Runs | Show me every trip. |
 * | Receipts | Show me every receipt — voided ones too, struck through and not counted. |
 *
 * (The Breakdown sheet had "by crew" and "by area" sections; crews and areas
 * were removed on the owner's call, and "by truck" took their place.)
 *
 * ## Rules the whole workbook keeps
 *
 * - **Totals are Excel formulas, not baked numbers**, so a manager who corrects
 *   a figure watches the sheet recalculate. The Summary states nothing of its
 *   own — every figure on it points at the sheet that owns the number — so it
 *   cannot disagree with the tab behind it.
 * - **Every peso figure is a number with a money format**, never a string. A
 *   sheet whose columns can't be summed is a picture of a report.
 * - **A column that must not be added up has no total**, and the footnote says
 *   why. "Stores" is the recurring one: the same shop served on two days is one
 *   shop, so those counts genuinely cannot be added.
 * - **"Stores" means one thing everywhere in this workbook** — on the day rows,
 *   the truck rollup, each run, each bread, and the Summary's "Stores
 *   served": the number of *different* shops served, counted as a set of
 *   `customerId`, so a shop served five times counts once and a receipt naming
 *   no shop counts nowhere. Every sheet carrying it says so in a footnote, and
 *   in **the same words** — `StoresNote` below — because a count that cannot be
 *   added is the one figure on a spreadsheet a reader will try to add.
 * - **Empty days are rows.** A gap is information; a table that skips the days
 *   nothing happened on misstates the shape of a week.
 * - **Expenses are never netted off anything**, here as everywhere else on this
 *   dashboard. They sit beside the takings with a note saying so.
 */

/** One place to change a tab's name — the sheets reference each other through these. */
const Sheets = {
  summary: 'Summary',
  breakdown: 'Breakdown',
  bread: 'Bread',
  stores: 'Stores',
  collected: 'Collected',
  expenses: 'Expenses',
  runs: 'Runs',
  receipts: 'Receipts',
} as const;

/** Free text is held to this rather than `autoWidth`'s 44-character cap, which would swamp the figures. */
const TextColumnWidth = 30;

export type ExportPeriodExcelInput = {
  summary: PeriodSummary;
};

// ---------------------------------------------------------------------------
// Sheet plumbing
// ---------------------------------------------------------------------------

/**
 * A table with a navy header, a run of data rows and a formula totals row.
 *
 * Every sheet in this workbook is one or two of these, so the header styling,
 * the number formats, the totals formulas, the frame and the money-column
 * sizing are written once. A column declares how it draws itself and whether it
 * totals; `addTable` does the rest.
 *
 * `total: 'sum'` writes `SUM(…)` over the column's own data rows. Leaving it
 * off leaves the total cell blank, which is the right answer for a column of
 * dates, a per-row average, or a count of distinct things — a wrong total is
 * worse than none, and the sheet's footnote says which is which.
 */
type TableColumn<T> = {
  header: string;
  value: (row: T) => ExcelJS.CellValue;
  format?: 'money' | 'count' | 'percent';
  total?: 'sum';
  width?: number;
};

type Table<T> = {
  columns: TableColumn<T>[];
  headerRow: number;
  firstDataRow: number;
  /** Equal to `headerRow` when the table has no rows at all. */
  lastDataRow: number;
  /** Null when the table had no rows — nothing to total, and nothing to point a formula at. */
  totalRow: number | null;
};

function addTable<T>(
  sheet: ExcelJS.Worksheet,
  columns: TableColumn<T>[],
  rows: T[],
  options: {
    startRow?: number;
    totalLabel?: string;
    /**
     * Makes every total skip the rows whose column headed `header` reads
     * `value` — `SUMIF(status, "<>Voided", …)` instead of `SUM(…)`. The rows
     * stay on the sheet; they just aren't added up, and a status typed into a
     * row in Excel moves the totals with it.
     */
    skipRowsWhere?: { header: string; value: string };
  } = {},
): Table<T> {
  const headerRow = options.startRow ?? 1;
  const firstDataRow = headerRow + 1;

  columns.forEach((column, index) => {
    sheet.getCell(headerRow, index + 1).value = column.header;
  });
  styleHeaderRow(sheet, headerRow, columns.length);

  rows.forEach((row, rowIndex) => {
    const sheetRow = firstDataRow + rowIndex;
    columns.forEach((column, index) => {
      const cell = sheet.getCell(sheetRow, index + 1);
      cell.value = column.value(row);
      applyFormat(cell, column.format);
    });
  });

  const lastDataRow = firstDataRow + rows.length - 1;
  let totalRow: number | null = null;

  if (rows.length > 0) {
    totalRow = lastDataRow + 1;
    sheet.getCell(totalRow, 1).value = options.totalLabel ?? 'Totals';
    const skip = options.skipRowsWhere;
    const skipIndex = skip ? columns.findIndex((column) => column.header === skip.header) : -1;
    if (skip && skipIndex < 0) throw new Error(`export-period-excel: no column headed "${skip.header}"`);
    const skipLetter = colLetter(skipIndex + 1);
    const skipRange = `$${skipLetter}$${firstDataRow}:$${skipLetter}$${lastDataRow}`;
    columns.forEach((column, index) => {
      if (column.total !== 'sum') return;
      const letter = colLetter(index + 1);
      const range = `${letter}${firstDataRow}:${letter}${lastDataRow}`;
      const cell = sheet.getCell(totalRow as number, index + 1);
      cell.value = {
        formula: skip ? `SUMIF(${skipRange},"<>${skip.value}",${range})` : `SUM(${range})`,
      };
      applyFormat(cell, column.format);
    });
    styleTotalRow(sheet, totalRow, columns.length);
  }

  // An empty table frames its header row alone rather than boxing in a blank one.
  outlineRange(sheet, headerRow, 1, totalRow ?? headerRow, columns.length);
  return { columns, headerRow, firstDataRow, lastDataRow, totalRow };
}

function applyFormat(cell: ExcelJS.Cell, format: TableColumn<unknown>['format']) {
  if (format === 'money') cell.numFmt = MoneyFormat;
  else if (format === 'count') cell.numFmt = CountFormat;
  else if (format === 'percent') cell.numFmt = PercentFormat;
}

/**
 * Where a column sits, found by its heading rather than counted by hand.
 *
 * The Summary points a dozen formulas at the By day sheet, and column letters
 * written out as constants are the classic way for a workbook to start quoting
 * the wrong figure: insert one column and every reference past it is silently
 * off by one, with no error anywhere. Looked up by heading, a renamed column
 * throws at export time instead.
 */
function columnOf<T>(table: Table<T>, header: string): number {
  const index = table.columns.findIndex((column) => column.header === header);
  if (index < 0) throw new Error(`export-period-excel: no column headed "${header}"`);
  return index + 1;
}

/**
 * Sizes a finished sheet: `autoWidth` first, then the money columns re-measured
 * from what Excel *draws*.
 *
 * `autoWidth` cannot see either of the things that matter here. It reads the
 * stored number ("1234.5") rather than "₱1,234.50", and it never measures the
 * totals row at all, because a formula cell has no cached result and so no
 * text — and that row is exactly where the widest figure sits. A money cell too
 * narrow for its value renders as `####` rather than wrapping.
 *
 * Every money column comes out the same width, on purpose: sales, returns and
 * net are one quantity in three columns, and three different widths read as
 * three unrelated numbers.
 */
function sizeSheet<T>(sheet: ExcelJS.Worksheet, table: Table<T>, rows: T[]) {
  autoWidth(sheet);
  const moneyColumns: number[] = [];
  const values: number[] = [];
  table.columns.forEach((column, index) => {
    if (column.width) sheet.getColumn(index + 1).width = column.width;
    if (column.format !== 'money') return;
    moneyColumns.push(index + 1);
    let columnTotal = 0;
    for (const row of rows) {
      const value = column.value(row);
      if (typeof value !== 'number') continue;
      values.push(value);
      columnTotal += value;
    }
    // The totals row is a formula with no text to measure, so it is measured
    // from the sum this sheet is about to make Excel compute.
    values.push(columnTotal);
  });
  if (moneyColumns.length > 0) fitMoneyColumns(sheet, moneyColumns, values);
}

const CountDigits = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** How many characters a value takes once Excel has drawn it in its column's format. */
function drawnLength(value: ExcelJS.CellValue, format: TableColumn<unknown>['format']): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'number') return String(value).length;
  if (format === 'money') return moneyTextLength(value);
  if (format === 'count') return CountDigits.format(value).length;
  if (format === 'percent') return `${(value * 100).toFixed(1)}%`.length;
  return String(value).length;
}

/**
 * How wide each column of a table has to be, in characters, to show its
 * heading, every row and the total under it **as Excel draws them** — "₱1,234.50"
 * rather than "1234.5", "8.3%" rather than "0.0829…". `autoWidth` reads the
 * stored value and cannot see a formula's result at all, so a sheet that sizes
 * several tables to one width measures them this way instead.
 */
function columnNeeds<T>(columns: TableColumn<T>[], rows: T[]): number[] {
  return columns.map((column) => {
    let widest = column.header.length;
    let total = 0;
    for (const row of rows) {
      const value = column.value(row);
      if (typeof value === 'number') total += value;
      widest = Math.max(widest, drawnLength(value, column.format));
    }
    if (column.total === 'sum' && rows.length > 0) widest = Math.max(widest, drawnLength(total, column.format));
    return widest;
  });
}

/**
 * The italic lines under a table.
 *
 * They sit two rows below the last thing written, and outside the frame,
 * because they are about the sheet rather than part of it. Every sheet here has
 * at least one, and they carry what a column heading cannot: which columns can
 * be added up, where a figure came from, and what a word on the sheet means.
 *
 * **Written into column A and deliberately not merged.** Merging looks tidier
 * and is the wrong call: Excel *clips* text too wide for a merged cell, so a
 * two-sentence note across a narrow sheet loses its second half with nothing to
 * show it has. An ordinary cell whose neighbours are empty overflows across
 * them and stays readable at any window width, and these rows are the last on
 * the sheet, so there is nothing to overflow into but blank grid.
 *
 * Called **after** the sheet has been sized, never before: `autoWidth` measures
 * every cell in a column, and a 180-character note in A would otherwise widen
 * the first column to the cap.
 */
function noteUnder<T>(sheet: ExcelJS.Worksheet, table: Table<T>, notes: string[]) {
  let row = (table.totalRow ?? table.lastDataRow) + 2;
  for (const note of notes) {
    sheet.getCell(row, 1).value = note;
    sheet.getCell(row, 1).font = NoteFont;
    row += 1;
  }
}

// ---------------------------------------------------------------------------
// Shared column sets
// ---------------------------------------------------------------------------

/**
 * The money columns every rollup sheet ends with, in one order.
 *
 * Sales and returns are the two halves and net is what they come to. Expenses
 * come last, outside the arithmetic, because nothing on this dashboard takes
 * them out of it.
 *
 * `collected: true` adds the pair that splits net into the money that is in and
 * the money somebody has to go and get. **Only the Runs sheet asks for it.** The
 * day and truck rollups were cut back to the takings on the owner's call —
 * what is still out there is a question about the period, and the Summary and
 * the Collected sheet are where it is answered; the Stores sheet is where it is
 * chased. Repeating the split on every rollup only widened four sheets.
 *
 * Written once so those sheets can't drift into four different orders for the
 * same figures.
 */
function moneyColumns<
  T extends { sales: number; returns: number; net: number; collected: number; owed: number; expenses: number },
>(options: { collected?: boolean } = {}): TableColumn<T>[] {
  const owing: TableColumn<T>[] = [
    { header: 'Collected', value: (row) => row.collected, format: 'money', total: 'sum' },
    { header: 'Still owed', value: (row) => row.owed, format: 'money', total: 'sum' },
  ];
  return [
    { header: 'Sales', value: (row) => row.sales, format: 'money', total: 'sum' },
    { header: 'Returns', value: (row) => row.returns, format: 'money', total: 'sum' },
    { header: 'Net', value: (row) => row.net, format: 'money', total: 'sum' },
    ...(options.collected ? owing : []),
    { header: 'Expenses', value: (row) => row.expenses, format: 'money', total: 'sum' },
  ];
}

/**
 * The one sentence every sheet with a Stores figure carries — **the same words
 * every time**, on the owner's call.
 *
 * Every "Stores" figure in this workbook is the size of a set of `customerId`:
 * the shops actually served, with the same shop served twice counting once and a
 * receipt naming no shop counting nowhere. The day rows, the truck rollup, each run and the Summary's "Stores served" are all that one number,
 * which is why none of them is ever totalled — adding the counts would double
 * every shop two trucks called on.
 *
 * It was six sheet-specific wordings first ("the shops this truck served", "the
 * shops served on this round"). One sentence is better: a reader moving between
 * tabs recognises the note instead of reading it again, and six phrasings of one
 * rule is six chances for them to drift into meaning six things.
 */
const StoresNote =
  'Stores counts the shops served. The same shop served more than once counts as one store, so this column is not totalled.';

/** The Stores sheet has no Stores column; the same rule shows up there as its row count. */
const StoreRowsNote = 'One row per shop: a shop served more than once in this period is still one row here.';

/** Loaded, sold, back and left — the truck's own account of the bread, in loaves. */
function loafColumns<
  T extends { loaded: number; sold: number; returnedLoaves: number; remaining: number },
>(): TableColumn<T>[] {
  return [
    { header: 'Loaded', value: (row) => row.loaded, format: 'count', total: 'sum' },
    { header: 'Sold', value: (row) => row.sold, format: 'count', total: 'sum' },
    { header: 'Returned', value: (row) => row.returnedLoaves, format: 'count', total: 'sum' },
    { header: 'Left on truck', value: (row) => row.remaining, format: 'count', total: 'sum' },
  ];
}

/** A share, or a blank cell — dividing by nothing is not 0%, it is a question with no answer. */
function share(part: number, whole: number): ExcelJS.CellValue {
  return whole > 0 ? part / whole : '';
}

/** An average over a count, blank when the count is zero for the same reason. */
function per(total: number, count: number): ExcelJS.CellValue {
  return count > 0 ? total / count : '';
}

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------

/**
 * Builds the period workbook and hands it to the browser as a download.
 *
 * Everything it needs has already been read and folded by `buildPeriodSummary`,
 * which is why this is a plain layout pass with a single `await` at the end for
 * the file itself. The Summary is written **last**, because every figure on it
 * is a formula pointing at a totals row that only exists once the sheet under
 * it has been laid out.
 */
export async function exportPeriodToExcel({ summary }: ExportPeriodExcelInput): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NewOldWorld POS';
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet(Sheets.summary, { views: [{ state: 'frozen', ySplit: 2 }] });
  // Every single-table sheet freezes its header row: all of them are long
  // enough to scroll, and a column of pesos with its heading off screen is a
  // column of numbers nobody can name. Breakdown holds three tables, so no one
  // header row can stay pinned — each section carries its own title instead.
  const frozen = { views: [{ state: 'frozen' as const, ySplit: 1 }] };
  const breakdownSheet = workbook.addWorksheet(Sheets.breakdown);
  const breadSheet = workbook.addWorksheet(Sheets.bread, frozen);
  const storesSheet = workbook.addWorksheet(Sheets.stores, frozen);
  const collectedSheet = workbook.addWorksheet(Sheets.collected);
  const expensesSheet = workbook.addWorksheet(Sheets.expenses, frozen);
  const runsSheet = workbook.addWorksheet(Sheets.runs, frozen);
  // Last: the finest grain in the file, after the trips the receipts belong to.
  const receiptsSheet = workbook.addWorksheet(Sheets.receipts, frozen);

  const days = buildBreakdownSheet(breakdownSheet, summary);
  buildBreadSheet(breadSheet, summary);
  buildStoresSheet(storesSheet, summary);
  const collected = buildCollectedSheet(collectedSheet, summary);
  const expenses = buildExpensesSheet(expensesSheet, summary);
  buildRunsSheet(runsSheet, summary);
  const receipts = buildReceiptsSheet(receiptsSheet, summary.receipts);
  buildSummarySheet(summarySheet, summary, { days, collected, expenses, receipts });

  const fileName =
    summary.from === summary.to ? `${summary.from}_summary.xlsx` : `${summary.from}_to_${summary.to}_summary.xlsx`;
  await downloadWorkbook(workbook, fileName);
}

// ---------------------------------------------------------------------------
// Breakdown — by day, by truck
// ---------------------------------------------------------------------------

/**
 * Blank rows between the last line of one Breakdown section and the next
 * section's title. Even, so the divider line can sit exactly in the middle of
 * them — two rows above it, two below.
 */
const SectionGap = 4;

/**
 * The rule drawn across the sheet between two Breakdown sections. Slate grey
 * rather than a blue: the frames around each table are indigo and the headers
 * navy, and a divider in either would read as one more edge of a table instead
 * of a break between two.
 */
const DividerEdge: Partial<ExcelJS.Border> = { style: 'medium', color: { argb: MutedColor } };

/**
 * Large on the owner's call, so a section's name is the first thing seen on
 * each part of the sheet. Excel has a single bold weight, so size is what makes
 * it stand out: 20pt, against the workbook's 11pt body and the Summary's 16pt
 * title.
 */
const SectionTitleFont: Partial<ExcelJS.Font> = { bold: true, size: 20, color: { argb: InkColor } };
/** Tall enough for `SectionTitleFont` — Excel does not grow a row for a bigger font on its own. */
const SectionTitleRowHeight = 32;
const SectionLeadFont: Partial<ExcelJS.Font> = { color: { argb: MutedColor } };

/**
 * The period cut two ways on one sheet: **by day, then by truck**, stacked top
 * to bottom in that order.
 *
 * They were separate tabs (By day, By crew, By area) until September 2026, when
 * the owner asked for one; crews and areas were later removed and By truck took
 * their place. The sections are the same figures summed along different lines,
 * with the same loaf and money columns and a totals row that comes to the same
 * amount in each, so one sheet lets a reader hold "the month by day" against
 * "the month by truck" without flipping tabs. The tab is
 * called **Breakdown** because that is what it is: the Summary's totals, broken
 * down. Each section is headed with the old tab's own name, so nothing a reader
 * learned to look for has moved further than a scroll.
 *
 * **Every figure sits in the same column in every section.** The day table
 * has two label columns (Day, Weekday) where a truck has one name, so
 * that name is merged across A:B. Without it Runs would be column C in one table
 * and B in the next, and the Net columns would sit at different offsets
 * on the same sheet — the comparison stacking them was meant to make easy is the
 * one the sheet would make hard. And **every column on the sheet is the same
 * width** — the owner found columns of different widths stacked on each other
 * ragged — sized to the widest figure, heading or total in any section.
 *
 * Each section is a bold title, a one-line muted description of its rows, then
 * the table in its frame. Between one section and the next are `SectionGap`
 * blank rows with a full-width grey line through the middle of them, on the
 * owner's call — blank rows alone left the sections reading as one long sheet
 * with gaps in it, where a line says plainly that one part has ended. Nothing is frozen: with several header rows on the sheet, no
 * one of them can stay pinned.
 *
 * **Notes:** the two that apply to every section (Stores, expenses) are written
 * once at the foot of the sheet, in the workbook's usual place for notes, rather
 * than once per section; the truck-rename note belongs to one section and sits
 * under it.
 *
 * The day table is the spine of the workbook — every calendar day, empty ones
 * included — and the Summary draws its totals from it, which is why it is the
 * table returned. The weekday is spelled out beside the date because half of
 * what a manager reads off it is a weekly rhythm, and counting rows to work out
 * which day is a Tuesday is work the sheet can do for them.
 *
 * The truck table was wider once: "Days out", collected, still owed and the two
 * net-per averages came out on the owner's call — eleven columns of context
 * buried the work done. Its rows follow the dashboard's own order for trucks
 * (`toGroupRows`), not the takings, which is why the Summary's "Best truck"
 * searches for the top net rather than reading the first row.
 */
function buildBreakdownSheet(sheet: ExcelJS.Worksheet, summary: PeriodSummary): Table<PeriodDayRow> {
  const dayColumns: TableColumn<PeriodDayRow>[] = [
    { header: 'Day', value: (row) => row.day },
    { header: 'Weekday', value: (row) => formatWeekday(row.day) },
    { header: 'Runs', value: (row) => row.runs, format: 'count', total: 'sum' },
    { header: 'Receipts', value: (row) => row.receipts, format: 'count', total: 'sum' },
    { header: 'Stores', value: (row) => row.stores, format: 'count' },
    ...loafColumns<PeriodDayRow>(),
    ...moneyColumns<PeriodDayRow>(),
    // The same column in the same place as the truck table below, so both
    // sections end on it. Blank on a day with no sales, and never
    // totalled: an average of averages is not the average.
    { header: 'Returns %', value: (row) => share(row.returns, row.sales), format: 'percent' },
  ];

  const groupColumns = (subject: string): TableColumn<PeriodGroupRow>[] => [
    { header: subject, value: (row) => row.name },
    // Holds Weekday's place, so every column after it lines up with the day
    // table's. Merged into the name once the sheet is sized.
    { header: '', value: () => null },
    { header: 'Runs', value: (row) => row.runs, format: 'count', total: 'sum' },
    { header: 'Receipts', value: (row) => row.receipts, format: 'count', total: 'sum' },
    { header: 'Stores', value: (row) => row.stores, format: 'count' },
    ...loafColumns<PeriodGroupRow>(),
    ...moneyColumns<PeriodGroupRow>(),
    // The one derived column sits after the money it comes from, and does not
    // total: an average of averages is not the average.
    { header: 'Returns %', value: (row) => share(row.returns, row.sales), format: 'percent' },
  ];

  type Section = {
    title: string;
    lead: string;
    titleRow: number;
    headerRow: number;
    /** The totals row, or the header row when the table is empty. */
    lastRow: number;
    notes: string[];
    mergeLabel: boolean;
    /** The row whose bottom edge is the divider above this section; null for the first. */
    dividerRow: number | null;
    /** Characters each column needs, from `columnNeeds`. */
    needs: number[];
  };
  const sections: Section[] = [];
  let nextTitleRow = 1;
  /** The last row anything has been placed on, notes included. */
  let lastUsedRow = 0;

  // Tables are written as they are placed; titles, descriptions, notes and the
  // label merges wait until every table is down and the one column width is
  // known.
  function place<T>(
    section: { title: string; lead: string; notes?: string[]; mergeLabel?: boolean },
    columns: TableColumn<T>[],
    rows: T[],
  ): Table<T> {
    const titleRow = nextTitleRow;
    const table = addTable(sheet, columns, rows, { startRow: titleRow + 2 });
    const lastRow = table.totalRow ?? table.headerRow;
    const notes = section.notes ?? [];
    sections.push({
      title: section.title,
      lead: section.lead,
      titleRow,
      headerRow: table.headerRow,
      lastRow,
      notes,
      mergeLabel: section.mergeLabel ?? false,
      // Halfway down the gap: `lastUsedRow` is still the previous section's end.
      dividerRow: sections.length > 0 ? lastUsedRow + SectionGap / 2 : null,
      needs: columnNeeds(columns, rows),
    });
    // Notes start one blank row under the table, as `noteUnder` places them.
    lastUsedRow = notes.length > 0 ? lastRow + 1 + notes.length : lastRow;
    nextTitleRow = lastUsedRow + SectionGap + 1;
    return table;
  }

  const days = place(
    { title: 'By day', lead: 'One row per day in the period, including days no truck went out.' },
    dayColumns,
    summary.days,
  );
  place(
    {
      title: 'By truck',
      lead: 'One row per truck, in the order the dashboard lists them.',
      notes: [
        'Each truck is named as it was when its run started, so a truck renamed part-way through the period keeps both names — and both sets of figures.',
      ],
      mergeLabel: true,
    },
    groupColumns('Truck'),
    summary.trucks,
  );

  // Every column on the sheet is one width, on the owner's call: stacked
  // tables whose columns jump between narrow and wide read as ragged, where one
  // even grid reads as one sheet. The width is the widest thing any column in
  // any section needs. A truck's name is merged across A:B, so it
  // only has to fit in two columns — half of it counts — and it is held to
  // `autoWidth`'s usual cap so one very long name can't stretch every column.
  const MaxLabel = 44;
  const ColumnPadding = 2;
  let columnWidth = 10;
  let columnCount = 0;
  for (const section of sections) {
    columnCount = Math.max(columnCount, section.needs.length);
    section.needs.forEach((need, index) => {
      const fits = section.mergeLabel && index === 0 ? Math.ceil(Math.min(need, MaxLabel) / 2) : need;
      columnWidth = Math.max(columnWidth, fits + ColumnPadding);
    });
  }
  for (let col = 1; col <= columnCount; col++) sheet.getColumn(col).width = columnWidth;

  for (const section of sections) {
    if (section.dividerRow !== null) {
      for (let col = 1; col <= columnCount; col++) {
        sheet.getCell(section.dividerRow, col).border = { bottom: DividerEdge };
      }
    }

    const title = sheet.getCell(section.titleRow, 1);
    title.value = section.title;
    title.font = SectionTitleFont;
    sheet.getRow(section.titleRow).height = SectionTitleRowHeight;

    const lead = sheet.getCell(section.titleRow + 1, 1);
    lead.value = section.lead;
    lead.font = SectionLeadFont;

    if (section.mergeLabel) {
      for (let row = section.headerRow; row <= section.lastRow; row++) sheet.mergeCells(row, 1, row, 2);
    }

    section.notes.forEach((note, index) => {
      const cell = sheet.getCell(section.lastRow + 2 + index, 1);
      cell.value = note;
      cell.font = NoteFont;
    });
  }

  // The notes that are about the whole sheet, once, at its foot.
  [StoresNote, 'Expenses sit beside the takings and are never subtracted from them.'].forEach((note, index) => {
    const cell = sheet.getCell(lastUsedRow + 2 + index, 1);
    cell.value = note;
    cell.font = NoteFont;
  });

  return days;
}

// ---------------------------------------------------------------------------
// Bread
// ---------------------------------------------------------------------------

/**
 * One row per bread type, in the reference lists' own manual order — the
 * position a manager dragged each bread to, so a reader who knows where
 * Pandesal sits in that table finds it in the same place here.
 *
 * **Every bread type in the catalog is here, whether it moved or not.** Over a
 * period a bread that sold nothing is itself the finding, and a reader scanning
 * for it should not have to notice an absence.
 *
 * **Counted in loaves, with no money on it** — the same call the Trends tab's
 * bread charts make. The sheet carried Sales and Returns credited until the
 * owner took them out: a bread selling three hundred cheap loaves is a bigger
 * part of the day than one selling four expensive ones, and the pesos are
 * already answered four other places in this workbook. What moved is what this
 * sheet is for.
 */
function buildBreadSheet(sheet: ExcelJS.Worksheet, summary: PeriodSummary): Table<PeriodBreadRow> {
  const columns: TableColumn<PeriodBreadRow>[] = [
    { header: 'Bread', value: (row) => row.name },
    { header: 'Loaded', value: (row) => row.loaded, format: 'count', total: 'sum' },
    { header: 'Sold', value: (row) => row.sold, format: 'count', total: 'sum' },
    { header: 'Returned', value: (row) => row.returned, format: 'count', total: 'sum' },
    { header: 'Left on truck', value: (row) => row.remaining, format: 'count', total: 'sum' },
    { header: 'Returns %', value: (row) => share(row.returned, row.sold), format: 'percent' },
    { header: 'Unsold %', value: (row) => share(row.remaining, row.loaded), format: 'percent' },
    { header: 'Stores', value: (row) => row.stores, format: 'count' },
  ];
  const table = addTable(sheet, columns, summary.bread);
  sizeSheet(sheet, table, summary.bread);
  noteUnder(sheet, table, [...UnsoldNotes, BreadStoresNote]);
  return table;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/**
 * The customer ledger for the period — and the one sheet with a phone number on
 * it, which is what makes it a worklist rather than a report.
 *
 * "Still owed" is the column nothing else on this dashboard answers: the credit
 * and the half-paid receipts somebody has to go and chase. First bought and last
 * bought sit beside it so a store that has stopped ordering can still be read
 * off the sheet — a "Days quiet" column counted that gap for the reader until
 * the owner took it out.
 */
function buildStoresSheet(sheet: ExcelJS.Worksheet, summary: PeriodSummary): Table<PeriodStoreRow> {
  const columns: TableColumn<PeriodStoreRow>[] = [
    { header: 'Store', value: (row) => row.name },
    { header: 'Contact', value: (row) => row.contact || '—' },
    { header: 'Phone', value: (row) => row.phone || '—' },
    { header: 'Receipts', value: (row) => row.receipts, format: 'count', total: 'sum' },
    { header: 'Loaves', value: (row) => row.loaves, format: 'count', total: 'sum' },
    { header: 'Sales', value: (row) => row.sales, format: 'money', total: 'sum' },
    { header: 'Returns', value: (row) => row.returns, format: 'money', total: 'sum' },
    { header: 'Net', value: (row) => row.net, format: 'money', total: 'sum' },
    { header: 'Collected', value: (row) => row.collected, format: 'money', total: 'sum' },
    { header: 'Still owed', value: (row) => row.owed, format: 'money', total: 'sum' },
    { header: 'Average receipt', value: (row) => per(row.net, row.receipts), format: 'money' },
    { header: 'First bought', value: (row) => formatBusinessDayShort(row.firstDay) },
    { header: 'Last bought', value: (row) => formatBusinessDayShort(row.lastDay) },
  ];
  const table = addTable(sheet, columns, summary.stores);
  sizeSheet(sheet, table, summary.stores);
  // One note, plus the failure one when it applies: a reader looking at three
  // blank columns needs to be told the catalog could not be read, or the sheet
  // simply looks wrong.
  const notes: string[] = [StoreRowsNote];
  if (summary.storeDetailsMissing) {
    notes.push(
      'The store list could not be read this time, so the contact and phone columns are blank. Every figure is still taken from the receipts themselves.',
    );
  }
  noteUnder(sheet, table, notes);
  return table;
}

// ---------------------------------------------------------------------------
// Collected
// ---------------------------------------------------------------------------

/**
 * How the money came in, method by method — the same six lines the run
 * workbook's Collected sheet carries, so a reader moving between the two files
 * finds the same shape.
 *
 * The total is deliberately **not** a sum of the column above it: "Partial —
 * amount owed" is what those receipts billed, and adding it to what was paid
 * would count the same money twice. Cash, GCash, cheque and the partial
 * payments are what is actually in the bag.
 */
function buildCollectedSheet(sheet: ExcelJS.Worksheet, summary: PeriodSummary): { totalRow: number } {
  const { collected } = summary;
  const rows: [string, number][] = [
    ['Cash', collected.cash],
    ['GCash', collected.gcash],
    ['Cheque', collected.cheque],
    ['Partial — amount owed', collected.partial],
    ['Partial — paid so far', collected.partialPaid],
    ['Credit', collected.credit],
  ];

  sheet.getCell(1, 1).value = 'Method';
  sheet.getCell(1, 2).value = 'Amount';
  styleHeaderRow(sheet, 1, 2);
  rows.forEach(([method, amount], index) => {
    const row = index + 2;
    sheet.getCell(row, 1).value = method;
    const cell = sheet.getCell(row, 2);
    cell.value = amount;
    cell.numFmt = MoneyFormat;
  });

  const totalRow = rows.length + 2;
  sheet.getCell(totalRow, 1).value = 'Cash + GCash + Cheque + Partial paid';
  sheet.getCell(totalRow, 2).value = { formula: 'SUM(B2:B4)+B6' };
  sheet.getCell(totalRow, 2).numFmt = MoneyFormat;
  styleTotalRow(sheet, totalRow, 2);
  outlineRange(sheet, 1, 1, totalRow, 2);

  // No footnotes here, on the owner's call: the row labels already name what
  // each line is, and the total row spells out its own arithmetic.
  autoWidth(sheet);
  sheet.getColumn(1).width = 40;
  fitMoneyColumns(sheet, [2], [...rows.map(([, amount]) => amount), collected.collected]);
  return { totalRow };
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/**
 * Every expense in the period, one row each, oldest first.
 *
 * It was two tables until September 2026: a grouping on top ("Fuel × 14,
 * ₱18,400") and this itemised list under it. The owner took the grouping out —
 * one table is what a manager sorts and filters for themselves, and the total
 * is the same figure either way. `groupExpenses` still folds it in
 * `period-summary.ts` if it is ever wanted back.
 */
function buildExpensesSheet(sheet: ExcelJS.Worksheet, summary: PeriodSummary): Table<PeriodExpenseItem> {
  const itemColumns: TableColumn<PeriodExpenseItem>[] = [
    { header: 'Day', value: (row) => row.day },
    { header: 'Time', value: (row) => formatBusinessTime(row.createdAt) },
    { header: 'Agents', value: (row) => row.agents, width: TextColumnWidth },
    { header: 'Truck', value: (row) => row.truck },
    { header: 'What for', value: (row) => row.title },
    { header: 'Notes', value: (row) => row.notes || '—', width: TextColumnWidth },
    { header: 'Amount', value: (row) => row.amount, format: 'money', total: 'sum' },
  ];
  const items = addTable(sheet, itemColumns, summary.expenseItems, { totalLabel: 'Total spent' });
  sizeSheet(sheet, items, summary.expenseItems);
  noteUnder(sheet, items, [
    'Expenses are recorded by the agents as trip notes. They are not deducted from sales or net anywhere in this file.',
    'An expense removed on the phone is not listed and is in no total here.',
  ]);
  return items;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Every trip in the period, newest first — the audit sheet, and the one a
 * manager sorts and filters for themselves.
 *
 * The truck lives here rather than on a sheet of its own. "Is a truck sitting
 * idle" is a real question, and sorting this column answers it without a tenth
 * tab that would only repeat the Breakdown sheet's truck columns.
 *
 * A run that outlived the day it went out has its end date spelled out
 * (`describeRunEnd`), exactly as the board does it, so a bare time can never be
 * read as the start day's evening.
 */
function buildRunsSheet(sheet: ExcelJS.Worksheet, summary: PeriodSummary): Table<PeriodRunRow> {
  const columns: TableColumn<PeriodRunRow>[] = [
    { header: 'Day', value: (row) => row.run.businessDay },
    { header: 'Agents', value: (row) => runAgentNames(row.run), width: TextColumnWidth },
    { header: 'Truck', value: (row) => row.run.truckName || '—' },
    { header: 'Started', value: (row) => (row.run.startedAt ? formatBusinessTime(row.run.startedAt) : '—') },
    { header: 'Ended', value: (row) => (row.run.status === 'closed' ? describeRunEnd(row.run) : 'Still out') },
    {
      header: 'Time out',
      value: (row) =>
        row.run.startedAt && row.run.status === 'closed' && row.run.closedAt
          ? formatDuration(row.run.closedAt - row.run.startedAt)
          : '—',
    },
    { header: 'Receipts', value: (row) => row.receipts, format: 'count', total: 'sum' },
    { header: 'Stores', value: (row) => row.stores, format: 'count' },
    ...loafColumns<PeriodRunRow>(),
    // The only sheet that still splits net into collected and still-owed — see
    // `moneyColumns`. A trip is where "who has not paid yet" is actually chased
    // from, because it names the agents who were there.
    ...moneyColumns<PeriodRunRow>({ collected: true }),
    { header: 'Status', value: (row) => runStatusLabel(row) },
  ];
  const table = addTable(sheet, columns, summary.runs);
  sizeSheet(sheet, table, summary.runs);
  noteUnder(sheet, table, [
    StoresNote,
  ]);
  return table;
}

/**
 * What is worth saying about a run in one cell.
 *
 * "Records refused" is the board's own notice rather than a check invented
 * here: the phone counts uploads the server turned away, and the Live tab
 * already puts that at the top of the day. **Nothing in this workbook compares
 * what a manifest claimed against what arrived** — that check was taken out of
 * the dashboard on the owner's call and is not being reintroduced here.
 */
function runStatusLabel(row: PeriodRunRow): string {
  if (!row.read) return 'Could not be read';
  const blocked = row.run.manifest?.blockedUploadCount ?? 0;
  if (blocked > 0) return `Records refused (${blocked})`;
  if (row.run.status === 'open') return 'Still out';
  const endDay = runEndDay(row.run);
  return endDay && endDay !== row.run.businessDay ? 'Ended on a later day' : 'Day ended';
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * The Receipts sheet's Status column — and the word every total on that sheet
 * reads, exactly as the run workbook's Receipts sheet does it. Totals are
 * `SUMIF(Status, "<>Voided", …)`, and the Summary's "Receipts voided" is a
 * `COUNTIF` on the same column.
 */
const VoidedStatus = 'Voided';
const FinalizedStatus = 'Finalized';

/**
 * Every receipt written in the period, oldest first — **voided ones included**.
 *
 * It replaced a Voided sheet that listed only the cancelled receipts, on the
 * owner's call in September 2026: one list of every receipt is what someone checking the server
 * looks things up in, and a voided sale is easier to make sense of in its place
 * among the receipts around it than on a tab of its own.
 *
 * **A voided receipt is on the sheet and in no total**, the same rule as the run
 * workbook: its row is struck through and grey, its Status reads "Voided" in
 * red, and every total is a `SUMIF` that skips that word — so the Sales, Net
 * and Collected totals here come to the same figures as the Breakdown and
 * Collected sheets, and a manager who types "Voided" into a row watches them
 * follow. The totals row says "(voided not counted)" whenever there is one to
 * not count.
 */
function buildReceiptsSheet(sheet: ExcelJS.Worksheet, rows: PeriodReceiptItem[]): Table<PeriodReceiptItem> {
  const columns: TableColumn<PeriodReceiptItem>[] = [
    { header: 'Day', value: (row) => row.day },
    { header: 'Time', value: (row) => formatBusinessTime(row.createdAt) },
    { header: 'Store', value: (row) => row.store },
    { header: 'Agents', value: (row) => row.agents, width: TextColumnWidth },
    { header: 'Truck', value: (row) => row.truck },
    { header: 'Payment', value: (row) => (row.paymentMethod ? paymentLabel(row.paymentMethod) : '—') },
    // Beside Payment, as on the run workbook: the two are read together — a
    // voided cash receipt collected nothing — and ahead of the money it decides.
    { header: 'Status', value: (row) => (row.voidedAt === null ? FinalizedStatus : VoidedStatus) },
    { header: 'Sales', value: (row) => row.sales, format: 'money', total: 'sum' },
    { header: 'Returns', value: (row) => row.returns, format: 'money', total: 'sum' },
    { header: 'Net', value: (row) => row.net, format: 'money', total: 'sum' },
    { header: 'Collected', value: (row) => row.collected, format: 'money', total: 'sum' },
    { header: 'Voided at', value: (row) => (row.voidedAt === null ? '' : formatBusinessTime(row.voidedAt)) },
  ];
  const anyVoided = rows.some((row) => row.voidedAt !== null);
  const table = addTable(sheet, columns, rows, {
    totalLabel: anyVoided ? 'Totals (voided not counted)' : 'Totals',
    skipRowsWhere: { header: 'Status', value: VoidedStatus },
  });

  // Still on the sheet, visibly not part of it: the row struck through, and the
  // one word the totals read picked out in red rather than struck.
  const statusCol = columnOf(table, 'Status');
  rows.forEach((row, index) => {
    if (row.voidedAt === null) return;
    const sheetRow = table.firstDataRow + index;
    for (let col = 1; col <= columns.length; col++) sheet.getCell(sheetRow, col).font = VoidFont;
    sheet.getCell(sheetRow, statusCol).font = { bold: true, color: { argb: 'FFE5484D' } };
  });

  sizeSheet(sheet, table, rows);
  // Sized to the dates, not to "Totals (voided not counted)": that label spills
  // across the blank Time and Store cells of the totals row, where it would
  // otherwise stretch the Day column to three times what a date needs.
  sheet.getColumn(1).width = 12;
  const notes = ['Every receipt written in this period, oldest first.'];
  if (anyVoided) {
    notes.push(
      'Voided receipts are left out of the totals here and of every other figure in this file. Their bread went back on the truck when they were voided.',
    );
  }
  noteUnder(sheet, table, notes);
  return table;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * The sheet somebody opens without being told what the file is.
 *
 * Three blocks: what the period *was*, what the trucks *moved*, and what it
 * *made*. **Every figure that another sheet owns is a formula pointing at it**,
 * so this page states almost nothing of its own and can never disagree with the
 * tab behind it — and a manager who corrects a number in Excel watches this
 * page follow. The two blocks at the top sit in A/B and D/E with column C left
 * as the gutter between them, exactly as the run workbook's Summary does.
 *
 * The handful of figures that are *not* formulas are the ones no column can be
 * summed to reach — "Stores served" above all — and they are counted rather than
 * added for the reason every Stores footnote in this workbook gives: the same
 * shop on two days is one shop.
 *
 * It was a longer page. Days a truck went out, crews out, trucks used, areas
 * covered, the two loaf shares, the two bread-type counts and the three
 * net-per-something averages all came out on the owner's call (crews and areas
 * have since been removed altogether). What is left is
 * the period, the bread and the money, and nothing a reader has to work out what
 * it is a ratio of.
 */
function buildSummarySheet(
  sheet: ExcelJS.Worksheet,
  summary: PeriodSummary,
  refs: {
    days: Table<PeriodDayRow>;
    collected: { totalRow: number };
    expenses: Table<PeriodExpenseItem>;
    receipts: Table<PeriodReceiptItem>;
  },
) {
  const DetailCol = 1;
  const WorkCol = 4;
  const LastCol = 5;
  const { totals } = summary;

  function banner(row: number, text: string, font: Partial<ExcelJS.Font>) {
    sheet.getCell(row, 1).value = text;
    sheet.getCell(row, 1).font = font;
    sheet.mergeCells(row, 1, row, LastCol);
  }

  function header(row: number, col: number, label: string, valueHeader: string) {
    sheet.getCell(row, col).value = label;
    sheet.getCell(row, col + 1).value = valueHeader;
    styleHeaderRow(sheet, row, 2, col);
  }

  function line(row: number, col: number, label: string, value: ExcelJS.CellValue, numFmt?: string): number {
    sheet.getCell(row, col).value = label;
    const cell = sheet.getCell(row, col + 1);
    cell.value = value;
    if (numFmt) cell.numFmt = numFmt;
    return row + 1;
  }

  /**
   * Flushes the value written by the `line` immediately before it to the right
   * edge of its column, and passes the next row straight through so it wraps a
   * `line` call rather than interrupting the run of them.
   *
   * Excel aligns by *type*, not by column: a number goes right and a string goes
   * left. Every figure in a block therefore lines up on one edge and every name
   * or date in the same column hangs off the other, which reads as two columns
   * of values rather than one.
   */
  function right(nextRow: number, col: number): number {
    sheet.getCell(nextRow - 1, col + 1).alignment = { horizontal: 'right' };
    return nextRow;
  }

  /**
   * A figure the Breakdown sheet's by-day table already totals, as a formula
   * pointing at that total. Falls back to the number itself only when that table
   * has no totals row — a period with no days in it at all — because a formula
   * pointing at a row that was never written renders as `#REF!` rather than as
   * zero.
   */
  const fromDays = (header: string, fallback: number): ExcelJS.CellValue =>
    refs.days.totalRow
      ? { formula: sheetRef(Sheets.breakdown,`${colLetter(columnOf(refs.days, header))}${refs.days.totalRow}`) }
      : fallback;

  banner(1, `Summary — ${formatDateRangeLabel(summary.from, summary.to)}`, {
    bold: true,
    size: 16,
    color: { argb: InkColor },
  });
  banner(
    2,
    [
      `${summary.days.length} day${summary.days.length === 1 ? '' : 's'}`,
      `${totals.runs} run${totals.runs === 1 ? '' : 's'}`,
      `${totals.trucks} truck${totals.trucks === 1 ? '' : 's'}`,
    ].join(' · '),
    { color: { argb: MutedColor } },
  );

  // Runs still out when the file was made are named in an Info banner straight
  // under the title, before any figure — see the matching banner in the run
  // workbook. The file is always read fresh at export (buildPeriodSummary
  // re-runs the query rather than reusing the dialog's count), so the point is
  // not that the data is stale but that these runs aren't finished.
  const exportedAt = Date.now();
  const exportedLabel = `${formatBusinessTime(exportedAt)}, ${formatBusinessDayLong(businessDayKey(exportedAt))}`;
  const openRuns = summary.runs.filter((row) => row.run.status === 'open');
  let blockTop = 4;
  if (openRuns.length > 0) {
    const NamedLimit = 5;
    const named = openRuns
      .slice(0, NamedLimit)
      .map(
        (row) =>
          `${row.run.truckName || 'No truck'} (${runAgentNames(row.run)}, ${formatBusinessDayShort(row.run.businessDay)})`,
      )
      .join(', ');
    const more = openRuns.length > NamedLimit ? ` and ${openRuns.length - NamedLimit} more` : '';
    const was = openRuns.length === 1 ? 'was' : 'were';
    infoBanner(
      sheet,
      3,
      LastCol,
      `Info: ${openRuns.length} of the ${totals.runs} runs in this period ${was} still out when this file was exported — not yet ended on the phone: ${named}${more}. Their figures are the latest the server had at ${exportedLabel} (Manila), and may still change. Each is listed on the Runs sheet.`,
    );
    blockTop = 5;
  }

  // What this file covers, in the words the board uses.
  header(blockTop, DetailCol, 'The period', '');
  let detailRow = blockTop + 1;
  detailRow = right(line(detailRow, DetailCol, 'From', formatBusinessDayLong(summary.from)), DetailCol);
  detailRow = right(line(detailRow, DetailCol, 'To', formatBusinessDayLong(summary.to)), DetailCol);
  detailRow = line(detailRow, DetailCol, 'Days covered', summary.days.length, CountFormat);
  detailRow = line(detailRow, DetailCol, 'Runs', fromDays('Runs', totals.runs), CountFormat);
  detailRow = line(detailRow, DetailCol, 'Receipts written', fromDays('Receipts', totals.receipts), CountFormat);
  // Counted off the Receipts sheet's Status column, so the figure and the list
  // can't disagree.
  const statusLetter = colLetter(columnOf(refs.receipts, 'Status'));
  detailRow = line(
    detailRow,
    DetailCol,
    'Receipts voided',
    refs.receipts.totalRow
      ? {
          formula: `COUNTIF(${sheetRef(Sheets.receipts, `${statusLetter}${refs.receipts.firstDataRow}:${statusLetter}${refs.receipts.lastDataRow}`)},"${VoidedStatus}")`,
        }
      : 0,
    CountFormat,
  );
  detailRow = line(detailRow, DetailCol, 'Stores served', totals.stores, CountFormat);
  // Excel flushes a number right and text left, so this name would sit
  // against the opposite edge of the same column every figure above it lines
  // up on. Aligned by hand, the value column has a single right edge from
  // "From" to "Best truck".
  detailRow = right(line(detailRow, DetailCol, 'Best truck', bestName(summary.trucks)), DetailCol);

  // What physically moved. Loaded minus sold is what came home; returned bread
  // is a separate figure and the notes at the foot say why.
  header(blockTop, WorkCol, 'The bread', 'Loaves');
  let workRow = blockTop + 1;
  workRow = line(workRow, WorkCol, 'Loaded onto trucks', fromDays('Loaded', totals.loaded), CountFormat);
  workRow = line(workRow, WorkCol, 'Sold', fromDays('Sold', totals.sold), CountFormat);
  workRow = line(workRow, WorkCol, 'Returned by stores', fromDays('Returned', totals.returnedLoaves), CountFormat);
  workRow = line(workRow, WorkCol, 'Left on the trucks', fromDays('Left on truck', totals.remaining), CountFormat);

  // Money. Collected and still-owed are the pair nothing else in the workbook
  // shows together: net is what the stores owe, collected is what actually came
  // back, and the gap between them is what somebody has to go and get.
  const moneyHeaderRow = Math.max(detailRow, workRow) + 1;
  let moneyRow = moneyHeaderRow;
  header(moneyRow, DetailCol, 'Money', 'Amount');
  moneyRow += 1;
  moneyRow = line(moneyRow, DetailCol, 'Sales (gross)', fromDays('Sales', totals.sales), MoneyFormat);
  moneyRow = line(moneyRow, DetailCol, 'Returns credited', fromDays('Returns', totals.returns), MoneyFormat);
  const netRow = moneyRow;
  moneyRow = line(moneyRow, DetailCol, 'Net takings', fromDays('Net', totals.net), MoneyFormat);
  styleTotalRow(sheet, netRow, 2);
  sheet.getCell(netRow, 2).font = { bold: true, color: { argb: 'FF1E40AF' } };

  const collectedRow = moneyRow;
  moneyRow = line(
    moneyRow,
    DetailCol,
    'Collected (cash, GCash, cheque, partial paid)',
    { formula: sheetRef(Sheets.collected, `B${refs.collected.totalRow}`) },
    MoneyFormat,
  );
  moneyRow = line(
    moneyRow,
    DetailCol,
    'Still owed (credit and unpaid partials)',
    { formula: `B${netRow}-B${collectedRow}` },
    MoneyFormat,
  );
  moneyRow = line(
    moneyRow,
    DetailCol,
    'Expenses',
    refs.expenses.totalRow
      ? {
          formula: sheetRef(
            Sheets.expenses,
            `${colLetter(columnOf(refs.expenses, 'Amount'))}${refs.expenses.totalRow}`,
          ),
        }
      : totals.expenses,
    MoneyFormat,
  );

  // One frame per block, drawn once all three are laid out. The notes below are
  // deliberately left outside them — they are about the whole sheet, not about
  // any one block.
  outlineRange(sheet, blockTop, DetailCol, detailRow - 1, DetailCol + 1);
  outlineRange(sheet, blockTop, WorkCol, workRow - 1, WorkCol + 1);
  outlineRange(sheet, moneyHeaderRow, DetailCol, moneyRow - 1, DetailCol + 1);

  const notes = [
    'Almost every figure on this page is a formula pointing at the sheet that owns it, so correcting a number there updates this one.',
    StoresNote,
    'Returned bread is credited to the store but never goes back on the truck, so "left on the trucks" is loaded minus sold.',
    'Expenses are recorded by the agents as trip notes. They are not deducted from sales or net.',
  ];
  if (summary.receipts.some((row) => row.voidedAt !== null)) {
    notes.push(
      'Voided receipts are left out of every figure in this file. They are still listed on the Receipts sheet.',
    );
  }
  if (summary.unreadRuns > 0) {
    notes.push(
      `${summary.unreadRuns} run${summary.unreadRuns === 1 ? '' : 's'} could not be read and contributed nothing to these figures. They are on the Runs sheet, marked "Could not be read".`,
    );
  }
  notes.push(`Exported ${formatBusinessDayLong(businessDayKey(exportedAt))}, ${formatBusinessTime(exportedAt)} (Manila).`);

  // Through `line`-style plain cells rather than `banner`: the two title rows at
  // the top are merged because they are one heading across the sheet, but a
  // merged note would be clipped at column E. See `noteUnder`.
  let noteRow = moneyRow + 1;
  for (const note of notes) {
    sheet.getCell(noteRow, 1).value = note;
    sheet.getCell(noteRow, 1).font = NoteFont;
    noteRow += 1;
  }

  // Column C is the gutter between the two blocks at the top — nothing is ever
  // written in it. It is wide enough to read as a gap rather than a cell border.
  autoWidth(sheet);
  sheet.getColumn(1).width = 44;
  sheet.getColumn(2).width = 36;
  sheet.getColumn(3).width = 12;
  sheet.getColumn(4).width = 26;
  sheet.getColumn(5).width = 14;
}

/**
 * The truck with the highest net takings, named — or a dash, because
 * "best" of nothing is not a name.
 *
 * **Searched for, not read off the top row.** The rows follow the dashboard's
 * own order rather than the takings, so the first one is simply whichever truck
 * is listed first. On a tie the one listed first wins.
 */
function bestName(rows: PeriodGroupRow[]): string {
  const best = rows.reduce<PeriodGroupRow | null>((top, row) => (top === null || row.net > top.net ? row : top), null);
  return best && best.net > 0 ? best.name : '—';
}
