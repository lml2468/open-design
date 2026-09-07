// @vitest-environment jsdom

import { useRef, useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAgentModelChoice } from '../../src/App';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(async () => ({ ok: false, models: [] })),
}));

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
  mediaProviders: {},
  agentModels: { codex: { model: 'gpt-5.2' } },
  agentCliEnv: {},
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.133.0-alpha.1',
  models: [
    { id: 'gpt-5.2', label: 'gpt-5.2', default: true },
    { id: 'gpt-5.1', label: 'gpt-5.1' },
    { id: 'gpt-enterprise', label: 'gpt-enterprise', enabled: false },
  ],
};

function StatefulSwitcher({
  compact = true,
  onPersist,
}: {
  compact?: boolean;
  onPersist?: (agentId: string, model: string | undefined) => void;
}) {
  const [config, setConfig] = useState<AppConfig>(baseConfig);
  const persistedRef = useRef(config);
  return (
    <InlineModelSwitcher
      config={config}
      agents={[codexAgent]}
      providerModelsCache={{}}
      compact={compact}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={(agentId, choice) => {
        const current = persistedRef.current;
        const merged = mergeAgentModelChoice(
          current.agentModels?.[agentId] ?? {},
          choice,
        );
        const next: AppConfig = {
          ...current,
          agentModels: { ...(current.agentModels ?? {}), [agentId]: merged },
        };
        persistedRef.current = next;
        onPersist?.(agentId, merged.model);
        setConfig(next);
      }}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  );
}

function chipText(): string {
  return screen.getByTestId('inline-model-switcher-chip').textContent ?? '';
}

function openSwitcher(): HTMLElement {
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  return screen.getByTestId('inline-model-switcher-popover');
}

function compactRow(modelId: string): HTMLElement {
  return screen.getByTestId(`inline-model-switcher-compact-model-${modelId}`);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('compact CLI model selection', () => {
  it('updates the chip and closes after selecting a model', () => {
    const persisted = vi.fn();
    render(<StatefulSwitcher onPersist={persisted} />);
    expect(chipText()).toContain('5.2');

    openSwitcher();
    fireEvent.click(compactRow('gpt-5.1'));

    expect(chipText()).toContain('5.1');
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
    expect(persisted).toHaveBeenLastCalledWith('codex', 'gpt-5.1');
  });

  it('does not offer an unavailable model', () => {
    render(<StatefulSwitcher />);
    openSwitcher();

    expect(
      screen.queryByTestId('inline-model-switcher-compact-model-gpt-enterprise'),
    ).toBeNull();
  });

  it('closes when the active model is selected again', () => {
    render(<StatefulSwitcher />);
    openSwitcher();
    fireEvent.click(compactRow('gpt-5.2'));

    expect(chipText()).toContain('5.2');
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('closes on a genuine outside click', () => {
    render(
      <div>
        <StatefulSwitcher />
        <button type="button" data-testid="outside">
          outside
        </button>
      </div>,
    );
    openSwitcher();
    fireEvent.mouseDown(screen.getByTestId('outside'));

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
  });

  it('keeps the non-compact portaled model picker working', () => {
    render(<StatefulSwitcher compact={false} />);
    openSwitcher();
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-agent-model-popover',
    );
    const option = within(modelPopover).getByRole('option', { name: /5\.1/ });

    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(chipText()).toContain('5.1');
    expect(screen.getByTestId('inline-model-switcher-agent-model')).toHaveTextContent(
      '5.1',
    );
  });
});
