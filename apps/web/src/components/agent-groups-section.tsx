import { useEffect, useState } from 'react';

import { useAuth } from '@/context/auth';
import { ADMIN_ONLY_NOTICE } from '@/lib/admin-gate';
import { NoticeModal } from '@/pages/bread-types';
import {
  addAgent,
  addAgentGroup,
  deleteAgent,
  deleteAgentGroup,
  updateAgent,
  updateAgentGroup,
  watchAgentGroups,
  watchAgents,
  type Agent,
  type AgentGroup,
} from '@/lib/agent-groups';

/**
 * The Agents list — crews, and the people in each.
 *
 * Its own component rather than a fourth `NamedListSection` because it edits
 * **two** collections whose relationship is the point: a truck is assigned a
 * whole crew, so an agent outside a group can never be put on one. Every edit
 * here preserves that — deleting a crew takes its people with it, adding a
 * person means adding them *to* a crew, and Review refuses to save a crew with
 * nobody in it.
 *
 * The workflow is deliberately identical to the Areas/Trucks sections and the
 * Bread Types page: an explicit Edit mode over local drafts, a review of every
 * pending change, then one Confirm. Nothing is written to Firestore until then.
 */

// New rows added in edit mode don't have a real Firestore id yet, so they're
// given a client-side placeholder prefixed like this. A draft is "new" (not
// yet saved) exactly when its id starts with it — and a new *agent* in a new
// *crew* holds the crew's placeholder id, which handleConfirm swaps for the
// real one once the crew document exists.
const NEW_ID_PREFIX = 'new-';

type GroupDraft = { id: string; name: string; order: number };
type AgentDraft = { id: string; name: string; order: number; groupId: string };

function isNew(id: string) {
  return id.startsWith(NEW_ID_PREFIX);
}

function newId() {
  return `${NEW_ID_PREFIX}${crypto.randomUUID()}`;
}

function byOrder<T extends { order: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order);
}

// Appends after whatever is currently last, regardless of gaps left by earlier
// deletes — only relative order matters, not contiguous numbering.
function nextOrder(items: { order: number }[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((item) => item.order)) + 1;
}

