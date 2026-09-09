// Local project navigation rail. Team collaboration is exposed from each
// project's Collaboration panel rather than from a global Workspace shell.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { GITHUB_STARS_FALLBACK_LABEL, formatStars, useGithubStars } from './useGithubStars';
import { RailRecentRow } from './entry-nav-rail/RailRecentRow';
import { useProjectRunSummaries } from '../hooks/useProjectRunStatuses';
import type { EntrySettingsSection } from './EntrySettingsMenu';
import type { Project } from '../types';
import { isRtlLocale, useI18n } from '../i18n';
import { ENTRY_RAIL_TOGGLE_EVENT } from './entryRailBridge';
import type { EntryHomeView } from '../router';
import type {
  AccountMenuClickProps,
  TrackingWorkspacePage,
} from '@open-design/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import {
  trackAccountMenuClick,
  trackEntryNavigationClick,
} from '../analytics/events';
import {
  entryViewToTracking,
  workspaceAnalyticsDimensions,
} from '../analytics/workspace';
import { workspaceChromeAccountActionsHost } from './workspaceChromeActions';

const REPO_URL = 'https://github.com/nexu-io/open-design';
const DISCORD_URL = 'https://discord.gg/mHAjSMV6gz';
const X_URL = 'https://x.com/OpenDesignHQ';
const CONTACT_EMAIL_URL = 'mailto:support@open-design.ai';
const externalLinkProps = { target: '_blank', rel: 'noreferrer noopener' } as const;

// The rail's destination ids are the entry-shell home views (kept in sync with
// the router so `navigate({ kind: 'home', view })` type-checks for every item).
export type EntryView = EntryHomeView;

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  /** Opens the project search palette (blurred modal over all projects). */
  onOpenSearch?: () => void;
  newProjectDisabled?: boolean;
  /** When false the rail is collapsed (hidden off-canvas) on the entry view. */
  open: boolean;
  /** Extra content rendered before the shared top-right controls. */
  topRightSlot?: ReactNode;
  /** Open the app settings dialog (optionally on a specific section). */
  onOpenSettings?: (section?: EntrySettingsSection) => void;
  /**
   * The update-ready host (`UpdaterPopup`), which renders nothing until the
   * updater reports a downloaded, unopened installer.
   *
   * It is an independent control in the top-right chrome cluster
   * (`.entry-nav-rail__updater`).
   */
  updaterSlot?: ReactNode;
  /** Projects for the rail's 最近浏览过 section (per product: 在插件下边新增一个
   *  类型). The SAME catalog and the SAME order 全部项目's 最近浏览过 tab shows —
   *  EntryShell hands over the one it already feeds that grid, so the two can
   *  never drift; this list only takes the head of it. Empty (or absent) hides
   *  the section entirely. */
  recentProjects?: Project[];
  /** Row actions for the 最近浏览过 list's ⋮ menu. Omit either to drop its item. */
  onRenameRecentProject?: (id: string, name: string) => void;
  onDeleteRecentProject?: (id: string) => Promise<boolean | void> | boolean | void;
  /** Opens one of those projects — the pull-first opener, so a shared project
   *  that is not local yet still lands. */
  onOpenRecentProject?: (id: string) => void | Promise<unknown>;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  /** Rail items that own a popup surface expose the button so the surface can
   *  return focus here on close, and advertise the popup's kind + open state. */
  buttonRef?: Ref<HTMLButtonElement>;
  ariaHasPopup?: 'dialog' | 'menu';
  ariaExpanded?: boolean;
  children: ReactNode;
}

// No `data-tooltip` here: every nav item renders its label inline, so the
// rail's hover bubble (entry-layout.css) would only duplicate visible text.
// That bubble stays reserved for the rail's icon-only controls (updater,
// avatar, icon-only sign-out).
function NavButton({
  active,
  ariaLabel,
  label,
  onClick,
  disabled,
  testId,
  buttonRef,
  ariaHasPopup,
  ariaExpanded,
  children,
}: NavButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaHasPopup ? Boolean(ariaExpanded) : undefined}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className="entry-nav-rail__btn-icon" aria-hidden>{children}</span>
      <span className="entry-nav-rail__btn-label">{label}</span>
    </button>
  );
}

/** How many of the recent projects the rail lists. The rail is navigation, not
 *  a grid: past ~8 rows the section outgrows the destinations above it and the
 *  whole rail starts to scroll. 全部项目 is one click away for the rest, and the
 *  section's own footer row goes there. */
const RAIL_RECENT_LIMIT = 8;

