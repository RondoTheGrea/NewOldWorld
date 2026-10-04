import { useEffect, useState } from 'react';

import { useAuth } from '@/context/auth';
import { BreadTypesPage } from '@/pages/bread-types';
import { OverviewPage } from '@/pages/overview';
import { ReferenceListsPage } from '@/pages/reference-lists';
import { SettingsPage } from '@/pages/settings';
import { TeamPage } from '@/pages/team';

type Section = 'overview' | 'bread-types' | 'reference-lists' | 'settings' | 'team';

/**
 * The width below which the sidebar stops being a column and becomes a drawer.
 *
 * **Kept in step with index.css by hand** — the same 900px appears there in the
 * `@media (max-width: 900px)` block that does the actual layout switch. This
 * copy exists because one thing can't be answered in CSS: whether the shut
 * sidebar should be `inert`. Off-screen it has to leave the tab order; as a
 * permanent column on a wide screen it has to stay in it, and both states have
 * `navOpen === false`. Change one, change the other.
 */
const NarrowQuery = '(max-width: 900px)';

/** `true` while the viewport is narrow enough that the sidebar is a drawer. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NarrowQuery).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(NarrowQuery);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    // Re-read on mount as well as on change: the first render's value was
    // taken before hydration and the window may have been resized since.
    setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return narrow;
}

const NAV_ITEMS: { section: Section; label: string }[] = [
  { section: 'overview', label: 'Overview' },
  { section: 'bread-types', label: 'Bread Types' },
  // Trucks and agents. Grouped under one nav entry because they're two short
  // lists a manager sets up once, not two destinations. The label names both.
  // (Areas had a list here too until they were removed.)
  { section: 'reference-lists', label: 'Trucks & Agents' },
  { section: 'settings', label: 'Settings' },
];

// Managing who can open the dashboard, shown only to administrators. Kept out
// of NAV_ITEMS rather than filtered out of it, because it is the one entry
// whose presence depends on the account — and it goes last, under Settings,
// since it is the thing a manager reaches for least often.
const ADMIN_NAV_ITEM: { section: Section; label: string } = { section: 'team', label: 'Team' };

export function DashboardShell() {
  const { user, isAdmin, signOut } = useAuth();
  const [section, setSection] = useState<Section>('overview');

  const navItems = isAdmin ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  const narrow = useIsNarrow();

  /*
    Whether the nav drawer is showing. Only meaningful while `narrow` — on a
    wide screen the sidebar is a permanent column and the scrim is
    `display: none`, so the flag is simply ignored. It is forced back to false
    on the way out of narrow all the same, so widening the window mid-drawer
    doesn't leave a stale `open` class waiting for the next time it narrows.
  */
  const [navOpen, setNavOpen] = useState(false);
  const drawerOpen = narrow && navOpen;

  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);

  // Escape closes the drawer, the same way it closes every overlay on the
  // Overview tab. Bound only while it's open so it can't swallow the key from
  // a drawer or modal underneath it.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setNavOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // An admin who is demoted mid-session (by another admin, on another machine)
  // keeps `section === 'team'` and would sit on a page that now refuses to
  // render its own contents. Send them somewhere real instead.
  useEffect(() => {
    if (!isAdmin && section === 'team') setSection('overview');
  }, [isAdmin, section]);

  const currentLabel = navItems.find((item) => item.section === section)?.label ?? '';

  return (
    <div className="dashboard-shell">
      {/*
        The scrim behind the drawer. Rendered unconditionally and shown by CSS
        rather than mounted on demand, so the fade has both an in and an out
        frame to run between; `display: none` above the breakpoint means the
        wide layout never sees it at all.
      */}
      <div
        className={drawerOpen ? 'dashboard-scrim open' : 'dashboard-scrim'}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <aside
        id="dashboard-nav"
        className={drawerOpen ? 'dashboard-sidebar open' : 'dashboard-sidebar'}
        // Off-screen and shut, the sidebar has to leave the tab order too —
        // otherwise tabbing from the top bar walks into four invisible
        // buttons. Only while it is a drawer: on a wide screen it is a
        // permanent column and must stay reachable.
        inert={narrow && !navOpen}>
        <span className="dashboard-brand">NewOldWorld</span>
        <nav className="dashboard-nav">
          {navItems.map((item) => (
            <button
              key={item.section}
              type="button"
              className={item.section === section ? 'dashboard-nav-item active' : 'dashboard-nav-item'}
              onClick={() => {
                setSection(item.section);
                // Picking a destination is the end of the drawer's job. Doing
                // this unconditionally is safe: on a wide screen nothing is
                // showing the flag anyway.
                setNavOpen(false);
              }}>
              {item.label}
            </button>
          ))}
        </nav>

        {/*
          Who is signed in, and the way out — at the foot of the sidebar rather
          than in a header strip above the page. The sidebar is the one part of
          the shell that never scrolls (see .dashboard-shell in index.css), so
          both stay reachable from anywhere on a long board.
        */}
        <div className="dashboard-account">
          <span className="dashboard-user" title={user?.email ?? undefined}>
            {user?.email}
          </span>
          <button type="button" onClick={() => void signOut()}>
            Log out
          </button>
        </div>
      </aside>

      <div className="dashboard-body">
        {/*
          The narrow-screen header: the only way to reach the nav once the
          sidebar has become a drawer. Hidden with `display: none` above the
          breakpoint. It's a sibling *above* .dashboard-main rather than a
          fixed bar over it, so the scrolling area below simply gets the
          remaining height and nothing has to reserve space by hand — the same
          arrangement .ops-tabs has to .ops-view.
        */}
        <header className="dashboard-topbar">
          <button
            type="button"
            className="dashboard-menu-button"
            aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={drawerOpen}
            aria-controls="dashboard-nav"
            onClick={() => setNavOpen((open) => !open)}>
            <span className="dashboard-menu-icon" aria-hidden="true" />
          </button>
          <span className="dashboard-topbar-title">{currentLabel}</span>
        </header>

        <main className="dashboard-main">
          {/*
            All four sections stay mounted for the life of the app, hidden with
            `display: none` rather than unmounted on switch — the same trick
            overview.tsx uses for its own Live/Trends/Stores tabs. Without it,
            leaving Bread Types mid-edit (or Trucks & Agents, or a half-typed
            Settings field) and coming back would throw the draft away. Only a
            page reload resets that now. Four sections' worth of listeners
            staying open is the same bounded, accepted cost overview.tsx
            already takes on for its three.
          */}
          <div style={{ display: section === 'overview' ? undefined : 'none' }}>
            <OverviewPage />
          </div>
          <div style={{ display: section === 'bread-types' ? undefined : 'none' }}>
            <BreadTypesPage />
          </div>
          <div style={{ display: section === 'reference-lists' ? undefined : 'none' }}>
            <ReferenceListsPage />
          </div>
          <div style={{ display: section === 'settings' ? undefined : 'none' }}>
            <SettingsPage />
          </div>
          {/*
            Mounted only for admins, unlike the four above. Those stay mounted
            to keep a half-finished edit alive across a tab switch; this one has
            no draft worth preserving, and mounting it for everybody would have
            every non-admin's dashboard open with a permission-denied call in
            flight on load.
          */}
          {isAdmin && (
            <div style={{ display: section === 'team' ? undefined : 'none' }}>
              <TeamPage />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
