import { CalendarPopover } from '@/components/calendar-popover';

/**
 * A one-day calendar — the Live tab's way of jumping to a business day that
 * isn't within a couple of taps of today. The same calendar as the Trends
 * tab's range picker (`CalendarPopover` is shared between them), with the one
 * difference the Live tab needs: exactly one day can be lit up at a time.
 *
 * **There is no Apply row.** A range needs one, because a range isn't a value
 * until both ends exist; a single day is complete the moment it's clicked, and
 * a confirm step after it would be a button that can only ever say yes. So a
 * click commits and the popover closes.
 *
 * The date in and out is a business-day key (`YYYY-MM-DD`) — the string the
 * phone stored, never a day re-derived from a timestamp here.
 */

/* Six week-rows and no Apply row — see PopoverHeight in date-range-picker.tsx,
   which is this plus that row. Used only to keep the popover on screen. */
const PopoverHeight = 268;

export function DatePicker({
  value,
  max,
  onChange,
  triggerLabel,
  triggerClassName = 'ops-select ops-calendar-trigger',
  triggerAriaLabel = 'Pick a date',
}: {
  /** The selected business day, lit up when the calendar opens. */
  value: string;
  /** No day after this one can be picked — there is no future data to show. */
  max: string;
  onChange: (day: string) => void;
  triggerLabel: React.ReactNode;
  triggerClassName?: string;
  triggerAriaLabel?: string;
}) {
  return (
    <CalendarPopover
      triggerLabel={triggerLabel}
      triggerClassName={triggerClassName}
      triggerAriaLabel={triggerAriaLabel}
      ariaLabel="Pick a date"
      max={max}
      // Opens on the month of the day currently being shown, wherever the
      // ‹ › buttons have walked it to — not on the current month.
      initialMonth={() => {
        const [year, month] = value.split('-').map(Number);
        return { year, month };
      }}
      popoverHeight={PopoverHeight}
      dayClassName={(key) =>
        key === value ? 'ops-calendar-day ops-calendar-day-endpoint' : 'ops-calendar-day'
      }
      onDayClick={(key, { close }) => {
        if (key > max) return;
        // Re-picking the day already shown is a no-op rather than a reload:
        // the Live tab always has a day, so there is nothing to toggle off to.
        if (key !== value) onChange(key);
        close();
      }}
    />
  );
}
