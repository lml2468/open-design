import type { AgentInfo, AgentModelChoice } from '../types';

type AgentModelSource =
  | {
      id: AgentInfo['id'];
      models?: Array<{ id: string; enabled?: boolean; default?: boolean }>;
    }
  | null
  | undefined;

export function defaultAgentModelId(agent: AgentModelSource): string | null {
  const models = agent?.models ?? [];
  return (
    models.find((model) => model.default === true && model.enabled !== false)?.id ??
    models.find((model) => model.enabled !== false)?.id ??
    null
  );
}

export function normalizeAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | null {
  const configuredModel =
    typeof choice?.model === 'string' && choice.model ? choice.model : null;
  if (!configuredModel) return null;
  if (configuredModel === 'default') return null;

  const matchingModel =
    agent?.models?.find((model) => model.id === configuredModel) ?? null;
  // Unknown ids remain valid custom CLI choices. Only an explicit disabled
  // catalogue row is normalized away.
  if (!matchingModel || matchingModel.enabled !== false) return null;

  const fallbackModel = defaultAgentModelId(agent);
  if (!fallbackModel || fallbackModel === configuredModel) return null;

  return {
    ...choice,
    model: fallbackModel,
  };
}

export function effectiveAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  return normalizeAgentModelChoice(agent, choice) ?? choice;
}

export function effectiveAgentModelId(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): string | null {
  const configuredModel = effectiveAgentModelChoice(agent, choice)?.model?.trim();
  return configuredModel && configuredModel !== 'default'
    ? configuredModel
    : defaultAgentModelId(agent);
}

/**
 * Whether `modelId` may be OFFERED to the user as a selectable model.
 *
 * This is the single definition of availability for every model-list surface.
 * Unknown ids remain valid custom CLI choices, while a catalogue row carrying
 * `enabled: false` is never offered as selectable.
 *
 * The invariant that makes it safe: this predicate is AT LEAST as strict as
 * `normalizeAgentModelChoice`. Every model normalization would coerce away is
 * unselectable here, so a surface that gates its rows on this can never offer a
 * pick that gets written and then silently reverted — which is exactly what the
 * compact list shipped with: the click was accepted, re-normalized back to the
 * default, and the chip snapped to the previous model with no explanation.
 * `agentModelSelection.test.ts` pins the strictness relation directly, so a
 * future change to either function that broke it would fail rather than quietly
 * reopen the silent-revert hole.
 */
export function agentModelIsSelectable(
  agent: AgentModelSource,
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  if (modelId === 'default') return true;
  const option = agent?.models?.find((model) => model.id === modelId) ?? null;
  return option?.enabled !== false;
}
