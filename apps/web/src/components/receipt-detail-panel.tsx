import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { PaymentTag } from '@/components/payment-tag';
import { formatBusinessDayLong, formatBusinessTime } from '@/lib/business-day';
import { describeProofError, paymentProofUrl } from '@/lib/payment-proof';
import { formatMoney, type RunReceipt } from '@/lib/runs';

/**
 * One receipt, opened from a run's feed or from a store's history — **the mobile
 * app's receipt detail modal, on the left of the screen.**
 *
 * This is the one thing on the Overview tab that deliberately does not wear the
 * page's ink-and-navy style. It is a copy of what the driver saw on the phone
 * when they took the payment (`apps/mobile/src/components/receipt-detail-modal.tsx`):
 * the green "Order items" block, the red "Returns items" block, the same hairline
 * totals, the same wording. Someone reading a figure off the server back to an
 * agent over the phone is then looking at the same object the agent is, which is
 * worth more here than visual consistency with the board behind it. The mobile
 * palette is re-declared as tokens on `.ops-receipt` in overview.css rather than
 * borrowed from `--ops-*`, so the two can't drift into each other.
 *
 * **Left, not right, because the run panel is already on the right.** Both stay
 * on screen: the receipt you are reading and the run it belongs to, with the
 * scrim between them dimming the run rather than replacing it.
 *
 * Two things the phone's version has are absent here, both for the same reason
 * — this is a record of something that already happened, not a working copy:
 *
 * - **No Delete / Edit / Payment method.** Those act on a draft, and a draft
 *   never leaves the phone (see "Sync" in CLAUDE.md). Every receipt that reaches
 *   Firestore is finalized, which is also why the card always wears the green
 *   finalized border.
 * - **No print preview.** There is no thermal printer on this end.
 *
 * The proof-of-payment photo *is* here, and is the one part of this card that
 * fetches: the receipt document carries a `proofStoragePath`, and a private
 * bucket needs that exchanged for a signed URL before an `<img>` can load it.
 * One round trip, and only when the photo is actually opened.
 *
 * Everything else is already in hand. Both callers hold whole receipts —
 * `RunReceipt` carries its own items and returns, whether it came from the run's
 * listener or from `fetchReceiptsForCustomer` — so opening one costs no read.
 * The phone's version fetches its lines because it keeps only summary rows in
 * its list.
 */

export function ReceiptDetailPanel({
  receipt,
  agentsLabel,
  onClose,
}: {
  receipt: RunReceipt | null;
  /**
   * Who was out, worded by whichever list opened this card, so the row and the
   * receipt it opens can never disagree.
   *
   * A function rather than a resolved string because of `displayed` below: the
   * card keeps the last receipt on screen through its exit transition, and a
   * plain prop would already have gone null by then — the agents line would blink
   * out halfway through the fade. Called on `displayed`, it stays right.
   *
   * The two callers answer it differently, and both are right where they are.
   * The run panel knows the run, so a receipt with no recorded names falls back
   * to the run header's own snapshot. The store history spans months and every
   * truck, so it resolves the agent ids against the reference list instead — see
   * `agentsLabel` in stores-tab.tsx.
   */
  agentsLabel: (receipt: RunReceipt) => string | null;
  onClose: () => void;
}) {
  /**
   * A fade-and-pop, distinct from the run/store drawers' edge-to-edge slide —
   * this card floats centred rather than living flush against a side, so it
   * gets its own flavour of the same idea rather than the drawer's motion.
   *
   * Held locally instead of rendering straight off `receipt`, so a close —
   * however it happens: the ✕, the scrim, or the parent panel's Escape
   * handler setting `receipt` to null (see that comment below) — gets to play
   * the exit transition before the card actually leaves the DOM. `displayed`
   * keeps the last receipt's content on screen while `visible` drives the
   * transition back to closed; only once that finishes does `displayed` drop
   * to null and unmount `ReceiptDetailBody` for real.
   */
  const [displayed, setDisplayed] = useState<RunReceipt | null>(receipt);
  const [visible, setVisible] = useState(false);
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (receipt) {
      setDisplayed(receipt);
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    }

    setVisible(false);
    const el = cardRef.current;
    if (!el) {
      setDisplayed(null);
      return;
    }
    let settled = false;
    const finish = (event?: TransitionEvent) => {
      if (event && event.propertyName !== 'opacity') return;
      if (settled) return;
      settled = true;
      el.removeEventListener('transitionend', finish);
      window.clearTimeout(fallback);
      setDisplayed(null);
    };
    el.addEventListener('transitionend', finish);
    const fallback = window.setTimeout(finish, 300);
    return () => {
      el.removeEventListener('transitionend', finish);
      window.clearTimeout(fallback);
    };
  }, [receipt]);

  // Escape is handled by whichever panel opened this one (RunPanel or the Stores
  // tab's StorePanel), which owns both overlays and closes the innermost one
  // first. Two listeners racing for the same key would close both. Since that
  // handler dismisses by setting `receipt` to null — the same prop change a ✕
  // or scrim click causes — the effect above animates all three the same way.
  if (!displayed) return null;
  return (
    <ReceiptDetailBody
      receipt={displayed}
      agents={agentsLabel(displayed)}
      visible={visible}
      cardRef={cardRef}
      onClose={onClose}
    />
  );
}

