// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type {
  ProjectRenameFenceToken,
} from '../../src/components/ProjectView';
import type { AgentInfo, AppConfig, Project } from '../../src/types';
import {
  fetchComposioConfigFromDaemon,
  fetchDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncComposioConfigToDaemon,
  syncConfigToDaemon,
} from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchPromptTemplates,
  fetchSkills,
  replaceProjectWorkingDir,
  uploadProjectFiles,
} from '../../src/providers/registry';
import {
  createDesignSystemProjectFromProject,
  createProject,
  createPluginShareProject,
  deleteProject,
  duplicateProject,
  getProject,
  invalidatePluginCatalogCache,
  listProjects,
  listTemplates,
  patchProject,
} from '../../src/state/projects';
import { resetCoalescedGet } from '../../src/lib/coalesced-get';

const iframePoolHarness = vi.hoisted(() => ({
  evictMatching: vi.fn(),
  evictProject: vi.fn(),
}));

const projectViewRenameFenceHarness = vi.hoisted(() => ({
  token: null as ProjectRenameFenceToken | null,
}));

const workspaceTabsHarness = vi.hoisted(() => ({
  projectIds: new Set<string>(),
}));

vi.mock('../../src/components/IframeKeepAlivePool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/components/IframeKeepAlivePool')>()),
  useIframeKeepAlivePool: () => ({
    attach: vi.fn(),
    release: vi.fn(),
    evict: vi.fn(),
    evictProject: iframePoolHarness.evictProject,
    evictMatching: iframePoolHarness.evictMatching,
    subscribe: vi.fn(() => () => {}),
    revision: vi.fn(() => 0),
  }),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({
    onCreateProject,
    onCreatePluginShareProject,
    onDeleteProject,
    onImportFolderResponse,
    onOpenProject,
    onRenameProject,
    onOpenSettings,
    onRefreshAgents,
    agents,
    projects,
    projectsLoading,
  }: {
    onCreateProject: (input: unknown) => boolean | Promise<boolean>;
    onCreatePluginShareProject: (
      pluginId: string,
      action: 'publish-github' | 'contribute-open-design',
    ) => Promise<unknown>;
    onDeleteProject: (id: string) => void;
    onImportFolderResponse?: (response: {
      conversationId: string;
      entryFile: string | null;
      ok: true;
      projectId: string;
    }) => Promise<void> | void;
    onOpenProject: (
      id: string,
      fileName?: string,
    ) => Promise<boolean> | boolean | void;
    onRenameProject?: (id: string, name: string) => Promise<void> | void;
    onOpenSettings: () => void;
    onRefreshAgents: () => void | Promise<void>;
    agents: AgentInfo[];
    projects: Project[];
    projectsLoading?: boolean;
  }) => (
    <main>
      <div data-testid="entry-home-surface" />
      <div data-testid="entry-projects-loading">{String(Boolean(projectsLoading))}</div>
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(onCreateProject({
            name: 'Fresh project',
            skillId: null,
            designSystemId: null,
            metadata: { kind: 'prototype' },
          })).catch(() => {});
        }}
      >
        Create project
      </button>
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(onCreateProject({
            name: 'Prompted project',
            skillId: null,
            designSystemId: null,
            pendingPrompt: 'Build the retained artifact prompt',
            pendingFiles: [new File(['brief'], 'brief.txt', { type: 'text/plain' })],
            autoSendFirstMessage: true,
            metadata: { kind: 'prototype' },
          })).catch(() => {});
        }}
      >
        Create prompted project
      </button>
      <button
        type="button"
        onClick={() => void onCreatePluginShareProject(
          'plugin-source',
          'publish-github',
        )}
      >
        Create plugin share project
      </button>
      <button
        type="button"
        onClick={() =>
          onCreateProject({
            name: 'Dir project',
            skillId: null,
            designSystemId: null,
            metadata: { kind: 'prototype', userWorkingDir: '/Users/me/external' },
            userWorkingDirToken: 'wd-token',
            pendingFiles: [new File(['hi'], 'note.txt', { type: 'text/plain' })],
          })
        }
      >
        Create project with working dir
      </button>
      <button
        type="button"
        onClick={() =>
          onCreateProject({
            name: 'Context dir project',
            skillId: null,
            designSystemId: null,
            metadata: { kind: 'prototype', linkedDirs: ['/Users/me/existing'] },
            linkedDirs: ['/Users/me/reference', ' /Users/me/reference ', '/Users/me/local-code'],
          })
        }
      >
        Create project with context dirs
      </button>
      <button
        type="button"
        onClick={() =>
          void onImportFolderResponse?.({
            conversationId: 'conv-import',
            entryFile: null,
            ok: true,
            projectId: 'project-new',
          })
        }
      >
        Host import folder
      </button>
      <button type="button" onClick={() => void onRefreshAgents()}>
        Refresh agents
      </button>
      <button type="button" onClick={onOpenSettings}>
        Open settings from home
      </button>
      <button type="button" onClick={() => void onOpenProject('project-missing')}>
        Open missing project
      </button>
      <button
        type="button"
        onClick={() => projects[0] && void onRenameProject?.(projects[0].id, 'Rename A')}
      >
        Rename first project A
      </button>
      <button
        type="button"
        onClick={() => projects[0] && void onRenameProject?.(projects[0].id, 'Rename B')}
      >
        Rename first project B
      </button>
      <div data-testid="entry-agent-list">
        {agents.map((agent) => (
          <span key={agent.id} data-testid={`entry-agent-${agent.id}`}>
            {agent.name}
          </span>
        ))}
      </div>
      {projects.map((project) => (
        <div key={project.id} data-testid={`entry-project-${project.id}`}>
          <span>{project.name}</span>
          <button type="button" onClick={() => onOpenProject(project.id)}>
            Open {project.name}
          </button>
          <button type="button" onClick={() => void onDeleteProject(project.id)}>
            Delete {project.name}
          </button>
        </div>
      ))}
    </main>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: ({
    onBack,
    onCreateProjectFromDesignSystem,
    onCreateDesignSystemFromProject,
    onDuplicateProject,
    onProjectsRefresh,
    onProjectChange,
    onProjectRenameStarted,
    onProjectRenameSettled,
    project,
    routeConversationId,
    onOpenSettings,
  }: {
    onBack: () => void;
    onCreateProjectFromDesignSystem?: (designSystemId: string, title: string) => Promise<void> | void;
    onCreateDesignSystemFromProject?: (
      sourceProjectId: string,
      input: { name?: string; pendingPrompt?: string },
    ) => Promise<void> | void;
    onDuplicateProject?: (
      sourceProjectId: string,
      input?: { name?: string },
    ) => Promise<void> | void;
    onProjectsRefresh: () => Promise<void>;
    onProjectChange: (project: Project) => void;
    onProjectRenameStarted?: (project: Project) => ProjectRenameFenceToken | null;
    onProjectRenameSettled?: (
      token: ProjectRenameFenceToken | null,
      project: Project,
    ) => void;
    project: Project;
    routeConversationId?: string | null;
    onOpenSettings?: () => void;
  }) => (
    <main data-testid="project-view">
      <span data-testid="project-title">{project.name}</span>
      <span data-testid="project-route-conversation">{routeConversationId ?? 'none'}</span>
      <button type="button" onClick={onBack}>
        Back to projects
      </button>
      <button
        type="button"
        onClick={() => void onCreateDesignSystemFromProject?.(project.id, {
          name: 'Derived design system',
          pendingPrompt: 'Extract the retained design system prompt',
        })}
      >
        Extract design system project
      </button>
      <button
        type="button"
        onClick={() => void onDuplicateProject?.(project.id, {
          name: 'Scoped duplicate',
        })}
      >
        Duplicate project
      </button>
      <button type="button" onClick={onOpenSettings}>
        Open settings from project
      </button>
      <button type="button" onClick={() => void onProjectsRefresh()}>
        Refresh projects
      </button>
      <button
        type="button"
        onClick={() => {
          const optimistic = {
            ...project,
            name: 'After local rename',
            updatedAt: project.updatedAt + 1,
          };
          projectViewRenameFenceHarness.token = onProjectRenameStarted?.(optimistic) ?? null;
          onProjectChange(optimistic);
        }}
      >
        Rename current project
      </button>
      <button
        type="button"
        onClick={() => onProjectChange({
          ...project,
          name: 'Remote rename',
          updatedAt: project.updatedAt + 1,
        })}
      >
        Apply remote project rename
      </button>
      <button
        type="button"
        onClick={() => onProjectRenameSettled?.(projectViewRenameFenceHarness.token, project)}
      >
        Settle current project rename
      </button>
      <button
        type="button"
        onClick={() => void onCreateProjectFromDesignSystem?.('slack', 'Slack')}
      >
        Create design from design system
      </button>
    </main>
  ),
}));

