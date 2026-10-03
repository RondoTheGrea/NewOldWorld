import { useState } from 'react';

import { CalendarPopover, shortLabel } from '@/components/calendar-popover';

/**
 * A same-page calendar for picking an arbitrary range — the "Custom" option on
 * the Trends tab and in the summary-export dialog. Deliberately not the
 * browser's native `<input type="date">` pair: two of those can't show which
 * days fall *between* the two ends, and two separate fields don't read as one
 * range the way a single lit-up block of days does.
 *
 * The calendar itself — popover, placement, month navigation, grid — is
 * `CalendarPopover`, shared with the Live tab's single-day picker. Only what
 * makes this one a *range* is here: two ends, the preview of the days between
 * them, and the Apply row that commits them together.
 *
 * **One day is a legal range here, and Apply lights up on the first click.**
 * It refused a single day at first, on the reading that a *range* needs two
 * ends; the owner's correction is the rule now. A reader who wants one
 * arbitrary day — one further back than the Day dropdown reaches — was being
 * made to click it twice and told to "pick an end date" for a question they
 * had already answered. So the second click is what makes it a *span*, not
 * what makes it valid: the end falls back to the start, and both callers
 * already render a from-equals-to range as a single date rather than as a
 * span of one.
 */

/* The popover at its tallest: six week-rows plus the Apply row. A five-row
   month is merely placed a little conservatively rather than ever clipped. */
const PopoverHeight = 320;

export function DateRangePicker({
  from,
  to,
  max,
  onChange,
  formatLabel,
}: {
  /** The committed range, or `null` before anything has been applied yet. */
  from: string | null;
  to: string | null;
  /** No day after this one can be picked — the tab has no future data to show. */
  max: string;
  onChange: (range: { from: string; to: string }) => void;
  formatLabel: (from: string, to: string) => string;
}) {
  // Seeded from the committed range, not blank: reopening shows whatever is
  // currently applied, highlighted, the same way it was left. `null` only
  // when nothing has ever been applied — that's the one case with a
  // genuinely blank start.
  const [draftStart, setDraftStart] = useState<string | null>(from);
  const [draftEnd, setDraftEnd] = useState<string | null>(to);
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  function handleDayClick(key: string) {
    if (key > max) return;

    // Clicking a day that's already one of the two ends toggles it off,
    // rather than being read as the start of a new selection — the same day
    // clicked twice should end up unpicked, not re-picked.
    if (key === draftStart) {
      // The other end (if any) becomes the sole selected day, ready to take
      // a new end on the next click.
      setDraftStart(draftEnd);
      setDraftEnd(null);
      return;
    }
    if (key === draftEnd) {
      setDraftEnd(null);
      return;
    }

    // A day picked while a complete pair is already showing starts a fresh
    // selection rather than nudging one end of the old one — start, then
    // end, is the same two clicks every time, with nothing to remember.
    if (!draftStart || draftEnd) {
      setDraftStart(key);
      setDraftEnd(null);
      return;
    }
    if (key < draftStart) {
      setDraftEnd(draftStart);
      setDraftStart(key);
    } else {
      setDraftEnd(key);
    }
  }

  // What Apply would commit right now: a full span once both ends exist, and
  // the start on its own day before that. `null` only while nothing is picked,
  // which is the one state Apply is refused in.
  const applyRange = draftStart ? { from: draftStart, to: draftEnd ?? draftStart } : null;

  // The second end of the range being painted: the confirmed end once
  // there is one, otherwise the hovered day — so the days in between light
  // up as a preview before the second click, not only after it.
  const previewEnd = draftEnd ?? hoverDay;
  const rangeLow = draftStart && previewEnd ? (draftStart < previewEnd ? draftStart : previewEnd) : draftStart;
  const rangeHigh = draftStart && previewEnd ? (draftStart < previewEnd ? previewEnd : draftStart) : draftStart;

  return (
    <CalendarPopover
      triggerLabel={from && to ? formatLabel(from, to) : 'Select dates'}
      triggerClassName="ops-select ops-calendar-trigger"
      ariaLabel="Select a date range"
      max={max}
      initialMonth={() => {
        const [year, month] = (to ?? max).split('-').map(Number);
        return { year, month };
      }}
      popoverHeight={PopoverHeight}
      // Reopening, or cancelling out of an edit, reverts to the committed
      // range rather than to blank: whatever was clicked this time and never
      // applied is thrown away, but a range that *was* applied earlier is
      // not — cancelling an edit isn't the same as clearing the range.
      onOpen={() => {
        setDraftStart(from);
        setDraftEnd(to);
      }}
      onDismiss={() => {
        setDraftStart(from);
        setDraftEnd(to);
      }}
      onDayHover={setHoverDay}
      onGridLeave={() => setHoverDay(null)}
      onDayClick={handleDayClick}
      dayClassName={(key) => {
        const isEndpoint = key === rangeLow || key === rangeHigh;
        const inRange = !!rangeLow && !!rangeHigh && key > rangeLow && key < rangeHigh;
        return [
          'ops-calendar-day',
          isEndpoint && 'ops-calendar-day-endpoint',
          !isEndpoint && inRange && 'ops-calendar-day-inrange',
        ]
          .filter(Boolean)
          .join(' ');
      }}
      footer={({ close }) => (
        <div className="ops-calendar-actions">
          {/* Says what Apply will do, not what is still missing — with one day
              picked that is already a complete answer, and the second half of
              the line is an offer rather than an instruction. */}
          <span className="ops-muted">
            {draftStart && draftEnd
              ? formatLabel(draftStart, draftEnd)
              : draftStart
                ? `${shortLabel(draftStart)} · or pick an end date`
                : 'Pick a date'}
          </span>
          <div className="ops-calendar-buttons">
            <button
              type="button"
              className="ops-calendar-cancel"
              onClick={() => {
                setDraftStart(from);
                setDraftEnd(to);
                close();
              }}>
              Cancel
            </button>
            <button
              type="button"
              className="ops-calendar-apply"
              disabled={!applyRange}
              onClick={() => {
                if (!applyRange) return;
                onChange(applyRange);
                close();
              }}>
              Apply
            </button>
          </div>
        </div>
      )}
    />
  );
}
