// Deliberately dependency-free: command-runner consumers can distinguish a
// cancelled child from a failed one without importing the runner itself.

/**
 * Whether a rejection is an operation WE cancelled, rather than one that
 * failed.
 *
 * Command runners mark a deliberate abort with `name: 'AbortError'` and
 * `code: 'ABORT_ERR'`, and keeps a separate `timeout` termination for real
 * deadline breaches. Callers may cancel in-flight commands as ordinary control
 * flow, so those cancellations must not be logged or counted as faults.
 *
 * Deliberately narrow: a real timeout and any transport error stay failures,
 * so a genuine fault can never be swallowed as "we meant to do that".
 */
export function isAbortedOperationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.code === 'ABORT_ERR' || candidate.name === 'AbortError';
}
