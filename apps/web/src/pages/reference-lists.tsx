import { useEffect, useState } from 'react';

import { AgentGroupsSection } from '@/components/agent-groups-section';
import { useAuth } from '@/context/auth';
import { ADMIN_ONLY_NOTICE } from '@/lib/admin-gate';
import { NoticeModal } from '@/pages/bread-types';
import {
  addNamedRecord,
  deleteNamedRecord,
  updateNamedRecord,
  watchNamedRecords,
  type NamedCollection,
  type NamedRecord,
  type NamedRecordInput,
} from '@/lib/named-records';

/**
 * Areas, Trucks and Agents — the lists a truck picks from when it starts its
 * day, and the ids everything it uploads is grouped by.
 *
 * Same edit-mode / review-then-confirm / drag-to-reorder workflow as the
 * Bread Types page (`bread-types.tsx`), just without the fields that don't
 * apply here (price, unit). Kept in step with that page on the owner's call —
 * one editing pattern across every dashboard-owned list, not two.
 *
 * Areas and Trucks are flat `{ name }` lists and share `NamedListSection`
 * below. **Agents are not** — they are grouped into crews, and a truck is
 * assigned a whole crew rather than a hand-picked set of people, so that
 * section edits two collections at once and lives in
 * `components/agent-groups-section.tsx`. It follows the same workflow, which
 * is why it sits on this page rather than getting a nav entry of its own.
 */

type ListConfig = {
  collectionName: NamedCollection;
  title: string;
  addLabel: string;
  placeholder: string;
  empty: string;
  /** Used in the review modal's delete warning, e.g. "area". */
  singular: string;
  hint: string;
};

const LISTS: ListConfig[] = [
  {
    collectionName: 'areas',
    title: 'Areas',
    addLabel: 'Add area',
    placeholder: 'Cainta',
    empty: 'No areas yet. Press Edit to add the first one — trucks can’t finish setup without one.',
    singular: 'area',
    hint: 'A group of stores a truck covers. Each store (customer) belongs to one area, and each truck serves one area per day.',
  },
  {
    collectionName: 'trucks',
    title: 'Trucks',
    addLabel: 'Add truck',
    placeholder: 'Truck 1',
    empty: 'No trucks yet. Press Edit to add the first one — trucks can’t finish setup without one.',
    singular: 'truck',
    hint: 'Every receipt and inventory entry the app uploads is filed under the truck picked here, so a truck must exist on this page before its phone can start a day.',
  },
];

// New rows added in edit mode don't have a real Firestore id yet, so they're
// given a client-side placeholder prefixed like this. A draft is "new" (not
// yet saved) exactly when its id doesn't match anything in the live `items`.
const NEW_ID_PREFIX = 'new-';

function sortedByOrder(items: NamedRecord[]): NamedRecord[] {
  return [...items].sort((a, b) => a.order - b.order);
}

// Appends after whatever is currently last, regardless of gaps left by
// earlier deletes — only relative order matters, not contiguous numbering.
function nextOrder(items: NamedRecord[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((item) => item.order)) + 1;
}

