import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { formatShare } from '@/lib/runs';

/**
 * The Overview tab's chart kit — inline SVG, no charting library.
 *
 * Five forms cover everything this dashboard plots, so a library would add a
 * few hundred kilobytes to an already-large bundle to draw shapes that are a
 * dozen lines of SVG each. If a fifth is ever needed, add it here rather
 * than reaching for a dependency: the value of one kit is that every chart on
 * the page obeys the same mark specs.
 *
 * **The form is chosen by the job.** Columns for magnitude across an ordered
 * axis, horizontal bars for magnitude across named categories, split bars
 * where one of those magnitudes is part of the other, lines for change over
 * time (curved, for a few series over a handful of weeks or months), a donut
 * for a few parts of one whole.
 *
 * A treemap, a dot plot and a weekday heatmap were built here in August 2026
 * and taken out again the same day: the owner's word was "ugly", and a chart
 * the person who reads it every morning doesn't want to look at is not a
 * better chart however well it maps to the data. **Don't reintroduce them
 * without being asked.** A dot timeline of store deliveries was tried again
 * in September 2026 and got the same verdict — dots are out. The lesson kept from the exercise is the one about
 * the *data*, not the drawing — bread is compared by loaves, and sold and
 * returned belong in one chart rather than two.
 *
 * Those specs are fixed and not per-chart taste:
 *
 * - **Bars and columns cap at 24px** and never fill their slot — the leftover
 *   is air. Data-ends are rounded 4px, square at the baseline.
 * - **Lines are 2px**, round join and cap; markers are ≥8px across and carry a
 *   2px ring in the surface colour so they stay legible where they cross.
 * - **Gridlines are solid hairlines** one step off the surface. Never dashed:
 *   dashing reads as "projection" or "threshold" when it is just a grid.
 * - **Never a number on every point.** The endpoint, the extreme, or nothing —
 *   the axis, the tooltip and the table view carry the rest.
 * - **Text never wears the series colour.** A light hue is illegible as text;
 *   identity comes from the coloured swatch beside the label.
 *
 * Every chart ships a **table view** (`ChartCard`'s toggle). That is not a nice
 * extra: three of the six series colours sit below 3:1 contrast on white, which
 * is legal only where the values are also reachable without colour.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * The categorical series colours, in fixed order.
 *
 * Validated as a set on a white surface — worst adjacent pair ΔE 9.1 under
 * simulated protanopia (target ≥ 8) and 19.6 to normal vision (floor 15). The
 * **order is the safety mechanism**, not decoration: re-ordering or inserting a
 * hue invalidates the result. Assign by slot and never cycle — a seventh series
 * folds into "Other" rather than getting a generated colour.
 *
 * Note these are *not* the page's navy accent. Navy sits at OKLCH L 0.42, below
 * the 0.43 floor a series colour has to clear to stay legible as a thin mark,
 * so it stays what it already is — chrome for links, pills and headings — while
 * the plotted marks use the validated set.
 */
export const SeriesColors = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
] as const;

/** Sequential blue, light → dark. One hue: magnitude is the job, identity isn't. */
export const SequentialStrong = '#2a78d6';
/** A lighter step of the same ramp, for a bar whose period hasn't finished yet. */
export const SequentialSoft = '#86b6ef';

const Grid = '#e4e8ee';
const Axis = '#cbd5e1';
const Surface = '#ffffff';

