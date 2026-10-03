import { useState } from 'react';

import { LiveBoard } from '@/components/live-board';
import { StoresTab } from '@/components/stores-tab';
import { TrendsTab } from '@/components/trends-tab';

import '@/pages/overview.css';

/**
 * The dashboard's operations surface — three views of the same business.
 *
 * - **Live** — today, as it happens: which trucks are out, in which areas, what
 *   they have taken so far, and whether a run that ended is missing records.
 * - **Trends** — the same figures over weeks, from the manifests each phone
 *   uploads when its day is closed.
 * - **Stores** — the route as a directory, and one store's whole history across
 *   every truck and every day.
 *
 * Tabs rather than three sidebar entries. The sidebar lists the things a
 * manager goes to *set up* — bread types, areas, trucks, settings — and these
 * three are one thing looked at from three distances. Splitting them into the
 * sidebar would put "check today's takings" and "add a truck" at the same level
 * of the app, which they are not. If Stores ever grows into somewhere people
 * spend their day, promoting it is one line here and one in dashboard-shell.
 *
 * **This surface has its own look and does not share the rest of the
 * dashboard's.** Everything in overview.css is scoped under `.ops`. That is
 * deliberate, not drift: the other pages are forms, this one is a board.
 */

type Tab = 'live' | 'trends' | 'stores';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'live', label: 'Live', hint: 'Trucks out today' },
  { id: 'trends', label: 'Trends', hint: 'Takings over time' },
  { id: 'stores', label: 'Stores', hint: 'The route, store by store' },
];

export function OverviewPage() {
  const [tab, setTab] = useState<Tab>('live');

  return (
    <div className="ops dashboard-page-fade">
      <nav className="ops-tabs" aria-label="Operations views">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === tab ? 'ops-tab active' : 'ops-tab'}
            aria-current={item.id === tab ? 'page' : undefined}
            onClick={() => setTab(item.id)}>
            {item.label}
            <span>{item.hint}</span>
          </button>
        ))}
      </nav>

      {/*
        The scrolling half. The tab strip above is a sibling, not a parent, so
        it stays put while this scrolls — the same relationship the sidebar has
        to the page (see .ops / .ops-view in overview.css).

        All three tabs stay mounted all the time, hidden with `display: none`
        rather than unmounted, so switching between Live/Trends/Stores doesn't
        throw away what the reader was doing on the other two — a picked date
        range, a selected run or store, a search. Only a page reload resets
        that now. This does mean Live's Firestore listeners keep running while
        Trends or Stores is showing; that's an accepted cost of not losing
        state, not an oversight — there are only three tabs, so it's bounded.
      */}
      <div className="ops-view">
        <div className="ops-tab-panel" style={{ display: tab === 'live' ? undefined : 'none' }}>
          <LiveBoard />
        </div>
        <div className="ops-tab-panel" style={{ display: tab === 'trends' ? undefined : 'none' }}>
          <TrendsTab />
        </div>
        <div className="ops-tab-panel" style={{ display: tab === 'stores' ? undefined : 'none' }}>
          <StoresTab />
        </div>
      </div>
    </div>
  );
}
