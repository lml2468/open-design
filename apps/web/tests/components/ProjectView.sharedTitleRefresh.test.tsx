// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectView,
  reconcileProjectDetail,
} from '../../src/components/ProjectView';
import type {
  ProjectRenameFenceToken,
} from '../../src/components/ProjectView';
import { useIframeKeepAlivePool } from '../../src/components/IframeKeepAlivePool';
import { useProjectFileEvents, type ProjectEvent } from '../../src/providers/project-events';
import type {
  AgentInfo,
  AppConfig,
  Conversation,
  DesignSystemSummary,
  Project,
  SkillSummary,
} from '../../src/types';
import {
  createConversation,
  getProject,
  listConversations,
  listMessages,
  loadTabs,
  patchProject,
} from '../../src/state/projects';
import {
  fetchPreviewComments,
  fetchProjectFiles,
  invalidateProjectFilesCache,
} from '../../src/providers/registry';

const fileWorkspaceRenderSpy = vi.hoisted(() => vi.fn());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: () => {},
  }),
}));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/components/IframeKeepAlivePool', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/IframeKeepAlivePool')>(
    '../../src/components/IframeKeepAlivePool',
  );
  return {
    ...actual,
    useIframeKeepAlivePool: vi.fn(),
  };
});

vi.mock('../../src/providers/anthropic', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn(),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
    invalidateProjectFilesCache: vi.fn(),
    fetchSkill: vi.fn(),
    getTemplate: vi.fn(),
    patchPreviewCommentStatus: vi.fn(),
    upsertPreviewComment: vi.fn(),
    writeProjectTextFile: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createConversation: vi.fn(),
    getProject: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    loadTabs: vi.fn(),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__',
  FileWorkspace: ({
    projectName,
    files = [],
    filesRefreshKey = 0,
    focusMode = false,
    onFocusModeChange,
  }: {
    projectName: string;
    files?: Array<{ name: string }>;
    filesRefreshKey?: number;
    focusMode?: boolean;
    onFocusModeChange?: (focused: boolean) => void;
  }) => {
    fileWorkspaceRenderSpy(filesRefreshKey);
    return (
      <div
        data-files-refresh-key={filesRefreshKey}
        data-project-name={projectName}
        data-testid="file-workspace"
      >
        {files.map((file) => <span key={file.name}>{file.name}</span>)}
        {focusMode ? (
          <button
            type="button"
            data-testid="workspace-focus-toggle"
            onClick={() => onFocusModeChange?.(false)}
          >
            show chat
          </button>
        ) : null}
      </div>
    );
  },
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: ({ error, projectHeader }: { error?: string | null; projectHeader?: ReactNode }) => (
    <div data-testid="chat-pane">
      {projectHeader}
      {error ? <span data-testid="chat-error">{error}</span> : null}
    </div>
  ),
}));

const mockedUseIframeKeepAlivePool = vi.mocked(useIframeKeepAlivePool);
const mockedUseProjectFileEvents = vi.mocked(useProjectFileEvents);
const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedInvalidateProjectFilesCache = vi.mocked(invalidateProjectFilesCache);
const mockedGetProject = vi.mocked(getProject);
const mockedPatchProject = vi.mocked(patchProject);

const onProjectChangeMock = vi.fn();

