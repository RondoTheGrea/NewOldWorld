import { useEffect, useMemo, useState } from 'react';

import { DatePicker } from '@/components/date-picker';
import { PeriodExportDialog } from '@/components/period-export-dialog';
import { RunPanel } from '@/components/run-panel';
import {
  currentBusinessDayKey,
  formatBusinessDayLong,
  formatBusinessTime,
  formatDuration,
  shiftBusinessDay,
} from '@/lib/business-day';
import { watchAgentGroups, type AgentGroup } from '@/lib/agent-groups';
import { watchBreadTypes, type BreadType } from '@/lib/bread-types';
import { watchReturnedBreadTypes, type ReturnedBreadType } from '@/lib/returned-bread-types';
import { watchNamedRecords, type NamedRecord } from '@/lib/named-records';
import {
  countBusinessDays,
  crewTripNumber,
  describeRunEnd,
  formatCount,
  formatMoney,
  runEndDay,
  runSpansDays,
  totalReceipts,
  watchRunExpenses,
  watchRunReceipts,
  watchRunStockEntries,
  watchRunsForDay,
  type Run,
  type RunExpense,
  type RunReceipt,
  type RunStockEntry,
} from '@/lib/runs';

/**
 * The Live tab: one business day, as it happens.
 *
 * The unit is the **area**, because that is the unit the business runs on: a
 * truck serves one area for one trip out, and "how is Cainta doing" is a
 * question with an answer, while "how is Truck 2 doing" depends on where it
 * went. Each area holds its runs; each run opens into its own panel.
 *
 * Everything here is live. The runs of a day, and every run's receipts and
 * ledger entries, are Firestore snapshot listeners — a receipt finalized on a
 * phone in Cainta appears as soon as it uploads, with no refresh.
 *
 * **A day is a Manila day, matched on the string the phone wrote.** The date
 * picker only decides which day to ask for; nothing here derives a day from a
 * timestamp. See lib/business-day.ts — a browser open in another timezone would
 * otherwise file a 6:30 AM Manila receipt under the previous day, which is
 * precisely the bug the stored string prevents.
 */

/** How often "out for 3h 12m" and the live totals re-render. */
const ClockTickMs = 30_000;

