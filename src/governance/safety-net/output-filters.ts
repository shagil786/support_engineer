/**
 * Output filters: veto secrets and PII before they leave the agent.
 * Veto (block) rather than redact — spec §5 says the SafetyNet is a hard
 * stop, and a partially-redacted card number is worse than no message.
 */
import type { VetoResult } from './injection.js';

interface FilterPattern {
  name: string;
  re: RegExp;
}

const PATTERNS: readonly FilterPattern[] = [
  // 13–19 digits with optional single spaces/dashes between groups (cards).
  { name: 'credit_card', re: /\b(?:\d[ -]*?){13,19}\b/ },
  // AWS access key id.
  { name: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  // JWT-shaped token (three base64url segments).
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
];

export class OutputFilters {
  check(text: string): VetoResult {
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) return { vetoed: true, reason: `output filter '${name}' matched` };
    }
    return { vetoed: false, reason: '' };
  }
}