export function seriesColor(index: number): string {
  return SeriesColors[index % SeriesColors.length];
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * The frame every chart sits in: a title, an optional note, the plot, and a
 * toggle to the same numbers as a table.
 *
 * The toggle is required rather than offered. A tooltip must never be the only
 * way to read a value, and several of the series colours are deliberately below
 * the contrast a reader could rely on alone.
 */
export function ChartCard({
  title,
  note,
  table,
  fullTable = false,
  footer,
  children,
}: {
  title: string;
  note?: ReactNode;
  table: ReactNode;
  /**
   * Let the table run to its full height instead of scrolling inside the card.
   *
   * The cap earns its place where a table is a long tail nobody reads to the
   * end of — ninety days of takings. It is wrong where the table *is* the
   * list, and a scrollbox inside a page that already scrolls is a well-known
   * way to hide the rows below the fold from a reader who never guesses they
   * are there.
   */
  fullTable?: boolean;
  /**
   * The sentence under the plot that states the totals — shown under *both*
   * views, which is why it is a prop rather than the last child of the chart.
   *
   * It is not a caption for the drawing, it is what the card as a whole adds
   * up to, and a reader who switched to the table did not ask to stop being
   * told. Rendered as a direct child of the card so `.ops-chart-card >
   * .ops-chart-note` gives it its own air, and outside the table's scroll box
   * so it can't scroll away sideways with a wide table.
   */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);

  return (
    <section className="ops-chart-card">
      <header className="ops-chart-head">
        <div>
          <h3>{title}</h3>
          {note && <p className="ops-chart-note">{note}</p>}
        </div>
        <button type="button" className="ops-chart-toggle" onClick={() => setShowTable((on) => !on)}>
          {showTable ? 'Chart' : 'Table'}
        </button>
      </header>
      {showTable ? (
        <div className={fullTable ? 'ops-chart-table ops-chart-table-full' : 'ops-chart-table'}>{table}</div>
      ) : (
        children
      )}
      {footer}
    </section>
  );
}

/** The identity channel that doesn't depend on telling two hues apart. */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="ops-legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className="ops-legend-key" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function ChartEmpty({ children }: { children: ReactNode }) {
  return <div className="ops-chart-empty">{children}</div>;
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

/**
 * The plot's width in real CSS pixels, measured.
 *
 * Load-bearing, not a refinement. The obvious way to make an SVG chart
 * responsive — a fixed `viewBox` with `width: 100%` — scales *everything* with
 * the box: a 2px line becomes 3px in a wide card and 1px in a narrow drawer, a
 * 24px bar cap becomes 38px, and 11px axis text becomes either 17px or 7px.
 * Every mark spec in this file would then mean something different per card.
 *
 * So the viewBox is set to the measured pixel width instead, making one SVG
 * unit exactly one pixel everywhere. 720 is only the width used for the first
 * paint, before the observer has measured anything.
 */
function usePlotWidth(ref: React.RefObject<HTMLDivElement | null>, fallback = 720): number {
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured && measured > 0) setWidth(Math.round(measured));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/**
 * The width below which a plot is drawn with tighter margins.
 *
 * The pads below are sized for a card on a desktop, where 52px of y-axis
 * gutter and 76px of end-label room are a small fraction of the plot. In a
 * 330px-wide card on a phone they are more than a third of it, and the line
 * chart's remaining 200px has to carry a week of days. Nothing about the marks
 * changes — bars stay capped at 24px, lines stay 2px (see usePlotWidth) — only
 * the space reserved around them.
 */
const NarrowPlot = 460;

/**
 * The gutter the y-axis labels need. Compact money tops out at "₱9.9M", which
 * fits in 40px at 11px type — 52 is comfort, not requirement, so a narrow plot
 * spends the difference on the data instead.
 */
function axisGutter(width: number): number {
  return width < NarrowPlot ? 40 : 52;
}

/**
 * A y-axis that stops on a number a person would have chosen — 0 / 5,000 /
 * 10,000, never 0 / 4,317 / 8,634. The ticks carry every value that isn't
 * directly labelled, so they have to be readable at a glance.
 */
function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return ticks;
}

/** Axis ticks are short by necessity — a full peso amount every 4 rows is noise. */
export function compactMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `₱${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `₱${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `₱${Math.round(value)}`;
}

// ---------------------------------------------------------------------------
// Columns — magnitude across an ordered axis (days)
// ---------------------------------------------------------------------------

export type Column = {
  key: string;
  /** The x-axis tick. Thinned automatically when there are too many to fit. */
  label: string;
  value: number;
  /** True for a period still in progress — drawn in a lighter step of the same hue. */
  partial?: boolean;
  /** Everything the tooltip should say beyond the value. */
  detail?: string;
};

