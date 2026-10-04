import { useEffect, useMemo, useState } from 'react';

import { DateRangePicker } from '@/components/date-range-picker';
import { currentBusinessDayKey, formatBusinessDayLong, shiftBusinessDay } from '@/lib/business-day';
import type { BreadType } from '@/lib/bread-types';
import {
  clampRangeEnd,
  daySpan,
  formatDateRangeLabel,
  monthRange,
  recentDayOptions,
  recentMonthOptions,
  startOfWeek,
  WeekOptionLabels,
} from '@/lib/day-ranges';
import type { NamedRecord } from '@/lib/named-records';
import {
  buildPeriodSummary,
  countRunsInRange,
  MaxRunsPerExport,
  SlowRunCount,
  type PeriodProgress,
} from '@/lib/period-summary';
import type { ReturnedBreadType } from '@/lib/returned-bread-types';
import { formatCount } from '@/lib/runs';

/**
 * "Export a summary" — the Live tab's period workbook, from the day on screen
 * outwards.
 *
 * **Why it lives on Live and not on Trends.** Trends is where a period is
 * *looked at*; Live is where the day is *worked*, and "give me the paperwork
 * for this month, or for today" is asked from the board somebody already has
 * open. Trends keeps its own range for its own charts; this dialog never
 * touches it, and neither steers the other.
 *
 * **The range control is the Trends tab's, deliberately.** Same units in the
 * same order — Month, Week, Day, Year, Custom — the same four week labels out
 * of `lib/day-ranges.ts`, the same Custom picker, and the same rule that an
 * unfinished period stops at today. One way of saying "these days" across the
 * dashboard, rather than a second idiom that has to be learned because it
 * happens to live in a dialog.
 *
 * **Every option is measured from today, never from the day the board is
 * showing.** This dialog takes no `day` prop for that reason. Anchoring the
 * lists to the board's day was the first version and the owner corrected it:
 * "This week" cannot mean two different weeks depending on where somebody had
 * navigated to, and a workbook asked for "this month" while reading back
 * through March must not quietly come out as March.
 *
 * **Why a dialog rather than a range picker in the day bar.** The Live tab is
 * one day, deliberately and all the way down — the heading, the ‹ Today ›
 * buttons, the calendar, the notices. A second, wider range sitting permanently
 * beside them would leave the reader working out which control the figures on
 * screen belong to. Behind a button, a range exists only while the export is
 * being set up and then goes away again.
 *
 * **The run count is fetched before the reader commits.** One indexed query
 * says "23 runs across 7 days" next to the Export button, so the size of what
 * they are asking for is on screen beforehand rather than discovered halfway
 * through a progress bar — and a range too big to gather in one go is refused
 * *here*, where the fix is one click on a shorter preset.
 */

type RangeType = 'month' | 'week' | 'day' | 'year' | 'custom';

/**
 * How far back the Day and Month dropdowns reach, today included. The same
 * counts the Trends tab uses, for the same reason: the cost of an option
 * nobody picks is one line in a list.
 *
 * Week has no count of its own — it offers exactly the four `WeekOptionLabels`
 * out of `lib/day-ranges.ts`, which is what keeps "2 weeks ago" meaning the
 * same week in both places.
 */
const DayOptionCount = 14;
const MonthOptionCount = 24;
const YearOptionCount = 6;