const config: AppConfig = {
  mode: 'api',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

// The state a member's web sits in right after deep-linking into a
// not-yet-pulled team-shared project: the daemon answered `getProject` with
// the placeholder record `ensureSharedProjectPlaceholder` registered, and
// App.tsx put that placeholder name into its `projects` state (sidebar + tab
// title both render it).
const project: Project = {
  id: 'project-1',
  name: '共享项目',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

const conversation: Conversation = {
  id: 'conv-1',
  projectId: project.id,
  title: null,
  createdAt: 1,
  updatedAt: 1,
};

function projectViewElement(
  projectOverride: Project = project,
  options: {
    projectAuthorizationKey?: string;
    onProjectChange?: (next: Project) => void;
    onProjectRenameStarted?: (next: Project) => ProjectRenameFenceToken | null;
    onProjectRenameSettled?: (
      token: ProjectRenameFenceToken | null,
      confirmed: Project,
    ) => void;
    onProjectsRefresh?: () => Promise<void> | void;
  } = {},
) {
  return (
    <ProjectView
      project={projectOverride}
      projectAuthorizationKey={options.projectAuthorizationKey ?? 'ws-1:wm-1:project-1'}
      routeFileName={null}
      config={config}
      agents={[] as AgentInfo[]}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={[] as DesignSystemSummary[]}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onRefreshAgents={vi.fn()}
      onOpenSettings={vi.fn()}
      onBack={vi.fn()}
      onClearPendingPrompt={vi.fn()}
      onTouchProject={vi.fn()}
      onProjectChange={options.onProjectChange ?? onProjectChangeMock}
      onProjectRenameStarted={options.onProjectRenameStarted}
      onProjectRenameSettled={options.onProjectRenameSettled}
      onProjectsRefresh={options.onProjectsRefresh ?? vi.fn()}
    />
  );
}

function renderProjectView(
  projectOverride: Project = project,
  options: {
    projectAuthorizationKey?: string;
  } = {},
) {
  return render(projectViewElement(projectOverride, options));
}

function dispatchProjectEvent(evt: ProjectEvent) {
  const handleProjectEvent = mockedUseProjectFileEvents.mock.calls[0]?.[2] as
    | ((evt: ProjectEvent) => void)
    | undefined;
  expect(handleProjectEvent).toBeTypeOf('function');
  handleProjectEvent!(evt);
}

describe('ProjectView shared-project title refresh on project-metadata-changed', () => {
  beforeEach(() => {
    mockedListConversations.mockReset();
    mockedListMessages.mockReset();
    mockedUseIframeKeepAlivePool.mockReturnValue({
      attach: vi.fn(),
      release: vi.fn(),
      evict: vi.fn(),
      evictProject: vi.fn(),
      evictMatching: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      revision: vi.fn(() => 0),
    });
    mockedListConversations.mockResolvedValue([conversation]);
    mockedCreateConversation.mockResolvedValue(conversation);
    mockedListMessages.mockResolvedValue([]);
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
    mockedFetchPreviewComments.mockResolvedValue([]);
    mockedFetchProjectFiles.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('invalidates the local file-list authority before publishing an SSE refresh', async () => {
    renderProjectView(project);

    mockedInvalidateProjectFilesCache.mockClear();
    fileWorkspaceRenderSpy.mockClear();
    dispatchProjectEvent({ type: 'file-changed', path: 'index.html', kind: 'change' });

    await waitFor(() => {
      expect(mockedInvalidateProjectFilesCache).toHaveBeenCalledWith(
        project.id,
        null,
      );
      expect(screen.getByTestId('file-workspace')).toHaveAttribute(
        'data-files-refresh-key',
        '1',
      );
    });

    const refreshedRender = fileWorkspaceRenderSpy.mock.calls.findIndex(
      ([filesRefreshKey]) => filesRefreshKey === 1,
    );
    expect(refreshedRender).toBeGreaterThanOrEqual(0);
    expect(mockedInvalidateProjectFilesCache.mock.invocationCallOrder[0]).toBeLessThan(
      fileWorkspaceRenderSpy.mock.invocationCallOrder[refreshedRender]!,
    );
  });

  // recvqhwv6RPU1j: a member's first open of a team-shared project registers a
  // "共享项目" placeholder record; the background pull later swaps in the real
  // name in the daemon DB only. The daemon signals that swap with the existing
  // `project-metadata-changed` thin event — the open project view must react
  // by re-fetching the project record and propagating it up through
  // `onProjectChange`, or App.tsx's `projects` state (sidebar + tab title)
  // keeps the placeholder until a manual page reload.
  it('re-fetches the project and propagates the real name up when project-metadata-changed fires', async () => {
    const pulled: Project = {
      ...project,
      name: 'Q3 Marketing Site',
      skillId: 'deck-builder',
      designSystemId: 'ds-emerald',
      updatedAt: 456,
    };
    mockedGetProject.mockResolvedValue(pulled);

    renderProjectView();
    dispatchProjectEvent({ type: 'project-metadata-changed', projectId: project.id });

    await waitFor(() => {
      expect(onProjectChangeMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'project-1', name: 'Q3 Marketing Site' }),
      );
    });
  });

  it('commits an owner rename before refreshing every list projection', async () => {
    const ownerProject = {
      ...project,
      name: 'Before rename',
    };
    const persisted = {
      ...ownerProject,
      name: 'After rename',
      updatedAt: 456,
    };
    mockedPatchProject.mockResolvedValue(persisted);
    const onProjectChange = vi.fn();
    const onProjectsRefresh = vi.fn(async () => undefined);

    render(projectViewElement(ownerProject, {
      onProjectChange,
      onProjectsRefresh,
    }));
    const title = await screen.findByTestId('project-title');
    title.textContent = 'After rename';
    fireEvent.blur(title);

    await waitFor(() => {
      expect(mockedPatchProject).toHaveBeenCalledWith(
        ownerProject.id,
        expect.objectContaining({ name: 'After rename' }),
        null,
      );
    });
    await waitFor(() => expect(onProjectsRefresh).toHaveBeenCalledTimes(1));
    expect(onProjectChange).toHaveBeenLastCalledWith(persisted);
  });

  it('settles the exact rename fence after the view switches to another project', async () => {
    const projectA = {
      ...project,
      name: 'Project A',
    };
    const projectB = {
      ...project,
      id: 'project-2',
      name: 'Project B',
    };
    const patch = deferred<Project | null>();
    const token: ProjectRenameFenceToken = {
      projectId: projectA.id,
      mutationVersion: 11,
    };
    const onProjectRenameStarted = vi.fn(() => token);
    const onProjectRenameSettled = vi.fn();
    const onProjectsRefresh = vi.fn();
    mockedPatchProject.mockImplementationOnce(() => patch.promise);

    const view = render(projectViewElement(projectA, {
      onProjectRenameStarted,
      onProjectRenameSettled,
      onProjectsRefresh,
    }));
    const title = await screen.findByTestId('project-title');
    title.textContent = 'Renamed while leaving';
    fireEvent.blur(title);
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(1));

    view.rerender(projectViewElement(projectB, {
      onProjectRenameStarted,
      onProjectRenameSettled,
      onProjectsRefresh,
    }));
    const persisted = {
      ...projectA,
      name: 'Renamed while leaving',
      updatedAt: projectA.updatedAt + 1,
    };
    await act(async () => {
      patch.resolve(persisted);
      await patch.promise;
    });

    expect(onProjectRenameSettled).toHaveBeenCalledWith(token, persisted);
    expect(onProjectsRefresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('project-title').textContent).toBe('Project B');
  });

  it('settles independent project rename fences when A and B finish out of order', async () => {
    const projectA = {
      ...project,
      name: 'Project A',
    };
    const projectB = {
      ...project,
      id: 'project-2',
      name: 'Project B',
    };
    const patchA = deferred<Project | null>();
    const patchB = deferred<Project | null>();
    const tokenA: ProjectRenameFenceToken = {
      projectId: projectA.id,
      mutationVersion: 11,
    };
    const tokenB: ProjectRenameFenceToken = {
      projectId: projectB.id,
      mutationVersion: 12,
    };
    const onProjectRenameStarted = vi.fn((next: Project) =>
      next.id === projectA.id ? tokenA : tokenB);
    const onProjectRenameSettled = vi.fn();
    mockedPatchProject
      .mockImplementationOnce(() => patchA.promise)
      .mockImplementationOnce(() => patchB.promise);

    const view = render(projectViewElement(projectA, {
      onProjectRenameStarted,
      onProjectRenameSettled,
    }));
    let title = await screen.findByTestId('project-title');
    title.textContent = 'Rename A';
    fireEvent.blur(title);
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(1));

    view.rerender(projectViewElement(projectB, {
      onProjectRenameStarted,
      onProjectRenameSettled,
    }));
    title = await screen.findByTestId('project-title');
    title.textContent = 'Rename B';
    fireEvent.blur(title);
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(2));

    const persistedB = {
      ...projectB,
      name: 'Rename B',
      updatedAt: projectB.updatedAt + 1,
    };
    await act(async () => {
      patchB.resolve(persistedB);
      await patchB.promise;
    });
    await waitFor(() => {
      expect(onProjectRenameSettled).toHaveBeenCalledWith(tokenB, persistedB);
    });

    const persistedA = {
      ...projectA,
      name: 'Rename A',
      updatedAt: projectA.updatedAt + 1,
    };
    await act(async () => {
      patchA.resolve(persistedA);
      await patchA.promise;
    });
    await waitFor(() => {
      expect(onProjectRenameSettled).toHaveBeenCalledWith(tokenA, persistedA);
    });
    expect(onProjectRenameSettled).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('project-title').textContent).toBe('Rename B');
  });

  it.each([
    [false, false, 'Confirmed name'],
    [true, false, 'Rename A'],
    [false, true, 'Rename B'],
    [true, true, 'Rename B'],
  ])(
    'serializes repeated renames (first=%s, second=%s) and ends at %s',
    async (firstSucceeds, secondSucceeds, expectedName) => {
    const ownerProject = {
      ...project,
      name: 'Confirmed name',
    };
    const firstPatch = deferred<Project | null>();
    const secondPatch = deferred<Project | null>();
    mockedPatchProject
      .mockImplementationOnce(() => firstPatch.promise)
      .mockImplementationOnce(() => secondPatch.promise);

    function RenameShell() {
      const [activeProject, setActiveProject] = useState<Project>(ownerProject);
      return projectViewElement(activeProject, {
        onProjectChange: setActiveProject,
      });
    }

    render(<RenameShell />);
    const rename = async (name: string) => {
      const title = await screen.findByTestId('project-title');
      title.textContent = name;
      fireEvent.blur(title);
    };

    await rename('Rename A');
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(1));
    await rename('Rename B');
    await act(async () => Promise.resolve());
    expect(mockedPatchProject).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('project-title').textContent).toBe('Rename B');

    await act(async () => {
      firstPatch.resolve(firstSucceeds
        ? { ...ownerProject, name: 'Rename A', updatedAt: ownerProject.updatedAt + 1 }
        : null);
      await firstPatch.promise;
    });
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('project-title').textContent).toBe('Rename B');

    await act(async () => {
      secondPatch.resolve(secondSucceeds
        ? { ...ownerProject, name: 'Rename B', updatedAt: ownerProject.updatedAt + 2 }
        : null);
      await secondPatch.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe(expectedName);
    });
  });

  it('hydrates the title through the local Project endpoint', async () => {
    const placeholder = { ...project };
    const pulled = {
      ...placeholder,
      name: 'Recipient sees the real title',
      updatedAt: 456,
    };
    mockedGetProject.mockResolvedValue(pulled);

    function RecipientShell() {
      const [activeProject, setActiveProject] = useState<Project>(placeholder);
      return (
        <>
          <span data-testid="recipient-sidebar-title">{activeProject.name}</span>
          <span data-testid="recipient-tab-title">{activeProject.name}</span>
          {projectViewElement(activeProject, {
            onProjectChange: setActiveProject,
          })}
        </>
      );
    }

    render(<RecipientShell />);
    dispatchProjectEvent({ type: 'project-metadata-changed', projectId: project.id });

    await waitFor(() => {
      expect(mockedGetProject).toHaveBeenCalledWith(project.id, null);
      expect(screen.getByTestId('recipient-sidebar-title').textContent).toBe(pulled.name);
      expect(screen.getByTestId('recipient-tab-title').textContent).toBe(pulled.name);
      expect(screen.getByTestId('file-workspace').getAttribute('data-project-name')).toBe(pulled.name);
    });
  });

  it('ignores project-metadata-changed events for other projects', async () => {
    mockedGetProject.mockResolvedValue({ ...project, id: 'project-2', name: 'Other' });

    renderProjectView();
    dispatchProjectEvent({ type: 'project-metadata-changed', projectId: 'project-2' });

    // Give any (wrong) async refetch a beat to run before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(onProjectChangeMock).not.toHaveBeenCalled();
  });

  it('does not churn App state when the re-fetched record matches what is already rendered', async () => {
    // Same name/skill/design-system as the current prop: e.g. the signal came
    // from a content-publish nudge, not a rename. No `onProjectChange` — an
    // unconditional apply would re-render the whole App on every publish.
    mockedGetProject.mockResolvedValue({ ...project });

    renderProjectView();
    dispatchProjectEvent({ type: 'project-metadata-changed', projectId: project.id });

    await waitFor(() => {
      expect(mockedGetProject).toHaveBeenCalledWith(project.id, null);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onProjectChangeMock).not.toHaveBeenCalled();
  });

  it('uses a newer detail from the same local project', () => {
    expect(reconcileProjectDetail(project, {
      ...project,
      name: 'Q3 Marketing Site',
      updatedAt: 2,
    }).name).toBe('Q3 Marketing Site');
  });

  it('ignores a late detail response from the previous project', () => {
    const nextProject = {
      ...project,
      id: 'project-2',
      name: 'Next project',
      updatedAt: 1,
    };
    expect(reconcileProjectDetail(nextProject, {
      ...project,
      id: 'project-1',
      name: 'Stale project',
      updatedAt: 999,
    })).toBe(nextProject);
  });

});
