// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { providerModelsCacheKey } from '../../src/components/providerModelsCache';
import { fetchProviderModels } from '../../src/providers/provider-models';
import type { AgentInfo, AppConfig, ProviderModelOption } from '../../src/types';

const analyticsMocks = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      track: analyticsMocks.track,
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      setConfigureGlobals: vi.fn(),
      anonymousId: 'test-anonymous-id',
      sessionId: 'test-session-id',
      newRequestId: () => 'test-request-id',
    }),
  };
});

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(),
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
  agentModels: {},
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
  ],
};

// Kept only as a removal-boundary fixture: legacy daemon payloads must not
// make the retired runtime visible again.
const retiredAmrAgent: AgentInfo = {
  id: 'amr',
  name: 'AMR (vela)',
  bin: 'amr',
  available: true,
  version: '1.0.0',
  models: [{ id: 'amr-cloud-latest', label: 'AMR Cloud Latest' }],
};

function optionNames(container: HTMLElement): string[] {
  return within(container).getAllByRole('option').map((option) => {
    const labelledBy = option.getAttribute('aria-labelledby');
    if (!labelledBy) return option.textContent?.trim() ?? '';
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
  });
}

function renderSwitcher(
  config: Partial<AppConfig> = {},
  agents: AgentInfo[] = [codexAgent],
  providerModelsCache: Record<string, ProviderModelOption[]> = {},
  options: { compact?: boolean } = {},
) {
  const callbacks = {
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  const view = render(
    <InlineModelSwitcher
      config={{ ...baseConfig, ...config }}
      agents={agents}
      providerModelsCache={providerModelsCache}
      compact={options.compact}
      daemonLive
      {...callbacks}
    />,
  );
  return { ...view, ...callbacks };
}

afterEach(() => {
  cleanup();
  vi.mocked(fetchProviderModels).mockReset();
  analyticsMocks.track.mockReset();
  vi.restoreAllMocks();
});

describe('InlineModelSwitcher', () => {
  it('never exposes the retired AMR runtime from a legacy daemon payload', () => {
    const { onAgentChange } = renderSwitcher(
      { agentId: 'amr' },
      [retiredAmrAgent, codexAgent],
    );

    expect(screen.getByTestId('inline-model-switcher-chip')).not.toHaveTextContent(
      /AMR|vela|AMR Cloud Latest/i,
    );
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    expect(screen.queryByTestId('inline-model-switcher-agent-amr')).toBeNull();
    expect(screen.queryByText(/AMR|vela|AMR Cloud Latest/i)).toBeNull();
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-codex'));
    expect(onAgentChange).toHaveBeenCalledWith('codex');
  });

  it('keeps an accessible name on the compact chip', () => {
    renderSwitcher(
      { agentModels: { codex: { model: 'gpt-5.1' } } },
      [codexAgent],
      {},
      { compact: true },
    );

    expect(
      screen.getByRole('button', { name: /Codex CLI.*gpt-5\.1/i }),
    ).toBeTruthy();
  });

  it('switches a regular CLI agent model from the non-compact picker', () => {
    const { onAgentModelChange } = renderSwitcher({
      agentModels: { codex: { model: 'gpt-5.2' } },
    });
    onAgentModelChange.mockClear();

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-model'));
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-agent-model-popover',
    );
    const option = within(modelPopover).getByRole('option', { name: /5\.1/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(onAgentModelChange).toHaveBeenCalledWith('codex', {
      model: 'gpt-5.1',
      serviceTier: undefined,
    });
  });

  it('filters fetched BYOK provider models in the search box', () => {
    renderSwitcher(
      {
        mode: 'api',
        apiProtocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiProviderBaseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4.1-mini',
      },
      [codexAgent],
      {
        [providerModelsCacheKey(
          'openai',
          'https://api.openai.com/v1',
          'sk-test',
        )]: [
          { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
          { id: 'gpt-4.1', label: 'gpt-4.1' },
          { id: 'gpt-5.5', label: 'gpt-5.5' },
          { id: 'o4-mini', label: 'o4-mini' },
          { id: 'o3', label: 'o3' },
          { id: 'o1', label: 'o1' },
          { id: 'gpt-4o', label: 'gpt-4o' },
          { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
        ],
      },
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-api-model'));
    fireEvent.change(
      screen.getByTestId('inline-model-switcher-api-model-search'),
      { target: { value: '5.5' } },
    );

    expect(
      optionNames(screen.getByTestId('inline-model-switcher-api-model-popover')),
    ).toEqual(['gpt-4.1-mini', 'gpt-5.5']);
  });

  it('warms the shared provider cache for keyless AIHubMix', async () => {
    vi.mocked(fetchProviderModels).mockResolvedValue({
      ok: true,
      kind: 'success',
      latencyMs: 1,
      models: [
        { id: 'claude-opus-4-8', label: 'claude-opus-4-8' },
        { id: 'gemini-3.5-flash', label: 'gemini-3.5-flash' },
      ],
    });
    const onProviderModelsCacheChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'aihubmix',
          baseUrl: 'https://aihubmix.com/v1',
          apiProviderBaseUrl: 'https://aihubmix.com/v1',
          model: 'claude-opus-4-8',
        }}
        agents={[codexAgent]}
        daemonLive
        providerModelsCache={{}}
        onProviderModelsCacheChange={onProviderModelsCacheChange}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(fetchProviderModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));

    await waitFor(() => {
      expect(fetchProviderModels).toHaveBeenCalledWith({
        protocol: 'aihubmix',
        baseUrl: 'https://aihubmix.com/v1',
        apiKey: '',
      });
      expect(onProviderModelsCacheChange).toHaveBeenCalledOnce();
    });

    const updater = onProviderModelsCacheChange.mock.calls[0]![0] as (
      current: Record<string, ProviderModelOption[]>,
    ) => Record<string, ProviderModelOption[]>;
    const key = providerModelsCacheKey(
      'aihubmix',
      'https://aihubmix.com/v1',
      '',
      '',
    );
    expect(updater({})[key]?.map((model) => model.id)).toEqual([
      'claude-opus-4-8',
      'gemini-3.5-flash',
    ]);
  });

  it('does not fetch a keyed provider catalogue without an API key', async () => {
    const onProviderModelsCacheChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiProviderBaseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'gpt-4.1-mini',
        }}
        agents={[codexAgent]}
        daemonLive
        providerModelsCache={{}}
        onProviderModelsCacheChange={onProviderModelsCacheChange}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    await act(async () => Promise.resolve());
    expect(fetchProviderModels).not.toHaveBeenCalled();
    expect(onProviderModelsCacheChange).not.toHaveBeenCalled();
  });

  it('keeps the panel mounted while selecting a BYOK model from its portal', () => {
    const onApiModelChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiProviderBaseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4.1-mini',
        }}
        agents={[codexAgent]}
        daemonLive
        providerModelsCache={{
          [providerModelsCacheKey(
            'openai',
            'https://api.openai.com/v1',
            'sk-test',
            '',
          )]: [
            { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
            { id: 'gpt-5.5', label: 'gpt-5.5' },
          ],
        }}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={onApiModelChange}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-api-model'));
    const option = within(
      screen.getByTestId('inline-model-switcher-api-model-popover'),
    ).getByRole('option', { name: 'gpt-5.5' });

    fireEvent.mouseDown(option);
    expect(screen.queryByTestId('inline-model-switcher-popover')).not.toBeNull();
    fireEvent.click(option);
    expect(onApiModelChange).toHaveBeenCalledWith('gpt-5.5');
  });

  it('uses the BYOK catalogue in compact mode without leaking CLI models', () => {
    const onApiModelChange = vi.fn();
    render(
      <InlineModelSwitcher
        config={{
          ...baseConfig,
          mode: 'api',
          apiProtocol: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiProviderBaseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4o',
        }}
        agents={[codexAgent, retiredAmrAgent]}
        compact
        daemonLive
        providerModelsCache={{
          [providerModelsCacheKey(
            'openai',
            'https://api.openai.com/v1',
            'sk-test',
            '',
          )]: [
            { id: 'gpt-4o', label: 'gpt-4o' },
            { id: 'gpt-5.5', label: 'gpt-5.5' },
          ],
        }}
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={onApiModelChange}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    const popover = screen.getByTestId('inline-model-switcher-popover');
    expect(within(popover).queryByText(/gpt-5\.2|AMR Cloud Latest/i)).toBeNull();

    fireEvent.click(within(popover).getByTestId('inline-model-switcher-api-model'));
    const modelPopover = screen.getByTestId(
      'inline-model-switcher-api-model-popover',
    );
    expect(optionNames(modelPopover)).toEqual(
      expect.arrayContaining(['gpt-4o', 'gpt-5.5']),
    );
    fireEvent.click(within(modelPopover).getByRole('option', { name: 'gpt-5.5' }));
    expect(onApiModelChange).toHaveBeenCalledWith('gpt-5.5');
  });
});
