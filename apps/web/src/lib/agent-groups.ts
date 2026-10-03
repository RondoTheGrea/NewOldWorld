import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  getDocs,
} from 'firebase/firestore';

import { db } from '@/lib/firebase';

/**
 * Crews, and the people in them.
 *
 * A truck is assigned a **whole group**, never a hand-picked set of people —
 * the mobile setup screen lists groups and the driver confirms one (see
 * `apps/mobile/src/components/agent-group-field.tsx`). So every agent belongs
 * to exactly one group, and an agent with no group is unreachable: nothing on
 * the phone can ever put them on a truck.
 *
 * That is why this module keeps the two collections together rather than
 * running `agents` through `named-records.ts` alongside areas and trucks. The
 * invariant "every agent is in a group" is only true if the two are written as
 * one edit — deleting a group has to take its agents with it, and creating an
 * agent has to name its group in the same write.
 *
 * Two collections rather than one document holding an array of members,
 * because the **ids** matter downstream: a run records `agentGroupId` *and*
 * the `agentIds` of who was aboard when it started. Array elements have no
 * stable id, so a rename would be indistinguishable from a swap.
 *
 * Renaming either is safe and deleting is mostly safe: ids never change on a
 * rename, and runs snapshot the names they saw at the time, so history never
 * rewrites itself. See docs/sync-design.md.
 */

export type AgentGroup = {
  id: string;
  name: string;
  /** Manual display position on the dashboard — lower shows first. Not necessarily contiguous. */
  order: number;
};

export type Agent = {
  id: string;
  name: string;
  /** Position **within its group**, not across the whole list. */
  order: number;
  /** The crew this agent rides with. Never empty for an agent the dashboard wrote. */
  groupId: string;
};

export type AgentGroupInput = { name: string; order: number };
export type AgentInput = { name: string; order: number; groupId: string };

const GroupsCollection = 'agentGroups';
const AgentsCollection = 'agents';

/**
 * Live-subscribes to the crews, sorted by the manual `order` field.
 *
 * The query asks Firestore for *name* order rather than `order`, for the same
 * reason `watchNamedRecords` does: `orderBy('order')` silently drops any doc
 * that doesn't carry the field yet, which is exactly the docs that predate it.
 * Every doc is read, a missing `order` is backfilled to its current
 * alphabetical position (a one-time, self-healing write), and the real sort
 * happens here. Returns the unsubscribe fn.
 */
export function watchAgentGroups(callback: (groups: AgentGroup[]) => void) {
  const q = query(collection(db, GroupsCollection), orderBy('name'));
  return onSnapshot(q, (snapshot) => {
    const groups = snapshot.docs.map((d, index) => {
      const data = d.data();
      const hasOrder = typeof data.order === 'number';
      const order = hasOrder ? (data.order as number) : index;
      if (!hasOrder) void updateDoc(doc(db, GroupsCollection, d.id), { order });
      return { id: d.id, name: (data.name as string) ?? '', order };
    });
    callback([...groups].sort((a, b) => a.order - b.order));
  });
}

/**
 * Live-subscribes to every agent, across every group, sorted by group then by
 * position within it.
 *
 * All of them at once rather than a listener per group: the whole page is one
 * edit surface (drag someone from one crew to another and both change), and a
 * business has tens of agents, not thousands.
 *
 * An agent whose `groupId` names a group that no longer exists still comes
 * back here. The page renders those in an "Unassigned" bucket so they can be
 * put somewhere rather than being invisible — see `pages/reference-lists.tsx`.
 */
export function watchAgents(callback: (agents: Agent[]) => void) {
  const q = query(collection(db, AgentsCollection), orderBy('name'));
  return onSnapshot(q, (snapshot) => {
    const agents = snapshot.docs.map((d, index) => {
      const data = d.data();
      const hasOrder = typeof data.order === 'number';
      const order = hasOrder ? (data.order as number) : index;
      if (!hasOrder) void updateDoc(doc(db, AgentsCollection, d.id), { order });
      return {
        id: d.id,
        name: (data.name as string) ?? '',
        order,
        groupId: (data.groupId as string) ?? '',
      };
    });
    callback([...agents].sort((a, b) => a.groupId.localeCompare(b.groupId) || a.order - b.order));
  });
}

export async function addAgentGroup(input: AgentGroupInput): Promise<string> {
  const ref = await addDoc(collection(db, GroupsCollection), {
    ...input,
    name: input.name.trim(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateAgentGroup(id: string, input: AgentGroupInput) {
  await updateDoc(doc(db, GroupsCollection, id), {
    ...input,
    name: input.name.trim(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Removes a crew **and everyone in it**.
 *
 * Not a convenience: an agent whose group is gone can never be assigned to a
 * truck again, so leaving them behind would quietly build up staff who exist
 * in the database and nowhere a phone can reach. The review modal on the
 * dashboard names each one before this runs, so the removal is never a
 * surprise.
 *
 * Members are re-read here rather than taken from the caller's draft state, so
 * an agent added to this group from another browser tab in the meantime goes
 * with it instead of being orphaned.
 */
export async function deleteAgentGroup(id: string) {
  const members = await getDocs(query(collection(db, AgentsCollection), where('groupId', '==', id)));
  await Promise.all(members.docs.map((d) => deleteDoc(doc(db, AgentsCollection, d.id))));
  await deleteDoc(doc(db, GroupsCollection, id));
}

export async function addAgent(input: AgentInput) {
  await addDoc(collection(db, AgentsCollection), {
    ...input,
    name: input.name.trim(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateAgent(id: string, input: AgentInput) {
  await updateDoc(doc(db, AgentsCollection, id), {
    ...input,
    name: input.name.trim(),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteAgent(id: string) {
  await deleteDoc(doc(db, AgentsCollection, id));
}