// Which side of the target row the dragged row will land on — matches the
// direction check in `reorder`, so the line shown while dragging is never
// wrong about which gap you're about to drop into.
function dropSide<T extends { id: string }>(sorted: T[], draggingId: string | null, targetId: string) {
  if (!draggingId || draggingId === targetId) return null;
  const fromIndex = sorted.findIndex((item) => item.id === draggingId);
  const toIndex = sorted.findIndex((item) => item.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return null;
  return fromIndex < toIndex ? ('after' as const) : ('before' as const);
}

/**
 * Drops the dragged row right next to the target row, taking over its slot and
 * shifting everything between them along — the same behaviour as the Bread
 * Types page (see that file for the full explanation).
 *
 * Returns the new `order` for each row that moved, keyed by id, so the caller
 * can patch whichever draft list the rows came from.
 */
function reorderedOrders<T extends { id: string; order: number }>(
  scope: T[],
  draggedId: string,
  targetId: string,
): Map<string, number> {
  const sorted = byOrder(scope);
  const fromIndex = sorted.findIndex((item) => item.id === draggedId);
  const toIndex = sorted.findIndex((item) => item.id === targetId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return new Map();

  const draggingDown = fromIndex < toIndex;
  const start = draggingDown ? fromIndex : toIndex;
  const end = draggingDown ? toIndex : fromIndex;
  const range = sorted.slice(start, end + 1);
  const orderValues = range.map((item) => item.order);

  const dragged = range.find((item) => item.id === draggedId)!;
  const displaced = range.filter((item) => item.id !== draggedId);
  const newRange = draggingDown ? [...displaced, dragged] : [dragged, ...displaced];

  return new Map(newRange.map((item, index) => [item.id, orderValues[index]]));
}

type Change =
  | { kind: 'group-added'; draft: GroupDraft }
  | { kind: 'group-edited'; original: AgentGroup; draft: GroupDraft }
  /** The members go with it — listed here rather than as separate removals, since one action removes them all. */
  | { kind: 'group-removed'; original: AgentGroup; members: Agent[] }
  | { kind: 'agent-added'; draft: AgentDraft; groupName: string }
  | { kind: 'agent-edited'; original: Agent; draft: AgentDraft; fromGroupName: string; toGroupName: string }
  | { kind: 'agent-removed'; original: Agent };

function changeId(change: Change): string {
  switch (change.kind) {
    case 'group-added':
    case 'group-edited':
      return `g:${change.draft.id}`;
    case 'group-removed':
      return `g:${change.original.id}`;
    case 'agent-added':
      return `a:${change.draft.id}`;
    case 'agent-edited':
      return `a:${change.draft.id}`;
    case 'agent-removed':
      return `a:${change.original.id}`;
  }
}

export function AgentGroupsSection() {
  const { isAdmin } = useAuth();
  const [groups, setGroups] = useState<AgentGroup[] | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [groupDrafts, setGroupDrafts] = useState<GroupDraft[]>([]);
  const [agentDrafts, setAgentDrafts] = useState<AgentDraft[]>([]);
  const [deletedGroupIds, setDeletedGroupIds] = useState<string[]>([]);
  const [deletedAgentIds, setDeletedAgentIds] = useState<string[]>([]);

  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Which freshly added row should take the caret. Adding a crew mounts two new
  // rows at once — the crew and the blank agent it starts with — and an
  // `autoFocus` on every new row handed the caret to whichever mounted last,
  // which is the agent. The crew's name is what the user came to type first, so
  // the row that asked for focus names itself here instead.
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => watchAgentGroups(setGroups), []);
  useEffect(() => watchAgents(setAgents), []);

  const loading = groups === null || agents === null;

  function enterEditMode() {
    if (!isAdmin) {
      setNotice(ADMIN_ONLY_NOTICE);
      return;
    }
    if (loading) return;
    setGroupDrafts(groups.map((group) => ({ ...group })));
    setAgentDrafts(agents.map((agent) => ({ ...agent })));
    setDeletedGroupIds([]);
    setDeletedAgentIds([]);
    setEditMode(true);
  }

  function discardChanges() {
    setEditMode(false);
    setReviewing(false);
    setNotice(null);
    setFocusId(null);
    setGroupDrafts([]);
    setAgentDrafts([]);
    setDeletedGroupIds([]);
    setDeletedAgentIds([]);
  }

  function membersOf(groupId: string): AgentDraft[] {
    return byOrder(agentDrafts.filter((agent) => agent.groupId === groupId));
  }

  function addGroupRow() {
    const id = newId();
    setGroupDrafts((current) => [...current, { id, name: '', order: nextOrder(current) }]);
    // A crew with nobody in it can't be saved, so it starts with one blank
    // person rather than making that a separate step the user has to discover.
    setAgentDrafts((current) => [...current, { id: newId(), name: '', order: 0, groupId: id }]);
    setFocusId(id);
  }

  function addAgentRow(groupId: string) {
    const id = newId();
    setAgentDrafts((current) => [
      ...current,
      { id, name: '', order: nextOrder(current.filter((a) => a.groupId === groupId)), groupId },
    ]);
    setFocusId(id);
  }

  /**
   * Removes a crew and everyone in it.
   *
   * The members are tracked as deletions in their own right even though
   * `deleteAgentGroup` cascades server-side: someone dragged into this crew
   * during the same edit session no longer belongs to the crew Firestore would
   * cascade over, and would otherwise be left pointing at a group that no
   * longer exists.
   */
  function deleteGroupRow(groupId: string) {
    const memberIds = agentDrafts.filter((agent) => agent.groupId === groupId).map((agent) => agent.id);
    setAgentDrafts((current) => current.filter((agent) => agent.groupId !== groupId));
    setDeletedAgentIds((current) => [...current, ...memberIds.filter((id) => !isNew(id))]);
    setGroupDrafts((current) => current.filter((group) => group.id !== groupId));
    if (!isNew(groupId)) setDeletedGroupIds((current) => [...current, groupId]);
  }

  function deleteAgentRow(id: string) {
    setAgentDrafts((current) => current.filter((agent) => agent.id !== id));
    if (!isNew(id)) setDeletedAgentIds((current) => [...current, id]);
  }

  function updateGroupDraft(id: string, patch: Partial<GroupDraft>) {
    setGroupDrafts((current) => current.map((group) => (group.id === id ? { ...group, ...patch } : group)));
  }

  function updateAgentDraft(id: string, patch: Partial<AgentDraft>) {
    setAgentDrafts((current) => current.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)));
  }

  /** Moves an agent to another crew, landing at the end of it. */
  function moveAgentToGroup(id: string, groupId: string) {
    setAgentDrafts((current) => {
      const destination = current.filter((agent) => agent.groupId === groupId && agent.id !== id);
      return current.map((agent) => (agent.id === id ? { ...agent, groupId, order: nextOrder(destination) } : agent));
    });
  }

  function reorderGroups(draggedId: string, targetId: string) {
    setGroupDrafts((current) => {
      const orders = reorderedOrders(current, draggedId, targetId);
      return current.map((group) => (orders.has(group.id) ? { ...group, order: orders.get(group.id)! } : group));
    });
  }

  /** Drag only reorders **within** a crew; moving between crews is the Crew dropdown. */
  function reorderAgents(draggedId: string, targetId: string) {
    setAgentDrafts((current) => {
      const dragged = current.find((agent) => agent.id === draggedId);
      const target = current.find((agent) => agent.id === targetId);
      if (!dragged || !target || dragged.groupId !== target.groupId) return current;
      const orders = reorderedOrders(
        current.filter((agent) => agent.groupId === dragged.groupId),
        draggedId,
        targetId,
      );
      return current.map((agent) => (orders.has(agent.id) ? { ...agent, order: orders.get(agent.id)! } : agent));
    });
  }

  // Agents whose crew no longer exists. Should never happen from this page —
  // deleting a crew takes its people — but a row written some other way would
  // otherwise be invisible *everywhere*: mobile drops it (it could never be
  // selected), so this page is the only place it can surface. It gets its own
  // bucket in both modes, and in edit mode nothing can be saved until it has
  // been given a crew.
  const orphans = editMode
    ? byOrder(agentDrafts.filter((agent) => !groupDrafts.some((group) => group.id === agent.groupId)))
    : byOrder((agents ?? []).filter((agent) => !(groups ?? []).some((group) => group.id === agent.groupId)));

  const groupNameById = new Map<string, string>([
    ...(groups ?? []).map((group): [string, string] => [group.id, group.name]),
    ...groupDrafts.map((group): [string, string] => [group.id, group.name]),
  ]);

  const changes: Change[] = [
    ...groupDrafts.flatMap((draft): Change[] => {
      const original = groups?.find((group) => group.id === draft.id);
      if (!original) return [{ kind: 'group-added', draft }];
      return original.name === draft.name && original.order === draft.order
        ? []
        : [{ kind: 'group-edited', original, draft }];
    }),
    ...deletedGroupIds.flatMap((id): Change[] => {
      const original = groups?.find((group) => group.id === id);
      if (!original) return [];
      return [{ kind: 'group-removed', original, members: (agents ?? []).filter((a) => a.groupId === id) }];
    }),
    ...agentDrafts.flatMap((draft): Change[] => {
      const original = agents?.find((agent) => agent.id === draft.id);
      if (!original) {
        return [{ kind: 'agent-added', draft, groupName: groupNameById.get(draft.groupId) ?? '' }];
      }
      if (original.name === draft.name && original.order === draft.order && original.groupId === draft.groupId) {
        return [];
      }
      return [
        {
          kind: 'agent-edited',
          original,
          draft,
          fromGroupName: groupNameById.get(original.groupId) ?? '',
          toGroupName: groupNameById.get(draft.groupId) ?? '',
        },
      ];
    }),
    // An agent removed *as part of* a crew removal is listed inside that
    // crew's entry instead — one action, one line in the review.
    ...deletedAgentIds.flatMap((id): Change[] => {
      const original = agents?.find((agent) => agent.id === id);
      if (!original || deletedGroupIds.includes(original.groupId)) return [];
      return [{ kind: 'agent-removed', original }];
    }),
  ];

  const draftsValid =
    groupDrafts.every((group) => group.name.trim().length > 0) &&
    agentDrafts.every((agent) => agent.name.trim().length > 0);

  function handleReviewClick() {
    if (changes.length === 0) {
      setNotice('No changes to review.');
      return;
    }
    if (orphans.length > 0) {
      setNotice(`“${orphans[0].name.trim() || 'This agent'}” is not in a crew. Every agent has to be in one.`);
      return;
    }

    const duplicateGroup = findDuplicate(groupDrafts);
    if (duplicateGroup) {
      setNotice(`“${duplicateGroup}” is on this list more than once.`);
      return;
    }
    const duplicateAgent = findDuplicate(agentDrafts);
    if (duplicateAgent) {
      setNotice(`“${duplicateAgent}” is on this list more than once.`);
      return;
    }

    // A crew with nobody in it can be picked on a phone and would assign no
    // one to the day, so it is refused here rather than shipped to the truck.
    const empty = byOrder(groupDrafts).find((group) => membersOf(group.id).length === 0);
    if (empty) {
      setNotice(`“${empty.name.trim() || 'This crew'}” has no agents in it. Add at least one, or delete the crew.`);
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
      // Crews first, and awaited: an agent's write names its crew, so a brand
      // new crew has to exist — and have a real id — before anyone can be put
      // in it. Everything downstream reads the placeholder id through `idMap`.
      const idMap = new Map<string, string>();
      for (const change of changes) {
        if (change.kind === 'group-added') {
          idMap.set(change.draft.id, await addAgentGroup({ name: change.draft.name, order: change.draft.order }));
        }
      }
      const resolveGroupId = (id: string) => idMap.get(id) ?? id;

      await Promise.all(
        changes.map((change) => {
          switch (change.kind) {
            case 'group-added':
              return Promise.resolve();
            case 'group-edited':
              return updateAgentGroup(change.draft.id, { name: change.draft.name, order: change.draft.order });
            case 'agent-added':
              return addAgent({
                name: change.draft.name,
                order: change.draft.order,
                groupId: resolveGroupId(change.draft.groupId),
              });
            case 'agent-edited':
              return updateAgent(change.draft.id, {
                name: change.draft.name,
                order: change.draft.order,
                groupId: resolveGroupId(change.draft.groupId),
              });
            case 'agent-removed':
              return deleteAgent(change.original.id);
            case 'group-removed':
              // Removes its members too, re-read server-side — see
              // lib/agent-groups.ts.
              return deleteAgentGroup(change.original.id);
          }
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

  const visibleGroups = editMode ? byOrder(groupDrafts) : (groups ?? []);

  return (
    <div>
      <div className="page-header">
        <h1>Agents</h1>
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
            <button type="button" className="btn-secondary" onClick={enterEditMode} disabled={loading}>
              Edit
            </button>
          )}
        </div>
      </div>

      <p className="hint catalog-hint">
        The staff who ride a truck, organised into crews. A truck is assigned a whole crew when its day starts — never
        one person at a time — so every agent has to be in one.
      </p>

      {notice && <NoticeModal message={notice} onClose={() => setNotice(null)} />}

      {loading ? (
        <p className="hint">Loading…</p>
      ) : !editMode && groups.length === 0 && orphans.length === 0 ? (
        <p className="hint">No crews yet. Press Edit to add the first one — trucks can’t finish setup without one.</p>
      ) : (
        <div className="table-scroll">
          <table className="bread-table crew-table">
            <thead>
              <tr>
                <th className="row-number-col" />
                <th>Name</th>
                {editMode && <th className="crew-move-col">Crew</th>}
                {editMode && <th />}
              </tr>
            </thead>
            <tbody>
              {orphans.length > 0 && (
                <>
                  <tr className="crew-group-row crew-orphan-row">
                    <td className="row-number-col" />
                    <td className="crew-group-name">Not in a crew</td>
                    {editMode && <td />}
                    {editMode && <td />}
                  </tr>
                  {orphans.map((agent) =>
                    editMode ? (
                      <AgentRow
                        key={agent.id}
                        draft={agent}
                        position={null}
                        groups={byOrder(groupDrafts)}
                        isNew={isNew(agent.id)}
                        autoFocus={agent.id === focusId}
                        isDragging={false}
                        dragOverSide={null}
                        onChange={(patch) => updateAgentDraft(agent.id, patch)}
                        onGroupChange={(groupId) => moveAgentToGroup(agent.id, groupId)}
                        onDelete={() => deleteAgentRow(agent.id)}
                        // No drag: this bucket has no order of its own, so
                        // there is nothing to reorder within it.
                        drag={null}
                      />
                    ) : (
                      <tr key={agent.id} className="crew-agent-row">
                        <td className="row-number-col" />
                        <td className="crew-agent-cell">{agent.name}</td>
                      </tr>
                    ),
                  )}
                </>
              )}

              {visibleGroups.map((group, groupIndex) => {
                const members = editMode
                  ? membersOf(group.id)
                  : byOrder((agents ?? []).filter((agent) => agent.groupId === group.id));
                const sortedGroups = byOrder(groupDrafts);

                return (
                  <GroupBlock
                    key={group.id}
                    group={group}
                    position={groupIndex + 1}
                    members={members}
                    editMode={editMode}
                    isNew={isNew(group.id)}
                    focusId={focusId}
                    draggingId={draggingId}
                    groupDropSide={
                      dragOverId === group.id ? dropSide(sortedGroups, draggingId, group.id) : null
                    }
                    allGroups={sortedGroups}
                    onGroupChange={(patch) => updateGroupDraft(group.id, patch)}
                    onGroupDelete={() => deleteGroupRow(group.id)}
                    onAgentChange={updateAgentDraft}
                    onAgentGroupChange={moveAgentToGroup}
                    onAgentDelete={deleteAgentRow}
                    onAddAgent={() => addAgentRow(group.id)}
                    onDragStart={setDraggingId}
                    onDragEnter={setDragOverId}
                    onDropGroup={(targetId) => {
                      if (draggingId) reorderGroups(draggingId, targetId);
                      setDraggingId(null);
                      setDragOverId(null);
                    }}
                    onDropAgent={(targetId) => {
                      if (draggingId) reorderAgents(draggingId, targetId);
                      setDraggingId(null);
                      setDragOverId(null);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDragOverId(null);
                    }}
                    agentDropSide={(scope, targetId) =>
                      dragOverId === targetId ? dropSide(scope, draggingId, targetId) : null
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editMode && (
        <div className="catalog-row-actions">
          <button type="button" className="btn-secondary add-row-button" onClick={addGroupRow}>
            + Add crew
          </button>
        </div>
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

/**
 * A duplicate name isn't blocked by Firestore, and two identically named crews
 * (or two identically named people) would be genuinely ambiguous in a report —
 * so it's caught here. Returns the offending name, or undefined.
 */
function findDuplicate(rows: { id: string; name: string }[]): string | undefined {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) return row.name.trim();
    seen.set(key, row.id);
  }
  return undefined;
}

function GroupBlock({
  group,
  position,
  members,
  editMode,
  isNew: groupIsNew,
  draggingId,
  groupDropSide,
  allGroups,
  onGroupChange,
  onGroupDelete,
  onAgentChange,
  onAgentGroupChange,
  onAgentDelete,
  onAddAgent,
  focusId,
  onDragStart,
  onDragEnter,
  onDropGroup,
  onDropAgent,
  onDragEnd,
  agentDropSide,
}: {
  group: { id: string; name: string; order: number };
  position: number;
  members: { id: string; name: string; order: number; groupId: string }[];
  editMode: boolean;
  isNew: boolean;
  /** Id of the row that was just added, if any — it takes the caret. */
  focusId: string | null;
  draggingId: string | null;
  groupDropSide: 'before' | 'after' | null;
  allGroups: GroupDraft[];
  onGroupChange: (patch: Partial<GroupDraft>) => void;
  onGroupDelete: () => void;
  onAgentChange: (id: string, patch: Partial<AgentDraft>) => void;
  onAgentGroupChange: (id: string, groupId: string) => void;
  onAgentDelete: (id: string) => void;
  onAddAgent: () => void;
  onDragStart: (id: string) => void;
  onDragEnter: (id: string) => void;
  onDropGroup: (targetId: string) => void;
  onDropAgent: (targetId: string) => void;
  onDragEnd: () => void;
  agentDropSide: (scope: { id: string; order: number }[], targetId: string) => 'before' | 'after' | null;
}) {
  const columns = editMode ? 4 : 2;

  return (
    <>
      <tr
        className={[
          'crew-group-row',
          draggingId === group.id ? 'dragging' : '',
          groupDropSide ? `drag-over-${groupDropSide}` : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={(event) => event.preventDefault()}
        onDragEnter={() => onDragEnter(group.id)}
        onDrop={(event) => {
          event.preventDefault();
          onDropGroup(group.id);
        }}
        onDragEnd={onDragEnd}>
        <td className="row-number-col">
          {editMode && (
            <span
              className="drag-handle"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', group.id);
                event.dataTransfer.effectAllowed = 'move';
                onDragStart(group.id);
              }}
              title="Drag to reorder">
              ⠿
            </span>
          )}
          <span className="row-number">{position}</span>
        </td>
        <td>
          {editMode ? (
            <input
              className="table-input"
              type="text"
              value={group.name}
              placeholder={groupIsNew ? 'Enter crew name' : undefined}
              autoFocus={group.id === focusId}
              onChange={(event) => onGroupChange({ name: event.target.value })}
            />
          ) : (
            <span className="crew-group-name">{group.name}</span>
          )}
        </td>
        {editMode && <td />}
        {editMode && (
          <td>
            <div className="bread-table-actions">
              <button type="button" className="danger" onClick={onGroupDelete}>
                {groupIsNew ? 'Remove' : 'Delete crew'}
              </button>
            </div>
          </td>
        )}
      </tr>

      {members.map((member, index) =>
        editMode ? (
          <AgentRow
            key={member.id}
            draft={member}
            position={index + 1}
            groups={allGroups}
            isNew={isNew(member.id)}
            autoFocus={member.id === focusId}
            isDragging={draggingId === member.id}
            dragOverSide={agentDropSide(members, member.id)}
            onChange={(patch) => onAgentChange(member.id, patch)}
            onGroupChange={(groupId) => onAgentGroupChange(member.id, groupId)}
            onDelete={() => onAgentDelete(member.id)}
            drag={{
              onDragStart: () => onDragStart(member.id),
              onDragEnter: () => onDragEnter(member.id),
              onDrop: () => onDropAgent(member.id),
              onDragEnd,
            }}
          />
        ) : (
          <tr key={member.id} className="crew-agent-row">
            <td className="row-number-col">
              <span className="row-number">{index + 1}</span>
            </td>
            <td className="crew-agent-cell">{member.name}</td>
          </tr>
        ),
      )}

      {!editMode && members.length === 0 && (
        <tr className="crew-agent-row">
          <td className="row-number-col" />
          <td className="crew-agent-cell hint">Nobody in this crew yet.</td>
        </tr>
      )}

      {editMode && (
        <tr className="crew-add-row">
          <td className="row-number-col" />
          <td colSpan={columns - 1}>
            <button type="button" className="btn-secondary crew-add-agent" onClick={onAddAgent}>
              + Add agent to {group.name.trim() || 'this crew'}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

function AgentRow({
  draft,
  position,
  groups,
  isNew: agentIsNew,
  autoFocus,
  isDragging,
  dragOverSide,
  onChange,
  onGroupChange,
  onDelete,
  drag,
}: {
  draft: { id: string; name: string; order: number; groupId: string };
  /** 1-based position **within its crew** — a render-time label, not stored on the row. */
  position: number | null;
  groups: GroupDraft[];
  isNew: boolean;
  /** True only for the row that was just added — see `focusId`. */
  autoFocus: boolean;
  isDragging: boolean;
  /** Which gap is highlighted while something is dragged over this row — matches where it'll land. */
  dragOverSide: 'before' | 'after' | null;
  onChange: (patch: Partial<AgentDraft>) => void;
  onGroupChange: (groupId: string) => void;
  onDelete: () => void;
  /** Null for a row that can't be dragged — the "Not in a crew" bucket has no order of its own. */
  drag: { onDragStart: () => void; onDragEnter: () => void; onDrop: () => void; onDragEnd: () => void } | null;
}) {
  return (
    <tr
      className={[
        'crew-agent-row',
        isDragging ? 'dragging' : '',
        dragOverSide ? `drag-over-${dragOverSide}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={drag?.onDragEnter}
      onDrop={
        drag
          ? (event) => {
              event.preventDefault();
              drag.onDrop();
            }
          : undefined
      }
      onDragEnd={drag?.onDragEnd}>
      <td className="row-number-col">
        {drag && (
          <span
            className="drag-handle"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', draft.id);
              event.dataTransfer.effectAllowed = 'move';
              drag.onDragStart();
            }}
            title="Drag to reorder within the crew">
            ⠿
          </span>
        )}
        {position !== null && <span className="row-number">{position}</span>}
      </td>
      <td className="crew-agent-cell">
        <input
          className="table-input"
          type="text"
          value={draft.name}
          placeholder={agentIsNew ? 'Enter agent name' : undefined}
          autoFocus={autoFocus}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </td>
      <td>
        {/* Where an agent changes crew. Dragging only reorders inside a crew —
            a dropdown says plainly which crews exist and which one this person
            is going to, which drag-and-drop across a long table does not. */}
        <select
          className="table-input crew-select"
          value={groups.some((group) => group.id === draft.groupId) ? draft.groupId : ''}
          onChange={(event) => onGroupChange(event.target.value)}>
          <option value="" disabled>
            Choose a crew
          </option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name.trim() || '(untitled crew)'}
            </option>
          ))}
        </select>
      </td>
      <td>
        <div className="bread-table-actions">
          <button type="button" className="danger" onClick={onDelete}>
            {agentIsNew ? 'Remove' : 'Delete'}
          </button>
        </div>
      </td>
    </tr>
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
  const hasRemovals = changes.some((change) => change.kind === 'group-removed' || change.kind === 'agent-removed');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wide" onClick={(event) => event.stopPropagation()}>
        <h2>Review changes</h2>

        {hasRemovals && (
          // Same point the Areas/Trucks review makes: past records are safe
          // because each run stores the names it saw at the time. What breaks
          // is anything still pointing at the id — a phone mid-setup.
          <p className="modal-warning">
            Days already recorded keep the crew and names they were saved with, and are not affected. But any phone that
            has already picked a deleted crew will need to choose again.
          </p>
        )}

        <div className="review-list">
          {changes.map((change) => (
            <div key={changeId(change)} className="review-item">
              <ChangeSummary change={change} />
            </div>
          ))}
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

function ChangeSummary({ change }: { change: Change }) {
  switch (change.kind) {
    case 'group-added':
      return (
        <h3>
          Crew: {change.draft.name || '(untitled)'}
          <span className="review-badge">New</span>
        </h3>
      );

    case 'group-edited':
      return (
        <>
          <h3>
            Crew: {change.draft.name || '(untitled)'}
            {change.original.order !== change.draft.order && <span className="review-badge">Reordered</span>}
          </h3>
          {change.original.name !== change.draft.name && (
            <div className="review-diff">
              <DiffLine label="Name" from={change.original.name} to={change.draft.name} />
            </div>
          )}
        </>
      );

    case 'group-removed':
      return (
        <>
          <h3>
            Crew: {change.original.name || '(untitled)'}
            <span className="review-badge review-badge-removed">Removed</span>
          </h3>
          {/* Named one by one on purpose: deleting a crew deletes its people,
              and that has to be visible before it happens rather than being
              discovered afterwards. */}
          <div className="review-diff">
            <DiffLine
              label={change.members.length === 1 ? 'Also deletes' : `Also deletes ${change.members.length}`}
              from={null}
              to={
                change.members.length > 0
                  ? change.members.map((member) => member.name || '(untitled)').join(', ')
                  : 'nobody — the crew is empty'
              }
            />
          </div>
        </>
      );

    case 'agent-added':
      return (
        <h3>
          {change.draft.name || '(untitled)'}
          <span className="review-badge">New</span>
          <span className="review-crew-note">in {change.groupName.trim() || '(untitled crew)'}</span>
        </h3>
      );

    case 'agent-removed':
      return (
        <h3>
          {change.original.name || '(untitled)'}
          <span className="review-badge review-badge-removed">Removed</span>
        </h3>
      );

    case 'agent-edited': {
      const movedCrew = change.original.groupId !== change.draft.groupId;
      const renamed = change.original.name !== change.draft.name;
      return (
        <>
          <h3>
            {change.draft.name || '(untitled)'}
            {movedCrew && <span className="review-badge">Moved crew</span>}
            {!movedCrew && change.original.order !== change.draft.order && (
              <span className="review-badge">Reordered</span>
            )}
          </h3>
          {(renamed || movedCrew) && (
            <div className="review-diff">
              {renamed && <DiffLine label="Name" from={change.original.name} to={change.draft.name} />}
              {movedCrew && (
                <DiffLine
                  label="Crew"
                  from={change.fromGroupName.trim() || '(none)'}
                  to={change.toGroupName.trim() || '(none)'}
                />
              )}
            </div>
          )}
        </>
      );
    }
  }
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
