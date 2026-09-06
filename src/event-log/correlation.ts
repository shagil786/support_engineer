/**
 * Generate a sortable, unique correlation id.
 *
 * Format: `<hexEpochMs>-<6-char base36 monotonic counter>`.
 *
 * - Sortable: two ids generated with the same `now` sort in the order they
 *   were produced (the counter is monotonic per ms).
 * - Unique within a process; the epoch prefix differentiates across processes.
 * - Short: fits comfortably in log lines.
 */
let lastMs = 0;
let counter = 0;

export function correlationId(now: number = Date.now()): string {
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  counter = (counter + 1) >>> 0; // wrap to uint32
  return `${now.toString(16)}-00${counter.toString(36).padStart(6, '0')}`;
}

/** Test-only: reset the monotonic state. Not exported from the barrel. */
export function __resetCorrelationState(): void {
  lastMs = 0;
  counter = 0;
}
