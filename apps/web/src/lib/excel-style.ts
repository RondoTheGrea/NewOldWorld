import ExcelJS from 'exceljs';

/**
 * The look of every workbook this dashboard produces, in one place.
 *
 * Started life inside `export-run-excel.ts` and moved out the moment there was
 * a second workbook (`export-period-excel.ts`). That is not tidying for its own
 * sake: the two files land in the same folder on the same shared drive and get
 * read side by side, and a navy header in one beside a blue-grey header in the
 * other reads as two systems rather than two reports. The frames, the fills,
 * the money format and the column sizing are the house style, so they live
 * where neither export can quietly change only its own copy.
 *
 * Nothing here knows what a run or a receipt is — it takes worksheets and cell
 * ranges. The per-workbook shapes stay in the exports themselves.
 */

/** Navy header — matches the Overview tab accent. */
export const HeaderFill: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E40AF' },
};

export const HeaderFont: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },
};

/** Soft blue — matches --ops-accent-soft. Fills the total rows. */
export const SoftBlue = 'FFEEF2FF';

/**
 * The frame around each section: the same indigo family, a few steps darker so
 * the boundary is visible on paper, and still well clear of the navy the header
 * rows are filled with — the header has to stay the darkest thing in a section.
 */
export const FrameBlue = 'FFA5B4FC';

export const TotalFill: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: SoftBlue },
};

/** Ink and muted ink — the same two the board draws its text in. */
export const InkColor = 'FF0F172A';
export const MutedColor = 'FF64748B';

/** Blue and underlined, so a link looks like one. */
export const LinkFont: Partial<ExcelJS.Font> = {
  color: { argb: 'FF1E40AF' },
  underline: true,
};

/** The italic grey every footnote under a sheet is set in. */
export const NoteFont: Partial<ExcelJS.Font> = { italic: true, color: { argb: MutedColor } };

/**
 * A voided receipt's row: struck through and greyed, so it is plainly on the
 * sheet and plainly not part of the figures beside it.
 */
export const VoidFont: Partial<ExcelJS.Font> = { strike: true, color: { argb: MutedColor } };

/**
 * The soft amber "Info" banner at the top of a Summary sheet.
 *
 * Used for the one thing a reader has to know *before* trusting any figure
 * under it: the export caught a run that was still out, so those numbers are
 * the latest the server had rather than the final ones. It is a banner under
 * the title rather than a footnote, because a footnote is read last and this
 * has to be read first.
 *
 * Merged across the summary's columns with wrapping on and a row tall enough
 * for the text. `charsPerLine` is the rough width of the merged area — Excel
 * does not grow a merged row on its own, so the height has to be set by hand.
 */
export function infoBanner(
  sheet: ExcelJS.Worksheet,
  row: number,
  lastCol: number,
  text: string,
  charsPerLine = 110,
) {
  const fill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
  for (let col = 1; col <= lastCol; col++) sheet.getCell(row, col).fill = fill;
  sheet.mergeCells(row, 1, row, lastCol);
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  cell.font = { bold: true, color: { argb: 'FF92400E' } };
  cell.alignment = { wrapText: true, vertical: 'middle' };
  const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
  sheet.getRow(row).height = lines * 15 + 8;
}

/**
 * The footnotes both workbooks' **Bread** sheets carry, word for word.
 *
 * The one exception to "nothing here knows what a run is": the run workbook and
 * the period workbook each have a Bread sheet with the same columns, and they
 * are read side by side. A definition worded two ways is two definitions, so the
 * sentences live where neither export can reword only its own copy.
 */
export const UnsoldNotes = [
  'Left on truck: bread that went out on the truck but was not sold.',
  'Unsold %: out of all the bread loaded, how much was not sold.',
];

/**
 * A Bread sheet's Stores column answers a different question from every other
 * Stores figure — the shops that took *that* bread, not the shops served — so it
 * has its own sentence.
 */
export const BreadStoresNote =
  'Stores counts the shops that took this bread. A shop that took it more than once counts as one store, so this column is not totalled.';

export const MoneyFormat = '"₱"#,##0.00';
export const CountFormat = '#,##0';
/** A share stored as a fraction — 0.083 draws as "8.3%". */
export const PercentFormat = '0.0%';

/**
 * How many characters Excel will draw for a peso figure.
 *
 * Only ever used to measure a column — nothing is rendered through it. It
 * exists because `MoneyFormat` is applied to the *cell*, so what the sheet
 * stores ("1234.5") and what it draws ("₱1,234.50") are different lengths, and
 * a money cell too narrow for its value shows `####` rather than wrapping.
 */
