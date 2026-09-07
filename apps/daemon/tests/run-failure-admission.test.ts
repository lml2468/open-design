import { describe, expect, it } from 'vitest';
import { classifyRunFailure, type RunEventForFailureClassification } from '../src/run-failure-classification.js';

// Minimized audit counterexamples: generic model/IDs, no user text or commands.
// These are runtime inputs, not PH records augmented with LF-only errors.
const hardQuotaError = 'Provider quota exceeded for this billing period.';
const start = { event: 'start', data: { agentId: 'kilo', model: 'example-model', streamFormat: 'acp-json-rpc' } };
const prompt = { event: 'agent', data: { type: 'status', label: 'waiting_for_first_output' } };
const text = { event: 'agent', data: { type: 'text_delta', delta: 'Example output' } };
const tool = { event: 'agent', data: { type: 'status', label: 'tool_call', detail: 'read' } };
function classify(message: string, events: RunEventForFailureClassification[] = [start, prompt], code = 'AGENT_EXECUTION_FAILED') {
  return classifyRunFailure({
    result: 'failed', agentId: 'kilo',
    status: { status: 'failed', errorCode: code, error: message },
    events,
  });
}

describe('admission and attribution v3', () => {
  it('keeps an ACP handshake policy error without an attempt boundary unknown', () => {
    expect(classify(`json-rpc id 2: ${hardQuotaError}`, [])).toMatchObject({
      policy_reason: 'hard_quota', admission_phase: 'unknown',
      admission_status: 'unknown', classifier_version: 'run-failure-v3',
    });
  });
  it.each([text, tool])('keeps limits after real activity admitted', (activity) => {
    expect(classify(hardQuotaError, [start, prompt, activity])).toMatchObject({
      failure_category: 'rate_limit', failure_detail: 'hard_quota',
      failure_mechanism: 'policy_rejection', policy_reason: 'hard_quota',
      admission_status: 'admitted', admission_phase: 'during_execution',
      retryable: false, user_action: 'none',
    });
  });
  it('keeps a policy failure after guarded plain stdout admitted', () => {
    expect(classifyRunFailure({
      result: 'failed', agentId: 'deepseek',
      status: { status: 'failed', errorCode: 'AGENT_EXECUTION_FAILED', error: hardQuotaError },
      events: [
        { event: 'start', data: { agentId: 'deepseek', streamFormat: 'plain' } },
        { event: 'stdout', data: { chunk: 'Example output' } },
        { event: 'error', data: { message: hardQuotaError } },
      ],
    })).toMatchObject({
      policy_reason: 'hard_quota', admission_phase: 'during_execution',
      admission_status: 'admitted',
    });
  });
  it.each([
    { event: 'agent', data: { type: 'artifact', path: 'example.html' } },
    { event: 'agent', data: { type: 'live_artifact', artifactId: 'artifact-example' } },
    { event: 'live_artifact', data: { artifactId: 'artifact-example' } },
  ])('keeps a policy failure after persisted artifact activity admitted', (activity) => {
    expect(classify(hardQuotaError, [start, prompt, activity])).toMatchObject({
      policy_reason: 'hard_quota', admission_phase: 'during_execution',
      admission_status: 'admitted',
    });
  });
  it('does not infer rejection before execution from missing tokens', () => {
    expect(classify(hardQuotaError)).toMatchObject({ admission_status: 'unknown', admission_phase: 'unknown' });
  });
  it('does not infer admission for an unknown technical error', () => {
    expect(classify('agent terminated')).toMatchObject({ admission_status: 'unknown', policy_reason: 'none' });
  });
  it('does not inherit previous attempt activity', () => {
    expect(classify(hardQuotaError, [start, prompt, text, tool, start, prompt])).toMatchObject({
      admission_status: 'unknown', admission_phase: 'unknown',
    });
  });
  it.each(['run_retry_attempted', 'run_resume_attempted'])('does not inherit admission or cause when %s preflight fails before a new start', (boundary) => {
    expect(classify('agent terminated', [start, prompt, text,
      { event: 'error', data: { message: hardQuotaError } },
      { event: boundary, data: { retry_attempt_index: 1 } },
    ])).toMatchObject({ admission_status: 'unknown', admission_phase: 'unknown',
      policy_reason: 'none', failure_domain: 'cross_boundary' });
  });
  it('does not count replayed session history before the current prompt', () => {
    expect(classify(hardQuotaError, [start, text, tool, prompt])).toMatchObject({ admission_status: 'unknown' });
  });
  it('does not count replayed session history for another ACP runtime', () => {
    const hermesStart = { event: 'start', data: {
      agentId: 'hermes', model: 'example-model', streamFormat: 'acp-json-rpc',
    } };
    expect(classifyRunFailure({
      result: 'failed', agentId: 'hermes',
      status: { status: 'failed', errorCode: 'AGENT_EXECUTION_FAILED', error: hardQuotaError },
      events: [hermesStart, text, tool, prompt],
    })).toMatchObject({ admission_status: 'unknown', admission_phase: 'unknown' });
  });
  it('does not count unproven ACP terminal pairs or host text as execution', () => {
    expect(classify(hardQuotaError, [start, prompt,
      { event: 'agent', data: { type: 'tool_use', id: 'opaque-tool', name: 'read' } },
      { event: 'agent', data: { type: 'tool_result', toolUseId: 'opaque-tool', hostSynthesized: true } },
      { event: 'agent', data: { ...text.data, hostSynthesized: true } },
    ])).toMatchObject({ admission_status: 'unknown' });
  });
  it('ignores late activity after the attempt verdict', () => {
    expect(classify(hardQuotaError, [start, prompt, { event: 'error', data: { message: hardQuotaError } }, text, tool]))
      .toMatchObject({ admission_status: 'unknown' });
  });
  it('does not mistake empty deltas or auxiliary usage for execution', () => {
    expect(classify(hardQuotaError, [start, prompt,
      { event: 'agent', data: { type: 'text_delta', delta: '' } },
      { event: 'agent', data: { type: 'usage', outputTokens: 100, requestRole: 'auxiliary' } },
    ])).toMatchObject({ admission_status: 'unknown' });
  });
  it.each([
    ['RATE_LIMITED', 'HTTP 429: too many requests'],
    ['UPSTREAM_UNAVAILABLE', 'HTTP 524 gateway timeout'],
    ['UPSTREAM_UNAVAILABLE', 'Streaming response failed'],
  ])('retains a real provider error %s as a technical failure', (code, message) => {
    expect(classify(message, [start, prompt], code)).toMatchObject({
      failure_mechanism: 'provider_rejection', failure_domain: 'provider_control_plane',
      repair_owner: 'provider_owner', policy_reason: 'none', admission_status: 'unknown',
    });
  });
  it('does not launder a provider verdict through an earlier transient policy error', () => {
    expect(classify('HTTP 524 gateway timeout', [start, prompt,
      { event: 'agent', data: { type: 'error', message: hardQuotaError } },
    ], 'UPSTREAM_UNAVAILABLE')).toMatchObject({
      failure_mechanism: 'provider_rejection', policy_reason: 'none', repair_owner: 'provider_owner',
    });
  });
});
