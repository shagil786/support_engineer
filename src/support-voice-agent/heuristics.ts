/**
 * Heuristic classifiers for meeting utterances.
 *
 * These are deliberately simple, regex-based heuristics. In a real deployment
 * they can be swapped for an LLM classifier behind the same functions — the
 * agent only depends on the boolean results.
 */

import type { Severity, Utterance } from './types';

export const DEFAULT_WAKE_WORD = 'hey agent';
export const DEFAULT_MIN_PAUSE_MS = 1500;
export const DEFAULT_MAX_RESPONSE_WORDS = 20;
export const DEFAULT_MUTE_DURATION_MS = 5 * 60_000;
/** How long a runbook offer stays valid before it must be re-offered. */
export const DEFAULT_RUNBOOK_CONFIRM_WINDOW_MS = 60_000;

export function containsWakeWord(text: string, wakeWord = DEFAULT_WAKE_WORD): boolean {
  return text.toLowerCase().includes(wakeWord.toLowerCase());
}

/** True when the utterance is *only* the wake word (plus punctuation). */
export function isBareWakeWord(text: string, wakeWord = DEFAULT_WAKE_WORD): boolean {
  const rest = text
    .toLowerCase()
    .replace(wakeWord.toLowerCase(), '')
    .replace(/[\s,.!?]+/g, '');
  return rest.length === 0;
}

export function mentionsAgent(text: string): boolean {
  return /\bagent\b/i.test(text);
}

/** "Agent, shut up" / "stop talking" → mute until next wake word (max 5 min). */
export function isShutUpCommand(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bagent[,\s]+(shut\s*up|stop\s*talking)\b/.test(t) ||
    /(shut\s*up|stop\s*talking|be\s*quiet)([,\s]+agent)?\b/.test(t) ||
    /\bgo\s*silent\b/.test(t)
  );
}

/** "This is a P1" / "Critical incident" → urgent barge-in. */
export function isCriticalDeclaration(text: string): boolean {
  return /\b(p0|p1|critical\s+incident|severe\s+outage|major\s+incident|sev[-\s]?1|production\s+(is\s+)?down)\b/i.test(text);
}