export const MoneyDigits = new Intl.NumberFormat('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function moneyTextLength(value: number): number {
  return MoneyDigits.format(value).length + 1;
}

/** 1 → "A", 27 → "AA". Spreadsheet column letters, for building formulas. */
export function colLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * A sheet name as it has to be written inside a formula.
 *
 * Excel needs single quotes around any name with a space in it — `'By day'!J8`
 * — and doubles an apostrophe inside one. Tab names on these workbooks are
 * written for a reader rather than for a formula parser, so every cross-sheet
 * reference goes through here instead of being concatenated by hand.
 */
export function sheetRef(sheetName: string, cell: string): string {
  return /^[A-Za-z0-9_]+$/.test(sheetName)
    ? `${sheetName}!${cell}`
    : `'${sheetName.replace(/'/g, "''")}'!${cell}`;
}

export function styleHeaderRow(sheet: ExcelJS.Worksheet, row: number, colCount: number, startCol = 1) {
  for (let col = startCol; col < startCol + colCount; col++) {
    const cell = sheet.getCell(row, col);
    cell.fill = HeaderFill;
    cell.font = HeaderFont;
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF1E40AF' } },
      left: { style: 'thin', color: { argb: 'FF1E40AF' } },
      bottom: { style: 'thin', color: { argb: 'FF1E40AF' } },
      right: { style: 'thin', color: { argb: 'FF1E40AF' } },
    };
  }
}

export function styleTotalRow(sheet: ExcelJS.Worksheet, row: number, colCount: number, startCol = 1) {
  for (let col = startCol; col < startCol + colCount; col++) {
    const cell = sheet.getCell(row, col);
    cell.fill = TotalFill;
    cell.font = { bold: true };
  }
}

/**
 * Draws one continuous frame around a rectangle of cells.
 *
 * Each cell keeps the borders it already has — the navy header row draws its
 * own — so this only ever adds the four outside edges. A section is easier to
 * find on a printed page than a run of rows separated by a blank one, and the
 * frame is drawn in a light indigo so it groups the block without competing
 * with the figures inside it.
 */
export function outlineRange(
  sheet: ExcelJS.Worksheet,
  top: number,
  left: number,
  bottom: number,
  right: number,
  style: ExcelJS.BorderStyle = 'medium',
) {
  const edge = { style, color: { argb: FrameBlue } };
  for (let row = top; row <= bottom; row++) {
    for (let col = left; col <= right; col++) {
      const cell = sheet.getCell(row, col);
      const border: Partial<ExcelJS.Borders> = { ...(cell.border ?? {}) };
      if (row === top) border.top = edge;
      if (row === bottom) border.bottom = edge;
      if (col === left) border.left = edge;
      if (col === right) border.right = edge;
      cell.border = border as ExcelJS.Borders;
    }
  }
}

export function autoWidth(sheet: ExcelJS.Worksheet, min = 10, max = 44) {
  sheet.columns.forEach((column) => {
    let width = min;
    if (column.eachCell) {
      column.eachCell({ includeEmpty: false }, (cell) => {
        const text = cell.text ?? '';
        width = Math.max(width, Math.min(max, text.length + 2));
      });
    }
    column.width = width;
  });
}

/**
 * Widens money columns to what Excel actually *draws*, which `autoWidth` cannot
 * see for two reasons: it reads the stored number ("1234.5") rather than
 * "₱1,234.50", and a formula cell has no cached result, so the totals row —
 * where the widest figure usually sits — measures as empty.
 *
 * Every column named is given the **same** width, deliberately. Sales, returns
 * and net are one quantity in three columns, and three different widths read as
 * three unrelated numbers.
 */
export function fitMoneyColumns(sheet: ExcelJS.Worksheet, columns: number[], values: number[], min = 12) {
  const width = values.reduce((widest, value) => Math.max(widest, moneyTextLength(value) + 2), min);
  for (const col of columns) sheet.getColumn(col).width = width;
}

/** Strips a name down to something safe to put in a download's file name. */
export function safeFilePart(value: string, fallback = 'export'): string {
  return value.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || fallback;
}

/**
 * Hands a finished workbook to the browser as a download.
 *
 * The object URL is revoked immediately after the click: the anchor is never in
 * the document, and the browser has already taken its copy of the blob by the
 * time `click()` returns.
 */
export async function downloadWorkbook(workbook: ExcelJS.Workbook, fileName: string): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