export function PeriodExportDialog({
  trucks,
  breadTypes,
  returnedBreadTypes,
  onClose,
}: {
  /** The trucks, for ordering the workbook's truck rows the way the dashboard lists them. */
  trucks: NamedRecord[];
  breadTypes: BreadType[];
  returnedBreadTypes: ReturnedBreadType[];
  onClose: () => void;
}) {
  const today = currentBusinessDayKey();

  // A type plus whichever value that type is currently showing — the Trends
  // tab's range control exactly, and for the same reason: there is no state
  // here that lets a "from" and a "to" drift apart from what the dropdowns
  // say, so every option but Custom always lands on a real calendar boundary.
  // Switching the type keeps the other selections, so flicking between Week
  // and Month and back loses nothing.
  //
  // **Month is the default**, not the day: a workbook is usually asked for a
  // period, and the one-day case is a click away in the dropdown beside it.
  const [rangeType, setRangeType] = useState<RangeType>('month');
  const [monthValue, setMonthValue] = useState(() => currentBusinessDayKey().slice(0, 7));
  const [weekOffset, setWeekOffset] = useState(0);
  const [dayValue, setDayValue] = useState(() => currentBusinessDayKey());
  const [yearValue, setYearValue] = useState(() => Number(currentBusinessDayKey().slice(0, 4)));
  // Custom starts with nothing picked, exactly as the Trends tab's does: no
  // default window and no guessed range. Choosing "Custom" offers the picker;
  // until *two* dates are applied there is nothing to export, and saying so is
  // better than silently substituting a month.
  const [customFrom, setCustomFrom] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState<string | null>(null);

  // **Every option is measured from today, never from the day the Live board
  // happens to be showing** — the owner's call, and the reason this dialog no
  // longer takes a `day` prop at all. Anchoring to the board's day made "This
  // week" mean two different weeks depending on where somebody had navigated
  // to, which is exactly the ambiguity a labelled dropdown is supposed to
  // remove. Reaching back is what the dropdowns are *for*; the day bar behind
  // them does not steer them.
  const monthOptions = useMemo(() => recentMonthOptions(today, MonthOptionCount), [today]);
  const dayOptions = useMemo(() => recentDayOptions(today, DayOptionCount), [today]);
  const yearOptions = useMemo(() => {
    const currentYear = Number(today.slice(0, 4));
    return Array.from({ length: YearOptionCount }, (_, i) => currentYear - i);
  }, [today]);

  const [runCount, setRunCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [countError, setCountError] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<PeriodProgress>({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  // A month or a week that runs past today is cut off there rather than padded
  // out with days that cannot hold a run — "September" on the 3rd means the
  // 1st to the 3rd, the same rule the Trends tab applies to its own ranges.
  //
  // `null` only ever happens for Custom before both dates have been applied.
  // Everything downstream treats that as "nothing to export yet": the readout
  // says which dates are missing and the Export button stays disabled.
  const range = useMemo((): { from: string; to: string } | null => {
    if (rangeType === 'month') {
      const [year, month] = monthValue.split('-').map(Number);
      return clampRangeEnd(monthRange(year, month), today);
    }
    if (rangeType === 'week') {
      const start = startOfWeek(shiftBusinessDay(today, -7 * weekOffset));
      return clampRangeEnd({ from: start, to: shiftBusinessDay(start, 6) }, today);
    }
    if (rangeType === 'day') return { from: dayValue, to: dayValue };
    if (rangeType === 'year') return clampRangeEnd({ from: `${yearValue}-01-01`, to: `${yearValue}-12-31` }, today);
    // Already clamped to `today` by the picker's own `max` — no cap needed here.
    return customFrom && customTo ? { from: customFrom, to: customTo } : null;
  }, [rangeType, monthValue, weekOffset, dayValue, yearValue, today, customFrom, customTo]);

  useEffect(() => {
    if (!range) {
      setRunCount(null);
      return;
    }
    let cancelled = false;
    setCounting(true);
    setCountError(false);
    void (async () => {
      try {
        const count = await countRunsInRange(range.from, range.to);
        if (!cancelled) setRunCount(count);
      } catch {
        // Not fatal: the count is a courtesy, and Export still works without
        // it — the same cap is enforced again inside `buildPeriodSummary`.
        if (!cancelled) {
          setRunCount(null);
          setCountError(true);
        }
      } finally {
        if (!cancelled) setCounting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  // Escape closes, like every other overlay on this page — but not while the
  // workbook is being built, because there is nothing to go back to and the
  // reads would carry on regardless.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !exporting) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [exporting, onClose]);

  const days = range ? daySpan(range.from, range.to) : 0;
  const tooMany = runCount !== null && runCount > MaxRunsPerExport;
  const slow = runCount !== null && runCount > SlowRunCount && !tooMany;

  const handleExport = async () => {
    if (!range || exporting || tooMany) return;
    setExporting(true);
    setError(null);
    setProgress({ done: 0, total: runCount ?? 0 });
    try {
      // Only the workbook is loaded on demand — that is where ExcelJS is, a few
      // hundred kilobytes nobody pays for until they ask for a file, exactly as
      // the run panel's own export does. `period-summary` is imported normally:
      // this dialog already reads its run count and its two limits on open, so
      // deferring the rest of it would split nothing and only make the code
      // read as though it did.
      const { exportPeriodToExcel } = await import('@/lib/export-period-excel');
      const summary = await buildPeriodSummary({
        from: range.from,
        to: range.to,
        trucks,
        breadTypes,
        returnedBreadTypes,
        onProgress: setProgress,
      });
      await exportPeriodToExcel({ summary });
      onClose();
    } catch (caught) {
      console.error('[period-export-dialog]', caught);
      setError(
        caught instanceof Error && caught.name === 'PeriodTooLargeError'
          ? caught.message
          : 'Could not build the summary. Check your connection and try again.',
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="ops-scrim ops-dialog-scrim" onClick={() => !exporting && onClose()} />
      <div className="ops-dialog" role="dialog" aria-modal="true" aria-labelledby="period-export-title">
        <div className="ops-dialog-head">
          <div>
            <span className="ops-label">Export</span>
            <h2 id="period-export-title">Summary workbook</h2>
          </div>
          <button type="button" className="ops-drawer-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="ops-dialog-note">
          One Excel file for the days you pick: the money day by day, every truck side by side, what each bread
          type moved and earned, which stores bought and which still owe, what came in and what was spent.
        </p>

        {/* The Trends tab's range control, in a dialog: the first dropdown
            picks which calendar unit to export by, the second picks which one
            of those. Same units in the same order, so somebody who browses
            Trends by month finds the same first option here. Day is the one
            addition — this is opened from a board showing a single day, and
            one day's paperwork is the commonest thing asked of it. */}
        <div className="ops-dialog-range">
          <label className="ops-muted" htmlFor="export-range-type">
            Range
          </label>
          <select
            id="export-range-type"
            className="ops-select"
            value={rangeType}
            disabled={exporting}
            onChange={(event) => setRangeType(event.target.value as RangeType)}>
            <option value="month">Month</option>
            <option value="week">Week</option>
            <option value="day">Day</option>
            <option value="year">Year</option>
            <option value="custom">Custom</option>
          </select>

          {rangeType === 'month' && (
            <select
              className="ops-select ops-dialog-range-value"
              aria-label="Month"
              value={monthValue}
              disabled={exporting}
              onChange={(event) => setMonthValue(event.target.value)}>
              {monthOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          {rangeType === 'week' && (
            <select
              className="ops-select ops-dialog-range-value"
              aria-label="Week"
              value={weekOffset}
              disabled={exporting}
              onChange={(event) => setWeekOffset(Number(event.target.value))}>
              {WeekOptionLabels.map((label, offset) => (
                <option key={label} value={offset}>
                  {label}
                </option>
              ))}
            </select>
          )}
          {rangeType === 'day' && (
            <select
              className="ops-select ops-dialog-range-value"
              aria-label="Day"
              value={dayValue}
              disabled={exporting}
              onChange={(event) => setDayValue(event.target.value)}>
              {dayOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          {rangeType === 'year' && (
            <select
              className="ops-select ops-dialog-range-value"
              aria-label="Year"
              value={yearValue}
              disabled={exporting}
              onChange={(event) => setYearValue(Number(event.target.value))}>
              {yearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          )}
          {/* Custom needs a start *and* an end before there is anything to
              export, so its trigger gets the whole row rather than sitting in
              the slot a one-word dropdown would fill. */}
          {rangeType === 'custom' && (
            <div className="ops-dialog-range-value ops-dialog-picker">
              <DateRangePicker
                from={customFrom}
                to={customTo}
                max={today}
                onChange={(picked) => {
                  setCustomFrom(picked.from);
                  setCustomTo(picked.to);
                }}
                formatLabel={formatDateRangeLabel}
              />
            </div>
          )}
        </div>

        {/* What is actually about to be exported, spelled out — the dates in
            full, then how much work it is. A reader who clicks Export should
            never be surprised by either. */}
        <div className="ops-dialog-readout">
          {range ? (
            <>
              <b>
                {range.from === range.to
                  ? formatBusinessDayLong(range.from)
                  : `${formatBusinessDayLong(range.from)} – ${formatBusinessDayLong(range.to)}`}
              </b>
              <span>
                {formatCount(days)} day{days === 1 ? '' : 's'}
                {' · '}
                {counting
                  ? 'counting runs…'
                  : countError
                    ? 'run count unavailable'
                    : runCount === null
                      ? '—'
                      : `${formatCount(runCount)} run${runCount === 1 ? '' : 's'}`}
              </span>
            </>
          ) : (
            <span className="ops-muted">Pick a start and an end date.</span>
          )}
        </div>

        {tooMany && (
          <div className="ops-notice ops-notice-warn">
            <span>
              <b>That is more than one file can gather.</b> This range holds {formatCount(runCount ?? 0)} runs and the
              limit is {formatCount(MaxRunsPerExport)}. Pick a shorter range — a month at a time exports cleanly.
            </span>
          </div>
        )}

        {slow && (
          <div className="ops-notice ops-notice-quiet">
            <span>
              {formatCount(runCount ?? 0)} runs is a lot to read. The file will take a minute or two — leave this tab
              open while it works.
            </span>
          </div>
        )}

        {error && (
          <div className="ops-notice ops-notice-alert">
            <span>{error}</span>
          </div>
        )}

        <div className="ops-dialog-actions">
          <button type="button" className="ops-dialog-cancel" onClick={onClose} disabled={exporting}>
            Cancel
          </button>
          <button
            type="button"
            className="ops-dialog-confirm"
            disabled={!range || exporting || tooMany}
            onClick={handleExport}>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>

      {/* Over the whole page while the workbook is built, the same overlay the
          run export uses and for the same reason: this reads every run's
          receipts, ledger and expenses before it can hand back a file, which is
          seconds on a day and a minute on a month. A button reading "Exporting…"
          in the corner is easy to miss, and clicking elsewhere meanwhile is
          confusing.

          The bar is determinate because the total is known before the first
          read: a spinner for a minute says nothing about whether anything is
          happening. */}
      {exporting && (
        <div className="ops-export-scrim" role="alertdialog" aria-live="assertive" aria-label="Preparing export">
          <div className="ops-export-modal">
            <div className="ops-spinner" aria-hidden="true" />
            <p>
              Building your summary…
              <span className="ops-sub">
                {progress.total > 0
                  ? `Reading run ${formatCount(Math.min(progress.done + 1, progress.total))} of ${formatCount(progress.total)}.`
                  : 'Gathering the runs in this period.'}
              </span>
            </p>
            {progress.total > 0 && (
              <div
                className="ops-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}>
                <div
                  className="ops-progress-fill"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
