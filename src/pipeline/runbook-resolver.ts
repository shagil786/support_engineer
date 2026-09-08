/**
 * RunbookResolver — maps a runbook_offer intent to a concrete provider
 * action. The provider's destructive flag (not the text) drives policy, so
 * resolution returns it alongside the id.
 */
import type { RunbookProvider } from '../support-voice-agent/integrations/runbook.js';

export interface ResolvedRunbook {
  id: string;
  destructive: boolean;
}

export class RunbookResolver {
  constructor(private readonly provider?: RunbookProvider) {}

  /** Exact id match, then name match, then description-keyword fuzzy match
   *  ("restart the checkout pod"). Any provider failure resolves to 'no
   *  match' — the offer degrades honestly instead of hanging the meeting. */
  async resolve(wanted: string | undefined, text: string): Promise<ResolvedRunbook | undefined> {
    if (!this.provider) return undefined;
    try {
      const actions = await this.provider.list();
      const match = wanted
        ? actions.find((a) => a.id === wanted)
        : actions.find((a) => text.toLowerCase().includes(a.name.toLowerCase()));
      if (match) return { id: match.id, destructive: match.destructive };
      // Fuzzy: match on description keywords.
      const descMatch = actions.find((a) =>
        a.description.split(/\s+/).some((w) => w.length > 3 && text.toLowerCase().includes(w.toLowerCase())),
      );
      return descMatch ? { id: descMatch.id, destructive: descMatch.destructive } : undefined;
    } catch {
      return undefined;
    }
  }
}