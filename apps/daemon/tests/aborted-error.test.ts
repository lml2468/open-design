import { describe, expect, it } from 'vitest';

import { isAbortedOperationError } from '../src/integrations/aborted-error.js';

// Command runners mark deliberate cancellation with `name: 'AbortError'`
// and `code: 'ABORT_ERR'`, while timeouts and transport failures remain real
// errors. This predicate must preserve that distinction for every caller.
describe('isAbortedOperationError', () => {
  it('recognizes a deliberately aborted command', () => {
    const error = new Error('vela command aborted', {
      cause: 'This operation was aborted',
    });
    error.name = 'AbortError';
    Object.assign(error, { code: 'ABORT_ERR' });

    expect(isAbortedOperationError(error)).toBe(true);
  });

  it('recognizes an abort identified only by its code', () => {
    // DOMException-shaped aborts from other layers carry the code but may not
    // preserve the name across a structured clone.
    const error = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
    expect(isAbortedOperationError(error)).toBe(true);
  });

  it('does NOT treat a timeout as a cancellation', () => {
    // A command runner's other termination reason. This is a real failure and
    // must keep reaching the failure logging + retry accounting.
    const error = new Error('vela command timed out after 30000ms');
    error.name = 'TimeoutError';
    expect(isAbortedOperationError(error)).toBe(false);
  });

  it('does NOT treat a transport failure as a cancellation', () => {
    // The shape seen from the vela CLI itself when the API is unreachable.
    const error = new Error(
      'list team projects: context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
    );
    expect(isAbortedOperationError(error)).toBe(false);
  });

  it('does NOT treat an arbitrary rejection as a cancellation', () => {
    expect(isAbortedOperationError(new Error('boom'))).toBe(false);
    expect(isAbortedOperationError('aborted')).toBe(false);
    expect(isAbortedOperationError(null)).toBe(false);
    expect(isAbortedOperationError(undefined)).toBe(false);
  });
});