// Which side of the target row the dragged row will actually land on —
// matches reorderDraft's own direction check, so the line shown while
// dragging is never wrong about which gap you're about to drop into.
function dropSide(sorted: NamedRecord[], draggingId: string | null, targetId: string): 'before' | 'after' | null {
  if (!draggingId || draggingId === targetId) return null;
  const fromIndex = sorted.findIndex((item) => item.id === draggingId);
  const toIndex = sorted.findIndex((item) => item.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return null;
  return fromIndex < toIndex ? 'after' : 'before';
}

function makeBlankDraft(order: number): NamedRecord {
  return { id: `${NEW_ID_PREFIX}${crypto.randomUUID()}`, name: '', order };
}

function recordsEqual(a: NamedRecord, b: NamedRecord) {
  return a.name === b.name && a.order === b.order;
}

function toInput(record: NamedRecord): NamedRecordInput {
  const { name, order } = record;
  return { name, order };
}

function isValidRecord(record: NamedRecord) {
  return record.name.trim().length > 0;
}

type Change =
  | { kind: 'added'; draft: NamedRecord }
  | { kind: 'edited'; original: NamedRecord; draft: NamedRecord }
  | { kind: 'removed'; original: NamedRecord };

export function ReferenceListsPage() {
  return (
    <div className="catalog-sections dashboard-page-fade">
      {LISTS.map((list) => (
        <NamedListSection key={list.collectionName} config={list} />
      ))}
      <AgentGroupsSection />
    </div>
  );
}

function NamedListSection({ config }: { config: ListConfig }) {
  const { isAdmin } = useAuth();
  const [items, setItems] = useState<NamedRecord[] | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [drafts, setDrafts] = useState<NamedRecord[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => watchNamedRecords(config.collectionName, setItems), [config.collectionName]);

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

  function updateDraft(id: string, patch: Partial<NamedRecord>) {
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  }

  function addDraftRow() {
    setDrafts((current) => [...current, makeBlankDraft(nextOrder(current))]);
  }

  // Moves a row one slot up/down in display order by swapping its `order`
  // value with its current neighbor's — works even if order values have gaps
  // from earlier deletes, since only relative position is compared here.
  // Drops the dragged row right next to the target row, taking over its
  // slot — same shifting behaviour as the Bread Types page (see that file
  // for the full explanation).
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

  // A duplicate name isn't blocked by Firestore, and two identically named
  // trucks would be genuinely ambiguous in a report — so it's caught here.
  function duplicateOf(draft: NamedRecord): NamedRecord | undefined {
    const wanted = draft.name.trim().toLowerCase();
    if (!wanted) return undefined;
    return drafts.find((other) => other.id !== draft.id && other.name.trim().toLowerCase() === wanted);
  }

  const changes: Change[] = [
    ...drafts.flatMap((draft): Change[] => {
      const original = items?.find((item) => item.id === draft.id);
      if (!original) return [{ kind: 'added', draft }];
      return recordsEqual(original, draft) ? [] : [{ kind: 'edited', original, draft }];
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
    const duplicate = drafts.map(duplicateOf).find((d) => d !== undefined);
    if (duplicate) {
      setNotice(`“${duplicate.name.trim()}” is on this list more than once.`);
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
          if (change.kind === 'added') return addNamedRecord(config.collectionName, toInput(change.draft));
          if (change.kind === 'edited')
            return updateNamedRecord(config.collectionName, change.draft.id, toInput(change.draft));
          return deleteNamedRecord(config.collectionName, change.original.id);
        }),
      );
      const count = changes.length;
      discardChanges();
      setNotice(`${count} change${count === 1 ? '' : 's'} saved.`);
    } catch {
      setNotice('Could not save. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const draftsValid = drafts.every(isValidRecord);

  return (
    <div>
      <div className="page-header">
        <h1>{config.title}</h1>
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

      <p className="hint catalog-hint">{config.hint}</p>

      {notice && <NoticeModal message={notice} onClose={() => setNotice(null)} />}

      {items === null ? (
        <p className="hint">Loading…</p>
      ) : !editMode && items.length === 0 ? (
        <p className="hint">{config.empty}</p>
      ) : (
        <div className="table-scroll">
          <table className="bread-table">
            <thead>
              <tr>
                <th className="row-number-col" />
                <th>Name</th>
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
                      isDragging={draggingId === draft.id}
                      dragOverSide={dragOverId === draft.id ? dropSide(sorted, draggingId, draft.id) : null}
                      placeholder={config.placeholder}
                      onChange={(patch) => updateDraft(draft.id, patch)}
                      onDelete={() => deleteDraftRow(draft.id)}
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
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {editMode && (
        <div className="catalog-row-actions">
          <button type="button" className="btn-secondary add-row-button" onClick={addDraftRow}>
            + {config.addLabel}
          </button>
        </div>
      )}

      {reviewing && (
        <ReviewChangesModal
          singular={config.singular}
          changes={changes}
          submitting={submitting}
          onConfirm={() => void handleConfirm()}
          onClose={() => setReviewing(false)}
        />
      )}
    </div>
  );
}

function EditableRow({
  draft,
  position,
  isNew,
  isDragging,
  dragOverSide,
  placeholder,
  onChange,
  onDelete,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: {
  draft: NamedRecord;
  /** 1-based position in the current display order — a render-time label, not stored on the item. */
  position: number;
  isNew: boolean;
  isDragging: boolean;
  /** Which gap is being highlighted while something's dragged over this row — matches where it'll actually land. */
  dragOverSide: 'before' | 'after' | null;
  placeholder: string;
  onChange: (patch: Partial<NamedRecord>) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
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
          placeholder={isNew ? placeholder : undefined}
          autoFocus={isNew}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </td>
      <td>
        <div className="bread-table-actions">
          <button type="button" className="danger" onClick={onDelete}>
            {isNew ? 'Remove' : 'Delete'}
          </button>
        </div>
      </td>
    </tr>
  );
}

function ReviewChangesModal({
  singular,
  changes,
  submitting,
  onConfirm,
  onClose,
}: {
  singular: string;
  changes: Change[];
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const hasRemovals = changes.some((change) => change.kind === 'removed');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wide" onClick={(event) => event.stopPropagation()}>
        <h2>Review changes</h2>

        {hasRemovals && (
          // Worth stating plainly: past records are safe because each run
          // stores the name it saw at the time, so deleting can't rewrite
          // history. What it does break is anything still pointing at the
          // id — a phone mid-setup, or a store filed under this {singular}.
          <p className="modal-warning">
            Days already recorded keep their name and are not affected. But any phone that has already picked a
            deleted {singular} will need to choose again, and stores filed under it will show no {singular}.
          </p>
        )}

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
                {change.kind === 'edited' && change.original.name !== change.draft.name && (
                  <div className="review-diff">
                    <DiffLine label="Name" from={change.original.name} to={change.draft.name} />
                  </div>
                )}
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
