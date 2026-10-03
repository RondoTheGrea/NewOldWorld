import ExcelJS from 'exceljs';

import {
  businessDayKey,
  formatBusinessDayLong,
  formatBusinessDayShort,
  formatBusinessTime,
  formatDuration,
} from '@/lib/business-day';
import { type BreadType } from '@/lib/bread-types';
// The house style — fills, frames, formats, column sizing — is shared with the
// period workbook so the two files read as one system on the shared drive.
import {
  autoWidth,
  BreadStoresNote,
  colLetter,
  CountFormat,
  downloadWorkbook,
  fitMoneyColumns,
  infoBanner,
  InkColor,
  LinkFont,
  MoneyDigits,
  MoneyFormat,
  MutedColor,
  NoteFont,
  outlineRange,
  PercentFormat,
  safeFilePart,
  styleHeaderRow,
  styleTotalRow,
  UnsoldNotes,
  VoidFont,
} from '@/lib/excel-style';
import { fetchPaymentProofImage, type PaymentProofImage } from '@/lib/payment-proof';
import { buildNameFor, buildOutcomeRows, compareBreadNames } from '@/lib/run-outcome';
import { type ReturnedBreadType } from '@/lib/returned-bread-types';
import {
  isVoided,
  totalCollected,
  totalExpenses,
  totalReceipts,
  totalStock,
  type Run,
  type RunExpense,
  type RunReceipt,
  type RunStockEntry,
} from '@/lib/runs';
import { paymentLabel } from '@/lib/payment-methods';


/**
 * Proof photos live on their own **Photos** sheet, one block each, and the
 * Receipts sheet links to them with a "View photo" cell.
 *
 * The bytes are still inside the workbook — a GCash or cheque receipt *is* its
 * screenshot, and the file is meant to survive being opened next week off a
 * shared drive by someone who may not be signed in, so a link to Storage would
 * be worthless there. What changed is where they sit. Embedded in the receipt
 * row, every photo made that row four times its natural height, and a table of
 * money nobody can skim is a worse table however good the pictures are.
 *
 * Excel has no popup image viewer — nothing in the file format has one — so a
 * jump to a sheet and a link back is as close to "click to open" as it gets.
 * The trade is deliberate: the receipts table stays readable, and the photo is
 * one click away at a size somebody can actually read a reference number off,
 * rather than a thumbnail wedged into a cell.
 */
const PhotoBoxWidthPx = 420;
const PhotoBoxHeightPx = 315;
const PhotoMarginPx = 8;
/** Excel's column unit: roughly 7px per character, plus 5px of cell padding. */
const PhotoColumnWidth = (PhotoBoxWidthPx + PhotoMarginPx * 2 - 5) / 7;
/** Row heights are points, not pixels — a 96dpi pixel is 0.75pt. */
const PhotoRowHeightPt = (PhotoBoxHeightPx + PhotoMarginPx * 2) * 0.75;
/** Width of the Photos sheet's second column, which holds the link back. */
const PhotoBackColumnWidth = 26;
/**
 * Each photo is a caption row, the picture under it, then a blank row. Fixed,
 * so the Receipts sheet can work out where a photo will land before the Photos
 * sheet has been written.
 */
const PhotoBlockRows = 3;
/** Row 1 is the title and row 2 is left blank, so the first caption is row 3. */
const PhotoFirstCaptionRow = 3;
/** Enough at once to hide the round trips, few enough not to stall the tab. */
const ProofConcurrency = 4;

/**
 * The two bread columns are held to this width whatever their contents.
 *
 * They list every bread on the receipt, so left to `autoWidth` one long
 * receipt would stretch the column to the 44-character cap and push the money
 * off the screen for every other row. Excel clips the overflow instead and
 * shows the whole list in the formula bar when the cell is clicked, which is
 * where a reader goes when they want the detail of one receipt.
 */
const BreadColumnWidth = 22;

/**
 * The Receipts sheet's Status column — and the word every total on that sheet
 * reads. Totals are `SUMIF(Status, "<>Voided", …)`, so a voided receipt stays on
 * the sheet (struck through) and is left out of the figures, and a manager who
 * types "Voided" into a row in Excel watches the totals, and the Summary behind
 * them, follow — the same "formulas, not baked numbers" rule as everywhere else.
 */
const VoidedStatus = 'Voided';
const FinalizedStatus = 'Finalized';

/**
 * The breads on one receipt as a single cell: "12× Pandesal, 3× Ensaymada".
 *
 * This replaced a count of *lines*, which told the reader how many kinds of
 * bread a store took without saying which — the one thing the sheet is asked
 * after the money. The quantity leads the name so a column of these reads as a
 * column of numbers.
 */
function joinBreadLines(lines: { name: string; quantity: number }[]): string {
  if (lines.length === 0) return '—';
  return lines.map((line) => `${line.quantity}× ${line.name || 'Unnamed bread type'}`).join(', ');
}

const EmuPerPixel = 9525;

/**
 * ExcelJS turns the fractional part of an anchor into an offset by multiplying
 * it by `cellSize * 10000` (see exceljs/lib/doc/anchor.js) — a scale of its
 * own, not EMU — so a margin wanted in pixels has to be converted back through
 * that same formula rather than guessed at as "about a tenth of a cell". Guess
 * it and the margin silently changes whenever the column is resized.
 */
function anchorFraction(cellSize: number, marginPx: number): number {
  return (marginPx * EmuPerPixel) / (cellSize * 10000);
}

