import { useEffect, useRef } from 'react';

/** How far the mouse has to travel before a press becomes a drag rather than a click. */
const DragThresholdPx = 5;

/**
 * Lets a sideways-scrolling strip (the run panel's tabs) be scrolled with a
 * mouse, not just a trackpad or a finger.
 *
 * - **Mouse wheel while hovering** scrolls it sideways. A wheel only sends
 *   vertical movement, which a sideways strip ignores, so a mouse user had no
 *   way to reach the tabs past the edge. Only the vertical part is translated —
 *   a trackpad already sends sideways movement and is left alone.
 *
 *   **Every wheel event over the strip is swallowed — no exceptions**, on the
 *   owner's call: hovering the tabs and wheeling must only ever move the tabs.
 *   Not at either end, not when the tabs happen to fit, not for a sideways
 *   (trackpad / tilt-wheel) movement. Letting any of those through is what made
 *   the drawer scroll once the tabs reached their end. The strip is one row
 *   high, so moving the pointer off it to scroll the page costs nothing.
 *   `overscroll-behavior: contain` on `.ops-subtabs` backs this up for the
 *   browser's own sideways scrolling, which this handler doesn't drive.
 * - **Click-and-drag** scrolls it too. A drag that went past a few pixels
 *   swallows the click it ends with, so letting go over a tab doesn't also
 *   switch to it. Mouse only: touch already scrolls natively, and taking over
 *   its pointer events would fight the browser's own momentum.
 *
 * Listeners are attached by hand rather than as React props because the wheel
 * one has to be non-passive to be allowed to stop the page scrolling, and
 * React attaches wheel listeners as passive.
 */
export function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const overflowing = () => el.scrollWidth > el.clientWidth;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Whichever direction the wheel moved most drives the strip sideways —
      // a mouse wheel sends deltaY, a trackpad or tilt wheel sends deltaX.
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      // deltaMode 1 is "lines" (Firefox with a mouse wheel), not pixels.
      el.scrollLeft += event.deltaMode === 1 ? delta * 16 : delta;
    };

    let pointerId: number | null = null;
    let startX = 0;
    let startLeft = 0;
    let dragged = false;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || !overflowing()) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startLeft = el.scrollLeft;
      dragged = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      const dx = event.clientX - startX;
      if (!dragged) {
        if (Math.abs(dx) < DragThresholdPx) return;
        dragged = true;
        el.setPointerCapture(event.pointerId);
        el.classList.add('dragging');
      }
      el.scrollLeft = startLeft - dx;
    };

    const onPointerUp = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      el.classList.remove('dragging');
      pointerId = null;
    };

    // Capture phase, so it runs before the tab's own onClick.
    const onClick = (event: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      event.preventDefault();
      event.stopPropagation();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('click', onClick, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('click', onClick, true);
    };
  }, []);

  return ref;
}
