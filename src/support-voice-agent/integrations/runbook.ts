/** Runbook actions — offered to humans for confirmation before execution. */

export interface RunbookAction {
  id: string;
  name: string;
  /** Verb phrase used in the offer, e.g. "restart the checkout pod". */
  description: string;
  /** Destructive actions always require explicit human confirmation. */
  destructive: boolean;
}

export interface RunbookResult {
  actionId: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface RunbookProvider {
  list(): RunbookAction[] | Promise<RunbookAction[]>;
  run(actionId: string): Promise<RunbookResult>;
}

export class RunbookNotFoundError extends Error {
  constructor(actionId: string) {
    super(`Runbook action '${actionId}' not found`);
    this.name = 'RunbookNotFoundError';
  }
}

/** In-memory registry + executor — the default for local dev and tests. */
export class InMemoryRunbookProvider implements RunbookProvider {
  constructor(
    private readonly actions: RunbookAction[],
    private readonly executor?: (actionId: string) => Promise<RunbookResult>,
  ) {}

  async list(): Promise<RunbookAction[]> {
    return [...this.actions];
  }

  async run(actionId: string): Promise<RunbookResult> {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) throw new RunbookNotFoundError(actionId);
    if (!this.executor) {
      return { actionId, ok: true, output: `${action.name} executed` };
    }
    return this.executor(actionId);
  }
}