export function ColumnChart({
  columns,
  height = 200,
  format = compactMoney,
  formatFull,
}: {
  columns: Column[];
  height?: number;
  format?: (value: number) => string;
  formatFull: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const width = usePlotWidth(frame);
  const pad = { top: 12, right: 12, bottom: 26, left: axisGutter(width) };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const ticks = niceTicks(Math.max(0, ...columns.map((c) => c.value)));
  const top = ticks[ticks.length - 1];
  const y = (value: number) => pad.top + plotH - (value / top) * plotH;

  const band = plotW / Math.max(columns.length, 1);
  // Capped rather than "fill the band" — a 60px-wide block reads loud, and the
  // leftover space is what makes a dense chart legible.
  const barW = Math.min(24, Math.max(3, band - 6));

  // Only as many x-labels as fit without colliding. The rest are in the tooltip
  // and the table; a clipped or overlapping tick is worse than an absent one.
  // The divisor is how many labels the plot has room for, which is a function
  // of its width — twelve "Aug 4"s need about 620px and overlap into mush
  // below that.
  const labelEvery = Math.max(1, Math.ceil(columns.length / Math.max(3, Math.floor(plotW / 52))));

  return (
    <div className="ops-plot" ref={frame}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="ops-svg" role="img">
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? Axis : Grid}
              strokeWidth={1}
            />
            <text x={pad.left - 8} y={y(tick) + 4} textAnchor="end" className="ops-axis-text">
              {format(tick)}
            </text>
          </g>
        ))}

        {columns.map((column, index) => {
          const cx = pad.left + band * index + band / 2;
          const barH = Math.max(column.value > 0 ? 2 : 0, y(0) - y(column.value));
          return (
            <g key={column.key}>
              {/* A hit target the width of the whole band, so a 3px column on a
                  90-day chart is still reachable with a mouse. */}
              <rect
                x={pad.left + band * index}
                y={pad.top}
                width={band}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover((current) => (current === index ? null : current))}
              />
              <rect
                x={cx - barW / 2}
                y={y(column.value)}
                width={barW}
                height={barH}
                rx={Math.min(4, barW / 2)}
                fill={column.partial ? SequentialSoft : SequentialStrong}
                opacity={hover === null || hover === index ? 1 : 0.45}
                pointerEvents="none"
              />
              {index % labelEvery === 0 && (
                <text x={cx} y={height - 8} textAnchor="middle" className="ops-axis-text" pointerEvents="none">
                  {column.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hover !== null && columns[hover] && (
        <Tooltip
          left={((pad.left + band * hover + band / 2) / width) * 100}
          title={columns[hover].label}
          rows={[
            {
              label: formatFull(columns[hover].value),
              color: columns[hover].partial ? SequentialSoft : SequentialStrong,
            },
          ]}
          detail={columns[hover].detail}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars — magnitude across named categories
// ---------------------------------------------------------------------------

export function BarChart({
  rows,
  formatFull,
}: {
  /** `detail` is optional per-row context — a quantity, a count — shown on hover, next to the value. */
  rows: { key: string; label: string; value: number; detail?: string }[];
  formatFull: (value: number) => string;
}) {
  // Tracks the pointer's position within whichever row it's over, not just
  // which row — the detail follows the cursor rather than sitting pinned at
  // the bar's end, so it reads next to whatever part of the bar you're
  // actually looking at.
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const max = Math.max(1, ...rows.map((row) => row.value));

  // Laid out in HTML rather than SVG: the category names are long and variable,
  // and letting the browser do the text layout is what keeps a label from ever
  // being clipped by its own bar.
  return (
    <div className="ops-barchart">
      {rows.map((row) => (
        <div
          key={row.key}
          className="ops-barchart-row"
          onMouseMove={(event) => {
            if (!row.detail) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setHover({ key: row.key, x: event.clientX - rect.left, y: event.clientY - rect.top });
          }}
          onMouseLeave={() => setHover((current) => (current?.key === row.key ? null : current))}>
          <span className="ops-barchart-label" title={row.label}>
            {row.label}
          </span>
          <span className="ops-barchart-track">
            <span
              className="ops-barchart-fill"
              style={{ width: `${Math.max(1, (row.value / max) * 100)}%`, background: SequentialStrong }}
            />
          </span>
          {/* At the tip, always — one value per bar is the whole point of the form.
              The detail — a quantity the value alone doesn't say — only on hover,
              so it never competes with the value for the reader's first look. */}
          <span className="ops-barchart-value">{formatFull(row.value)}</span>
          {hover?.key === row.key && row.detail && (
            <span className="ops-barchart-tip" style={{ left: hover.x, top: hover.y }}>
              {row.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split bars — one quantity per category, divided into its parts
// ---------------------------------------------------------------------------

/**
 * A horizontal bar per category, laid down in coloured segments, with every
 * segment's own figure in a column of its own at the end of the row.
 *
 * The form to reach for when two measures are **the same unit and belong to the
 * same category** — the loaves a bread sold and the loaves of it that came
 * back. Two separate charts can only be compared by holding one in your head
 * while reading the other, and the smaller of the two says nothing at all on
 * its own scale. One row puts them side by side at the size they really are.
 *
 * **Every segment drawn has its number printed**, under a heading carrying that
 * segment's colour, and `extras` adds further columns for figures that have no
 * mark on the bar — a count, or an already-formatted share, that belongs beside
 * the quantities without being one of them. Their headings carry no swatch,
 * which is what says they aren't in the picture to the left. The columns
 * themselves are unruled — a vertical grid inside a chart makes it look like
 * neither chart nor table — but **the rows are separated by the same hairline
 * the table view draws**, because a name on the left and its figures 500px away
 * on the right are only reliably on one line if a line says so.
 *
 * **It is built to sit exactly where its table view sits.** Row padding, rule
 * and heading metrics mirror `.ops-table-even` (see overview.css), so toggling
 * ChartCard between the two swaps the bars for the missing column and moves
 * nothing else: the same bread stays on the same line at the same height, and
 * every figure column stays at the same x. That only holds if the caller gives
 * the two views the same columns in the same order, `leadLabel` included.
 *
 * **It has no hover of its own, deliberately.** Every figure it holds is
 * already on the row, so a tooltip could only repeat them — and a mark that
 * lights up under the pointer promises something more when it is clicked.
 * `BarChart` above keeps its hover because a bar there carries a quantity its
 * peso value doesn't say; here there is nothing left over to tell.
 */
export function SplitBarChart({
  rows,
  series,
  extras = [],
  leadLabel,
  format,
  onSelect,
}: {
  /**
   * `values` lines up with `series` and `extras` with `extras`, index for
   * index — one column each, the first group also a segment of the bar.
   *
   * An `extras` entry may be a string, which is printed as it stands. `format`
   * is one function for the whole chart and the segments' unit is the chart's
   * unit; a column that is a *share* of them has already been formatted by the
   * caller, and passing it through a loaf formatter would print "0".
   */
  rows: { key: string; label: string; values: number[]; extras?: (number | string)[] }[];
  /** One per segment: the colour it is drawn in, and the word that heads its column. */
  series: { label: string; color: string }[];
  /** Columns with a figure but no mark — headed by a word alone. */
  extras?: { label: string }[];
  /**
   * What to head the name column with — the table view's first heading, so the
   * header row is the same row in both views. Left off, the cell is empty.
   */
  leadLabel?: string;
  format: (value: number) => string;
  /**
   * Makes every row openable, and is what earns this chart a hover state.
   *
   * The rule this reverses is written down in `apps/web/CLAUDE.md`: with both
   * figures already printed on the row there was nothing left for a tooltip to
   * say, and a row that lit up under the pointer would have promised something
   * more if it were clicked. Passing this *is* that something more, so the
   * highlight becomes a truthful signal rather than a misleading one — and
   * without it the chart stays exactly as it was, unlit and inert.
   *
   * A row becomes a real `<button>` when this is given, not a div with a
   * click handler: it is a control, and the keyboard has to reach it. The
   * grid that lays the row out is declared on the class, not on the element,
   * so the swap costs the layout nothing.
   */
  onSelect?: (key: string) => void;
}) {
  const max = Math.max(1, ...rows.map((row) => row.values.reduce((sum, value) => sum + value, 0)));

  // The number columns are sized from the series count, which the CSS reads as
  // a custom property so a media query can still narrow them on a phone —
  // an inline `grid-template-columns` would win over one and can't.
  const frame = { '--splitbar-count': series.length + extras.length } as React.CSSProperties;

  // Laid out in HTML rather than SVG for the same reason BarChart is: the
  // category names are long and variable, and letting the browser measure the
  // text is what keeps a label from ever being clipped by its own bar.
  return (
    <div className="ops-barchart ops-splitbar" style={frame}>
      {/* The heading is the legend: the swatch sits directly over the column of
          figures it belongs to, so which number is which is answered where the
          numbers are rather than in a key somewhere below them. */}
      <div className="ops-splitbar-head">
        <span className="ops-splitbar-gap">{leadLabel}</span>
        {series.map((slot) => (
          <span key={slot.label}>
            <i className="ops-legend-key" style={{ background: slot.color }} />
            {slot.label}
          </span>
        ))}
        {extras.map((column) => (
          <span key={column.label}>{column.label}</span>
        ))}
      </div>

      {rows.map((row) => {
        // Which segments actually get drawn, so the rounded ends land on the
        // real ends of the bar and a zero segment doesn't leave a stray gap.
        const drawn = row.values
          .map((value, slot) => ({ value, slot }))
          .filter((segment) => segment.value > 0);

        const Row = onSelect ? 'button' : 'div';

        return (
          <Row
            key={row.key}
            className="ops-barchart-row"
            {...(onSelect
              ? { type: 'button' as const, onClick: () => onSelect(row.key), 'aria-label': `${row.label} — see the detail` }
              : {})}>
            <span className="ops-barchart-label" title={row.label}>
              {row.label}
            </span>
            <span className="ops-barchart-track ops-barchart-split">
              {drawn.map((segment, position) => (
                <span
                  key={series[segment.slot].label}
                  className="ops-barchart-fill"
                  style={{
                    // Floored so a segment that exists is always visible: three
                    // loaves back out of four hundred rounds to nothing on this
                    // scale, and drawing nothing says none came back. The exact
                    // figure is in the column either way.
                    width: `${Math.max(0.4, (segment.value / max) * 100)}%`,
                    background: series[segment.slot].color,
                    // Square where it meets its neighbour, rounded at the two
                    // ends of the bar — one bar, not a row of blocks.
                    borderRadius: `${position === 0 ? '3px' : '0'} ${position === drawn.length - 1 ? '4px' : '0'} ${position === drawn.length - 1 ? '4px' : '0'} ${position === 0 ? '3px' : '0'}`,
                  }}
                />
              ))}
            </span>
            {/* First column is the row's headline figure and stays in full ink;
                the rest step back a shade. Same information, an order to read
                it in — and no rule drawn between them to do that job. */}
            {[...row.values, ...(row.extras ?? [])].map((value, slot) => (
              <span
                key={(series[slot] ?? extras[slot - series.length]).label}
                className={slot === 0 ? 'ops-barchart-value' : 'ops-barchart-value ops-barchart-value-soft'}>
                {typeof value === 'number' ? format(value) : value}
              </span>
            ))}
          </Row>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut — parts of one whole
// ---------------------------------------------------------------------------

/**
 * A ring cut into a handful of slices, with the whole in the middle and a key
 * beside it that prints every slice's figure and share.
 *
 * The form for **a few named parts of one total** — how much of all store
 * takings the biggest stores account for. Keep it to five or six slices plus
 * one grey "everyone else": past that the thin slices can't be told apart, and
 * the job belongs to a table.
 *
 * The key is not optional decoration: slice colours are the series palette,
 * several of which fall below 3:1, so every value has to be readable as text.
 * Hovering a slice or its key row lights it and puts its figures in the
 * centre.
 */
export function DonutChart({
  slices,
  centerLabel,
  formatFull,
}: {
  slices: { key: string; label: string; value: number; color: string }[];
  /** Under the total in the middle — what the whole is. */
  centerLabel: string;
  formatFull: (value: number) => string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const size = 208;
  const thickness = 30;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const drawn = slices.filter((slice) => slice.value > 0);
  const total = drawn.reduce((sum, slice) => sum + slice.value, 0);
  // A hairline of surface between slices, so neighbours stay two marks.
  const gap = drawn.length > 1 ? 2 : 0;
  const active = drawn.find((slice) => slice.key === hover) ?? null;

  let start = 0;
  const arcs = drawn.map((slice) => {
    const length = total > 0 ? (slice.value / total) * circumference : 0;
    const arc = { slice, offset: start, length: Math.max(0.5, length - gap) };
    start += length;
    return arc;
  });

  const share = (value: number) => (total > 0 ? formatShare(value / total) : '—');

  return (
    <div className="ops-donut">
      <div className="ops-donut-ring">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={Grid} strokeWidth={thickness} />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {arcs.map(({ slice, offset, length }) => (
              <circle
                key={slice.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth={hover === slice.key ? thickness + 6 : thickness}
                strokeDasharray={`${length} ${circumference}`}
                strokeDashoffset={-offset}
                opacity={hover === null || hover === slice.key ? 1 : 0.35}
                onMouseEnter={() => setHover(slice.key)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </g>
        </svg>
        <div className="ops-donut-center">
          <strong>{formatFull(active ? active.value : total)}</strong>
          <span>{active ? `${active.label} · ${share(active.value)}` : centerLabel}</span>
        </div>
      </div>

      <ul className="ops-donut-key">
        {slices.map((slice) => (
          <li
            key={slice.key}
            className={hover !== null && hover !== slice.key ? 'ops-donut-key-dim' : undefined}
            onMouseEnter={() => setHover(slice.key)}
            onMouseLeave={() => setHover(null)}>
            <i className="ops-legend-key" style={{ background: slice.color }} />
            <span className="ops-donut-key-name" title={slice.label}>
              {slice.label}
            </span>
            <b>{formatFull(slice.value)}</b>
            <span className="ops-donut-key-share">{share(slice.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}



// ---------------------------------------------------------------------------
// Lines — change over time, several series at once
// ---------------------------------------------------------------------------

export type Series = {
  id: string;
  name: string;
  color: string;
  /** One value per x slot, `null` where the series has nothing yet. */
  values: (number | null)[];
};

/**
 * A smooth path through the points that **never overshoots them** — monotone
 * cubic interpolation (Fritsch–Carlson). An ordinary spline bulges past its
 * points, so a store that bought ₱0 one week and ₱900 the next would be drawn
 * dipping below zero between them: a curve that invents money. This one only
 * rounds the corners. Returns one `C` command per gap between points, so a
 * caller can draw the last one on its own (see `partialLast`).
 */
function monotoneSegments(points: [number, number][]): string[] {
  const n = points.length;
  if (n < 2) return [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    slopes.push((points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]));
  }
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === n - 1) return slopes[n - 2];
    return slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  });
  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangents[i] = t * a * slopes[i];
      tangents[i + 1] = t * b * slopes[i];
    }
  }
  return slopes.map((_, i) => {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const d = (x1 - x0) / 3;
    return `C ${x0 + d},${y0 + tangents[i] * d} ${x1 - d},${y1 - tangents[i + 1] * d} ${x1},${y1}`;
  });
}

export function LineChart({
  series,
  labels,
  height = 220,
  format = compactMoney,
  formatFull,
  curved = false,
  partialLast = false,
}: {
  series: Series[];
  /** One x-axis label per slot. */
  labels: string[];
  height?: number;
  /** Round the corners (`monotoneSegments`) — for a handful of points, where straight joins look jagged. */
  curved?: boolean;
  /**
   * The last slot is a period still running ("this week so far"). Its segment
   * is drawn dashed — the one place this kit dashes a line, because here
   * "not final yet" is exactly what dashing means — so a half-finished week
   * doesn't read as a store collapsing.
   */
  partialLast?: boolean;
  format?: (value: number) => string;
  formatFull: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const width = usePlotWidth(frame);
  const clipId = useId();

  // `right` is the room the end-of-line series labels live in. It is the
  // biggest single cost on a narrow plot, so below NarrowPlot the labels are
  // dropped (`showEndLabels`) and that space goes back to the data. Nothing
  // becomes unidentifiable by it: the hover tooltip names every series, the
  // table view every chart is required to ship (ChartCard) lists them all, and
  // a caller that wants standing identity renders <Legend> under the plot.
  const showEndLabels = width >= NarrowPlot;
  const pad = { top: 14, right: showEndLabels ? 76 : 14, bottom: 26, left: axisGutter(width) };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const flat = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.max(0, ...flat));
  const top = ticks[ticks.length - 1];

  const x = (index: number) => pad.left + (labels.length <= 1 ? 0 : (plotW * index) / (labels.length - 1));
  const y = (value: number) => pad.top + plotH - (value / top) * plotH;

  const labelEvery = Math.max(1, Math.ceil(labels.length / Math.max(3, Math.floor(plotW / 56))));

  function onMove(event: React.MouseEvent<HTMLDivElement>) {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    // One SVG unit is one CSS pixel (see usePlotWidth), so the offset into the
    // box is the x coordinate directly — no viewBox scaling to undo.
    const offset = event.clientX - box.left - pad.left;
    const index = Math.round(offset / (plotW / Math.max(labels.length - 1, 1)));
    setHover(Math.max(0, Math.min(labels.length - 1, index)));
  }

  return (
    <div className="ops-plot" ref={frame} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="ops-svg" role="img">
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.left} y={0} width={plotW + pad.right} height={height} />
          </clipPath>
        </defs>

        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? Axis : Grid}
              strokeWidth={1}
            />
            <text x={pad.left - 8} y={y(tick) + 4} textAnchor="end" className="ops-axis-text">
              {format(tick)}
            </text>
          </g>
        ))}

        {labels.map((label, index) =>
          index % labelEvery === 0 ? (
            <text key={label + index} x={x(index)} y={height - 8} textAnchor="middle" className="ops-axis-text">
              {label}
            </text>
          ) : null,
        )}

        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} stroke={Axis} strokeWidth={1} />
        )}

        <g clipPath={`url(#${clipId})`}>
          {series.map((s) => {
            const points = s.values
              .map((value, index) => (value === null ? null : `${x(index)},${y(value)}`))
              .filter((point): point is string => point !== null);
            if (points.length === 0) return null;

            const lastIndex = s.values.reduce<number>((last, value, index) => (value === null ? last : index), -1);
            const lastValue = lastIndex >= 0 ? s.values[lastIndex] : null;
            const hoverValue = hover === null ? null : (s.values[hover] ?? null);

            return (
              <g key={s.id}>
                {curved || partialLast ? (
                  (() => {
                    const coords = s.values
                      .map((value, index) => (value === null ? null : ([x(index), y(value)] as [number, number])))
                      .filter((point): point is [number, number] => point !== null);
                    const segments = curved
                      ? monotoneSegments(coords)
                      : coords.slice(1).map(([px, py]) => `L ${px},${py}`);
                    const dashLast = partialLast && lastIndex === labels.length - 1 && segments.length > 0;
                    const solid = dashLast ? segments.slice(0, -1) : segments;
                    const common = {
                      fill: 'none',
                      stroke: s.color,
                      strokeWidth: 2,
                      strokeLinejoin: 'round' as const,
                      strokeLinecap: 'round' as const,
                    };
                    return (
                      <>
                        {solid.length > 0 && <path d={`M ${coords[0][0]},${coords[0][1]} ${solid.join(' ')}`} {...common} />}
                        {dashLast && (
                          <path
                            d={`M ${coords[coords.length - 2][0]},${coords[coords.length - 2][1]} ${segments[segments.length - 1]}`}
                            {...common}
                            strokeDasharray="5 5"
                          />
                        )}
                      </>
                    );
                  })()
                ) : (
                  <polyline
                    points={points.join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                {lastValue !== null && (
                  <>
                    {/* Ring in the surface colour, so two series ending close
                        together stay two marks rather than one blob. */}
                    <circle cx={x(lastIndex)} cy={y(lastValue)} r={5} fill={s.color} stroke={Surface} strokeWidth={2} />
                    {/* The end label — the one direct label this form gets.
                        Ink, never the series colour: several of these hues are
                        illegible as text. Dropped on a narrow plot, where the
                        room it needs is worth more to the line itself. */}
                    {showEndLabels && (
                      <text x={x(lastIndex) + 10} y={y(lastValue) + 4} className="ops-line-label">
                        {s.name}
                      </text>
                    )}
                  </>
                )}
                {hover !== null && hoverValue !== null && (
                  <circle cx={x(hover)} cy={y(hoverValue)} r={4} fill={s.color} stroke={Surface} strokeWidth={2} />
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {hover !== null && (
        <Tooltip
          left={(x(hover) / width) * 100}
          title={labels[hover]}
          rows={series
            .filter((s) => s.values[hover] !== null && s.values[hover] !== undefined)
            .map((s) => ({ label: `${s.name} · ${formatFull(s.values[hover] as number)}`, color: s.color }))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

/**
 * Positioned as a percentage of the plot's width and flipped past the midpoint,
 * so it never runs off the card. It enhances, it never gates: everything in it
 * is also in the table view.
 */
function Tooltip({
  left,
  title,
  rows,
  detail,
}: {
  left: number;
  title: string;
  rows: { label: string; color: string }[];
  detail?: string;
}) {
  const flip = left > 55;
  return (
    <div
      className="ops-tooltip"
      style={{
        left: `${left}%`,
        transform: flip ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
      }}>
      <strong>{title}</strong>
      {rows.map((row) => (
        <span key={row.label}>
          <i className="ops-legend-key" style={{ background: row.color }} />
          {row.label}
        </span>
      ))}
      {detail && <em>{detail}</em>}
    </div>
  );
}
