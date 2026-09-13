/**
 * The maintenance-window port for critical-risk executions (ADR-0007's
 * "critical → two approvals + maintenance window", enforced).
 *
 * The gate asks `isOpen(now)` only when an approval carries a critical
 * blast assessment. Fail-closed by construction: an absent window or a
 * throwing port denies execution — the question "is now inside the window?"
 * must have a positive answer, never an optimistic default.
 */

/** Injectable window check. Implementations: clock-window (config), CI/CD
 *  freeze calendars, on-call acknowledgements — anything that can answer
 *  "may critical infrastructure work start right now?". */
export interface MaintenanceWindow {
  isOpen(now: number): boolean;
}

/** Thrown by ApprovalGate.assertExecutable when a critical-risk action
 *  attempts to execute outside (or without) a maintenance window. */
export class MaintenanceWindowError extends Error {}

/** Config-driven wall-clock window: daily, server-local time,
 *  `startMinute`–`endMinute` in minutes-since-midnight. `end < start`
 *  wraps midnight (e.g. 23:00–01:00 is a valid cross-midnight window). */
export class LocalTimeMaintenanceWindow implements MaintenanceWindow {
  private readonly startMinute: number;
  private readonly endMinute: number;

  constructor(spec: { startMinute: number; endMinute: number }) {
    this.startMinute = spec.startMinute;
    this.endMinute = spec.endMinute;
  }

  isOpen(now: number): boolean {
    const d = new Date(now);
    const minute = d.getHours() * 60 + d.getMinutes();
    return this.startMinute <= this.endMinute
      ? minute >= this.startMinute && minute < this.endMinute
      : minute >= this.startMinute || minute < this.endMinute;
  }
}

/** The always-closed window — tests and hosts that want critical actions
 *  hard-blocked regardless of wall-clock time. */
export const CLOSED_MAINTENANCE_WINDOW: MaintenanceWindow = { isOpen: () => false };