/** Fits a photo inside the box without distorting it, and never enlarges one. */
function fitToBox(image: PaymentProofImage): { width: number; height: number } {
  const scale = Math.min(PhotoBoxWidthPx / image.width, PhotoBoxHeightPx / image.height, 1);
  return { width: Math.round(image.width * scale), height: Math.round(image.height * scale) };
}

type ProofOutcome = { image: PaymentProofImage } | { note: string };

/**
 * Short enough to sit in the cell it replaces. The two named cases are
 * genuinely different — a file that never reached the server is a gap in the
 * record, anything else is this browser's own problem — and collapsing them
 * would send someone chasing the wrong one.
 */
function proofFailureNote(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'storage/object-not-found') return 'Photo never reached the server';
  if (code === 'storage/unauthorized') return 'Photo not readable by this account';
  return 'Photo could not be downloaded';
}

/**
 * Downloads every proof photo in the run, a few at a time.
 *
 * **Nothing here rejects.** A photo that can't be fetched becomes a note in its
 * own cell and the workbook is still produced — an export that failed outright
 * over one missing file would cost the reader the other forty receipts too.
 */
async function fetchProofImages(receipts: RunReceipt[]): Promise<Map<string, ProofOutcome>> {
  const pending = receipts.filter((receipt) => receipt.proofStoragePath);
  const outcomes = new Map<string, ProofOutcome>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= pending.length) return;
      const receipt = pending[index];
      try {
        const image = await fetchPaymentProofImage(receipt.proofStoragePath as string);
        outcomes.set(receipt.id, { image });
      } catch (error) {
        console.error('[export-run-excel.proof]', receipt.id, error);
        outcomes.set(receipt.id, { note: proofFailureNote(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ProofConcurrency, pending.length) }, worker));
  return outcomes;
}

/**
 * What goes in the proof cell: a link to the photo's block on the Photos sheet,
 * or a short note saying why there isn't one.
 *
 * The link is the `HYPERLINK()` worksheet function, **not** ExcelJS's
 * `{ text, hyperlink }` cell value. That form writes every link as an
 * *external* relationship whatever the target, so a workbook-internal
 * destination comes out as `TargetMode="External"` and Excel goes looking for a
 * file named "Photos!A3". The formula is also passed **without** a leading
 * `=` — with one, ExcelJS emits `<f>=HYPERLINK(…)</f>`, which is malformed.
 */
function proofCellValue(
  receipt: RunReceipt,
  outcome: ProofOutcome | undefined,
  captionRow: number | undefined,
): ExcelJS.CellValue {
  if (!receipt.proofStoragePath) return '—';
  if (captionRow !== undefined) {
    return { formula: `HYPERLINK("#Photos!A${captionRow}","View photo")` };
  }
  return outcome && 'note' in outcome ? outcome.note : 'Photo could not be downloaded';
}

/**
 * The loading half of the Bread sheet: what went onto the truck at the start,
 * and each top-up batch in the order the phone wrote them — all keyed by
 * **name**, resolved through `nameFor`, so they land on the same row as the
 * sold, returned and left-on-truck figures `buildOutcomeRows` keys the same way.
 */
function buildLoadingByName(entries: RunStockEntry[], nameFor: (id: string) => string) {
  const add = (into: Map<string, number>, id: string, quantity: number) => {
    const name = nameFor(id);
    into.set(name, (into.get(name) ?? 0) + quantity);
  };

  const initial = new Map<string, number>();
  let initialLoadedAt: number | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'initial') continue;
    // `entries` is oldest-first, so the first one with a real timestamp is
    // when the count was written.
    if (initialLoadedAt === null && entry.createdAt > 0) initialLoadedAt = entry.createdAt;
    for (const item of entry.items) add(initial, item.breadTypeId, item.quantity);
  }

  const additions = entries.filter((entry) => entry.kind === 'addition');
  const batches = additions.map((batch) => {
    const quantities = new Map<string, number>();
    for (const item of batch.items) add(quantities, item.breadTypeId, item.quantity);
    return quantities;
  });
  /** When each batch went on, in the same order as `batches`. */
  const batchLoadedAt = additions.map((batch) => (batch.createdAt > 0 ? batch.createdAt : null));

  return { initial, initialLoadedAt, batches, batchLoadedAt };
}

/**
 * A load column's heading with when it went on underneath — "Batch 2", then the
 * Manila date, then the Manila time, one per line. Always shown in the file
 * (the panel hides it behind a toggle; a spreadsheet has nothing to tap).
 */
function loadHeading(label: string, loadedAt: number | null): string {
  if (loadedAt === null) return label;
  return `${label}\n${formatBusinessDayShort(businessDayKey(loadedAt))}\n${formatBusinessTime(loadedAt)}`;
}

export type ExportRunExcelInput = {
  run: Run;
  /**
   * Which trip of the day this is for this crew — see `crewTripNumber`. Only
   * the file name uses it, and only above 1.
   *
   * Optional, falling back to the phone's own `sequence`. That fallback is the
   * weaker answer of the two: the phone counts per account, so two logins that
   * both took this crew out today each believe they are trip 1.
   */
  tripNumber?: number;
  receipts: RunReceipt[];
  entries: RunStockEntry[];
  expenses: RunExpense[];
  breadTypes: BreadType[];
  /**
   * The old-price catalog, in its own manual order — what places a returned
   * bread on the Bread sheet when no current bread type is named after it.
   */
  returnedBreadTypes: ReturnedBreadType[];
};