/** Remembers the section's open/closed state across launches, next to the
 *  rail's own `od.entry.railOpen`. A disclosure the user closed should stay
 *  closed — re-opening it on every boot is the whole reason to have the
 *  control. */
const RECENT_SECTION_STORAGE_KEY = 'od.entry.railRecentOpen';

function readStoredRecentOpen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    // Default OPEN: the section is new and a collapsed-by-default disclosure
    // reads as a missing feature.
    return window.localStorage.getItem(RECENT_SECTION_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Which finished run the user has already looked at, per project (per product:
 * 点进去之后对号换回默认 icon).
 *
 * Invariant: a ✓ is acknowledged for ONE specific finished run — the value is
 * that run's id — and a newer finished run is a new notice. Keyed on the run
 * rather than the project so the acknowledgement stays correct even when the
 * section was collapsed (and not polling) for the whole of the next run: on
 * re-expanding, the newest terminal run's id no longer matches and the ✓ shows
 * again. Only a project whose live status is `succeeded` consults this at all.
 *
 * Persisted next to the section's own open/closed flag: a reload re-reads the
 * same runs feed and would otherwise re-raise every ✓ the user has already
 * cleared.
 */
const RECENT_SEEN_DONE_STORAGE_KEY = 'od.entry.railRecentSeenDone';

type AcknowledgedRuns = Readonly<Record<string, string>>;

function readStoredSeenDone(): AcknowledgedRuns {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(RECENT_SEEN_DONE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    // Anything but a plain object of run ids — including a bare list of
    // project ids, which cannot say which run it meant — reads as "nothing
    // acknowledged". The worst case is one ✓ the user has already seen, never a
    // missing one.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const acknowledged: Record<string, string> = {};
    for (const [projectId, runId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof runId === 'string' && runId) acknowledged[projectId] = runId;
    }
    return acknowledged;
  } catch {
    return {};
  }
}

function writeStoredSeenDone(acknowledged: AcknowledgedRuns): void {
  try {
    window.localStorage.setItem(RECENT_SEEN_DONE_STORAGE_KEY, JSON.stringify(acknowledged));
  } catch {
    // Private mode / storage disabled: the ✓ still clears for this session.
  }
}

/**
 * 最近浏览过 — a collapsible list of the projects the 全部项目 view's own
 * 最近浏览过 tab would show, sitting under 插件 in the rail (per product).
 *
 * It takes the catalog EntryShell already feeds that grid and shows the head of
 * it in the same order (most recently touched first), so the rail and the grid
 * can never disagree about what "recent" means. Rows open the project through
 * the same pull-first opener the grid uses.
 */
function RailRecentSection({
  projects,
  onOpen,
  onRename,
  onDelete,
  label,
}: {
  projects: Project[];
  onOpen?: (id: string) => void | Promise<unknown>;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => Promise<boolean | void> | boolean | void;
  label: string;
}) {
  const [open, setOpen] = useState(readStoredRecentOpen);
  const items = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RAIL_RECENT_LIMIT),
    [projects],
  );
  // Run status for the rows' leading glyph. This is the same live runs feed
  // the workspace tab dropdown reads, which keeps the two glyph columns
  // telling one story.
  // Only polled while the disclosure is open: it costs one request per listed
  // project (≤ RAIL_RECENT_LIMIT), and a collapsed section shows no glyphs.
  const runStatusProjectIds = useMemo(() => items.map((item) => item.id), [items]);
  const runSummaryByProjectId = useProjectRunSummaries(runStatusProjectIds, {
    enabled: open,
  });
  const [seenDone, setSeenDone] = useState<AcknowledgedRuns>(readStoredSeenDone);

  // Opening a project is what spends its ✓ (per product): the finished run on
  // screen is recorded as seen. Recorded only when there is actually one, so
  // the store stays the list of notices the user has dismissed rather than of
  // every project ever opened.
  const openProject = useCallback(
    (id: string) => {
      const summary = runSummaryByProjectId.get(id);
      if (summary?.status === 'succeeded' && summary.latestTerminalRunId) {
        const runId = summary.latestTerminalRunId;
        setSeenDone((prev) => {
          if (prev[id] === runId) return prev;
          const next = { ...prev, [id]: runId };
          writeStoredSeenDone(next);
          return next;
        });
      }
      return onOpen?.(id);
    },
    [onOpen, runSummaryByProjectId],
  );

  function toggle() {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      try {
        window.localStorage.setItem(RECENT_SECTION_STORAGE_KEY, String(next));
      } catch {
        // Private mode / storage disabled: the section still toggles, it just
        // forgets. Never let a storage failure swallow the interaction.
      }
      return next;
    });
  }

  // Nothing to list is not an empty state worth a row: a workspace with no
  // projects yet should see the rail it had before this section existed.
  if (items.length === 0) return null;

  return (
    <div className="entry-nav-rail__recent">
      <button
        type="button"
        className="entry-nav-rail__recent-head"
        onClick={toggle}
        aria-expanded={open}
        data-testid="entry-nav-recent-toggle"
      >
        {/* Title first, chevron trailing (per product: 展开和收起的按钮在最右侧).
            DOM order follows the visual one rather than an `order` swap, so the
            reading order matches too. */}
        <span className="entry-nav-rail__recent-title">{label}</span>
        <span className="entry-nav-rail__recent-chevron" aria-hidden>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        </span>
      </button>
      {/* The canonical disclosure pair (index.css / composio.css): the outer
          grid animates 0fr → 1fr, the inner box carries the clip. `hidden` on
          the wrapper would skip the transition entirely. */}
      <div className={`accordion-collapsible${open ? ' open' : ''}`}>
        <div className="accordion-collapsible-inner">
          <ul className="entry-nav-rail__recent-list">
            {items.map((project) => {
              const summary = runSummaryByProjectId.get(project.id);
              const status = summary?.status;
              // An acknowledged ✓ is DROPPED, not drawn quieter: the row goes
              // back to its default chat mark (per product). Every other status
              // is live and stays. Acknowledged means THIS finished run was
              // seen; a newer one is a new notice.
              const acknowledged =
                status === 'succeeded'
                && summary?.latestTerminalRunId !== undefined
                && seenDone[project.id] === summary.latestTerminalRunId;
              return (
                <li key={project.id}>
                  <RailRecentRow
                    project={project}
                    runStatus={acknowledged ? undefined : status}
                    onOpen={openProject}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

interface TopRightControlsProps {
  /** Analytics page the controls report from. */
  page: TrackingWorkspacePage;
  /** Extra content rendered before the shared controls. */
  leadingSlot?: ReactNode;
  /** Stable host for the update-ready control. */
  updaterSlot?: ReactNode;
}

/**
 * Shell-neutral top-right controls shared by entry and project routes.
 * Account identity is intentionally absent: self-hosted collaboration lives in
 * the Project panel, while Settings remains a stable local rail destination.
 */
function TopRightControls({
  page,
  leadingSlot,
  updaterSlot,
}: TopRightControlsProps) {
  const analytics = useAnalytics();
  const [chromeActionsHost, setChromeActionsHost] = useState<HTMLElement | null>(
    workspaceChromeAccountActionsHost,
  );

  // On the initial App render the tabs chrome and this cluster are committed
  // in the same pass, so the host does not exist while this component renders.
  // A layout effect finds it after the DOM commit and moves the controls before
  // paint. Electron can then build its first draggable-region hit map with the
  // no-drag controls as real descendants of the drag header.
  useLayoutEffect(() => {
    // Isolated component harnesses do not mount the application chrome. Keep
    // those public component tests usable without re-creating the whole App;
    // the real shell always supplies the dedicated host above.
    setChromeActionsHost(workspaceChromeAccountActionsHost() ?? document.body);
  }, []);

  const updaterSlotHostRef = useRef<HTMLDivElement | null>(null);
  const [updaterControlVisible, setUpdaterControlVisible] = useState(false);
  // ReactNode truthiness cannot tell whether UpdaterPopup rendered its control.
  useLayoutEffect(() => {
    const host = updaterSlotHostRef.current;
    if (!host) {
      setUpdaterControlVisible(false);
      return;
    }
    const syncVisibility = () => setUpdaterControlVisible(host.hasChildNodes());
    syncVisibility();
    const observer = new MutationObserver(syncVisibility);
    observer.observe(host, { childList: true });
    return () => observer.disconnect();
  }, [chromeActionsHost, updaterSlot]);
  const githubStars = useGithubStars();

  if (typeof document === 'undefined' || !chromeActionsHost) return null;

  return (
    createPortal(
        <div className="entry-top-right-cluster">
          {leadingSlot}
          <a
            className="entry-top-right-github"
            href={REPO_URL}
            {...externalLinkProps}
            aria-label={`GitHub · ${githubStars == null ? GITHUB_STARS_FALLBACK_LABEL : formatStars(githubStars)} stars`}
            title={`GitHub · ${githubStars == null ? GITHUB_STARS_FALLBACK_LABEL : formatStars(githubStars)} stars`}
            data-testid="entry-top-right-github"
            onClick={() => {
              trackAccountMenuClick(analytics.track, {
                page_name: page,
                area: 'account_menu',
                element: 'github',
              });
            }}
          >
            <Icon name="github-filled" size={14} />
            <span>{githubStars == null ? GITHUB_STARS_FALLBACK_LABEL : formatStars(githubStars)}</span>
          </a>
          {/* Keep this host mounted while the updater is idle so the updater can
              publish its control without remounting the surrounding chrome. */}
          <div
            ref={updaterSlotHostRef}
            className={updaterControlVisible ? 'entry-nav-rail__updater' : undefined}
            data-testid={updaterControlVisible ? 'entry-nav-updater-host' : undefined}
          >
            {updaterSlot}
          </div>
        </div>,
        chromeActionsHost,
      )
  );
}

/** Project-view mount for the same shell-neutral controls used by the entry rail. */
export function ProjectTopRightControls({
  updaterSlot,
}: {
  updaterSlot?: ReactNode;
}) {
  return <TopRightControls page="project" updaterSlot={updaterSlot} />;
}

/**
 * Community/contact links pinned to the bottom of the nav rail.
 *
 * The row's first slot is the Discord invite for every locale (the Chinese
 * Feishu group entry was retired so there is one community to point at).
 * All three labels are translated and surface through the shared
 * `.od-tooltip` layer. Analytics keeps reporting these
 * under `area: 'account_menu'` so the existing funnel stays comparable across
 * the move out of that menu.
 */
function RailSocialRow({
  page,
  dimensions,
}: {
  page: TrackingWorkspacePage;
  dimensions: ReturnType<typeof workspaceAnalyticsDimensions>;
}) {
  const { t, locale } = useI18n();
  const analytics = useAnalytics();
  // The rail sits on the leading edge, so tooltips open away from it —
  // right in LTR, left once RTL moves the whole rail to the right edge.
  // Without the flip the bubble would be clamped against the viewport
  // and land back on top of the icons it describes.
  const tooltipPlacement = isRtlLocale(locale) ? 'left' : 'right';
  // One string per link doubles as the accessible name and the hover
  // tooltip: the bubble is the only place the icons say what they do, so
  // the copy leads with the payoff (Discord hands out credits) rather
  // than naming the destination.
  const communityLabel = t('entry.discordAria');
  const xLabel = t('entry.xAria');
  const mailLabel = t('entry.mailAria');

  function track(element: AccountMenuClickProps['element']) {
    trackAccountMenuClick(analytics.track, {
      page_name: page,
      area: 'account_menu',
      element,
      ...dimensions,
    });
  }

  return (
    <div className="entry-nav-rail__social" data-testid="entry-nav-rail-social">
      <a
        className="entry-nav-rail__social-btn od-tooltip"
        href={DISCORD_URL}
        {...externalLinkProps}
        aria-label={communityLabel}
        data-tooltip={communityLabel}
        data-tooltip-placement={tooltipPlacement}
        data-testid="entry-nav-rail-discord"
        onClick={() => track('discord')}
      >
        <Icon name="discord" size={15} />
      </a>
      <a
        className="entry-nav-rail__social-btn od-tooltip"
        href={X_URL}
        {...externalLinkProps}
        aria-label={xLabel}
        data-tooltip={xLabel}
        data-tooltip-placement={tooltipPlacement}
        onClick={() => track('twitter')}
      >
        <span className="entry-nav-rail__menu-x" aria-hidden>X</span>
      </a>
      <a
        className="entry-nav-rail__social-btn od-tooltip"
        href={CONTACT_EMAIL_URL}
        aria-label={mailLabel}
        data-tooltip={mailLabel}
        data-tooltip-placement={tooltipPlacement}
        onClick={() => track('email')}
      >
        <Icon name="mail" size={15} />
      </a>
    </div>
  );
}

export function EntryNavRail({
  view,
  onViewChange,
  onOpenSearch,
  open,
  topRightSlot,
  onOpenSettings,
  updaterSlot,
  recentProjects,
  onOpenRecentProject,
  onRenameRecentProject,
  onDeleteRecentProject,
}: Props) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const analyticsPage = entryViewToTracking(view);
  const workspaceDimensions = workspaceAnalyticsDimensions(null);
  const communityLabel = t('pluginsHome.title');
  // #5517 renamed the rail's first item from 最近 (Recents) to 首页 (Home) —
  // the key keeps its historical name, the VALUE now reads Home in every
  // locale (polish round 2, ref 1db2d00c2).
  const homeLabel = t('entry.navRecents');
  const isHome = view === 'home';

  const selectView = (next: EntryView) => {
    trackEntryNavigationClick(analytics.track, {
      page_name: analyticsPage,
      area: 'entry_nav',
      element: 'nav_item',
      target: entryViewToTracking(next),
      entry_from: 'sidebar',
      ...workspaceDimensions,
    });
    onViewChange(next);
  };

  // While collapsed the rail is visually hidden but its controls stay mounted;
  // mark it `inert` so they leave the tab order and pointer flow entirely.
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    if (open) {
      node.removeAttribute('inert');
    } else {
      node.setAttribute('inert', '');
    }
  }, [open]);

  return (
    <nav
      ref={railRef}
      className={`entry-nav-rail${open ? ' is-open' : ''}`}
      aria-label={t('entry.primaryNavAria')}
      aria-hidden={open ? undefined : true}
    >
      <div className="entry-nav-rail__panel">
      <div className="entry-nav-rail__group">

        {/* Search + the rail-collapse control in one row. The collapse button
            moved here from the chrome corner (per product: 收起按钮放在输入框
            后边) — the corner slot is the brand logo now, and re-opening a
            collapsed rail is what the logo does there. */}
        <div className="entry-nav-rail__search-row">
          <button
            type="button"
            className="entry-nav-rail__search"
            onClick={() => {
              trackEntryNavigationClick(analytics.track, {
                page_name: analyticsPage,
                area: 'entry_nav',
                element: 'search',
                target: 'search',
                entry_from: 'sidebar',
                ...workspaceDimensions,
              });
              onOpenSearch?.();
            }}
            aria-label={t('common.search')}
            data-testid="entry-nav-search"
          >
            <Icon name="search" size={14} />
            <span className="entry-nav-rail__search-placeholder">{t('common.search')}</span>
            <span className="entry-nav-rail__search-kbd" aria-hidden>⌘K</span>
          </button>
          <button
            type="button"
            className="entry-nav-rail__collapse od-tooltip"
            aria-label={t('entry.navCollapse')}
            title={t('entry.navCollapse')}
            data-tooltip={t('entry.navCollapse')}
            data-tooltip-placement="bottom"
            data-testid="entry-rail-collapse"
            onClick={() => {
              window.dispatchEvent(new CustomEvent(ENTRY_RAIL_TOGGLE_EVENT));
            }}
          >
            <Icon name="panel-left" size={15} />
          </button>
        </div>

        <NavButton
          active={isHome}
          ariaLabel={homeLabel}
          label={homeLabel}
          onClick={() => selectView('home')}
          testId="entry-nav-home"
        >
          <Icon name="home" size={16} />
        </NavButton>
        <NavButton
          active={view === 'community'}
          ariaLabel={communityLabel}
          label={communityLabel}
          onClick={() => selectView('community')}
          testId="entry-nav-community"
        >
          <Icon name="globe" size={16} />
        </NavButton>

        <NavButton
          active={view === 'design-systems'}
          ariaLabel={t('entry.navDesignSystems')}
          label={t('entry.navDesignSystems')}
          onClick={() => selectView('design-systems')}
          testId="entry-nav-design-systems"
        >
          <Icon name="palette" size={16} />
        </NavButton>
        <NavButton
          active={view === 'plugins'}
          ariaLabel={t('entry.navPlugins')}
          label={t('entry.navPlugins')}
          onClick={() => selectView('plugins')}
          testId="entry-nav-plugins"
        >
          <Icon name="puzzle" size={16} />
        </NavButton>
        <RailRecentSection
          projects={recentProjects ?? []}
          onOpen={onOpenRecentProject}
          onRename={onRenameRecentProject}
          onDelete={onDeleteRecentProject}
          label={t('recentProjects.collectionRecent')}
        />
        <NavButton
          ariaLabel={t('entry.accountSettings')}
          label={t('entry.accountSettings')}
          onClick={() => {
            trackAccountMenuClick(analytics.track, {
              page_name: analyticsPage,
              area: 'account_menu',
              element: 'settings',
            });
            onOpenSettings?.();
          }}
          testId="entry-settings-button"
        >
          <Icon name="settings" size={16} />
        </NavButton>
      </div>
      <div className="entry-nav-rail__footer">
        <RailSocialRow page={analyticsPage} dimensions={workspaceDimensions} />
      </div>
      </div>

      <TopRightControls
        page={analyticsPage}
        leadingSlot={topRightSlot}
        updaterSlot={updaterSlot}
      />
    </nav>
  );
}
