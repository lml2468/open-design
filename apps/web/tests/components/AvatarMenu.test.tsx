// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AvatarMenu } from '../../src/components/AvatarMenu';
import { providerModelsCacheKey } from '../../src/components/providerModelsCache';
import type { AgentInfo, AppConfig, ExecMode } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));


const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.134.0',
  models: [{ id: 'default', label: 'Default (CLI config)' }],
  reasoningOptions: [
    { id: 'default', label: 'Default' },
    { id: 'high', label: 'High' },
  ],
};

const claudeAgent: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '2.1.131',
  models: [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'sonnet', label: 'Sonnet (alias)' },
  ],
};

const deepSeekHarnessAgent: AgentInfo = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  bin: 'dsh',
  available: true,
  version: '0.1.0-rc.6',
  models: [
    {
      id: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek-V4-Flash · DeepSeek',
      reasoningOptions: [
        { id: 'off', label: 'Off' },
        { id: 'high', label: 'High', default: true },
        { id: 'max', label: 'Max' },
      ],
    },
  ],
};

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  model: 'claude-sonnet-4-5',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: { codex: { model: 'default', reasoning: 'default' } },
  agentCliEnv: {},
};

type EventSourceListener = (event: unknown) => void;
class MockAvatarEventSource {
  static instances: MockAvatarEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Set<EventSourceListener>>();

  constructor(readonly url: string) {
    MockAvatarEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventSourceListener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }

  removeEventListener(name: string, listener: EventSourceListener): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  close(): void {}
}

type ModeChangeHandler = (mode: ExecMode) => void;
type AgentChangeHandler = (id: string) => void;
type AgentModelChangeHandler = (
  id: string,
  choice: { model?: string; reasoning?: string },
) => void;
type VoidHandler = () => void;
type OpenSettingsHandler = (section?: 'execution') => void;

function renderMenu({
  config = baseConfig,
  agents = [codexAgent, claudeAgent],
  daemonLive = true,
  onModeChange = vi.fn<ModeChangeHandler>(),
  onAgentChange = vi.fn<AgentChangeHandler>(),
  onAgentModelChange = vi.fn<AgentModelChangeHandler>(),
  onOpenSettings = vi.fn<OpenSettingsHandler>(),
  onRefreshAgents = vi.fn<VoidHandler>(),
}: {
  config?: AppConfig;
  agents?: AgentInfo[];
  daemonLive?: boolean;
  onModeChange?: ReturnType<typeof vi.fn<ModeChangeHandler>>;
  onAgentChange?: ReturnType<typeof vi.fn<AgentChangeHandler>>;
  onAgentModelChange?: ReturnType<typeof vi.fn<AgentModelChangeHandler>>;
  onOpenSettings?: ReturnType<typeof vi.fn<OpenSettingsHandler>>;
  onRefreshAgents?: ReturnType<typeof vi.fn<VoidHandler>>;
} = {}) {
  render(
    <AvatarMenu
      config={config}
      agents={agents}
      daemonLive={daemonLive}
      onModeChange={onModeChange}
      onAgentChange={onAgentChange}
      onAgentModelChange={onAgentModelChange}
      onOpenSettings={onOpenSettings}
      onRefreshAgents={onRefreshAgents}
    />,
  );
  return {
    onModeChange,
    onAgentChange,
    onAgentModelChange,
    onOpenSettings,
    onRefreshAgents,
  };
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'avatar.title' }));
  return screen.getByRole('dialog', { name: 'avatar.title' });
}