vi.mock('../../src/components/WorkspaceTabsBar', () => ({
  WorkspaceTabsBar: ({
    projects,
  }: {
    projects: Project[];
  }) => (
    <>
      {projects.map((project) => (
        <span key={project.id} data-testid={`workspace-tab-name-${project.id}`}>
          {project.name}
        </span>
      ))}
    </>
  ),
  openWorkspaceTab: (route: { kind: string; projectId?: string }) => {
    if (route.kind === 'project' && route.projectId) {
      workspaceTabsHarness.projectIds.add(route.projectId);
    }
  },
  removeWorkspaceProjectTabs: (projectId: string) => {
    workspaceTabsHarness.projectIds.delete(projectId);
  },
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="settings-surface">
      <button type="button" onClick={onClose}>
        Close settings
      </button>
    </div>
  ),
  switchApiProtocolConfig: (config: AppConfig) => config,
  updateCurrentApiProtocolConfig: (config: AppConfig) => config,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
    replaceProjectWorkingDir: vi.fn(),
    uploadProjectFiles: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createDesignSystemProjectFromProject: vi.fn(),
    createProject: vi.fn(),
    createPluginShareProject: vi.fn(),
    deleteProject: vi.fn(),
    duplicateProject: vi.fn(),
    getProject: vi.fn(),
    invalidatePluginCatalogCache: vi.fn(actual.invalidatePluginCatalogCache),
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
    patchProject: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchDaemonConfig: vi.fn().mockResolvedValue({}),
    fetchComposioConfigFromDaemon: vi.fn().mockResolvedValue(null),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    saveConfig: vi.fn(),
    syncComposioConfigToDaemon: vi.fn().mockResolvedValue(true),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchDesignSystems = vi.mocked(fetchDesignSystems);
const mockedFetchDesignTemplates = vi.mocked(fetchDesignTemplates);
const mockedFetchPromptTemplates = vi.mocked(fetchPromptTemplates);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedUploadProjectFiles = vi.mocked(uploadProjectFiles);
const mockedReplaceProjectWorkingDir = vi.mocked(replaceProjectWorkingDir);
const mockedCreateDesignSystemProjectFromProject = vi.mocked(createDesignSystemProjectFromProject);
const mockedCreateProject = vi.mocked(createProject);
const mockedCreatePluginShareProject = vi.mocked(createPluginShareProject);
const mockedDeleteProject = vi.mocked(deleteProject);
const mockedDuplicateProject = vi.mocked(duplicateProject);
const mockedGetProject = vi.mocked(getProject);
const mockedInvalidatePluginCatalogCache = vi.mocked(invalidatePluginCatalogCache);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedPatchProject = vi.mocked(patchProject);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);
const mockedFetchComposioConfigFromDaemon = vi.mocked(fetchComposioConfigFromDaemon);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedMergeDaemonConfig = vi.mocked(mergeDaemonConfig);
const mockedSaveConfig = vi.mocked(saveConfig);
const mockedSyncComposioConfigToDaemon = vi.mocked(syncComposioConfigToDaemon);
const mockedSyncConfigToDaemon = vi.mocked(syncConfigToDaemon);

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  privacyDecisionAt: 1778244000000,
  mediaProviders: {},
  composio: {},
  agentModels: {},
  agentCliEnv: {},
};