/**
 * Builds a formatted multi-sheet workbook for one run and triggers a download.
 *
 * Totals on the Summary, Receipts, Bread, Collected and Expenses sheets use
 * Excel formulas so a manager can adjust figures in Excel and watch them
 * recalculate.
 */
export async function exportRunToExcel(input: ExportRunExcelInput): Promise<void> {
  const { run, receipts, entries, expenses, breadTypes, returnedBreadTypes } = input;
  const totals = totalReceipts(receipts);
  const stock = totalStock(entries);
  const spend = totalExpenses(expenses);
  const liveExpenses = expenses.filter((expense) => !expense.deleted);
  const nameFor = buildNameFor(breadTypes, receipts);
  const loading = buildLoadingByName(entries, nameFor);
  // The same rows, from the same builder, as the panel's Outcome tab — the
  // Bread sheet and the screen can't disagree about what came back.
  const outcomeRows = buildOutcomeRows({ stock, receipts, nameFor, breadTypes, returnedBreadTypes });
  const collected = totalCollected(receipts);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NewOldWorld POS';
  workbook.created = new Date();

  // Downloaded before any sheet exists, because whether there are photos at all
  // decides whether the Photos tab is created — an empty one is just noise.
  const proofImages = await fetchProofImages(receipts);
  const receiptFirstDataRow = 2;
  const photoBlocks: { receiptRow: number; image: PaymentProofImage; captionRow: number }[] = [];
  receipts.forEach((receipt, index) => {
    const outcome = proofImages.get(receipt.id);
    if (!outcome || !('image' in outcome)) return;
    photoBlocks.push({
      receiptRow: receiptFirstDataRow + index,
      image: outcome.image,
      captionRow: PhotoFirstCaptionRow + photoBlocks.length * PhotoBlockRows,
    });
  });
  const captionRowByReceiptRow = new Map(photoBlocks.map((block) => [block.receiptRow, block.captionRow]));

  const summarySheet = workbook.addWorksheet('Summary', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const receiptsSheet = workbook.addWorksheet('Receipts');
  const breadSheet = workbook.addWorksheet('Bread');
  const collectedSheet = workbook.addWorksheet('Collected');
  const expensesSheet = workbook.addWorksheet('Expenses');
  // Last, and only if it has something in it. Nothing reads the tab order —
  // the links into it name the sheet — so this is purely where a reader meets
  // it: after the sheets they came for, since it is reached by clicking a
  // receipt rather than by browsing to it.
  const photosSheet =
    photoBlocks.length > 0
      ? workbook.addWorksheet('Photos', { views: [{ state: 'frozen', ySplit: 1 }] })
      : null;

  // --- Receipts (built first so Summary can reference row ranges) ---
  const receiptHeaders = [
    'Store',
    'Time',
    'Payment',
    'Status',
    'Subtotal',
    'Returns',
    'Net',
    'Bread sold',
    'Bread returned',
    'Proof photo',
  ];
  receiptsSheet.addRow(receiptHeaders);
  styleHeaderRow(receiptsSheet, 1, receiptHeaders.length);

  // Status sits beside Payment because the two are read together — a voided
  // cash receipt collected nothing — and ahead of the money it decides about.
  const statusCol = 4;
  const moneyCols = [5, 6, 7];
  const soldCol = 8;
  const returnedCol = 9;
  const proofCol = receiptHeaders.length;
  receipts.forEach((receipt, index) => {
    const row = receiptFirstDataRow + index;
    const outcome = proofImages.get(receipt.id);
    const captionRow = captionRowByReceiptRow.get(row);
    const voided = isVoided(receipt);
    receiptsSheet.addRow([
      receipt.customerName || 'Unnamed store',
      formatBusinessTime(receipt.createdAt),
      receipt.paymentMethod ? paymentLabel(receipt.paymentMethod) : '—',
      voided ? VoidedStatus : FinalizedStatus,
      receipt.subtotal,
      receipt.returnsTotal,
      receipt.total,
      joinBreadLines(
        receipt.items.map((item) => ({
          name: item.name || nameFor(item.breadTypeId),
          quantity: item.quantity,
        })),
      ),
      joinBreadLines(receipt.returns),
      proofCellValue(receipt, outcome, captionRow),
    ]);
    // Still on the sheet, visibly not part of it: the row struck through, and
    // the one word the totals read picked out in red rather than struck.
    if (voided) {
      for (let col = 1; col <= receiptHeaders.length; col++) receiptsSheet.getCell(row, col).font = VoidFont;
      receiptsSheet.getCell(row, statusCol).font = { bold: true, color: { argb: 'FFE5484D' } };
    }
    if (captionRow !== undefined) receiptsSheet.getCell(row, proofCol).font = LinkFont;
  });
  const receiptLastDataRow = Math.max(receiptFirstDataRow, receipts.length + 1);
  const receiptTotalRow = receiptLastDataRow + 1;
  const statusRange = `$${colLetter(statusCol)}$${receiptFirstDataRow}:$${colLetter(statusCol)}$${receiptLastDataRow}`;
  const sumQuantities = (lines: { quantity: number }[]) =>
    lines.reduce((sum, line) => sum + line.quantity, 0);
  const standing = receipts.filter((receipt) => !isVoided(receipt));
  const totalBreadSold = standing.reduce((sum, receipt) => sum + sumQuantities(receipt.items), 0);
  const totalBreadReturned = standing.reduce((sum, receipt) => sum + sumQuantities(receipt.returns), 0);

  if (receipts.length > 0) {
    const sumStanding = (col: number) => {
      const letter = colLetter(col);
      return { formula: `SUMIF(${statusRange},"<>${VoidedStatus}",${letter}${receiptFirstDataRow}:${letter}${receiptLastDataRow})` };
    };
    receiptsSheet.addRow([
      totals.voidedCount > 0 ? 'Totals (voided not counted)' : 'Totals',
      '',
      '',
      '',
      ...moneyCols.map(sumStanding),
      // The only two figures on this sheet that aren't formulas: the cells
      // above them are text now, and nothing in Excel sums a list of names.
      // They count loaves, not lines — the total the sheet was always asked
      // for, just no longer derivable from the column it sits under. Voided
      // receipts are left out of them, as the formulas beside them leave them
      // out of the money.
      totalBreadSold,
      totalBreadReturned,
      '',
    ]);
    styleTotalRow(receiptsSheet, receiptTotalRow, receiptHeaders.length);
    receiptsSheet.getCell(receiptTotalRow, soldCol).numFmt = CountFormat;
    receiptsSheet.getCell(receiptTotalRow, returnedCol).numFmt = CountFormat;
  }

  for (let row = receiptFirstDataRow; row <= receiptLastDataRow; row++) {
    for (const col of moneyCols) receiptsSheet.getCell(row, col).numFmt = MoneyFormat;
  }
  if (receipts.length > 0) {
    for (const col of moneyCols) receiptsSheet.getCell(receiptTotalRow, col).numFmt = MoneyFormat;
  }
  // An empty sheet frames its header row alone rather than boxing in a blank one.
  outlineRange(receiptsSheet, 1, 1, receipts.length > 0 ? receiptTotalRow : 1, receiptHeaders.length);
  autoWidth(receiptsSheet);
  receiptsSheet.getColumn(soldCol).width = BreadColumnWidth;
  receiptsSheet.getColumn(returnedCol).width = BreadColumnWidth;

  // Subtotal, Returns and Net share one width: they are one quantity in three
  // columns — what the store was charged, what was credited back, and the
  // difference — and three different widths read as three unrelated numbers.
  //
  // It is measured from what Excel *draws*, not from what `autoWidth` can see,
  // for two reasons. `autoWidth` reads the stored number ("1234.5") rather than
  // "₱1,234.50", and it never measures the totals row at all: those cells are
  // formulas with no cached result, so their text is empty — and that row is
  // exactly where the sheet's widest figure sits.
  fitMoneyColumns(receiptsSheet, moneyCols, [
    ...receipts.flatMap((receipt) => [receipt.subtotal, receipt.returnsTotal, receipt.total]),
    totals.salesTotal,
    totals.returnsTotal,
    totals.netTotal,
  ]);

  // --- Photos ---
  //
  // One block per photo: a caption naming the receipt, the picture under it,
  // and a blank row. The caption is what the Receipts sheet links to, so the
  // reader lands on the label with the photo directly below rather than in the
  // middle of an unidentified image.
  if (photosSheet) {
    photosSheet.getColumn(1).width = PhotoColumnWidth;
    photosSheet.getColumn(2).width = PhotoBackColumnWidth;
    photosSheet.getCell(1, 1).value = 'Proof of payment photos';
    photosSheet.getCell(1, 2).value = '';
    styleHeaderRow(photosSheet, 1, 2);

    for (const block of photoBlocks) {
      const receipt = receipts[block.receiptRow - receiptFirstDataRow];
      const caption = [
        receipt.customerName || 'Unnamed store',
        formatBusinessTime(receipt.createdAt),
        receipt.paymentMethod ? paymentLabel(receipt.paymentMethod) : 'No method',
        `₱${MoneyDigits.format(receipt.total)}`,
        ...(isVoided(receipt) ? [VoidedStatus] : []),
      ].join(' · ');
      photosSheet.getCell(block.captionRow, 1).value = caption;
      photosSheet.getCell(block.captionRow, 1).font = { bold: true };
      photosSheet.getCell(block.captionRow, 2).value = {
        formula: `HYPERLINK("#Receipts!A${block.receiptRow}","← Back to the receipt")`,
      };
      photosSheet.getCell(block.captionRow, 2).font = LinkFont;
      photosSheet.getRow(block.captionRow + 1).height = PhotoRowHeightPt;
      outlineRange(photosSheet, block.captionRow, 1, block.captionRow + 1, 2);
    }

    // Pictures last, and only once every width and height above is settled:
    // ExcelJS resolves an anchor's offsets against the column width and row
    // height *at the moment addImage is called* (exceljs/lib/doc/anchor.js), so
    // an image placed earlier is positioned against geometry that no longer
    // exists.
    for (const block of photoBlocks) {
      const imageId = workbook.addImage({
        base64: block.image.base64,
        extension: block.image.extension,
      });
      photosSheet.addImage(imageId, {
        tl: {
          col: anchorFraction(PhotoColumnWidth, PhotoMarginPx),
          row: block.captionRow + anchorFraction(PhotoRowHeightPt, PhotoMarginPx),
        },
        ext: fitToBox(block.image),
      });
    }
  }

  // --- Bread ---
  //
  // One sheet for the bread, laid out like the period workbook's Bread sheet, on
  // the owner's call. It was two — Inventory (what went on, batch by batch) and
  // Outcome (what sold, came back and stayed aboard) — in two different orders,
  // so following one bread meant finding its row on one tab and then again on
  // another. Now each bread is one row that reads left to right the way the trip
  // went: the morning load and each top-up, what that came to, and what became
  // of it. The batch columns are kept rather than folded into Loaded, because
  // "when did the second load of Pandesal go on" is still a question somebody
  // asks of one trip.
  //
  // Rows are in the panel's Outcome order (`compareBreadNames`, the reference
  // lists' manual order) — the same order the period workbook uses — and only
  // bread that moved gets a row, as on the panel.
  const byPosition = compareBreadNames(breadTypes, returnedBreadTypes);
  const outcomeByName = new Map(outcomeRows.map((row) => [row.name, row]));
  const breadNames = [
    ...new Set([
      ...outcomeRows.map((row) => row.name),
      ...loading.initial.keys(),
      ...loading.batches.flatMap((batch) => [...batch.keys()]),
    ]),
  ].sort(byPosition);

  // The shops that took each bread, standing receipts only. Named through
  // `nameFor` first, the way the ledger rows are, so a receipt line and the
  // ledger entry written beside it land on one row.
  const storesByName = new Map<string, Set<string>>();
  for (const receipt of standing) {
    if (!receipt.customerId) continue;
    for (const item of receipt.items) {
      const name = item.breadTypeId ? nameFor(item.breadTypeId) : item.name || 'Unnamed bread type';
      const shops = storesByName.get(name) ?? new Set<string>();
      shops.add(receipt.customerId);
      storesByName.set(name, shops);
    }
  }

  const breadHeaders = [
    'Bread',
    'Initial',
    ...loading.batches.map((_, i) => `Batch ${i + 1}`),
    'Loaded',
    'Sold',
    'Returned',
    'Left on truck',
    'Returns %',
    'Unsold %',
    'Stores',
  ];
  // Found by heading rather than counted, because the batch columns make every
  // position after them depend on how many top-ups the truck took.
  const breadCol = (header: string) => {
    const index = breadHeaders.indexOf(header);
    if (index < 0) throw new Error(`export-run-excel: no Bread column headed "${header}"`);
    return index + 1;
  };
  const breadInitialCol = breadCol('Initial');
  const breadLoadedCol = breadCol('Loaded');
  const breadSoldCol = breadCol('Sold');
  const breadReturnedCol = breadCol('Returned');
  const breadLeftCol = breadCol('Left on truck');
  const breadReturnsPctCol = breadCol('Returns %');
  const breadUnsoldPctCol = breadCol('Unsold %');
  const breadStoresCol = breadCol('Stores');
  const L = colLetter;

  // The row written is not `breadHeaders` itself: the load columns carry their
  // date and time under the label. `breadHeaders` stays the plain labels,
  // because `breadCol` finds columns by them.
  const loadHeadings = [
    loadHeading('Initial', loading.initialLoadedAt),
    ...loading.batches.map((_, i) => loadHeading(`Batch ${i + 1}`, loading.batchLoadedAt[i])),
  ];
  breadSheet.addRow([breadHeaders[0], ...loadHeadings, ...breadHeaders.slice(1 + loadHeadings.length)]);
  styleHeaderRow(breadSheet, 1, breadHeaders.length);
  const anyLoadTime = loading.initialLoadedAt !== null || loading.batchLoadedAt.some((at) => at !== null);
  if (anyLoadTime) {
    // Excel doesn't grow a row to fit wrapped text in a file it didn't write,
    // so the three lines need the height set by hand. Every heading is
    // top-aligned so "Bread" and "Sold" line up with "Batch 1" rather than
    // sinking to the bottom of the taller row.
    breadSheet.getRow(1).height = 45;
    for (let col = 1; col <= breadHeaders.length; col++) {
      breadSheet.getCell(1, col).alignment = { vertical: 'top', wrapText: true };
    }
  }

  const breadFirstDataRow = 2;
  breadNames.forEach((name, index) => {
    const row = breadFirstDataRow + index;
    const outcome = outcomeByName.get(name);
    breadSheet.addRow([
      name,
      loading.initial.get(name) ?? 0,
      ...loading.batches.map((batch) => batch.get(name) ?? 0),
      // Loaded adds up the columns beside it, so a load corrected in Excel
      // carries through to Unsold % and the Summary.
      { formula: `SUM(${L(breadInitialCol)}${row}:${L(breadLoadedCol - 1)}${row})` },
      outcome?.sold ?? 0,
      outcome?.returned ?? 0,
      outcome?.remaining ?? 0,
      // Blank rather than 0% when there is nothing to divide by, as in the
      // period workbook: a share of nothing is a question with no answer.
      {
        formula: `IF(${L(breadSoldCol)}${row}>0,${L(breadReturnedCol)}${row}/${L(breadSoldCol)}${row},"")`,
      },
      {
        formula: `IF(${L(breadLoadedCol)}${row}>0,${L(breadLeftCol)}${row}/${L(breadLoadedCol)}${row},"")`,
      },
      storesByName.get(name)?.size ?? 0,
    ]);
    for (let col = breadInitialCol; col <= breadLeftCol; col++) breadSheet.getCell(row, col).numFmt = CountFormat;
    breadSheet.getCell(row, breadReturnsPctCol).numFmt = PercentFormat;
    breadSheet.getCell(row, breadUnsoldPctCol).numFmt = PercentFormat;
    breadSheet.getCell(row, breadStoresCol).numFmt = CountFormat;
  });

  const breadLastDataRow = breadFirstDataRow + breadNames.length - 1;
  let breadTotalRow: number | null = null;
  if (breadNames.length > 0) {
    breadTotalRow = breadLastDataRow + 1;
    // The two percentages and Stores are left blank: an average of averages is
    // not the average, and a shop that took two breads is still one shop.
    const totalRowValues: ExcelJS.CellValue[] = ['Totals'];
    for (let col = breadInitialCol; col <= breadLeftCol; col++) {
      totalRowValues.push({ formula: `SUM(${L(col)}${breadFirstDataRow}:${L(col)}${breadLastDataRow})` });
    }
    breadSheet.addRow(totalRowValues);
    styleTotalRow(breadSheet, breadTotalRow, breadHeaders.length);
    for (let col = breadInitialCol; col <= breadLeftCol; col++) {
      breadSheet.getCell(breadTotalRow, col).numFmt = CountFormat;
    }
  }
  // An empty sheet frames its header row alone rather than boxing in a blank one.
  outlineRange(breadSheet, 1, 1, breadTotalRow ?? 1, breadHeaders.length);
  autoWidth(breadSheet);
  // `autoWidth` measures a heading's whole text, newlines included, so a
  // three-line load heading would size its column as if it were one long line.
  // Measured again here by its longest line.
  for (let col = breadInitialCol; col < breadLoadedCol; col++) {
    const heading = String(breadSheet.getCell(1, col).value ?? '');
    const longestLine = Math.max(...heading.split('\n').map((line) => line.length));
    let width = Math.max(10, longestLine + 2);
    breadSheet.getColumn(col).eachCell({ includeEmpty: false }, (cell, row) => {
      if (row > 1) width = Math.max(width, Math.min(44, (cell.text ?? '').length + 2));
    });
    breadSheet.getColumn(col).width = width;
  }
  // The same footnotes as the period workbook's Bread sheet, word for word
  // (`lib/excel-style.ts`). Written after `autoWidth` so the sentences don't
  // stretch the Bread column, two rows under the frame like every footnote.
  [...UnsoldNotes, BreadStoresNote].forEach((note, index) => {
    const cell = breadSheet.getCell((breadTotalRow ?? 1) + 2 + index, 1);
    cell.value = note;
    cell.font = NoteFont;
  });

  // --- Collected ---
  const collectedRows: [string, number][] = [
    ['Cash', collected.cash],
    ['GCash', collected.gcash],
    ['Cheque', collected.cheque],
    ['Partial — amount owed', collected.partial],
    ['Partial — paid so far', collected.partialPaid],
    ['Credit', collected.credit],
  ];
  collectedSheet.addRow(['Method', 'Amount']);
  styleHeaderRow(collectedSheet, 1, 2);
  collectedRows.forEach(([method, amount], index) => {
    const row = index + 2;
    collectedSheet.addRow([method, amount]);
    collectedSheet.getCell(row, 2).numFmt = MoneyFormat;
  });
  const collectedTotalRow = collectedRows.length + 2;
  collectedSheet.addRow([
    'Cash + GCash + Cheque + Partial paid',
    { formula: `SUM(B2:B4)+B6` },
  ]);
  styleTotalRow(collectedSheet, collectedTotalRow, 2);
  collectedSheet.getCell(collectedTotalRow, 2).numFmt = MoneyFormat;
  outlineRange(collectedSheet, 1, 1, collectedTotalRow, 2);
  autoWidth(collectedSheet);

  // --- Expenses ---
  expensesSheet.addRow(['What for', 'Notes', 'Time', 'Amount']);
  styleHeaderRow(expensesSheet, 1, 4);

  const expenseFirstDataRow = 2;
  liveExpenses.forEach((expense, index) => {
    const row = expenseFirstDataRow + index;
    expensesSheet.addRow([
      expense.title || 'Untitled',
      expense.notes,
      formatBusinessTime(expense.createdAt),
      expense.amount,
    ]);
    expensesSheet.getCell(row, 4).numFmt = MoneyFormat;
  });
  const expenseLastDataRow = Math.max(expenseFirstDataRow, liveExpenses.length + 1);
  let expenseTotalRow: number | null = null;
  if (liveExpenses.length > 0) {
    expenseTotalRow = expenseLastDataRow + 1;
    expensesSheet.addRow([
      'Total spent',
      '',
      '',
      { formula: `SUM(D${expenseFirstDataRow}:D${expenseLastDataRow})` },
    ]);
    styleTotalRow(expensesSheet, expenseTotalRow, 4);
    expensesSheet.getCell(expenseTotalRow, 4).numFmt = MoneyFormat;
  }
  outlineRange(expensesSheet, 1, 1, expenseTotalRow ?? 1, 4);
  autoWidth(expensesSheet);

  // --- Summary ---
  //
  // The one sheet somebody opens without being told what the file is, so it
  // answers three questions: which trip this was, what bread it moved, and
  // what money it made. Every figure below is a formula pointing at the sheet
  // that owns it — the Summary states nothing of its own, so it can never
  // disagree with the tab behind it, and a manager who edits a number in Excel
  // sees this page follow.
  //
  // Two blocks sit side by side at the top (A/B and D/E, with C left empty as
  // the gutter) because they are the same trip described two ways — who was
  // out, and what they moved — and both fit on one screen without scrolling.
  const DetailCol = 1;
  const WorkCol = 4;
  const LastCol = 5;

  function summaryHeader(row: number, col: number, label: string, valueHeader: string) {
    summarySheet.getCell(row, col).value = label;
    summarySheet.getCell(row, col + 1).value = valueHeader;
    styleHeaderRow(summarySheet, row, 2, col);
  }

  function summaryRow(
    row: number,
    col: number,
    label: string,
    value: ExcelJS.CellValue,
    numFmt?: string,
  ): number {
    summarySheet.getCell(row, col).value = label;
    const cell = summarySheet.getCell(row, col + 1);
    cell.value = value;
    if (numFmt) cell.numFmt = numFmt;
    return row + 1;
  }

  function summaryBanner(row: number, text: string, font: Partial<ExcelJS.Font>) {
    summarySheet.getCell(row, 1).value = text;
    summarySheet.getCell(row, 1).font = font;
    summarySheet.mergeCells(row, 1, row, LastCol);
  }

  summaryBanner(1, `${run.agentGroupName || 'Crew'} — ${run.areaName || 'Area'}`, {
    bold: true,
    size: 16,
    color: { argb: InkColor },
  });
  summaryBanner(
    2,
    [
      run.businessDay ? formatBusinessDayLong(run.businessDay) : 'Unknown day',
      run.truckName || 'No truck',
      run.status === 'closed' ? 'Day ended' : 'Still out',
    ].join(' · '),
    { color: { argb: MutedColor } },
  );

  // A run still out when the file was made gets an Info banner straight under
  // the title, before any figure. The workbook is always built from the latest
  // documents the server has — the panel's live rows — so what needs saying is
  // not that the data is old but that it isn't final: receipts can still arrive
  // or be voided. It used to be the last footnote on the page, which is the
  // wrong end for something a reader has to know before trusting the numbers.
  const exportedAt = Date.now();
  const exportedLabel = `${formatBusinessTime(exportedAt)}, ${formatBusinessDayLong(businessDayKey(exportedAt))}`;
  let blockTop = 4;
  if (run.status !== 'closed') {
    infoBanner(
      summarySheet,
      3,
      LastCol,
      `Info: this run was still out when this file was exported — it had not been ended on the phone yet. Every figure here is the latest the server had at ${exportedLabel} (Manila), and may still change.`,
    );
    blockTop = 5;
  }

  // Run details: which trip this file is, in the same words the run panel
  // uses. The crew and its members are two different facts and both are worth
  // stating: the crew is what was assigned, the names are who it held when the
  // truck went out.
  summaryHeader(blockTop, DetailCol, 'Run details', '');
  let detailRow = blockTop + 1;
  detailRow = summaryRow(
    detailRow,
    DetailCol,
    'Business day',
    run.businessDay ? formatBusinessDayLong(run.businessDay) : '—',
  );
  detailRow = summaryRow(detailRow, DetailCol, 'Area', run.areaName || '—');
  detailRow = summaryRow(detailRow, DetailCol, 'Truck', run.truckName || '—');
  detailRow = summaryRow(detailRow, DetailCol, 'Crew', run.agentGroupName || '—');
  detailRow = summaryRow(
    detailRow,
    DetailCol,
    'Agents',
    run.agents.length > 0 ? run.agents.map((agent) => agent.name).join(', ') : '—',
  );
  detailRow = summaryRow(
    detailRow,
    DetailCol,
    'Started',
    run.startedAt ? formatBusinessTime(run.startedAt) : '—',
  );
  detailRow = summaryRow(
    detailRow,
    DetailCol,
    'Ended',
    run.status === 'closed' ? (run.closedAt ? formatBusinessTime(run.closedAt) : '—') : 'Not ended yet',
  );
  detailRow = summaryRow(
    detailRow,
    DetailCol,
    'Time out',
    run.startedAt
      ? run.status === 'closed' && run.closedAt
        ? formatDuration(run.closedAt - run.startedAt)
        : `${formatDuration(Date.now() - run.startedAt)} so far`
      : '—',
  );
  detailRow = summaryRow(detailRow, DetailCol, 'Signed in as', run.createdByEmail || '—');
  detailRow = summaryRow(detailRow, DetailCol, 'Run id', run.id);

  // The day's work: the physical side of the same trip. Loaded minus sold is
  // what is left on the truck; returned bread is a separate figure and the
  // note at the foot says so, because it looks like it should be part of it.
  summaryHeader(blockTop, WorkCol, "The day's work", 'Count');
  let workRow = blockTop + 1;
  // Counted off the Status column, so they follow a status corrected in Excel
  // the same way the money does.
  const statusRef = `Receipts!${statusRange}`;
  workRow = summaryRow(
    workRow,
    WorkCol,
    'Receipts written',
    receipts.length > 0 ? { formula: `COUNTIF(${statusRef},"<>${VoidedStatus}")` } : 0,
    CountFormat,
  );
  workRow = summaryRow(
    workRow,
    WorkCol,
    'Receipts voided',
    receipts.length > 0 ? { formula: `COUNTIF(${statusRef},"${VoidedStatus}")` } : 0,
    CountFormat,
  );
  workRow = summaryRow(workRow, WorkCol, 'Stores billed', totals.storeCount, CountFormat);
  workRow = summaryRow(
    workRow,
    WorkCol,
    'Bread loaded',
    breadTotalRow
      ? { formula: `Bread!${colLetter(breadLoadedCol)}${breadTotalRow}` }
      : outcomeRows.reduce((sum, row) => sum + row.sold + row.remaining, 0),
    CountFormat,
  );
  workRow = summaryRow(
    workRow,
    WorkCol,
    'Bread sold',
    breadTotalRow
      ? { formula: `Bread!${colLetter(breadSoldCol)}${breadTotalRow}` }
      : outcomeRows.reduce((sum, row) => sum + row.sold, 0),
    CountFormat,
  );
  workRow = summaryRow(
    workRow,
    WorkCol,
    'Bread left on the truck',
    breadTotalRow
      ? { formula: `Bread!${colLetter(breadLeftCol)}${breadTotalRow}` }
      : outcomeRows.reduce((sum, row) => sum + row.remaining, 0),
    CountFormat,
  );
  workRow = summaryRow(
    workRow,
    WorkCol,
    'Returned bread',
    breadTotalRow
      ? { formula: `Bread!${colLetter(breadReturnedCol)}${breadTotalRow}` }
      : outcomeRows.reduce((sum, row) => sum + row.returned, 0),
    CountFormat,
  );

  // Money. "Collected" and "Still owed" are the pair the other sheets can't
  // show on their own: net takings is what the stores owe, collected is what
  // actually came back, and the gap between them is the credit and the
  // half-paid receipts somebody has to chase.
  const moneyHeaderRow = Math.max(detailRow, workRow) + 1;
  let moneyRow = moneyHeaderRow;
  summaryHeader(moneyRow, DetailCol, 'Money', 'Amount');
  moneyRow += 1;
  moneyRow = summaryRow(
    moneyRow,
    DetailCol,
    'Sales (gross)',
    receipts.length > 0 ? { formula: `Receipts!E${receiptTotalRow}` } : totals.salesTotal,
    MoneyFormat,
  );
  moneyRow = summaryRow(
    moneyRow,
    DetailCol,
    'Returns credited',
    receipts.length > 0 ? { formula: `Receipts!F${receiptTotalRow}` } : totals.returnsTotal,
    MoneyFormat,
  );
  const netRow = moneyRow;
  moneyRow = summaryRow(
    moneyRow,
    DetailCol,
    'Net takings',
    receipts.length > 0 ? { formula: `Receipts!G${receiptTotalRow}` } : totals.netTotal,
    MoneyFormat,
  );
  styleTotalRow(summarySheet, netRow, 2);
  summarySheet.getCell(netRow, 2).font = { bold: true, color: { argb: 'FF1E40AF' } };

  const collectedRow = moneyRow;
  moneyRow = summaryRow(
    moneyRow,
    DetailCol,
    'Collected (cash, GCash, cheque, partial paid)',
    { formula: `Collected!B${collectedTotalRow}` },
    MoneyFormat,
  );
  moneyRow = summaryRow(
    moneyRow,
    DetailCol,
    'Still owed (credit and unpaid partials)',
    { formula: `B${netRow}-B${collectedRow}` },
    MoneyFormat,
  );
  moneyRow = summaryRow(
    moneyRow,
    DetailCol,
    'Expenses',
    expenseTotalRow ? { formula: `Expenses!D${expenseTotalRow}` } : spend.total,
    MoneyFormat,
  );

  // One frame per section, drawn once all three are laid out. The notes below
  // are deliberately left outside them — they are about the whole sheet, not
  // about any one block.
  outlineRange(summarySheet, blockTop, DetailCol, detailRow - 1, DetailCol + 1);
  outlineRange(summarySheet, blockTop, WorkCol, workRow - 1, WorkCol + 1);
  outlineRange(summarySheet, moneyHeaderRow, DetailCol, moneyRow - 1, DetailCol + 1);

  let noteRow = moneyRow + 1;
  summaryBanner(
    noteRow,
    'Returned bread is credited to the store but never goes back on the truck, so "bread left on the truck" is loaded minus sold.',
    NoteFont,
  );
  noteRow += 1;
  summaryBanner(
    noteRow,
    'Expenses are recorded by the crew as trip notes. They are not deducted from sales or net above.',
    NoteFont,
  );
  noteRow += 1;
  if (totals.voidedCount > 0) {
    summaryBanner(
      noteRow,
      'Voided receipts are still listed on the Receipts sheet but are left out of every total. Their bread went back on the truck when they were voided.',
      NoteFont,
    );
    noteRow += 1;
  }
  summaryBanner(
    noteRow,
    `Exported ${formatBusinessDayLong(businessDayKey(exportedAt))}, ${formatBusinessTime(exportedAt)} (Manila).`,
    NoteFont,
  );

  // Column C is the gutter between the two blocks at the top — nothing is ever
  // written in it. It is wide enough to read as a gap rather than a cell border.
  autoWidth(summarySheet);
  summarySheet.getColumn(1).width = 44;
  summarySheet.getColumn(2).width = 36;
  summarySheet.getColumn(3).width = 12;
  summarySheet.getColumn(4).width = 24;
  summarySheet.getColumn(5).width = 12;

  const trip = input.tripNumber ?? run.sequence;
  const tripSuffix = trip > 1 ? `_trip${trip}` : '';
  const fileName = `${run.businessDay}_${safeFilePart(run.agentGroupName || 'crew', 'run')}${tripSuffix}.xlsx`;

  await downloadWorkbook(workbook, fileName);
}