function ReceiptDetailBody({
  receipt,
  agents,
  visible,
  cardRef,
  onClose,
}: {
  receipt: RunReceipt;
  agents: string | null;
  visible: boolean;
  cardRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  /*
   * Recomputed from the lines rather than read off `receipt.subtotal`, and only
   * for the subtotal row: the stored figure is what the phone's arithmetic
   * produced, and showing it above lines that don't add up to it would hide the
   * disagreement. The Total below stays the stored one — that is the number the
   * store was actually charged.
   */
  const lineSubtotal = receipt.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const balanceDue = receipt.amountPaid == null ? 0 : receipt.total - receipt.amountPaid;

  return (
    <>
      <div className={visible ? 'ops-receipt-scrim open' : 'ops-receipt-scrim'} onClick={onClose} />
      <aside
        ref={cardRef}
        className={['ops-receipt', visible && 'open', receipt.voidedAt !== null && 'ops-receipt-void']
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-label={`Receipt — ${receipt.customerName || 'Unnamed store'}`}>
        <div className="ops-receipt-head">
          <div className="ops-receipt-title">
            <h3>{receipt.customerName || 'Unnamed store'}</h3>
            {!!receipt.customerContactName && <p>{receipt.customerContactName}</p>}
          </div>
          <button type="button" className="ops-receipt-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/*
          The day as well as the time, and the day comes from the receipt's own
          stored `businessDay` string rather than being re-derived from the
          timestamp beside it — a browser open outside Manila would file a
          6:30 AM delivery under the day before (see lib/business-day.ts).

          The run panel already knows which day it is showing, but the Stores
          tab's history runs back months, where a bare "2:30 PM" says nothing.
          One card serves both, so it carries the day.
        */}
        <p className="ops-receipt-date">
          {receipt.businessDay && `${formatBusinessDayLong(receipt.businessDay)} · `}
          {formatBusinessTime(receipt.finalizedAt ?? receipt.createdAt)}
        </p>

        {/* The phone's voided banner, in the same place: above the scrolling
            body, so it can't be scrolled past. Everything under it is still the
            receipt as it was written; none of it counts. */}
        {receipt.voidedAt !== null && (
          <div className="ops-receipt-void-note">
            <b>Voided · {formatBusinessTime(receipt.voidedAt)}</b>
            <span>Voided on the phone. Not counted in any total on this dashboard.</span>
          </div>
        )}

        {/* Everything below the name and the time scrolls as one, so a receipt
            with forty lines never pushes the totals off the bottom of the card
            — the same arrangement as the phone's. */}
        <div className="ops-receipt-body">
          <section className="ops-receipt-block ops-receipt-block-order">
            <h4>Order items</h4>
            <div className="ops-receipt-rows">
              {receipt.items.length === 0 ? (
                <p className="ops-receipt-none">This receipt has no order items.</p>
              ) : (
                receipt.items.map((item, index) => (
                  <LineRow
                    // The phone keys these by breadTypeId; here the array is
                    // whatever Firestore stored, and a document written by an
                    // older build could repeat one. Index is stable — this list
                    // is read-only and never reorders.
                    key={`${item.breadTypeId}-${index}`}
                    name={item.name || 'Removed bread type'}
                    unitPrice={item.unitPrice}
                    quantity={item.quantity}
                  />
                ))
              )}
            </div>
          </section>

          {receipt.returns.length > 0 && (
            <section className="ops-receipt-block ops-receipt-block-returns">
              <h4>Returns items</h4>
              <div className="ops-receipt-rows">
                {receipt.returns.map((line, index) => (
                  <LineRow
                    key={`${line.name}-${index}`}
                    name={line.name || 'Removed bread type'}
                    unitPrice={line.unitPrice}
                    quantity={line.quantity}
                    negative
                  />
                ))}
              </div>
            </section>
          )}

          <div className="ops-receipt-totals">
            <TotalRow label="Subtotal" value={lineSubtotal} />
            {receipt.returnsTotal > 0 && <TotalRow label="Returns credit" value={-receipt.returnsTotal} />}
            <TotalRow label="Total" value={receipt.total} emphasize />

            {/* The tag rather than bold text, so the method is the same
                object here as in the list that was clicked to get here — and
                as on the phone the receipt was written on. Inside this card it
                picks up the mobile palette from the --rc-* tokens rather than
                the board's; see .ops-tag in overview.css. */}
            {receipt.paymentMethod && (
              <div className="ops-receipt-total-row">
                <span>Payment</span>
                <PaymentTag method={receipt.paymentMethod} />
              </div>
            )}
            {receipt.paymentMethod === 'partial' && receipt.amountPaid != null && (
              <>
                <div className="ops-receipt-total-row">
                  <span>Paid</span>
                  <span>{formatMoney(receipt.amountPaid)}</span>
                </div>
                <div className="ops-receipt-total-row">
                  <span>Balance due</span>
                  <b className="ops-receipt-due">{formatMoney(balanceDue)}</b>
                </div>
              </>
            )}

            {/* Under the payment block, which is where the phone puts it and
                where it prints on the paper — so all three copies of this
                receipt read in the same order. Omitted rather than shown empty
                when there is nothing to say: an "Agents —" row would read as a
                receipt nobody delivered. */}
            {!!agents && (
              <div className="ops-receipt-total-row">
                <span>Agents</span>
                <b>{agents}</b>
              </div>
            )}
          </div>

          <ProofOfPayment receipt={receipt} />

          {/* The one line the phone's modal has no need for: on the phone you
              are holding the receipt you just wrote, here you may be looking at
              one of hundreds and need to quote it. */}
          <div className="ops-receipt-ref">
            <span>Receipt id</span>
            <b className="ops-id">{receipt.id}</b>
          </div>
        </div>
      </aside>
    </>
  );
}

/** Payment methods a proof photo is expected for — the same two the phone offers it on. */
const PROOF_METHODS = new Set(['gcash', 'cheque']);

/**
 * The file name the phone shows for this photo.
 *
 * Taken as the last segment of the storage path rather than stored separately,
 * and that is genuinely the same string: the phone names the local file
 * `${receiptId}.jpg` (lib/payment-proof.ts) and uploads it to
 * `paymentProofs/${receiptId}.jpg` (paymentProofPath in lib/sync.ts). So the
 * server reads back the same file name the driver is looking at, which is the
 * point of matching the phone here at all.
 */
function proofFileName(storagePath: string): string {
  return storagePath.split('/').pop() || storagePath;
}

/**
 * The proof-of-payment photo — the phone's section, reproduced.
 *
 * A **link showing the file name**, opening a **centred modal** with the image,
 * exactly as `receipt-detail-modal.tsx` and `payment-proof-view-modal.tsx` do on
 * the phone. Not a thumbnail: this card's whole job is to be the same object the
 * agent is holding, so someone reading a figure back over the telephone is
 * describing the same screen.
 *
 * The section renders only where the phone's does: a GCash or cheque receipt.
 * On a cash receipt there was never a photo to take, and an empty "Proof of
 * payment" block on every cash sale would train people to ignore it.
 *
 * **A missing photo is stated, never left blank.** `proofStoragePath` is null
 * either because nobody took one or because it hasn't uploaded yet, and the two
 * are different problems — one needs nothing, the other needs the phone to find
 * signal. The panel can't tell them apart on its own, so it says exactly that
 * rather than picking one.
 */
function ProofOfPayment({ receipt }: { receipt: RunReceipt }) {
  const [open, setOpen] = useState(false);
  const path = receipt.proofStoragePath;

  // Reset when the reader clicks through to another receipt, or the modal would
  // stay open over a photo that belongs to a different sale.
  useEffect(() => setOpen(false), [receipt.id]);

  if (!receipt.paymentMethod || !PROOF_METHODS.has(receipt.paymentMethod)) return null;

  return (
    <section className="ops-receipt-proof">
      <h4>Proof of payment</h4>

      {!path ? (
        <p className="ops-receipt-none">
          No photo has reached the server for this receipt — either none was taken, or the phone still has it waiting
          to send.
        </p>
      ) : (
        // A button styled as a link, not an anchor: it opens an overlay rather
        // than navigating, and it must be reachable from the keyboard.
        <button type="button" className="ops-receipt-proof-link" onClick={() => setOpen(true)}>
          {proofFileName(path)}
        </button>
      )}

      {open && path && (
        <ProofPhotoModal
          storagePath={path}
          alt={`Proof of payment for ${receipt.customerName || 'this receipt'}`}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * The photo itself, centred over the page.
 *
 * The download URL is resolved **here**, on open, rather than when the receipt
 * is opened: the link only needs the file name, which comes free from the path,
 * so a reader who never clicks costs no request at all. The phone has no
 * equivalent step — its copy is already on disk — which is why this is the one
 * place the two versions differ in behaviour rather than only in styling.
 *
 * Its own scrim rather than reusing the receipt's, so dismissing the photo
 * leaves the receipt open behind it — the same nesting the phone has, where
 * closing the image modal returns to the receipt rather than to the list.
 *
 * **Portalled to `document.body`, and that is required rather than tidy.**
 * `.ops-receipt` carries `transform: translateY(-50%)` to centre itself, and a
 * transformed element becomes the containing block for `position: fixed`
 * descendants — so rendered in place this would be centred inside the receipt
 * card instead of over the page. The portal also puts it outside the `--rc-*`
 * tokens declared on `.ops-receipt`, which is why `.ops-proof-card` redeclares
 * the few it needs.
 */
function ProofPhotoModal({
  storagePath,
  alt,
  onClose,
}: {
  storagePath: string;
  alt: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guarded against a late resolve landing after the modal has been closed
    // and reopened on another receipt.
    let cancelled = false;
    paymentProofUrl(storagePath)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeProofError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [storagePath]);

  return createPortal(
    <div className="ops-proof-scrim" onClick={onClose}>
      {/* Escape is handled here rather than by RunPanel's window listener, and
          `stopPropagation` is what keeps the two from both firing: React binds
          at the root container, so stopping the synthetic event stops the native
          one before it reaches window. Without it Escape would close the photo
          *and* the receipt behind it, when the rule for stacked overlays on this
          page is innermost-first. */}
      <div
        className="ops-proof-card"
        role="dialog"
        aria-label="Proof of payment"
        tabIndex={-1}
        ref={(node) => node?.focus()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onClose();
        }}>
        <div className="ops-proof-head">
          <b>{proofFileName(storagePath)}</b>
          <button type="button" className="ops-proof-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error ? (
          <p className="ops-receipt-proof-error">{error}</p>
        ) : !url ? (
          <p className="ops-receipt-none">Loading the photo…</p>
        ) : (
          <img className="ops-proof-image" src={url} alt={alt} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function LineRow({
  name,
  unitPrice,
  quantity,
  negative,
}: {
  name: string;
  unitPrice: number;
  quantity: number;
  negative?: boolean;
}) {
  return (
    <div className="ops-receipt-row">
      <div className="ops-receipt-row-label">
        <b>{name}</b>
        <span>
          {formatMoney(unitPrice)} × {quantity}
        </span>
      </div>
      <b className={negative ? 'ops-receipt-row-amount ops-receipt-negative' : 'ops-receipt-row-amount'}>
        {negative ? '−' : ''}
        {formatMoney(unitPrice * quantity)}
      </b>
    </div>
  );
}

function TotalRow({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  const negative = value < 0;
  const amount = `${negative ? '−' : ''}${formatMoney(Math.abs(value))}`;
  return (
    <div className={emphasize ? 'ops-receipt-total-row ops-receipt-total-row-strong' : 'ops-receipt-total-row'}>
      <span>{label}</span>
      {emphasize ? <b className={negative ? 'ops-receipt-negative' : undefined}>{amount}</b> : <span>{amount}</span>}
    </div>
  );
}