const freshProject: Project = {
  id: 'project-new',
  name: 'Fresh project',
  skillId: null,
  designSystemId: null,
  createdAt: 1778244000000,
  updatedAt: 1778244000000,
  metadata: { kind: 'prototype' },
};

const existingProject: Project = {
  id: 'project-existing',
  name: 'Existing project',
  skillId: null,
  designSystemId: null,
  createdAt: 1778243000000,
  updatedAt: 1778243000000,
  metadata: { kind: 'prototype' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('App project creation routing', () => {
  beforeEach(() => {
    resetCoalescedGet();
    projectViewRenameFenceHarness.token = null;
    workspaceTabsHarness.projectIds.clear();
    window.history.replaceState(null, '', '/');
    mockedDaemonIsLive.mockResolvedValue(true);
    mockedFetchAgentsStream.mockResolvedValue([]);
    mockedFetchSkills.mockResolvedValue([]);
    mockedFetchDesignTemplates.mockResolvedValue([]);
    mockedFetchDesignSystems.mockResolvedValue([]);
    mockedFetchPromptTemplates.mockResolvedValue([]);
    mockedFetchAppVersionInfo.mockResolvedValue(null);
    mockedListTemplates.mockResolvedValue([]);
    mockedFetchDaemonConfig.mockResolvedValue({});
    mockedFetchComposioConfigFromDaemon.mockResolvedValue(null);
    mockedMergeDaemonConfig.mockImplementation((local) => local);
    mockedLoadConfig.mockReturnValue({ ...baseConfig });
    mockedUploadProjectFiles.mockResolvedValue({ uploaded: [], failed: [] });
    mockedCreateProject.mockResolvedValue({
      project: freshProject,
      conversationId: 'conv-new',
    });
    mockedCreateDesignSystemProjectFromProject.mockResolvedValue({
      project: {
        ...freshProject,
        id: 'project-design-system',
        name: 'Derived design system',
      },
      conversationId: 'conv-design-system',
      designSystemId: 'derived-design-system',
      copiedFiles: [],
    });
    mockedCreatePluginShareProject.mockResolvedValue({
      ok: true,
      project: {
        ...freshProject,
        id: 'project-plugin-share',
        name: 'Plugin share project',
        pendingPrompt: 'Publish the retained plugin share prompt',
      },
      conversationId: 'conv-plugin-share',
      actionPluginId: 'od-plugin-publish-github',
      sourcePluginId: 'plugin-source',
      stagedPath: 'plugin-source',
      prompt: 'Publish the retained plugin share prompt',
      message: 'Prepared',
    });
    mockedDeleteProject.mockResolvedValue(true);
    mockedDuplicateProject.mockResolvedValue({
      project: {
        ...freshProject,
        id: 'project-duplicate',
        name: 'Scoped duplicate',
      },
      conversationId: 'conv-duplicate',
      copiedFiles: [],
    });
    mockedGetProject.mockResolvedValue(null);
    mockedPatchProject.mockResolvedValue(freshProject);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetCoalescedGet();
  });

  it('auto-picks the first available agent in registry order after streamed probes settle', async () => {
    const codexAgent: AgentInfo = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.80.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const claudeAgent: AgentInfo = {
      id: 'claude',
      name: 'Claude Code',
      bin: 'claude',
      available: true,
      version: '1.0.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    mockedLoadConfig.mockReturnValue({ ...baseConfig, agentId: null });
    mockedListProjects.mockResolvedValue([]);
    mockedFetchAgentsStream.mockImplementation(async ({ onAgent }) => {
      onAgent(codexAgent);
      onAgent(claudeAgent);
      return [codexAgent, claudeAgent];
    });

    render(<App />);

    await waitFor(() => {
      expect(mockedSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'claude' }),
      );
    });
    expect(
      mockedSaveConfig.mock.calls.some(([saved]) => saved.agentId === 'codex'),
    ).toBe(false);
    expect(mockedSyncConfigToDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'claude' }),
    );
  });

  it('ignores stale streamed writes from an older bootstrap after a newer rescan', async () => {
    const staleCodexAgent: AgentInfo = {
      id: 'codex',
      name: 'Stale Codex CLI',
      bin: 'codex',
      available: false,
      version: null,
      models: [],
    };
    const refreshedCodexAgent: AgentInfo = {
      id: 'codex',
      name: 'Fresh Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.80.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const staleBootstrap = deferred<AgentInfo[]>();
    let emitStaleAgent: ((agent: AgentInfo) => void) | null = null;
    mockedFetchAgentsStream
      .mockImplementationOnce(({ onAgent }) => {
        emitStaleAgent = onAgent;
        return staleBootstrap.promise;
      })
      .mockImplementationOnce(async ({ onAgent }) => {
        onAgent(refreshedCodexAgent);
        return [refreshedCodexAgent];
      });
    mockedListProjects.mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh agents' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-agent-codex').textContent).toBe(
        'Fresh Codex CLI',
      );
    });

    await act(async () => {
      emitStaleAgent?.(staleCodexAgent);
      staleBootstrap.resolve([staleCodexAgent]);
      await staleBootstrap.promise;
    });

    expect(screen.getByTestId('entry-agent-codex').textContent).toBe(
      'Fresh Codex CLI',
    );
  });

  it('does not auto-pick from a partial rescan when an older bootstrap settles', async () => {
    const codexAgent: AgentInfo = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.80.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const claudeAgent: AgentInfo = {
      id: 'claude',
      name: 'Claude Code',
      bin: 'claude',
      available: true,
      version: '1.0.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const staleBootstrap = deferred<AgentInfo[]>();
    const rescan = deferred<AgentInfo[]>();
    mockedLoadConfig.mockReturnValue({ ...baseConfig, agentId: null });
    mockedListProjects.mockResolvedValue([]);
    mockedFetchAgentsStream
      .mockReturnValueOnce(staleBootstrap.promise)
      .mockImplementationOnce(({ onAgent }) => {
        onAgent(codexAgent);
        return rescan.promise;
      });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh agents' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-agent-codex').textContent).toBe(
        'Codex CLI',
      );
    });

    await act(async () => {
      staleBootstrap.resolve([]);
      await staleBootstrap.promise;
    });
    await act(async () => {
      rescan.resolve([codexAgent, claudeAgent]);
      await rescan.promise;
    });

    await waitFor(() => {
      expect(mockedSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'claude' }),
      );
    });
    expect(
      mockedSaveConfig.mock.calls.some(([saved]) => saved.agentId === 'codex'),
    ).toBe(false);
  });

  it('keeps auto-pick gated while rescanning from an empty agent state', async () => {
    const codexAgent: AgentInfo = {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.80.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const claudeAgent: AgentInfo = {
      id: 'claude',
      name: 'Claude Code',
      bin: 'claude',
      available: true,
      version: '1.0.0',
      models: [{ id: 'default', label: 'Default' }],
    };
    const initialProbe = deferred<AgentInfo[]>();
    const rescan = deferred<AgentInfo[]>();
    mockedLoadConfig.mockReturnValue({ ...baseConfig, agentId: null });
    mockedListProjects.mockResolvedValue([]);
    mockedFetchAgentsStream
      .mockReturnValueOnce(initialProbe.promise)
      .mockImplementationOnce(({ onAgent }) => {
        onAgent(codexAgent);
        return rescan.promise;
      });

    render(<App />);

    await waitFor(() => {
      expect(mockedFetchAgentsStream).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      initialProbe.resolve([]);
      await initialProbe.promise;
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh agents' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-agent-codex').textContent).toBe(
        'Codex CLI',
      );
    });

    await act(async () => {
      rescan.resolve([codexAgent, claudeAgent]);
      await rescan.promise;
    });

    await waitFor(() => {
      expect(mockedSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'claude' }),
      );
    });
    expect(
      mockedSaveConfig.mock.calls.some(([saved]) => saved.agentId === 'codex'),
    ).toBe(false);
  });

  it('keeps a newly created project open when the initial project list resolves stale', async () => {
    const bootstrapProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('stores the Home auto-send prompt outside the project projection before a refresh can drop it', async () => {
    mockedListProjects.mockResolvedValue([]);
    mockedCreateProject.mockResolvedValue({
      project: { ...freshProject, name: 'Prompted project' },
      conversationId: 'conv-new',
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));

    await screen.findByTestId('project-view');
    expect(window.sessionStorage.getItem('od:auto-send-first:project-new')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:project-new')).toBe(
      'Build the retained artifact prompt',
    );
  });

  it('enters the project preparing surface before Home project creation settles', async () => {
    mockedListProjects.mockResolvedValue([]);
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    let requestedProjectId: string | undefined;
    mockedCreateProject.mockImplementation((input) => {
      requestedProjectId = (input as typeof input & { id?: string }).id;
      return creation.promise;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));

    await screen.findByTestId('project-creation-pending-view');
    expect(requestedProjectId).toBeTruthy();
    expect(window.location.pathname).toBe(`/projects/${requestedProjectId}`);
    expect(screen.getByText('Build the retained artifact prompt')).toBeTruthy();
    expect(screen.getByText('Preparing...')).toBeTruthy();
    expect(screen.queryByTestId('entry-home-surface')).toBeNull();
    expect(screen.queryByTestId('project-view')).toBeNull();

    creation.resolve({
      project: {
        ...freshProject,
        id: requestedProjectId!,
        name: 'Prompted project',
        pendingPrompt: 'Build the retained artifact prompt',
      },
      conversationId: 'conv-new',
    });

    await screen.findByTestId('project-view');
    expect(window.location.pathname).toBe(`/projects/${requestedProjectId}`);
  });

  it('rolls a failed optimistic Home creation back to the preserved Home surface', async () => {
    mockedListProjects.mockResolvedValue([]);
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    let requestedProjectId: string | undefined;
    mockedCreateProject.mockImplementation((input) => {
      requestedProjectId = (input as typeof input & { id?: string }).id;
      return creation.promise;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));
    await screen.findByTestId('project-creation-pending-view');
    expect(workspaceTabsHarness.projectIds.has(requestedProjectId!)).toBe(true);

    creation.reject(new Error('Could not create project'));

    await screen.findByTestId('entry-home-surface');
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByTestId('project-creation-pending-view')).toBeNull();
    expect(screen.queryByTestId(`entry-project-${requestedProjectId}`)).toBeNull();
    expect(workspaceTabsHarness.projectIds.has(requestedProjectId!)).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('Could not create project');
  });

  it('releases a persisted project when attachment setup fails after creation', async () => {
    mockedListProjects.mockResolvedValue([]);
    mockedUploadProjectFiles.mockRejectedValue(new Error('Attachment upload failed'));
    const creation = deferred<{
      project: Project;
      conversationId: string;
    }>();
    let requestedProjectId: string | undefined;
    mockedCreateProject.mockImplementation((input) => {
      requestedProjectId = (input as typeof input & { id?: string }).id;
      return creation.promise;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create prompted project' }));
    await screen.findByTestId('project-creation-pending-view');

    creation.resolve({
      project: {
        ...freshProject,
        id: requestedProjectId!,
        name: 'Persisted prompted project',
        pendingPrompt: 'Build the retained artifact prompt',
      },
      conversationId: 'conv-new',
    });

    await screen.findByTestId('project-view');
    expect(screen.getByTestId('project-title').textContent).toBe('Persisted prompted project');
    expect(window.location.pathname).toBe(`/projects/${requestedProjectId}`);
    expect(screen.queryByTestId('project-creation-pending-view')).toBeNull();
    expect(workspaceTabsHarness.projectIds.has(requestedProjectId!)).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Attachment upload failed');
  });

  it('stores the plugin-share prompt before its prepared project projection can refresh', async () => {
    mockedListProjects.mockResolvedValue([]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create plugin share project' }));

    await waitFor(() => expect(mockedCreatePluginShareProject).toHaveBeenCalled());
    await screen.findByTestId('project-view');
    expect(window.sessionStorage.getItem('od:auto-send-first:project-plugin-share')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:project-plugin-share')).toBe(
      'Publish the retained plugin share prompt',
    );
  });

  it('routes "create with this design system" through the default design router, not a prototype', async () => {
    mockedListProjects.mockResolvedValue([existingProject]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    await screen.findByTestId('project-view');
    fireEvent.click(screen.getByRole('button', { name: 'Create design from design system' }));

    await waitFor(() => {
      expect(mockedCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Untitled',
          skillId: null,
          designSystemId: 'slack',
          // No prototype assumption: the click binds the hidden default
          // router so the agent asks (via the task-type question-form) what
          // to build, then auto-sends a preset prompt that names the system.
          pluginId: 'od-default',
          conversationMode: 'design',
          pendingPrompt: expect.stringContaining('Slack'),
          pluginInputs: expect.objectContaining({
            prompt: expect.stringContaining('Slack'),
          }),
          metadata: expect.objectContaining({
            kind: 'other',
          }),
        }),
      );
    });

    // The web-prototype scenario and prototype kind must NOT leak in.
    const call = mockedCreateProject.mock.calls.at(-1)?.[0] as
      | { pluginId?: string; metadata?: { kind?: string } }
      | undefined;
    expect(call?.pluginId).not.toBe('example-web-prototype');
    expect(call?.metadata?.kind).not.toBe('prototype');
    expect(window.sessionStorage.getItem('od:auto-send-first:project-new')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:project-new')).toContain('Slack');
  });

  it('stores the extraction prompt when converting an existing project into a design system', async () => {
    mockedListProjects.mockResolvedValue([existingProject]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Extract design system project' }));

    await waitFor(() => {
      expect(mockedCreateDesignSystemProjectFromProject).toHaveBeenCalledWith(
        'project-existing',
        expect.objectContaining({
          pendingPrompt: 'Extract the retained design system prompt',
        }),
      );
    });
    expect(window.sessionStorage.getItem('od:auto-send-first:project-design-system')).toBe('1');
    expect(window.sessionStorage.getItem('od:auto-send-prompt:project-design-system')).toBe(
      'Extract the retained design system prompt',
    );
  });

  it('duplicates a local project', async () => {
    const sourceProject = { ...existingProject };
    window.history.replaceState(null, '', `/projects/${sourceProject.id}`);
    mockedListProjects.mockResolvedValue([sourceProject]);
    render(<App />);
    await screen.findByTestId('project-view');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate project' }));

    await waitFor(() => {
      expect(mockedDuplicateProject).toHaveBeenCalledWith(
        sourceProject.id,
        { name: 'Scoped duplicate' },
      );
    });
  });

  it('creates a design-system copy from a local project', async () => {
    const sourceProject = { ...existingProject };
    window.history.replaceState(null, '', `/projects/${sourceProject.id}`);
    mockedListProjects.mockResolvedValue([sourceProject]);
    render(<App />);
    await screen.findByTestId('project-view');
    fireEvent.click(screen.getByRole('button', { name: 'Extract design system project' }));

    await waitFor(() => {
      expect(mockedCreateDesignSystemProjectFromProject).toHaveBeenCalledWith(
        sourceProject.id,
        expect.objectContaining({
          pendingPrompt: 'Extract the retained design system prompt',
        }),
      );
    });
  });

  it('keeps a newly created project open when a post-create refresh resolves stale', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const staleRefreshProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(staleRefreshProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));

    await act(async () => {
      staleRefreshProjects.resolve([]);
      await staleRefreshProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('ignores an older stale project list after a newer response confirms the local project', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const refreshedProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(refreshedProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));

    await act(async () => {
      refreshedProjects.resolve([freshProject]);
      await refreshedProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('does not revive nonlocal projects from an older list after a newer empty refresh', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const createRefreshProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(createRefreshProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    expect(mockedListProjects).toHaveBeenCalledTimes(2);

    await act(async () => {
      createRefreshProjects.resolve([]);
      await createRefreshProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([existingProject]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-home-surface')).toBeTruthy();
      expect(screen.getByTestId('entry-project-project-new').textContent).toContain(
        'Fresh project',
      );
    });
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByTestId('entry-project-project-existing')).toBeNull();
  });

  it('removes a locally deleted project from workspace tabs and ignores a stale list', async () => {
    const initialProjects = deferred<Project[]>();
    const staleRefreshProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(initialProjects.promise)
      .mockReturnValueOnce(staleRefreshProjects.promise)
      .mockResolvedValue([]);

    render(<App />);

    await act(async () => {
      initialProjects.resolve([freshProject]);
      await initialProjects.promise;
    });

    expect(screen.getByTestId('entry-project-project-new').textContent).toContain(
      'Fresh project',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Fresh project' }));

    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    });
    workspaceTabsHarness.projectIds.add('project-new');
    expect(workspaceTabsHarness.projectIds.has('project-new')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    expect(mockedListProjects).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Fresh project' }));

    await waitFor(() => {
      expect(mockedDeleteProject).toHaveBeenCalledWith('project-new');
      expect(screen.queryByTestId('entry-project-project-new')).toBeNull();
      expect(workspaceTabsHarness.projectIds.has('project-new')).toBe(false);
    });

    await act(async () => {
      staleRefreshProjects.resolve([freshProject]);
      await staleRefreshProjects.promise;
    });

    expect(screen.queryByTestId('entry-project-project-new')).toBeNull();
  });

  it('keeps a host-imported project routable when getProject and the list lag behind', async () => {
    // Desktop import flow (handleImportFolderResponse fallback): the host
    // bridge has already POSTed the import, but `/api/projects/:id` and
    // `/api/projects` are both still catching up. Without a placeholder
    // the stale `[]` list response would drop the just-imported project
    // from state and the route-guard effect would bounce to Home.
    const bootstrapProjects = deferred<Project[]>();
    const importListProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(importListProjects.promise)
      .mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(null);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Host import folder' }));

    await act(async () => {
      importListProjects.resolve([]);
      await importListProjects.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('project-view')).toBeTruthy();
    });
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-view')).toBeTruthy();
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('hydrates a host-import placeholder from an older project list that contains the import', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const importListProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(importListProjects.promise)
      .mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(null);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Host import folder' }));

    await act(async () => {
      importListProjects.resolve([]);
      await importListProjects.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('project-view')).toBeTruthy();
    });
    expect(screen.getByTestId('project-title').textContent).toBe('');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([freshProject]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    expect(window.location.pathname).toBe('/projects/project-new');
  });

  it('does not revive unrelated projects from an older list that hydrates a host import', async () => {
    const bootstrapProjects = deferred<Project[]>();
    const importListProjects = deferred<Project[]>();
    mockedListProjects
      .mockReturnValueOnce(bootstrapProjects.promise)
      .mockReturnValueOnce(importListProjects.promise)
      .mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(null);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Host import folder' }));

    await act(async () => {
      importListProjects.resolve([]);
      await importListProjects.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('project-view')).toBeTruthy();
    });
    expect(screen.getByTestId('project-title').textContent).toBe('');
    expect(window.location.pathname).toBe('/projects/project-new');

    await act(async () => {
      bootstrapProjects.resolve([freshProject, existingProject]);
      await bootstrapProjects.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('Fresh project');
    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));

    await waitFor(() => {
      expect(screen.getByTestId('entry-project-project-new').textContent).toContain(
        'Fresh project',
      );
    });
    expect(screen.queryByTestId('entry-project-project-existing')).toBeNull();
  });

  it('switches to the picked working dir before uploading staged Home attachments', async () => {
    // Regression for the "picked working dir + staged attachment" case:
    // replaceProjectWorkingDir flips metadata.baseDir to the external folder,
    // so it must run BEFORE uploadProjectFiles — otherwise the staged files
    // land in the temporary managed .od/projects/<id> root and vanish once the
    // working dir flips. Asserting the call order locks the ordering in.
    mockedListProjects.mockResolvedValue([]);
    mockedReplaceProjectWorkingDir.mockResolvedValue(undefined as never);

    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project with working dir' }),
    );

    await waitFor(() => {
      expect(mockedReplaceProjectWorkingDir).toHaveBeenCalledTimes(1);
      expect(mockedUploadProjectFiles).toHaveBeenCalledTimes(1);
    });

    expect(mockedReplaceProjectWorkingDir).toHaveBeenCalledWith(
      'project-new',
      '/Users/me/external',
      'wd-token',
    );
    // Both target the same project id, and the working-dir handoff is ordered
    // strictly before the upload so the files land in the final tree.
    expect(mockedUploadProjectFiles.mock.calls[0]?.[0]).toBe('project-new');
    const replaceOrder = mockedReplaceProjectWorkingDir.mock.invocationCallOrder[0]!;
    const uploadOrder = mockedUploadProjectFiles.mock.invocationCallOrder[0]!;
    expect(replaceOrder).toBeLessThan(uploadOrder);
  });

  it('persists Home context linked dirs into the project create metadata', async () => {
    mockedListProjects.mockResolvedValue([]);

    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project with context dirs' }),
    );

    await waitFor(() => {
      expect(mockedCreateProject).toHaveBeenCalled();
    });
    expect(mockedCreateProject.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          linkedDirs: [
            '/Users/me/existing',
            '/Users/me/reference',
            '/Users/me/local-code',
          ],
        }),
      }),
    );
  });

  it('short-circuits the upload + auto-send when the working-dir handoff fails', async () => {
    // Regression for the swallowed-failure case: the desktop working-dir token
    // has a ~60s TTL, so a slow user (or any rejected POST) makes
    // replaceProjectWorkingDir throw AFTER the project already exists. The old
    // code only logged a warning and then uploaded the staged attachments into
    // the managed root while the user believed their chosen folder was applied.
    // The fix surfaces a create-time error toast AND aborts the rest of the
    // submit path so the first run cannot proceed on a tree the user did not
    // choose.
    mockedListProjects.mockResolvedValue([]);
    mockedReplaceProjectWorkingDir.mockRejectedValue(
      new Error('working-dir token expired'),
    );

    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create project with working dir' }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Couldn't apply the chosen folder/i)).toBeTruthy();
    });
    expect(mockedReplaceProjectWorkingDir).toHaveBeenCalledTimes(1);
    // The handoff failed, so the staged attachments must NOT be uploaded into
    // the managed `.od/projects/<id>` root the user did not pick.
    expect(mockedUploadProjectFiles).not.toHaveBeenCalled();
  });

  it('surfaces a toast instead of silently bouncing when opening a missing project', async () => {
    mockedListProjects.mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(null);

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open missing project' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'This project has been deleted or no longer exists.',
      );
    });
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByTestId('project-view')).toBeNull();
  });

  it('projects a current-view rename into the tab and recent list immediately', async () => {
    mockedListProjects.mockResolvedValue([existingProject]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    await screen.findByTestId('project-view');

    fireEvent.click(screen.getByRole('button', { name: 'Rename current project' }));
    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('After local rename');
      expect(screen.getByTestId('workspace-tab-name-project-existing').textContent).toBe(
        'After local rename',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    await waitFor(() => {
      expect(screen.getByTestId('entry-project-project-existing').textContent).toContain(
        'After local rename',
      );
    });
  });

  it('does not mistake an authoritative remote title update for a local rename fence', async () => {
    mockedListProjects
      .mockResolvedValueOnce([existingProject])
      .mockResolvedValue([{ ...existingProject, name: 'Newer server authority' }]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    await screen.findByTestId('project-view');

    fireEvent.click(screen.getByRole('button', { name: 'Apply remote project rename' }));
    expect(screen.getByTestId('project-title').textContent).toBe('Remote rename');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Newer server authority');
      expect(screen.getByTestId('workspace-tab-name-project-existing').textContent).toBe(
        'Newer server authority',
      );
    });
  });

  it('releases a settled local rename fence to a newer authoritative server title', async () => {
    mockedListProjects
      .mockResolvedValueOnce([existingProject])
      .mockResolvedValue([{ ...existingProject, name: 'Other tab rename' }]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    await screen.findByTestId('project-view');

    fireEvent.click(screen.getByRole('button', { name: 'Rename current project' }));
    expect(screen.getByTestId('project-title').textContent).toBe('After local rename');
    fireEvent.click(screen.getByRole('button', { name: 'Settle current project rename' }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('Other tab rename');
      expect(screen.getByTestId('workspace-tab-name-project-existing').textContent).toBe(
        'Other tab rename',
      );
    });
  });

  it('does not let a pre-rename list response roll back the project title or tab', async () => {
    const staleList = deferred<Project[]>();
    mockedListProjects
      .mockResolvedValueOnce([existingProject])
      .mockImplementationOnce(() => staleList.promise)
      .mockResolvedValue([{ ...existingProject, name: 'After local rename' }]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Existing project' }));
    await screen.findByTestId('project-view');
    fireEvent.click(screen.getByRole('button', { name: 'Rename current project' }));
    expect(screen.getByTestId('project-title').textContent).toBe('After local rename');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    await waitFor(() => expect(mockedListProjects).toHaveBeenCalledTimes(2));
    await act(async () => {
      staleList.resolve([existingProject]);
      await staleList.promise;
    });

    expect(screen.getByTestId('project-title').textContent).toBe('After local rename');
    expect(screen.getByTestId('workspace-tab-name-project-existing').textContent).toBe(
      'After local rename',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    await waitFor(() => expect(mockedListProjects).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    await waitFor(() => {
      expect(screen.getByTestId('entry-project-project-existing').textContent).toContain(
        'After local rename',
      );
    });
  });

  it('serializes list renames and rolls repeated failures back to the confirmed name', async () => {
    const firstPatch = deferred<Project | null>();
    const secondPatch = deferred<Project | null>();
    mockedListProjects.mockResolvedValue([existingProject]);
    mockedPatchProject
      .mockImplementationOnce(() => firstPatch.promise)
      .mockImplementationOnce(() => secondPatch.promise);

    render(<App />);
    await screen.findByTestId('entry-project-project-existing');
    fireEvent.click(screen.getByRole('button', { name: 'Rename first project A' }));
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Rename first project B' }));
    await act(async () => Promise.resolve());
    expect(mockedPatchProject).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('entry-project-project-existing').textContent).toContain('Rename B');

    await act(async () => {
      firstPatch.resolve(null);
      await firstPatch.promise;
    });
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('entry-project-project-existing').textContent).toContain('Rename B');

    await act(async () => {
      secondPatch.resolve(null);
      await secondPatch.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId('entry-project-project-existing').textContent).toContain(
        'Existing project',
      );
    });
  });

  it.each([
    [true, 'Newer Project A authority'],
    [false, 'Project A'],
  ])(
    'settles a captured rename fence after another project enters the list (success=%s)',
    async (succeeds, expectedName) => {
      const projectA: Project = {
        ...existingProject,
        id: 'project-a',
        name: 'Project A',
      };
      const projectB: Project = {
        ...existingProject,
        id: 'project-b',
        name: 'Project B',
      };
      const patch = deferred<Project | null>();
      let projectAAuthority = projectA;
      mockedPatchProject.mockImplementationOnce(() => patch.promise);
      mockedListProjects.mockImplementation(async () => [projectAAuthority, projectB]);

      render(<App />);
      await screen.findByTestId('entry-project-project-a');
      fireEvent.click(screen.getByRole('button', { name: 'Rename first project A' }));
      await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledTimes(1));

      expect(screen.queryByTestId('entry-project-project-b')).not.toBeNull();

      const persisted = succeeds
        ? { ...projectA, name: 'Rename A', updatedAt: projectA.updatedAt + 1 }
        : null;
      projectAAuthority = succeeds
        ? { ...projectA, name: 'Newer Project A authority', updatedAt: projectA.updatedAt + 2 }
        : projectA;
      await act(async () => {
        patch.resolve(persisted);
        await patch.promise;
      });

      await waitFor(() => {
        expect(screen.getByTestId('entry-project-project-a').textContent).toContain(expectedName);
      });
    },
  );

  it('keeps a newly created renamed project across project and home routes', async () => {
    const olderProjects: Project[] = [
      {
        ...existingProject,
        id: 'project-old-a',
        name: 'Untitled A',
      },
      {
        ...existingProject,
        id: 'project-old-b',
        name: 'Untitled B',
      },
    ];
    const createdProject: Project = { ...freshProject };
    mockedListProjects.mockResolvedValue(olderProjects);
    mockedCreateProject.mockResolvedValue({
      project: createdProject,
      conversationId: 'conv-new',
    });
    render(<App />);
    await screen.findByTestId('entry-project-project-old-a');

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByTestId('project-view');
    fireEvent.click(screen.getByRole('button', { name: 'Rename current project' }));
    await waitFor(() => {
      expect(screen.getByTestId('project-title').textContent).toBe('After local rename');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    await screen.findByTestId('entry-home-surface');
    expect(screen.getByTestId('entry-project-project-new').textContent).toContain(
      'After local rename',
    );
  });

  it('preserves a newly created Project alongside a refreshed project list', async () => {
    const createdProject: Project = { ...freshProject };
    const existingPeerProject: Project = {
      ...existingProject,
      id: 'project-peer',
      name: 'Peer project',
    };
    mockedCreateProject.mockResolvedValue({
      project: createdProject,
      conversationId: 'conv-new',
    });
    mockedListProjects.mockResolvedValue([createdProject, existingPeerProject]);

    render(<App />);
    await waitFor(() => expect(mockedListProjects).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByTestId('project-view');

    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    await screen.findByTestId('entry-project-project-peer');
    expect(screen.queryByTestId('entry-project-project-new')).not.toBeNull();
  });

  it('preserves a newly created local project when returning home', async () => {
    const createdProject: Project = { ...freshProject };
    mockedListProjects.mockResolvedValue([]);
    mockedCreateProject.mockResolvedValue({
      project: createdProject,
      conversationId: 'conv-new',
    });
    render(<App />);
    await waitFor(() => expect(mockedListProjects).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await screen.findByTestId('project-view');

    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
    expect(await screen.findByTestId('entry-project-project-new')).not.toBeNull();
  });

  it('returns from full-page Settings to the exact project conversation and file route', async () => {
    window.history.replaceState(
      null,
      '',
      '/projects/project-existing/conversations/conv-exact/files/nested%2Fartifact.html',
    );
    mockedListProjects.mockResolvedValue([existingProject]);

    render(<App />);
    await screen.findByTestId('project-view');

    fireEvent.click(screen.getByRole('button', { name: 'Open settings from project' }));
    await screen.findByTestId('settings-surface');
    expect(window.location.pathname).toBe('/settings');

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(
        '/projects/project-existing/conversations/conv-exact/files/nested/artifact.html',
      );
      expect(screen.getByTestId('project-route-conversation').textContent).toBe('conv-exact');
    });
  });

  it('returns home when full-page Settings was opened from home', async () => {
    mockedListProjects.mockResolvedValue([]);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings from home' }));
    await screen.findByTestId('settings-surface');

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
      expect(screen.getByTestId('entry-home-surface')).toBeTruthy();
    });
  });

  it('opens the seeded brand extraction conversation after creating a design system', async () => {
    const brandProject: Project = {
      id: 'brand-acme',
      name: 'acme.com Design System',
      skillId: null,
      designSystemId: null,
      createdAt: 1778244000000,
      updatedAt: 1778244000000,
      metadata: { kind: 'brand', importedFrom: 'brand-extraction', brandId: 'acme' },
    };
    window.history.replaceState(null, '', '/design-systems/create');
    mockedListProjects.mockResolvedValue([]);
    mockedGetProject.mockResolvedValue(brandProject);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, _init?: unknown) => {
        if (typeof input === 'string' && input === '/api/brands') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'acme',
              projectId: brandProject.id,
              conversationId: 'conv-brand-acme',
              sourceUrl: 'https://acme.com/',
              status: 'extracting',
            }),
          } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }),
    );

    render(<App />);

    fireEvent.change(await screen.findByPlaceholderText('https://github.com/org/repo'), {
      target: { value: 'https://acme.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue to generation/i }));

    await waitFor(() => {
      expect(screen.getByTestId('project-route-conversation').textContent).toBe('conv-brand-acme');
    });
    expect(window.location.pathname).toBe(`/projects/${brandProject.id}/conversations/conv-brand-acme`);
  });
});
