/**
 * RunbookResolver — maps a runbook_offer intent to a concrete provider
 * action. The provider's destructive flag (not the text) drives policy, so
 * resolution returns it alongside the id.
 *
 * Resolution is a precision problem: executing the WRONG action is worse
 * than executing nothing, and the wrong action can be harmless-looking
 * (live-proven: "please restart the primary database" resolved through
 * description keywords to `restart-checkout-pod` and auto-executed, because
 * the catalog had no database action and both descriptions share "restart").
 * The tiers, safest first:
 *
 *  1. Exact id — the speaker (or the LLM) named the action id.
 *  2. Full action name appearing in the text.
 *  3. Hybrid KB retrieval over the catalog's own docs (`runbook:*`,
 *     ingested by syncRunbooksToKnowledge) — the SAME BM25+vector→RRF→rerank
 *     engine that grounds citations, so "which action did the speaker mean"
 *     and "which document answers the question" share one scorer. Calibrated
 *     on catalog-shaped docs: true matches score 1.18–1.53, wrong winners
 *     0.95–1.05, unrelated queries ≤ 0.2.
 *
 * Tier 3 is fail-safe, not best-effort: a strong score resolves; a
 * sub-strong score resolves only when the top candidate is destructive
 * (its real flag stages it behind M-of-N approval — a human confirms the
 * card names what they asked for) or when a destructive candidate is in a
 * near-tie with the top hit (staging the destructive candidate puts the
 * ambiguity in front of a human). A clear non-destructive winner below the
 * strong floor is an action the speaker did NOT name — refused with the
 * closest ids as a hint, never executed. With no KB wired, tiers 1–2 only.
 */
import type { RunbookProvider } from '../support-voice-agent/integrations/runbook.js';

/** Structural search port — the platform KB satisfies it without the
 *  pipeline layer importing the concrete knowledge-base class. */
export interface RunbookSearchPort {
  search(
    query: string,
    opts?: { topK?: number; minScore?: number; where?: { source?: string } },
  ): Promise<Array<{ docId: string; score: number; metadata?: Record<string, unknown> }>>;
}

export interface ResolvedRunbook {
  id: string;
  destructive: boolean;
  /** Why this action was chosen — recorded on the spine via the envelope. */
  matchedBy: 'id' | 'name' | 'kb';
}

export type RunbookResolution =
  | { kind: 'resolved'; match: ResolvedRunbook }
  /** A clear-but-unconfirmed winner below the strong floor: refuse and name
   *  the closest actions instead of guessing. */
  | { kind: 'ambiguous'; closest: string[] };

/** Tier-3 acceptance bands, calibrated on the live scoring engine (see file
 *  header). A true catalog match outruns the wrong-winner band with margin;
 *  these constants sit in the gap. */
const KB_FLOOR = 0.3;
const KB_STRONG = 1.1;
const KB_TIE = 0.15;

export class RunbookResolver {
  constructor(
    private readonly provider?: RunbookProvider,
    private readonly knowledge?: RunbookSearchPort,
  ) {}

  /** Exact id match, then full-name match, then hybrid-KB match with the
   *  fail-safe bands above. Any provider failure resolves to 'no match' —
   *  the offer degrades honestly instead of hanging the meeting. */
  async resolve(wanted: string | undefined, text: string): Promise<RunbookResolution | undefined> {
    if (!this.provider) return undefined;
    try {
      const actions = await this.provider.list();
      if (wanted) {
        const byId = actions.find((a) => a.id === wanted);
        if (byId) return { kind: 'resolved', match: { id: byId.id, destructive: byId.destructive, matchedBy: 'id' } };
      }
      const lower = text.toLowerCase();
      const byName = actions.find((a) => lower.includes(a.name.toLowerCase()));
      if (byName) return { kind: 'resolved', match: { id: byName.id, destructive: byName.destructive, matchedBy: 'name' } };
      return await this.resolveViaKnowledge(text);
    } catch {
      return undefined;
    }
  }

  private async resolveViaKnowledge(text: string): Promise<RunbookResolution | undefined> {
    if (!this.knowledge) return undefined;
    const hits = await this.knowledge.search(text, { topK: 3, where: { source: 'runbooks' } });
    const usable = hits.filter((h) => {
      const id = h.metadata?.['runbookId'];
      return typeof id === 'string' && id.length > 0;
    });
    if (usable.length === 0 || usable[0]!.score < KB_FLOOR) return undefined;
    const top = usable[0]!;
    const runnerUp = usable[1];
    const topId = top.metadata?.['runbookId'] as string;
    const topDestructive = top.metadata?.['destructive'] === true;
    const destructiveCandidate = usable.find((h) => h.metadata?.['destructive'] === true);

    // Strong: an unambiguous catalog match — resolve (policy still gates a
    // destructive action behind approval via its real flag).
    if (top.score >= KB_STRONG) {
      return { kind: 'resolved', match: { id: topId, destructive: topDestructive, matchedBy: 'kb' } };
    }
    // Sub-strong but the top candidate itself is destructive: resolving it
    // means the approval gate decides, never auto-execution.
    if (topDestructive) {
      return { kind: 'resolved', match: { id: topId, destructive: true, matchedBy: 'kb' } };
    }
    // Near-tie between the top hit and a destructive candidate: stage the
    // destructive one — the human resolves the ambiguity from the card.
    if (destructiveCandidate && runnerUp && top.score - runnerUp.score < KB_TIE) {
      const nearTied = usable.filter((h) => top.score - h.score < KB_TIE);
      const destructiveTied = destructiveCandidate && nearTied.includes(destructiveCandidate);
      if (destructiveTied) {
        return {
          kind: 'resolved',
          match: { id: destructiveCandidate.metadata?.['runbookId'] as string, destructive: true, matchedBy: 'kb' },
        };
      }
    }
    // A clear non-destructive winner below the strong floor: the speaker
    // named an action this catalog does not have. Refuse with the hint.
    return {
      kind: 'ambiguous',
      closest: usable.slice(0, 3).map((h) => h.metadata?.['runbookId'] as string),
    };
  }
}