/** Vague technical complaint ("it's down", "something's broken") → ask for specifics. */
const VAGUE_PATTERNS: RegExp[] = [
  /\bit('|’| is )s?\s+(down|broken|laggy|slow|not\s+working|crashing)\b/i,
  /\bsomething\s+(is\s+)?(wrong|broken|off|weird|going\s+on)\b/i,
  /\bsomething['’]s?\s+(broken|wrong|off|weird|going\s+on)\b/i,
  /\bthings?\s+(are|is)\s+(breaking|failing|erroring)\b/i,

  /** Accept explicit question-form status checks ("is the api down?") as
   *  non-vague technical questions rather than vague complaints. These still
   *  match the vague complaint pattern, but isDirectQuestion() will short-circuit
   *  them before they reach handleVagueComplaint(). */
  /\b(is|are|was|were)\s+(the)?\s*(api|server|app|service|site|page|pod|checkout|payment)\s+(down|broken|dying|crashing|erroring|unresponsive|not\s+loading|not\s+working)\b/i,

  /\bwe('|’)?re?\s+(seeing|getting)\s+errors?\b/i,
  /\b(server|api|app|service|site|page|pod|checkout|payment)\s+(is\s+)?(down|dead|crashing|erroring|unresponsive|not\s+loading|not\s+working)\b/i,
  /\bnot\s+working\b/i,
];

export function isVagueTechnicalComplaint(text: string): boolean {
  return VAGUE_PATTERNS.some((re) => re.test(text));
}

/** Detect questions explicitly asking for logs, errors, stack traces, or CloudWatch/Splunk. */
export const LOG_TERMS: RegExp = /\b(logs?|errors?|exceptions?|stack\s*traces?|metrics?|latency|error\s*rate|cloudwatch|splunk|crash(es|ing)?)\b/i;

export function asksForLogs(text: string): boolean {
  return LOG_TERMS.test(text);
}

/** Verbal feedback ("User hates the new UI") → paraphrase + offer to file a Jira bug. */
const FEEDBACK_PATTERNS: RegExp[] = [
  /\b(users?|clients?|customers?|people|everyone|the\s+team|they)\s+(hate|hates|love|loves|dislike|dislikes|complain|complains|are\s+unhappy|rave|raves|praise|praises)\b/i,
  /\b(i|we|they)\s+(hate|love|like|dislike|enjoy)\s+(the\s+)?(new\s+)?(ui|design|layout|screen|feature|flow|workflow|dashboard|experience|onboarding)\b/i,
];

export function isFeedback(text: string): boolean {
  return FEEDBACK_PATTERNS.some((re) => re.test(text));
}

/** Extract a concise paraphrase of the feedback for the Jira bug summary. */
export function paraphraseFeedback(text: string): string {
  let t = text
    .trim()
    .replace(/^(i think |well |so |yeah,? |also |basically )+/i, '')
    .replace(/\s+/g, ' ');
  t = t.replace(/[.!\s]+$/, '');
  if (!t) t = 'unspecified feedback';
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}

/** Direct question aimed at status/data/help for the group (or at the agent). */
const QUESTION_STARTERS =
  /^(what|how|when|where|why|who|which|can|could|would|is|are|do|does|did|has|have|should|agent)\b/i;
const STATUS_TERMS =
  /\b(status|data|logs?|errors?|exceptions?|jira|ticket|alert|alerts|runbook|incident|outage|metrics?|health|numbers?|report|update|summary|server|api|pod|deploy(ment)?|uptime|downtime|affected|progress|blockers?)\b/i;

export function isDirectQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const asksQuestion = /\?\s*$/.test(t) || QUESTION_STARTERS.test(t);
  if (!asksQuestion) return false;
  if (mentionsAgent(t) || STATUS_TERMS.test(t) || /\b(help|check|look\s+up|pull\s+up)\b/i.test(t)) return true;
  // "is the api down?" is a direct question, not a vague complaint.
  if (/\b(is|are|was|were)\s+(the)?\s*(api|server|app|service|site|page|pod|checkout|payment)\s+(down|broken|dying|crashing|erroring|unresponsive|not\s+loading|not\s+working)\b/i.test(t)) return true;
  return false;
}

/** Extract a Jira ticket key like SUPPORT-42. */
export function extractTicketKey(text: string): string | null {
  const m = text.match(/\b[A-Z][A-Z0-9_]+-\d{1,8}\b/);
  return m ? m[0] : null;
}

/** Affirmative reply to an agent's offer (runbook execution, etc.). */
export function isAffirmation(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /^(yes|yeah|yep|yup|sure|ok|okay|go\s*ahead|do\s*it|please\s*(do|go\s*ahead)|confirmed|affirmative)[.!]*$/.test(t) ||
    /\b(yes,?\s*(please|go\s*ahead|do\s*it)|go\s*ahead|please\s*restart|restart\s*it|do\s*it)\b/.test(t)
  );
}

/** Negation reply to an agent's offer (e.g. "no, never mind"). */
export function isNegation(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /^\s*(no|nah|nope|skip|forget\s*it|don'?t\s*bother|never\s*mind)[.!]*\s*$/.test(t) ||
    /^\s*(nah|nope|no),?\s+\S.*$/.test(t) ||
    /^\s*never\s*mind,?\s*.+$/.test(t) ||
    /\bskip\s+it\b/.test(t)
  );
}

/** Map a human priority answer ("P2", "low", "urgent") to a Severity. */
export function parsePriority(input: string): Severity | null {
  const t = input.toLowerCase();
  if (/\b(p0|critical|sev[-\s]?0)\b/.test(t)) return 'P0';
  if (/\b(p1|urgent|high\s+priority|sev[-\s]?1)\b/.test(t)) return 'P1';
  if (/\b(p2|high|sev[-\s]?2)\b/.test(t)) return 'P2';
  if (/\b(p3|medium|normal|moderate|sev[-\s]?3)\b/.test(t)) return 'P3';
  if (/\b(p4|low|minor|nice\s*to\s*have|sev[-\s]?4)\b/.test(t)) return 'P4';
  return null;
}

/** Truncate to at most `max` words with an ellipsis (20-word response rule). */
export function enforceMaxWords(text: string, max: number): string {
  if (max <= 0) return text;
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text;
  return words.slice(0, max).join(' ') + '…';
}

/** Two+ speakers deep in an architecture discussion → stay silent. */
const ARCHITECTURE_TERMS =
  /\b(architecture|architecturally|design|refactor|trade-?off|proposal|migration|scalab|modular|service\s+boundary|we\s+could|what\s+if\s+we|tech\s+stack|schema|contract|interface|dependency|event-driven|microservices?)\b/i;

export function isArchitectureDeepDive(recent: Pick<Utterance, 'speakerId' | 'text'>[]): boolean {
  if (recent.length < 3) return false;
  const window = recent.slice(-10);
  const counts = new Map<string, number>();
  for (const u of window) counts.set(u.speakerId, (counts.get(u.speakerId) ?? 0) + 1);
  const activeSpeakers = [...counts.values()].filter((c) => c >= 2).length;
  const archHits = window.filter((u) => ARCHITECTURE_TERMS.test(u.text)).length;
  return activeSpeakers >= 2 && archHits >= Math.min(3, window.length * 0.4);
}

/** Default log query for a natural-language question: last 15 minutes, 50 rows. */
export function buildLogQuery(text: string, now = Date.now()): { query: string; from: number; to: number; limit: number } {
  return { query: text, from: now - 15 * 60_000, to: now, limit: 50 };
}