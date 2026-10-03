import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The month grid that both date pickers on this page are built out of — the
 * Trends tab's two-date range (`date-range-picker.tsx`) and the Live tab's
 * single day (`date-picker.tsx`).
 *
 * Everything that is the *same* about them lives here: the trigger button, the
 * popover and where on screen it goes, month navigation, the Monday-first
 * grid, and every way of closing it. What differs — how many days can be lit
 * up at once, what a click means, and whether there is an Apply row — is
 * passed in. Splitting it this way is what keeps the two calendars looking and
 * behaving identically; two copies of this drift the first time one of them is
 * touched.
 *
 * Dates in and out are business-day keys (`YYYY-MM-DD`), the same format used
 * everywhere else on this tab. Nothing here does timezone work — it only lays
 * out the digits already in the key, the same way `formatMonthLabel` in
 * lib/day-ranges.ts does.
 *
 * **The popover is portalled out to the `.ops` root, not left beside its
 * trigger.** It is `position: fixed` and placed from the trigger's on-screen
 * rectangle, and "fixed" stops meaning *the viewport* the moment any ancestor
 * carries a `transform` — that ancestor becomes the containing block instead.
 * The summary-export dialog is exactly that ancestor: it centres itself with
 * `translate(-50%, -50%)` and scrolls inside itself, so a calendar rendered in
 * place there came out offset by half the dialog and then clipped by its
 * overflow. Same class of bug, same fix, as the proof-of-payment modal
 * portalling out of `.ops-receipt` (see apps/web/CLAUDE.md).
 *
 * **`.ops`, specifically — not `document.body`.** Every colour in
 * `overview.css` is a `--ops-*` custom property declared on `.ops`, and custom
 * properties inherit down the *DOM*, which a portal moves the popover out of.
 * Portalled to the body it would render with no background and no borders.
 * `.ops` has no transform and clips nothing, so it escapes the dialog while
 * still being inside the tokens — and it is where the calendar already lived
 * on the Trends tab, so nothing about that case changes.
 *
 * React events still bubble through a portal, but the two DOM listeners below
 * are on `document` and have to account for it: "outside" now means outside
 * the trigger *and* outside the popover, since the two are no longer nested.
 */