export function LiveBoard() {
  const [day, setDay] = useState(currentBusinessDayKey);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [areas, setAreas] = useState<NamedRecord[]>([]);
  // Only the summary export reads these — it lists crews in the dashboard's order.
  const [agentGroups, setAgentGroups] = useState<AgentGroup[]>([]);
  // The whole catalog, not just its names: the run panel's Inventory and
  // Outcome tables list bread in the catalog's own manual order (see
  // watchBreadTypes), so it needs the rows, in that order.
  const [breadTypes, setBreadTypes] = useState<BreadType[]>([]);
  // And the old-price catalog beside it: the Outcome table folds returns in by
  // name, and this is the list that places a return no bread type is named
  // after (see buildOutcomeRows).
  const [returnedBreadTypes, setReturnedBreadTypes] = useState<ReturnedBreadType[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  /** Whether the "Export a summary" dialog is open. It owns the range it exports; this tab stays on one day. */
  const [exportOpen, setExportOpen] = useState(false);

  const now = useNow();
  const today = currentBusinessDayKey();

  useEffect(() => {
    setRuns(null);
    setRunsError(null);
    return watchRunsForDay(day, setRuns, () =>
      setRunsError('Could not load the day. Check your connection — this page reloads on its own once it is back.'),
    );
  }, [day]);

  useEffect(() => watchNamedRecords('areas', setAreas), []);

  useEffect(() => watchAgentGroups(setAgentGroups), []);

  useEffect(() => watchBreadTypes(setBreadTypes), []);

  useEffect(() => watchReturnedBreadTypes(setReturnedBreadTypes), []);

  const records = useRunRecords(runs);
  const groups = useMemo(() => groupByArea(areas, runs ?? []), [areas, runs]);
  const dayReceipts = useMemo(
    () => (runs ?? []).flatMap((run) => records.receipts.get(run.id) ?? []),
    [runs, records.receipts],
  );
  const dayTotals = useMemo(() => totalReceipts(dayReceipts), [dayReceipts]);

  const selectedRun = (runs ?? []).find((run) => run.id === selectedRunId) ?? null;
  const openRuns = (runs ?? []).filter((run) => run.status === 'open');

  return (
    <>
      <div className="ops-daybar">
        <div>
          <span className="ops-label">{day === today ? 'Today' : 'Business day'}</span>
          <h1>{formatBusinessDayLong(day)}</h1>
          <div className="ops-daybar-when">
            {day === today ? (
              <span className="ops-pill ops-pill-live">
                <span className="ops-dot" />
                Live
              </span>
            ) : (
              <span className="ops-pill ops-pill-closed">Past day</span>
            )}
            <span>Philippine time · {day}</span>
          </div>
        </div>

        {/* The day's own controls and the one action taken *on* a day, side by
            side but not dressed alike: ‹ Today › and the calendar are four ways
            of moving the same day and share one chrome (see .ops-daynav in
            overview.css), while Export is an action and reads as one. Putting
            it in .ops-daynav would have given it the day bar's button styling
            and made it look like a fifth way to navigate. */}
        <div className="ops-daybar-tools">
          <div className="ops-daynav">
            <button type="button" onClick={() => setDay(shiftBusinessDay(day, -1))} aria-label="Previous day">
              ‹
            </button>
            <button type="button" onClick={() => setDay(today)} disabled={day === today}>
              Today
            </button>
            {/* Forward stops at today: a future business day cannot hold a run,
                and an empty page nobody can explain reads as a fault. */}
            <button
              type="button"
              onClick={() => setDay(shiftBusinessDay(day, 1))}
              disabled={day >= today}
              aria-label="Next day">
              ›
            </button>
            {/* The same calendar the Trends tab uses, limited to one day: ‹ and
                › are fine for yesterday, useless for last month. `max` is today
                for the same reason › stops there. */}
            <DatePicker
              value={day}
              max={today}
              onChange={setDay}
              triggerClassName="ops-daynav-date"
              triggerAriaLabel="Pick a date"
              triggerLabel={
                <>
                  <CalendarIcon />
                  <span>Pick a date</span>
                </>
              }
            />
          </div>

          {/* The summary export picks its own range, measured from today and
              not from whatever day this bar is showing — see
              components/period-export-dialog.tsx for why the range lives in a
              dialog rather than in this bar. */}
          <button
            type="button"
            className="ops-daybar-export"
            onClick={() => setExportOpen(true)}
            aria-haspopup="dialog">
            Export summary
          </button>
        </div>
      </div>

      <div className="ops-stats">
        <div className="ops-stat">
          <span className="ops-label">Trucks out</span>
          <div className="ops-figure">{formatCount(openRuns.length)}</div>
          <p className="ops-stat-note">
            {runs === null ? 'Loading…' : `${formatCount(runs.length)} run${runs.length === 1 ? '' : 's'} today`}
          </p>
        </div>
        <div className="ops-stat">
          <span className="ops-label">Sales</span>
          <div className="ops-figure">{formatMoney(dayTotals.salesTotal)}</div>
          <p className="ops-stat-note">before returns</p>
        </div>
        <div className="ops-stat">
          <span className="ops-label">Returns</span>
          <div className="ops-figure">{formatMoney(dayTotals.returnsTotal)}</div>
          <p className="ops-stat-note">credited back</p>
        </div>
        <div className="ops-stat ops-stat-accent">
          <span className="ops-label">Net</span>
          <div className="ops-figure">{formatMoney(dayTotals.netTotal)}</div>
          <p className="ops-stat-note">sales less returns</p>
        </div>
        <div className="ops-stat">
          <span className="ops-label">Receipts</span>
          <div className="ops-figure">{formatCount(dayTotals.receiptCount)}</div>
          <p className="ops-stat-note">
            {dayTotals.storeCount === 1 ? '1 store served' : `${formatCount(dayTotals.storeCount)} stores served`}
          </p>
        </div>
      </div>

      <DayNotices runs={runs ?? []} />

      {runsError && (
        <div className="ops-day-notices">
          <div className="ops-notice ops-notice-alert">{runsError}</div>
        </div>
      )}

      {runs === null ? (
        <p className="ops-muted">Loading the day…</p>
      ) : groups.length === 0 ? (
        <div className="ops-empty">
          <strong>No areas yet</strong>
          Add an area under “Areas &amp; Trucks” — a truck can’t start a day without one.
        </div>
      ) : (
        <div className="ops-areas">
          {groups.map((group) => (
            <AreaSection
              key={group.id}
              group={group}
              records={records}
              now={now}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
            />
          ))}
        </div>
      )}

      {exportOpen && (
        <PeriodExportDialog
          agentGroups={agentGroups}
          areas={areas}
          breadTypes={breadTypes}
          returnedBreadTypes={returnedBreadTypes}
          onClose={() => setExportOpen(false)}
        />
      )}

      {selectedRun && (
        <RunPanel
          run={selectedRun}
          tripNumber={crewTripNumber(selectedRun, runs ?? [])}
          receipts={records.receipts.get(selectedRun.id) ?? null}
          entries={records.entries.get(selectedRun.id) ?? null}
          expenses={records.expenses.get(selectedRun.id) ?? null}
          breadTypes={breadTypes}
          returnedBreadTypes={returnedBreadTypes}
          now={now}
          onClose={() => setSelectedRunId(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

type AreaGroup = {
  id: string;
  name: string;
  runs: Run[];
  /** False for an area a run was filed under that has since been deleted from the Areas list. */
  known: boolean;
};

/**
 * Every area, with the day's runs hung off it.
 *
 * Areas with no runs are kept rather than dropped: "Pasig has no truck out" is
 * a fact worth seeing on an operations board, and an area that quietly vanished
 * from the page would be indistinguishable from one nobody set up.
 *
 * A run whose `areaId` is no longer on the Areas list still gets a group of its
 * own, labelled with the name the run captured when it started. Deleting an
 * area does not rewrite history — runs snapshot the name — so the day it
 * belonged to must still be readable.
 */
function groupByArea(areas: NamedRecord[], runs: Run[]): AreaGroup[] {
  const groups = new Map<string, AreaGroup>();

  for (const area of areas) {
    groups.set(area.id, { id: area.id, name: area.name, runs: [], known: true });
  }

  for (const run of runs) {
    const existing = groups.get(run.areaId);
    if (existing) {
      existing.runs.push(run);
      continue;
    }
    const orphan = groups.get(`missing:${run.areaId}`) ?? {
      id: `missing:${run.areaId}`,
      name: run.areaName || 'No area',
      runs: [],
      known: false,
    };
    orphan.runs.push(run);
    groups.set(orphan.id, orphan);
  }

  // Busiest first, and anything live above everything else — the page is read
  // top-down while something is happening, and scrolled only when it isn't.
  return [...groups.values()].sort((a, b) => {
    const liveA = a.runs.some((run) => run.status === 'open') ? 1 : 0;
    const liveB = b.runs.some((run) => run.status === 'open') ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    if (a.runs.length !== b.runs.length) return b.runs.length - a.runs.length;
    return a.name.localeCompare(b.name);
  });
}

function AreaSection({
  group,
  records,
  now,
  selectedRunId,
  onSelect,
}: {
  group: AreaGroup;
  records: RunRecords;
  now: number;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const receipts = group.runs.flatMap((run) => records.receipts.get(run.id) ?? []);
  const totals = totalReceipts(receipts);
  const openCount = group.runs.filter((run) => run.status === 'open').length;

  return (
    <section className={openCount > 0 ? 'ops-area ops-area-live' : 'ops-area'}>
      <div className="ops-area-head">
        <h2 className="ops-area-name">
          {group.name}
          {openCount > 0 && (
            <span className="ops-pill ops-pill-live">
              <span className="ops-dot" />
              {openCount === 1 ? '1 truck out' : `${openCount} trucks out`}
            </span>
          )}
          {!group.known && <span className="ops-pill ops-pill-warn">Area deleted</span>}
        </h2>

        {group.runs.length > 0 && (
          <div className="ops-area-metrics">
            <span className="ops-area-metric">
              <b>{formatMoney(totals.netTotal)}</b> net
            </span>
            <span className="ops-area-metric">
              <b>{formatCount(totals.receiptCount)}</b> receipts
            </span>
            <span className="ops-area-metric">
              <b>{formatCount(totals.storeCount)}</b> stores
            </span>
          </div>
        )}
      </div>

      {group.runs.length === 0 ? (
        <p className="ops-area-idle">No truck started a day in this area.</p>
      ) : (
        <div className="ops-runs-scroll">
          <table className="ops-runs">
            <thead>
              <tr>
                <th>Crew</th>
                <th>Truck</th>
                <th>Hours</th>
                <th className="ops-num">Receipts</th>
                <th className="ops-num">Net</th>
                <th className="ops-num">Sold</th>
                <th className="ops-num">Returns</th>
              </tr>
            </thead>
            <tbody>
              {group.runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  records={records}
                  now={now}
                  selected={run.id === selectedRunId}
                  onSelect={onSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RunRow({
  run,
  records,
  now,
  selected,
  onSelect,
}: {
  run: Run;
  records: RunRecords;
  now: number;
  selected: boolean;
  onSelect: (runId: string) => void;
}) {
  const receipts = records.receipts.get(run.id) ?? null;
  const totals = totalReceipts(receipts ?? []);
  const problem = runProblem(run);
  const memberNames = run.agents.map((agent) => agent.name).join(', ');
  /* The bold line is the crew, and it is never blank: a run recorded before
     crews existed (or one whose crew was since renamed away) falls back to the
     people, then to the login that started it. The muted line under it is the
     membership, shown only when it isn't already saying the same thing as the
     line above. */
  const crewName = run.agentGroupName || memberNames || run.createdByEmail || '—';
  const crewMembers = run.agentGroupName && memberNames ? memberNames : null;
  const spansDays = runSpansDays(run);
  const dayCount = countBusinessDays(run.businessDay, runEndDay(run));

  return (
    <tr
      className={selected ? 'ops-run-selected' : undefined}
      onClick={() => onSelect(run.id)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(run.id);
        }
      }}>
      {/* The crew leads the row, because who went out is what a manager
          assigned and what they ask about; the people under it, because a crew
          name alone doesn't say who is actually out. Falls back through the
          member names to the login, so this line is never blank.

          The status pill rides in this cell rather than in a column of its
          own: "who is out" and "are they still out" are one fact, and a whole
          column spent on a badge is width the money columns need. It wraps
          under the crew name when the column is tight. */}
      <td>
        <div className="ops-crew-line">
          <span className="ops-crew">{crewName}</span>
          {run.status === 'open' ? (
            <span className="ops-pill ops-pill-live">
              <span className="ops-dot" />
              Out now
            </span>
          ) : problem === 'blocked' ? (
            <span className="ops-pill ops-pill-warn">Refused records</span>
          ) : (
            <span className="ops-pill ops-pill-closed">Day ended</span>
          )}
        </div>
        {crewMembers && <div className="ops-sub">{crewMembers}</div>}
      </td>
      {/* The truck sits immediately beside the crew: it's what the crew took
          out, so the two read as one fact rather than two columns. */}
      <td>
        <div className="ops-run-truck">
          {run.truckName || 'Unnamed truck'}
          {run.sequence > 1 && <span className="ops-trip">Trip {run.sequence}</span>}
        </div>
      </td>
      {/* The run stays on its start date whatever happens afterwards — a run
          belongs to the day it went out. What changes for a run that outlives
          that day is only how the end is worded: a bare "to 6:42 PM" under a
          Monday heading reads as Monday evening, which for a truck that came
          back on Wednesday is simply wrong. When the two days differ the date
          is spelled out. */}
      <td>
        <div>{run.startedAt ? formatBusinessTime(run.startedAt) : '—'}</div>
        <div className="ops-sub">
          {run.status === 'open'
            ? `out ${formatDuration(now - run.startedAt)}`
            : run.closedAt
              ? `to ${describeRunEnd(run)}`
              : 'ended'}
        </div>
        {/* Said out loud rather than left to be inferred from the date above,
            because on a board of same-day runs this one is the exception and
            the reader is not looking for it. */}
        {spansDays && (
          <div className="ops-sub ops-run-span">
            {run.status === 'open' ? `still out · day ${dayCount}` : `${dayCount} days out`}
          </div>
        )}
      </td>
      <td className="ops-num">{receipts === null ? '…' : formatCount(totals.receiptCount)}</td>
      {/* Net leads the money, because it's the figure the run is judged on —
          what the stores actually owe once returns are written off. Sold and
          Returns follow as the two halves it's made of, in that order, so the
          row reads answer-then-workings rather than the other way round. */}
      <td className="ops-num ops-net">{formatMoney(totals.netTotal)}</td>
      <td className="ops-num">{formatMoney(totals.salesTotal)}</td>
      <td className="ops-num">{formatMoney(totals.returnsTotal)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// What's worth saying about the day as a whole
// ---------------------------------------------------------------------------

/**
 * The two things on this page that ask for a human.
 *
 * Kept at the top of the day rather than only inside each run, because both
 * are the kind of thing nobody goes looking for — they have to be visible
 * to someone who opened the page for a different reason.
 */
function DayNotices({ runs }: { runs: Run[] }) {
  const blocked = runs.filter((run) => runProblem(run) === 'blocked');
  const doubled = duplicateTrucks(runs);

  if (blocked.length === 0 && doubled.length === 0) return null;

  return (
    <div className="ops-day-notices">
      {blocked.length > 0 && (
        <div className="ops-notice ops-notice-warn">
          <span>
            <b>Records were refused.</b> {blocked.map((run) => run.truckName).join(', ')} finished the day holding
            records the server turned away. They are set aside on the phone, not lost — the agent can resend them from
            Settings once signed in.
          </span>
        </div>
      )}

      {doubled.map((entry) => (
        /* The one anomaly the sync design says the *dashboard* is responsible
           for spotting: nothing server-side stops two accounts taking the same
           truck out, because rules can't tell "two agents aboard" from "wrong
           truck tapped". That is a human judgement, so it surfaces here. */
        <div key={entry.truckId} className="ops-notice ops-notice-warn">
          <span>
            <b>{entry.truckName} was taken out by two different accounts today.</b> {entry.emails.join(' and ')} both
            started a day on it. If that was a mistake, the totals for this truck are split across two runs.
          </span>
        </div>
      ))}
    </div>
  );
}

type RunProblem = 'blocked' | null;

/**
 * Whether a *closed* run needs looking at.
 *
 * An open run is never a problem: its manifest hasn't been written yet.
 */
function runProblem(run: Run): RunProblem {
  if (run.status !== 'closed' || !run.manifest) return null;
  return run.manifest.blockedUploadCount > 0 ? 'blocked' : null;
}

/**
 * Trucks that carry more than one run today under **different accounts**.
 *
 * A second run by the same account is normal and expected — that is the truck
 * going back out, and the trip number already says so. Two accounts is the case
 * the run id's account segment exists to keep from silently merging, and the
 * one nobody can decide but a person.
 */
function duplicateTrucks(runs: Run[]): { truckId: string; truckName: string; emails: string[] }[] {
  const byTruck = new Map<string, Run[]>();
  for (const run of runs) {
    byTruck.set(run.truckId, [...(byTruck.get(run.truckId) ?? []), run]);
  }

  const result: { truckId: string; truckName: string; emails: string[] }[] = [];
  for (const [truckId, truckRuns] of byTruck) {
    const emails = [...new Set(truckRuns.map((run) => run.createdByEmail).filter(Boolean))];
    if (emails.length > 1) {
      result.push({ truckId, truckName: truckRuns[0].truckName || 'A truck', emails });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

type RunRecords = {
  receipts: Map<string, RunReceipt[]>;
  entries: Map<string, RunStockEntry[]>;
  expenses: Map<string, RunExpense[]>;
};

/**
 * Every run of the day's receipts, ledger entries and expenses, live.
 *
 * Listeners per run rather than one collection-group query per day, and
 * that is a correctness choice, not a convenience: a receipt's own
 * `businessDay` comes from when it was written, so a run that crosses midnight
 * would have its late receipts filed under the next day and drop out of a
 * day-filtered query. Reading them under `runs/{runId}/…` makes membership a
 * matter of where the document lives, which nothing can disagree about.
 *
 * A day holds a handful of runs — one per truck per trip — so the listener
 * count stays small.
 *
 * Expenses ride along here rather than being subscribed to inside the run panel,
 * for the same reason the other two do: the board already watches every run, and
 * a panel that subscribed again would double the listeners for the same rows.
 */
function useRunRecords(runs: Run[] | null): RunRecords {
  const runIds = (runs ?? []).map((run) => run.id);
  const key = runIds.join(' ');

  const [receipts, setReceipts] = useState<Map<string, RunReceipt[]>>(new Map());
  const [entries, setEntries] = useState<Map<string, RunStockEntry[]>>(new Map());
  const [expenses, setExpenses] = useState<Map<string, RunExpense[]>>(new Map());

  useEffect(() => {
    const ids = key ? key.split(' ') : [];
    const live = new Set(ids);

    // Prune rather than clear. A run opening mid-afternoon re-runs this effect,
    // and wiping the map would blank every total on the page for as long as the
    // listeners take to answer — numbers flashing to zero on an operations
    // board read as something having gone wrong.
    const prune = <T,>(prev: Map<string, T>) => new Map([...prev].filter(([id]) => live.has(id)));
    setReceipts(prune);
    setEntries(prune);
    setExpenses(prune);

    // A failed listener is left to Firestore's own retry: it reconnects on its
    // own, and the page-level notice already covers "the day wouldn't load".
    const stops = ids.flatMap((id) => [
      watchRunReceipts(
        id,
        (rows) => setReceipts((prev) => new Map(prev).set(id, rows)),
        () => {},
      ),
      watchRunStockEntries(
        id,
        (rows) => setEntries((prev) => new Map(prev).set(id, rows)),
        () => {},
      ),
      watchRunExpenses(
        id,
        (rows) => setExpenses((prev) => new Map(prev).set(id, rows)),
        () => {},
      ),
    ]);

    return () => stops.forEach((stop) => stop());
  }, [key]);

  return { receipts, entries, expenses };
}

/**
 * The day bar's calendar glyph. Inline rather than an icon dependency — it is
 * the only icon on the dashboard, and `currentColor` is what lets it take the
 * button's own ink, including the hover and disabled states.
 */
function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="3.25" width="12.5" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.75 6.75h12.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.25 1.75v2.5M10.75 1.75v2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A clock that re-renders the page every half minute, so elapsed times don't go stale. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ClockTickMs);
    return () => clearInterval(timer);
  }, []);
  return now;
}
