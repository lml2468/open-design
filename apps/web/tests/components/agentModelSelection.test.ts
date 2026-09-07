import { describe, expect, it } from 'vitest';
import {
  agentModelIsSelectable,
  defaultAgentModelId,
  effectiveAgentModelChoice,
  effectiveAgentModelId,
  normalizeAgentModelChoice,
} from '../../src/components/agentModelSelection';
import type { AgentInfo } from '../../src/types';

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'gpt-5.2', label: 'GPT 5.2', default: true },
    { id: 'gpt-5.1', label: 'GPT 5.1' },
    { id: 'gpt-enterprise', label: 'GPT Enterprise', enabled: false },
  ],
};

describe('agent model selection', () => {
  it('normalizes an explicitly disabled model to the first enabled model', () => {
    expect(
      normalizeAgentModelChoice(codexAgent, {
        model: 'gpt-enterprise',
        reasoning: 'medium',
      }),
    ).toEqual({ model: 'gpt-5.2', reasoning: 'medium' });
    expect(
      effectiveAgentModelChoice(codexAgent, {
        model: 'gpt-enterprise',
        reasoning: 'medium',
      }),
    ).toEqual({ model: 'gpt-5.2', reasoning: 'medium' });
  });

  it('preserves the default sentinel and resolves its effective model', () => {
    const choice = { model: 'default', reasoning: 'default' };

    expect(normalizeAgentModelChoice(codexAgent, choice)).toBeNull();
    expect(effectiveAgentModelChoice(codexAgent, choice)).toEqual(choice);
    expect(effectiveAgentModelId(codexAgent, choice)).toBe('gpt-5.2');
  });

  it('does not select a disabled model as the default', () => {
    const disabledAgent: AgentInfo = {
      ...codexAgent,
      models: [
        { id: 'model-a', label: 'Model A', enabled: false },
        { id: 'model-b', label: 'Model B', enabled: false, default: true },
      ],
    };

    expect(defaultAgentModelId(disabledAgent)).toBeNull();
    expect(effectiveAgentModelChoice(disabledAgent, undefined)).toBeUndefined();
  });

  it('offers enabled, default, and custom model ids but refuses disabled rows', () => {
    expect(agentModelIsSelectable(codexAgent, 'gpt-5.2')).toBe(true);
    expect(agentModelIsSelectable(codexAgent, 'default')).toBe(true);
    expect(agentModelIsSelectable(codexAgent, 'custom-codex-model')).toBe(true);
    expect(agentModelIsSelectable(codexAgent, 'gpt-enterprise')).toBe(false);
    expect(agentModelIsSelectable(codexAgent, '')).toBe(false);
    expect(agentModelIsSelectable(codexAgent, null)).toBe(false);
  });

  it('keeps custom model choices unchanged', () => {
    expect(
      effectiveAgentModelChoice(codexAgent, {
        model: 'custom-codex-model',
        reasoning: 'high',
      }),
    ).toEqual({ model: 'custom-codex-model', reasoning: 'high' });
  });

  it('never offers a model that normalization would replace', () => {
    for (const model of codexAgent.models ?? []) {
      const normalized = normalizeAgentModelChoice(codexAgent, {
        model: model.id,
      });
      if (normalized) {
        expect(agentModelIsSelectable(codexAgent, model.id)).toBe(false);
      }
    }
  });
});
