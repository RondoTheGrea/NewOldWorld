import { useEffect, useState, type ChangeEvent } from 'react';

import { useAuth } from '@/context/auth';
import { ADMIN_ONLY_NOTICE } from '@/lib/admin-gate';

import { type UnitLabel, addBreadType, deleteBreadType, formatUnit, updateBreadType, watchBreadTypes } from '@/lib/bread-types';
import {
  addReturnedBreadType,
  deleteReturnedBreadType,
  updateReturnedBreadType,
  watchReturnedBreadTypes,
} from '@/lib/returned-bread-types';

const UNIT_LABELS: { value: UnitLabel; label: string }[] = [
  { value: 'tray', label: 'Tray' },
  { value: 'box', label: 'Box' },
  { value: 'piece', label: 'Piece' },
];

// The shape bread types and returned bread types have in common — everything
// the catalog section, its inline editor, and the review modal work with.
// BreadType and ReturnedBreadType both satisfy this structurally, so the
// same section/watch/add/update/remove functions work for either collection
// without a generic parameter.
type CatalogItem = {
  id: string;
  name: string;
  price: number;
  unitSize: number;
  unitLabel: UnitLabel;
  /** Manual display position — lower shows first. Not necessarily contiguous. */
  order: number;
};

type CatalogItemInput = Omit<CatalogItem, 'id'>;

// New rows added in edit mode don't have a real Firestore id yet, so they're
// given a client-side placeholder prefixed like this. A draft is "new" (not
// yet saved) exactly when its id doesn't match anything in the live `items`.
const NEW_ID_PREFIX = 'new-';

function sortedByOrder(items: CatalogItem[]): CatalogItem[] {
  return [...items].sort((a, b) => a.order - b.order);
}

// Appends after whatever is currently last, regardless of gaps left by
// earlier deletes — only relative order matters, not contiguous numbering.
function nextOrder(items: CatalogItem[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((item) => item.order)) + 1;
}