describe('AvatarMenu', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.clearAllMocks();
    MockAvatarEventSource.instances = [];
  });

  // The composer popover is a one-decision surface: pick the model for the
  // active agent. Execution mode, which CLI agent runs, PATH rescan, reasoning
  // effort and the BYOK model are configuration, and live in
  // Settings → Execution. Keeping them out is what makes the popover compact.
  it('keeps execution configuration out of the composer popover', () => {
    const onOpenSettings = vi.fn<OpenSettingsHandler>();
    const onRefreshAgents = vi.fn<VoidHandler>();
    renderMenu({ daemonLive: false, onOpenSettings, onRefreshAgents });

    openMenu();

    // The execution console itself is gone from this popover per #5517: no mode
    // switch, no CLI list, no PATH rescan.
    expect(screen.queryByRole('button', { name: /avatar.useLocal/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /avatar.useApi/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'avatar.rescan' })).toBeNull();
    expect(onRefreshAgents).not.toHaveBeenCalled();

    // …but the link OUT to it must stay. #5517 has no such entry, and it also
    // never moved CLI switching out of this popover — we did, so without this
    // the place switching moved TO is unreachable from where it used to be.
    const openSettings = screen.getByTestId('avatar-open-execution-settings');
    expect(openSettings).toBeTruthy();
    fireEvent.click(openSettings);
    expect(onOpenSettings).toHaveBeenCalledWith('execution');
  });

  it('changes reasoning effort from the composer popover', () => {
    const { onAgentModelChange } = renderMenu({
      config: {
        ...baseConfig,
        agentId: 'deepseek-harness',
        agentModels: {
          'deepseek-harness': {
            model: 'deepseek/deepseek-v4-flash',
            reasoning: 'high',
          },
        },
      },
      agents: [deepSeekHarnessAgent],
    });

    const menu = openMenu();
    const reasoningSelect = within(menu).getByLabelText(
      'avatar.reasoningLabel',
    );
    expect(reasoningSelect).toHaveValue('high');
    expect(
      within(reasoningSelect).getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Off', 'High', 'Max']);

    fireEvent.change(reasoningSelect, { target: { value: 'max' } });

    expect(onAgentModelChange).toHaveBeenCalledWith('deepseek-harness', {
      reasoning: 'max',
    });
  });

  it('selects a model from the inline list and dismisses the popover', () => {
    const { onAgentModelChange } = renderMenu({
      config: { ...baseConfig, agentId: 'claude' },
      agents: [codexAgent, claudeAgent],
    });

    openMenu();
    const list = screen.getByTestId('avatar-model-list');
    const options = within(list).getAllByRole('radio');
    expect(options.map((o) => o.textContent)).toEqual([
      'Default (CLI config)',
      'Sonnet (alias)',
    ]);

    fireEvent.click(options[1]!);

    expect(onAgentModelChange).toHaveBeenCalledWith('claude', { model: 'sonnet' });
    expect(screen.queryByRole('dialog', { name: 'avatar.title' })).toBeNull();
  });

  it('keeps a custom saved model visible when it is not in the declared agent model list', () => {
    renderMenu({
      config: {
        ...baseConfig,
        agentModels: { codex: { model: 'custom-codex-model', reasoning: 'default' } },
      },
    });

    openMenu();
    // The model picker is an always-expanded radio list. A custom saved model
    // that isn't in the agent's declared list is appended as an extra option so
    // it stays visible and checked instead of silently dropping.
    const list = screen.getByTestId('avatar-model-list');
    const custom = within(list).getByRole('radio', { name: /custom-codex-model/i });
    expect(custom.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps disabled catalogue models unavailable without an external upgrade path', () => {
    const { onAgentModelChange } = renderMenu({
      agents: [{
        id: 'test-agent',
        name: 'Test agent',
        bin: 'test-agent',
        available: true,
        models: [
          { id: 'ready-model', label: 'Ready model', enabled: true },
          { id: 'disabled-model', label: 'Disabled model', enabled: false },
        ],
      }],
      config: { ...baseConfig, agentId: 'test-agent' },
    });

    openMenu();
    const disabled = screen.getByRole('radio', { name: /Disabled model/i });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(onAgentModelChange).not.toHaveBeenCalled();
  });

  it('lets the user switch the BYOK model from the composer popover', () => {
    // Regression (#6142): in BYOK mode the composer popover collapsed the
    // model area into a read-only box showing the current model, so switching
    // BYOK models from the composer became impossible. The popover is the
    // model picker for the ACTIVE execution mode — in BYOK mode that means a
    // selectable provider-catalogue list writing through onApiModelChange,
    // exactly like the daemon-mode list writes through onAgentModelChange.
    const onApiModelChange = vi.fn<(model: string) => void>();
    render(
      <AvatarMenu
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiProviderBaseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4o',
        }}
        agents={[codexAgent, claudeAgent]}
        daemonLive={true}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiModelChange={onApiModelChange}
        providerModelsCache={{
          [providerModelsCacheKey('openai', 'https://api.openai.com/v1', 'sk-test', '')]: [
            { id: 'gpt-4o', label: 'gpt-4o' },
            { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
            { id: 'gpt-5.5', label: 'gpt-5.5' },
          ],
        }}
        onOpenSettings={vi.fn()}
        onRefreshAgents={vi.fn()}
      />,
    );

    const menu = openMenu();
    // The current model reads as the checked option, not as a dead-end box.
    const current = within(menu).getByRole('radio', { name: 'gpt-4o' });
    expect(current.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(menu).getByRole('radio', { name: 'gpt-5.5' }));
    expect(onApiModelChange).toHaveBeenCalledWith('gpt-5.5');
    expect(screen.queryByRole('dialog', { name: 'avatar.title' })).toBeNull();
  });

});