const Weekdays = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function keyOf(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday-first weekday offset (0 = Monday) of a month's 1st. */
function leadingBlanks(year: number, month: number): number {
  const sunday0 = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 = Sunday .. 6 = Saturday
  return (sunday0 + 6) % 7;
}

function shiftMonth(year: number, month: number, offset: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + offset;
  return { year: Math.floor(total / 12), month: (((total % 12) + 12) % 12) + 1 };
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function shortLabel(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/* The popover's own width, as declared in overview.css. Used to keep it inside
   the window (see placePopover). The height is passed in by each picker,
   because a calendar with an Apply row is taller than one without. */
const PopoverWidth = 280;

/**
 * Where the popover goes, given where its trigger is.
 *
 * Below the trigger and left-aligned to it is the answer on a desktop, and was
 * the whole of it until this page had to work on a phone: on a 360px screen a
 * 280px calendar hung off the right edge whenever the trigger wasn't flush
 * left, and in landscape it ran off the bottom, where a `position: fixed`
 * element can't be scrolled to — the page scrolls, the popover doesn't move.
 *
 * So both axes are clamped into the viewport, and if there isn't room below
 * the trigger the popover flips above it rather than being pushed up over the
 * control it belongs to. The width and height used here are the CSS ones (see
 * .ops-calendar-popover in overview.css, which caps the width the same way on
 * a narrow screen) — measuring the real element would mean rendering it first
 * and moving it after, which is a visible jump.
 */
function placePopover(rect: DOMRect, height: number): { top: number; left: number } {
  const margin = 8;
  const width = Math.min(PopoverWidth, window.innerWidth - margin * 2);

  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));

  const below = rect.bottom + 6;
  const above = rect.top - 6 - height;
  // Flip only when there is genuinely more room above — on a short landscape
  // window neither side fits, and clamping the "below" position keeps the
  // calendar next to its trigger instead of jumping across it.
  const flip = below + height > window.innerHeight - margin && above >= margin;
  const top = flip ? above : Math.max(margin, Math.min(below, window.innerHeight - height - margin));

  return { top, left };
}

export function CalendarPopover({
  triggerLabel,
  triggerClassName,
  triggerAriaLabel,
  ariaLabel,
  max,
  /** Which month to open on. Read fresh on every open, not just on mount. */
  initialMonth,
  popoverHeight,
  dayClassName,
  onDayClick,
  onDayHover,
  onGridLeave,
  onOpen,
  onDismiss,
  footer,
}: {
  triggerLabel: ReactNode;
  triggerClassName: string;
  triggerAriaLabel?: string;
  ariaLabel: string;
  /** No day after this one can be picked — the tab has no future data to show. */
  max: string;
  initialMonth: () => { year: number; month: number };
  popoverHeight: number;
  dayClassName: (key: string) => string;
  /** `close` lets a picker that commits on a single click shut itself. */
  onDayClick: (key: string, api: { close: () => void }) => void;
  onDayHover?: (key: string | null) => void;
  onGridLeave?: () => void;
  /** Called just before opening, so a picker can reseed its draft state. */
  onOpen?: () => void;
  /** Called on every way out but a deliberate commit — revert drafts here. */
  onDismiss?: () => void;
  footer?: (api: { close: () => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(initialMonth);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The popover is `position: fixed` and placed by hand from the trigger's
  // on-screen position, rather than `position: absolute` under the trigger —
  // see overview.css for why.
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  // Resolved when the picker opens rather than during render: the container is
  // mounted by then, and pinning the host for the life of one opening keeps a
  // re-render from moving the popover between parents mid-selection.
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  /** An outside click, Escape, Cancel, or re-clicking the trigger. */
  const dismiss = useCallback(() => {
    onDismiss?.();
    setOpen(false);
  }, [onDismiss]);

  /** A deliberate commit — no revert, because the caller just took the value. */
  const close = useCallback(() => setOpen(false), []);

  // Outside click and Escape both dismiss it — same expectation as any other
  // popover on the page. "Outside" is two elements now that the popover is
  // portalled: a click in the calendar is not inside the trigger's container
  // any more, and testing only that container closed the calendar on the first
  // day clicked.
  //
  // Escape is caught in the *capture* phase and its propagation stopped, so a
  // calendar opened inside a dialog takes the key for itself: the innermost
  // thing on screen is what Escape should shut, and without this the summary
  // dialog's own Escape handler closed the whole dialog out from under an open
  // calendar.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      dismiss();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dismiss();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, dismiss]);

  // `position: fixed` means the popover no longer moves with the page the way
  // an absolutely-positioned one would, so a scroll under it — the Overview
  // tab's own `.ops-view` panel, or the summary dialog's own overflow — has to
  // close it rather than leave it hanging in place over the wrong spot. Listened for on `window`
  // with `capture: true` because `scroll` doesn't bubble, so a plain listener
  // on `window` would never see one fired on a scrolled-inside container.
  useEffect(() => {
    if (!open) return;
    function onScroll() {
      dismiss();
    }
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open, dismiss]);

  function openPicker() {
    onOpen?.();
    setView(initialMonth());
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPopoverPos(placePopover(rect, popoverHeight));
    setPortalHost(containerRef.current?.closest<HTMLElement>('.ops') ?? document.body);
    setOpen(true);
  }

  const blanks = leadingBlanks(view.year, view.month);
  const total = daysInMonth(view.year, view.month);
  const cells: (string | null)[] = [
    ...(Array(blanks).fill(null) as null[]),
    ...Array.from({ length: total }, (_, i) => keyOf(view.year, view.month, i + 1)),
  ];

  const next = shiftMonth(view.year, view.month, 1);
  const nextDisabled = keyOf(next.year, next.month, 1) > max;

  return (
    <div className="ops-calendar" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={triggerClassName}
        aria-label={triggerAriaLabel}
        aria-expanded={open}
        onClick={() => (open ? dismiss() : openPicker())}>
        {triggerLabel}
      </button>
      {open &&
        popoverPos &&
        portalHost &&
        createPortal(
          <div
            ref={popoverRef}
            className="ops-calendar-popover"
            style={{ top: popoverPos.top, left: popoverPos.left }}
            role="dialog"
            aria-label={ariaLabel}>
            <div className="ops-calendar-nav">
              <button
                type="button"
                className="ops-calendar-navbtn"
                onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))}
                aria-label="Previous month">
                ‹
              </button>
              <span>{monthLabel(view.year, view.month)}</span>
              <button
                type="button"
                className="ops-calendar-navbtn"
                onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))}
                disabled={nextDisabled}
                aria-label="Next month">
                ›
              </button>
            </div>

            <div className="ops-calendar-weekdays">
              {Weekdays.map((weekday) => (
                <span key={weekday}>{weekday}</span>
              ))}
            </div>

            <div className="ops-calendar-grid" onMouseLeave={onGridLeave}>
              {cells.map((key, index) => {
                if (!key) return <span key={index} />;
                const disabled = key > max;
                return (
                  <button
                    key={key}
                    type="button"
                    className={dayClassName(key)}
                    disabled={disabled}
                    onMouseEnter={() => !disabled && onDayHover?.(key)}
                    onClick={() => onDayClick(key, { close })}>
                    {Number(key.slice(8))}
                  </button>
                );
              })}
            </div>

            {footer?.({ close })}
          </div>,
          portalHost,
        )}
    </div>
  );
}