// Which side of the target row the dragged row will actually land on —
// matches reorderDraft's own direction check, so the line shown while
// dragging is never wrong about which gap you're about to drop into.
function dropSide(sorted: CatalogItem[], draggingId: string | null, targetId: string): 'before' | 'after' | null {
  if (!draggingId || draggingId === targetId) return null;
  const fromIndex = sorted.findIndex((item) => item.id === draggingId);
  const toIndex = sorted.findIndex((item) => item.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return null;
  return fromIndex < toIndex ? 'after' : 'before';
}


// Drops the zero a number field was sitting on once a real figure is typed
// onto it: "05" → "5", "007" → "7". A lone "0" is left alone (it's a real
// value until something replaces it) and so is the one in "0.50", which is
// part of the number rather than in front of it.
function stripLeadingZeros(text: string): string {
  return text.replace(/^0+(?=\d)/, '');
}

/**
 * Types a figure into a number field and makes the field show it.
 *
 * `<input type="number">` needs the help: React only writes the DOM back when
 * `node.value != value`, and that comparison is **loose**. A new row is
 * prefilled with 0, so typing 5 onto it leaves the field holding "05" — which
 * `== 5`, so React sees nothing to update and the stale "05" stays on screen
 * over a price that really is 5. Cleaning the node itself is what closes that
 * gap, and only when the text actually changed, so a half-typed decimal is
 * never touched: mid-way through "5.25" the browser reports "" for "5.",
 * which must be left exactly where it is or the field would erase itself
 * under the typist.
 */
function handleNumberInput(
  event: ChangeEvent<HTMLInputElement>,
  apply: (value: number) => void,
) {
  const raw = event.target.value;
  const cleaned = stripLeadingZeros(raw);
  if (cleaned !== raw) event.target.value = cleaned;
  apply(Number(cleaned));
}

function makeBlankDraft(order: number): CatalogItem {
  return { id: `${NEW_ID_PREFIX}${crypto.randomUUID()}`, name: '', price: 0, unitSize: 8, unitLabel: 'tray', order };
}

function itemsEqual(a: CatalogItem, b: CatalogItem) {
  return (
    a.name === b.name &&
    a.price === b.price &&
    a.unitSize === b.unitSize &&
    a.unitLabel === b.unitLabel &&
    a.order === b.order
  );
}

function toInput(item: CatalogItem): CatalogItemInput {
  const { name, price, unitSize, unitLabel, order } = item;
  return { name, price, unitSize, unitLabel, order };
}

function isValidItem(item: CatalogItem) {
  return item.name.trim().length > 0 && item.price >= 0 && (item.unitLabel === 'piece' || item.unitSize > 0);
}

type Change =
  | { kind: 'added'; draft: CatalogItem }
  | { kind: 'edited'; original: CatalogItem; draft: CatalogItem }
  | { kind: 'removed'; original: CatalogItem };

export function BreadTypesPage() {
  const [breadTypes, setBreadTypes] = useState<CatalogItem[]>([]);
  useEffect(() => watchBreadTypes(setBreadTypes), []);

  return (
    <div className="catalog-sections dashboard-page-fade">
      <CatalogSection
        title="Bread Types"
        addButtonLabel="Add bread type"
        priceFieldLabel="Price (₱)"
        emptyMessage="No bread types yet. Press Edit to add the first one."
        watch={watchBreadTypes}
        add={addBreadType}
        update={updateBreadType}
        remove={deleteBreadType}
      />
      <CatalogSection
        title="Returned Bread Types"
        addButtonLabel="Add returned bread type"
        priceFieldLabel="Old price (₱)"
        hint="For bread sold at an old price that may still come back as a return. Add an entry here with that old price so the return is deducted correctly, without touching the current price above."
        emptyMessage="No returned bread types yet."
        watch={watchReturnedBreadTypes}
        add={addReturnedBreadType}
        update={updateReturnedBreadType}
        remove={deleteReturnedBreadType}
        copySource={breadTypes}
        copySourceLabel="Bread Types"
      />
    </div>
  );
}

function CatalogSection({
  title,
  addButtonLabel,
  priceFieldLabel,
  hint,
  emptyMessage,
  watch,
  add,
  update,
  remove,
  copySource,
  copySourceLabel,
}: {
  title: string;
  addButtonLabel: string;
  priceFieldLabel: string;
  hint?: string;
  emptyMessage: string;
  watch: (callback: (items: CatalogItem[]) => void) => () => void;
  add: (input: CatalogItemInput) => Promise<void>;
  update: (id: string, input: CatalogItemInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Another catalog to offer copying rows in from (e.g. Bread Types → Returned Bread Types). */
  copySource?: CatalogItem[];
  copySourceLabel?: string;
}) {
  const { isAdmin } = useAuth();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [drafts, setDrafts] = useState<CatalogItem[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [copyWarning, setCopyWarning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => watch(setItems), [watch]);

  function enterEditMode() {
    if (!isAdmin) {
      setNotice(ADMIN_ONLY_NOTICE);
      return;
    }
    if (!items) return;
    setDrafts(items.map((item) => ({ ...item })));
    setDeletedIds([]);
    setEditMode(true);
  }

  function discardChanges() {
    setEditMode(false);
    setReviewing(false);
    setNotice(null);
    setDrafts([]);
    setDeletedIds([]);
  }

  function updateDraft(id: string, patch: Partial<CatalogItem>) {
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  }

  function addDraftRow() {
    setDrafts((current) => [...current, makeBlankDraft(nextOrder(current))]);
  }

  // Makes this list an exact copy of the source catalog: every source row's
  // name, price, unit and order come across as they stand right now, and
  // anything here the source doesn't have is dropped. A mirror, not a merge —
  // pressing it twice in a row changes nothing the second time.
  //
  // **A row that survives keeps its own document id.** The two collections are
  // separate and their ids never relate, so a surviving row is *edited* in
  // place rather than deleted and re-created — which keeps the review modal
  // honest (a price change reads as a price change) and leaves ids stable for
  // anything already pointing at them. Names are matched **word for word**,
  // the same rule the run panel's Outcome table joins on, so a row differing
  // only in case or spacing is a different bread here too: it is dropped and
  // the source's spelling is added in its place, with a fresh id.
  //
  // Rows never saved yet just disappear; saved ones go to `deletedIds`, so the
  // review modal lists them as removals and nothing is written until Confirm.
  // The caller is expected to have confirmed the warning modal first.
  function copyFromSource() {
    if (!copySource) return;
    // First existing row of a given name wins; a second row of the same name
    // has no source row left to claim it and is dropped like any other.
    const existingByName = new Map<string, CatalogItem>();
    for (const draft of drafts) {
      if (draft.name && !existingByName.has(draft.name)) existingByName.set(draft.name, draft);
    }
    const kept = new Set<string>();
    const mirrored = copySource.map((item) => {
      const existing = existingByName.get(item.name);
      // Claimed once and once only: two source rows sharing a name must not
      // both reuse the same document id, or one save would write over the other.
      if (existing) {
        kept.add(existing.id);
        existingByName.delete(item.name);
      }
      return {
        id: existing?.id ?? `${NEW_ID_PREFIX}${crypto.randomUUID()}`,
        name: item.name,
        price: item.price,
        unitSize: item.unitSize,
        unitLabel: item.unitLabel,
        order: item.order,
      };
    });
    const dropped = drafts
      .filter((draft) => !kept.has(draft.id) && !draft.id.startsWith(NEW_ID_PREFIX))
      .map((draft) => draft.id);
    setDrafts(mirrored);
    setDeletedIds((current) => [...new Set([...current, ...dropped])]);
    setCopyWarning(false);
  }

  // Moves a row one slot up/down in display order by swapping its `order`
  // value with its current neighbor's — works even if order values have gaps
  // from earlier deletes, since only relative position is compared here.
  function moveDraft(id: string, direction: -1 | 1) {
    setDrafts((current) => {
      const sorted = sortedByOrder(current);
      const index = sorted.findIndex((draft) => draft.id === id);
      const swapIndex = index + direction;
      if (index === -1 || swapIndex < 0 || swapIndex >= sorted.length) return current;
      const a = sorted[index];
      const b = sorted[swapIndex];
      return current.map((draft) => {
        if (draft.id === a.id) return { ...draft, order: b.order };
        if (draft.id === b.id) return { ...draft, order: a.order };
        return draft;
      });
    });
  }

  // Drops the dragged row right next to the target row, taking over its
  // slot — everything from the target up to the dragged row's old spot
  // shifts one place to make room, the same way pulling a card out of a
  // stack and pushing it back in elsewhere does. Only that shifted stretch
  // changes `order`; nothing outside it is touched, so a short drag only
  // shows a couple of rows as reordered, not the whole table. The left-hand
  // row numbers are just each row's position at render time, so they're
  // automatically unaffected: they relabel to 1..n, they don't move with a row.
  function reorderDraft(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    setDrafts((current) => {
      const sorted = sortedByOrder(current);
      const fromIndex = sorted.findIndex((draft) => draft.id === draggedId);
      const toIndex = sorted.findIndex((draft) => draft.id === targetId);
      if (fromIndex === -1 || toIndex === -1) return current;

      const draggingDown = fromIndex < toIndex;
      const start = draggingDown ? fromIndex : toIndex;
      const end = draggingDown ? toIndex : fromIndex;
      const range = sorted.slice(start, end + 1);
      const orderValues = range.map((item) => item.order);

      // Dragging down drops the row just after the target (end of the
      // range); dragging up drops it just before the target (start of the
      // range). Either way, everyone else in the range keeps their relative
      // order but slides into the next slot over.
      const dragged = range.find((item) => item.id === draggedId)!;
      const displaced = range.filter((item) => item.id !== draggedId);
      const newRange = draggingDown ? [...displaced, dragged] : [dragged, ...displaced];

      const newOrderById = new Map(newRange.map((item, i) => [item.id, orderValues[i]]));
      return current.map((draft) =>
        newOrderById.has(draft.id) ? { ...draft, order: newOrderById.get(draft.id)! } : draft,
      );
    });
  }

  // A new (unsaved) row just disappears — it never existed. An existing row
  // is pulled out of the visible table but tracked in deletedIds so it can
  // show up as a pending removal in the review modal.
  function deleteDraftRow(id: string) {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
    if (!id.startsWith(NEW_ID_PREFIX)) {
      setDeletedIds((current) => [...current, id]);
    }
  }

  const changes: Change[] = [
    ...drafts.flatMap((draft): Change[] => {
      const original = items?.find((item) => item.id === draft.id);
      if (!original) return [{ kind: 'added', draft }];
      return itemsEqual(original, draft) ? [] : [{ kind: 'edited', original, draft }];
    }),
    ...deletedIds.flatMap((id): Change[] => {
      const original = items?.find((item) => item.id === id);
      return original ? [{ kind: 'removed', original }] : [];
    }),
  ];

  function handleReviewClick() {
    if (changes.length === 0) {
      setNotice('No changes to review.');
      return;
    }
    setReviewing(true);
  }

  async function handleConfirm() {
    // The account can be demoted by another administrator while this page sits
    // open in edit mode. The rules would refuse the write anyway; catching it
    // here says why, instead of "could not save".
    if (!isAdmin) {
      setReviewing(false);
      setNotice(ADMIN_ONLY_NOTICE);
      return;
    }
    setSubmitting(true);
    try {
      await Promise.all(
        changes.map((change) => {
          if (change.kind === 'added') return add(toInput(change.draft));
          if (change.kind === 'edited') return update(change.draft.id, toInput(change.draft));
          return remove(change.original.id);
        }),
      );
      const count = changes.length;
      discardChanges();
      setNotice(`${count} change${count === 1 ? '' : 's'} saved.`);
    } finally {
      setSubmitting(false);
    }
  }

  const draftsValid = drafts.every(isValidItem);

  return (
    <div>
      <div className="page-header">
        <h1>{title}</h1>
        <div className="page-header-actions">
          {editMode ? (
            <>
              <button type="button" className="btn-secondary" onClick={discardChanges} disabled={submitting}>
                Discard changes
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleReviewClick}
                disabled={!draftsValid || submitting}>
                Review changes
              </button>
            </>
          ) : (
            <button type="button" className="btn-secondary" onClick={enterEditMode} disabled={items === null}>
              Edit
            </button>
          )}
        </div>
      </div>

      {notice && <NoticeModal message={notice} onClose={() => setNotice(null)} />}

      {hint && <p className="hint catalog-hint">{hint}</p>}

      {items === null ? (
        <p className="hint">Loading…</p>
      ) : !editMode && items.length === 0 ? (
        <p className="hint">{emptyMessage}</p>
      ) : (
        <div className="table-scroll">
          <table className="bread-table">
            <thead>
              <tr>
                <th className="row-number-col" />
                <th>Name</th>
                <th>{editMode ? priceFieldLabel : 'Price'}</th>
                <th>Unit</th>
                {editMode && <th />}
              </tr>
            </thead>
            <tbody>
              {editMode
                ? sortedByOrder(drafts).map((draft, index, sorted) => (
                    <EditableRow
                      key={draft.id}
                      draft={draft}
                      position={index + 1}
                      isNew={draft.id.startsWith(NEW_ID_PREFIX)}
                      isFirst={index === 0}
                      isLast={index === sorted.length - 1}
                      isDragging={draggingId === draft.id}
                      dragOverSide={dragOverId === draft.id ? dropSide(sorted, draggingId, draft.id) : null}
                      onChange={(patch) => updateDraft(draft.id, patch)}
                      onDelete={() => deleteDraftRow(draft.id)}
                      onMoveUp={() => moveDraft(draft.id, -1)}
                      onMoveDown={() => moveDraft(draft.id, 1)}
                      onDragStart={() => setDraggingId(draft.id)}
                      onDragEnter={() => setDragOverId(draft.id)}
                      onDrop={() => {
                        if (draggingId) reorderDraft(draggingId, draft.id);
                        setDraggingId(null);
                        setDragOverId(null);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverId(null);
                      }}
                    />
                  ))
                : items.map((item, index) => (
                    <tr key={item.id}>
                      <td className="row-number-col">
                        <span className="row-number">{index + 1}</span>
                      </td>
                      <td>{item.name}</td>
                      <td>₱{item.price.toFixed(2)}</td>
                      <td>{formatUnit(item.unitSize, item.unitLabel)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {editMode && (
        <div className="catalog-row-actions">
          <button type="button" className="btn-secondary add-row-button" onClick={addDraftRow}>
            + {addButtonLabel}
          </button>
          {copySource && copySource.length > 0 && (
            <button type="button" className="btn-secondary add-row-button" onClick={() => setCopyWarning(true)}>
              Copy from {copySourceLabel}
            </button>
          )}
        </div>
      )}

      {copyWarning && copySourceLabel && (
        <CopyWarningModal
          sourceLabel={copySourceLabel}
          onConfirm={copyFromSource}
          onCancel={() => setCopyWarning(false)}
        />
      )}

      {reviewing && (
        <ReviewChangesModal
          changes={changes}
          submitting={submitting}
          onConfirm={() => void handleConfirm()}
          onClose={() => setReviewing(false)}
        />
      )}
    </div>
  );
}

function CopyWarningModal({
  sourceLabel,
  onConfirm,
  onCancel,
}: {
  sourceLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <h2>Copy from {sourceLabel}?</h2>
        <p className="modal-warning">
          This replaces the whole list with an exact copy of {sourceLabel} — same names, same prices, same units,
          same order. Anything listed here that {sourceLabel.toLowerCase()} doesn't have is removed, and any price
          here that differs is overwritten with the {sourceLabel.toLowerCase()} price as it stands right now.
        </p>
        <p className="hint" style={{ textAlign: 'left' }}>
          So an old price you saved here earlier will be replaced. If you're trying to keep today's price before
          changing it above, copy first — copying after the change brings in the new price, not the old one.
          Nothing is saved until you review and confirm, and the review lists every removal.
        </p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            Copy all
          </button>
        </div>
      </div>
    </div>
  );
}

function EditableRow({
  draft,
  position,
  isNew,
  isFirst,
  isLast,
  isDragging,
  dragOverSide,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: {
  draft: CatalogItem;
  /** 1-based position in the current display order — a render-time label, not stored on the item. */
  position: number;
  isNew: boolean;
  isFirst: boolean;
  isLast: boolean;
  isDragging: boolean;
  /** Which gap is being highlighted while something's dragged over this row — matches where it'll actually land. */
  dragOverSide: 'before' | 'after' | null;
  onChange: (patch: Partial<CatalogItem>) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const isPiece = draft.unitLabel === 'piece';

  return (
    <tr
      className={isDragging ? 'dragging' : dragOverSide ? `drag-over-${dragOverSide}` : undefined}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={onDragEnter}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}>
      <td className="row-number-col">
        <span
          className="drag-handle"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('text/plain', draft.id);
            event.dataTransfer.effectAllowed = 'move';
            onDragStart();
          }}
          title="Drag to reorder">
          ⠿
        </span>
        <span className="row-number">{position}</span>
      </td>
      <td>
        <input
          className="table-input"
          type="text"
          value={draft.name}
          placeholder={isNew ? 'Whole Wheat' : undefined}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </td>
      <td>
        <input
          className="table-input"
          type="number"
          min="0"
          step="0.01"
          value={draft.price}
          onChange={(event) => handleNumberInput(event, (price) => onChange({ price }))}
        />
      </td>
      <td>
        <div className="table-unit-cell">
          <select
            className="table-input"
            value={draft.unitLabel}
            onChange={(event) => onChange({ unitLabel: event.target.value as UnitLabel })}>
            {UNIT_LABELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {!isPiece && (
            <input
              className="table-input"
              type="number"
              min="1"
              step="1"
              value={draft.unitSize}
              onChange={(event) => handleNumberInput(event, (unitSize) => onChange({ unitSize }))}
            />
          )}
        </div>
      </td>
      <td>
        <div className="bread-table-actions">
          <button type="button" aria-label="Move up" title="Move up" disabled={isFirst} onClick={onMoveUp}>
            ↑
          </button>
          <button type="button" aria-label="Move down" title="Move down" disabled={isLast} onClick={onMoveDown}>
            ↓
          </button>
          <button type="button" className="danger" onClick={onDelete}>
            {isNew ? 'Remove' : 'Delete'}
          </button>
        </div>
      </td>
    </tr>
  );
}

export function NoticeModal({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <p>{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn-primary" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewChangesModal({
  changes,
  submitting,
  onConfirm,
  onClose,
}: {
  changes: Change[];
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wide" onClick={(event) => event.stopPropagation()}>
        <h2>Review changes</h2>

        <div className="review-list">
          {changes.map((change) => {
            const item = change.kind === 'removed' ? change.original : change.draft;
            return (
              <div key={item.id} className="review-item">
                <h3>
                  {item.name || '(untitled)'}
                  {change.kind === 'added' && <span className="review-badge">New</span>}
                  {change.kind === 'removed' && <span className="review-badge review-badge-removed">Removed</span>}
                  {change.kind === 'edited' && change.original.order !== change.draft.order && (
                    <span className="review-badge">Reordered</span>
                  )}
                </h3>
                <div className="review-diff">
                  {change.kind === 'added' && (
                    <>
                      <DiffLine label="Price" from={null} to={`₱${change.draft.price.toFixed(2)}`} />
                      <DiffLine
                        label="Unit"
                        from={null}
                        to={formatUnit(change.draft.unitSize, change.draft.unitLabel)}
                      />
                    </>
                  )}
                  {change.kind === 'removed' && (
                    <>
                      <DiffLine label="Price" from={`₱${change.original.price.toFixed(2)}`} to={null} />
                      <DiffLine
                        label="Unit"
                        from={formatUnit(change.original.unitSize, change.original.unitLabel)}
                        to={null}
                      />
                    </>
                  )}
                  {change.kind === 'edited' && (
                    <>
                      {change.original.name !== change.draft.name && (
                        <DiffLine label="Name" from={change.original.name} to={change.draft.name} />
                      )}
                      {change.original.price !== change.draft.price && (
                        <DiffLine
                          label="Price"
                          from={`₱${change.original.price.toFixed(2)}`}
                          to={`₱${change.draft.price.toFixed(2)}`}
                        />
                      )}
                      {(change.original.unitSize !== change.draft.unitSize ||
                        change.original.unitLabel !== change.draft.unitLabel) && (
                        <DiffLine
                          label="Unit"
                          from={formatUnit(change.original.unitSize, change.original.unitLabel)}
                          to={formatUnit(change.draft.unitSize, change.draft.unitLabel)}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Close
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm} disabled={submitting}>
            {submitting ? 'Saving…' : `Confirm ${changes.length} change${changes.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiffLine({ label, from, to }: { label: string; from: string | null; to: string | null }) {
  return (
    <div className="review-diff-row">
      <span className="review-diff-label">{label}</span>
      <span>
        {from !== null && <s>{from}</s>}
        {from !== null && to !== null && ' → '}
        {to}
      </span>
    </div>
  );
}
