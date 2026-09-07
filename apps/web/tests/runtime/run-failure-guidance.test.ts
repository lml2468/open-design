import { describe, expect, it } from 'vitest';

import { resolveRunFailureUi } from '../../src/runtime/run-failure-guidance';

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

  it('preserves session-resume guidance', () => {
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
