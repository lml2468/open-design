import { describe, expect, it } from 'vitest';

import {
  formatModelWindowRetryAt,
  modelWindowLimitCopy,
  resolveRunFailureUi,
} from '../../src/runtime/run-failure-guidance';

describe('modelWindowLimitCopy', () => {
  it('extracts a valid reset instant from a model-window failure', () => {
    expect(
      modelWindowLimitCopy(
        'You have reached the 5-hour usage limit for this model. Try again after 2026-08-12T06:34:47Z.',
      ),
    ).toEqual({
      messageKey: 'chat.runError.modelWindowLimitMessage',
      retryAt: '2026-08-12T06:34:47Z',
    });
  });

  it('uses copy without a time when the failure has no valid instant', () => {
    expect(
      modelWindowLimitCopy('[code=model_limit_exceeded] rolling window in effect'),
    ).toEqual({ messageKey: 'chat.runError.modelWindowLimitMessageNoTime' });
  });

  it('ignores unrelated failures', () => {
    expect(modelWindowLimitCopy('Could not create project')).toBeNull();
    expect(modelWindowLimitCopy(null)).toBeNull();
  });
});

describe('formatModelWindowRetryAt', () => {
  it('formats valid instants and preserves invalid input', () => {
    expect(formatModelWindowRetryAt('2026-08-12T06:34:47Z', 'en-US')).toContain('Aug');
    expect(formatModelWindowRetryAt('not-an-instant', 'en-US')).toBe('not-an-instant');
  });
});

describe('resolveRunFailureUi', () => {
  it('maps agent-independent failures to actionable localized guidance', () => {
    expect(resolveRunFailureUi('AGENT_UNAVAILABLE', null, 'codex')).toMatchObject({
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.cliMissing',
      messageKey: 'chat.runError.cliMissingMessage',
      secondaryRetry: false,
    });
    expect(resolveRunFailureUi('AGENT_PROMPT_TOO_LARGE', null, 'claude')).toMatchObject({
      titleKey: 'chat.runError.title.promptTooLarge',
      messageKey: 'chat.runError.promptTooLargeMessage',
    });
    expect(resolveRunFailureUi('AGENT_CONNECTION_DROPPED', null, 'kimi')).toMatchObject({
      titleKey: 'chat.runError.title.connectionDropped',
      messageKey: 'chat.connectionDropped',
    });
  });

  it('keeps hard quota failures non-retryable without promoting another runtime', () => {
    expect(resolveRunFailureUi('RATE_LIMITED', 'hard_quota', 'claude')).toEqual({
      primaryAction: 'none',
      titleKey: 'chat.runError.title.quotaExhausted',
      messageKey: 'chat.runError.quotaExhaustedMessage',
      secondaryRetry: false,
    });
    expect(
      resolveRunFailureUi('RATE_LIMITED', 'workspace_credits_exhausted', 'claude'),
    ).toEqual({
      primaryAction: 'none',
      titleKey: 'chat.runError.title.quotaExhausted',
      messageKey: 'chat.runError.workspaceCreditsMessage',
      secondaryRetry: false,
    });
  });

  it('preserves generic auth, rate-limit, and upstream retry guidance', () => {
    expect(resolveRunFailureUi('UNAUTHORIZED', null, 'codex')).toMatchObject({
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.signInRequired',
      messageKey: 'chat.runError.signInMessage.other',
    });
    expect(resolveRunFailureUi('RATE_LIMITED', null, 'codex')).toMatchObject({
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.rateLimited',
      messageKey: 'chat.runError.rateLimitedMessage',
    });
    expect(resolveRunFailureUi('UPSTREAM_UNAVAILABLE', null, 'codex')).toMatchObject({
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.upstreamUnavailable',
      messageKey: 'chat.runError.upstreamUnavailableMessage',
    });
  });

  it('keeps Antigravity terminal recovery actions', () => {
    expect(resolveRunFailureUi('AGENT_AUTH_REQUIRED', null, 'antigravity')).toMatchObject({
      primaryAction: 'launch-terminal-auth',
      titleKey: 'chat.runError.title.signInRequired',
      secondaryRetry: true,
    });
    expect(resolveRunFailureUi('RATE_LIMITED', null, 'antigravity')).toMatchObject({
      primaryAction: 'launch-terminal-switch-model',
      titleKey: 'chat.runError.title.rateLimited',
      secondaryRetry: true,
    });
  });

  it('preserves detailed retry guidance and parsed reset times', () => {
    expect(
      resolveRunFailureUi(
        'RATE_LIMITED',
        'model_window_limit',
        'codex',
        'You have reached the 5-hour usage limit for this model. Try again after 2026-08-12T06:34:47Z.',
      ),
    ).toMatchObject({
      titleKey: 'chat.runError.title.modelWindowLimit',
      messageKey: 'chat.runError.modelWindowLimitMessage',
      messageVars: { retryAt: '2026-08-12T06:34:47Z' },
    });
    expect(
      resolveRunFailureUi('AGENT_EXECUTION_FAILED', 'session_resume_expired', 'claude'),
    ).toMatchObject({
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.sessionExpired',
      messageKey: 'chat.runError.sessionExpiredMessage',
    });
  });

  it('falls back to a generic retry', () => {
    expect(resolveRunFailureUi('AGENT_EXECUTION_FAILED', null, 'claude')).toEqual({
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.generic',
      messageKey: null,
      secondaryRetry: false,
    });
  });
});
