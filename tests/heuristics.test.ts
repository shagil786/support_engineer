import { describe, it, expect } from 'vitest';
import * as h from '../src/support-voice-agent/heuristics.ts';

describe('containsWakeWord', () => {
  it('detects the default wake word case-insensitively', () => {
    expect(h.containsWakeWord('Hey Agent!')).toBe(true);
    expect(h.containsWakeWord('hey agent')).toBe(true);
    expect(h.containsWakeWord('HEY AGENT')).toBe(true);
  });
  it('ignores bare mentions of agent without the wake word', () => {
    expect(h.containsWakeWord('the agent is down')).toBe(false);
  });
  it('supports a custom wake word', () => {
    expect(h.containsWakeWord('buffy on', 'buffy')).toBe(true);
    expect(h.containsWakeWord('hey agent', 'buffy')).toBe(false);
  });
});

describe('mentionsAgent', () => {
  it('matches agent as a standalone word', () => {
    expect(h.mentionsAgent('hey agent')).toBe(true);
    expect(h.mentionsAgent('the agent')).toBe(true);
  });
  it('does not match agent inside other words by default', () => {
    expect(h.mentionsAgent('agentic automation')).toBe(false);
  });
});

describe('isShutUpCommand', () => {
  it('detects "Agent, shut up"', () => {
    expect(h.isShutUpCommand('Agent, shut up')).toBe(true);
    expect(h.isShutUpCommand('agent shut up')).toBe(true);
  });
  it('detects "Stop talking"', () => {
    expect(h.isShutUpCommand('Stop talking')).toBe(true);
    expect(h.isShutUpCommand('agent, stop talking')).toBe(true);
  });
  it('detects "be quiet" variations', () => {
    expect(h.isShutUpCommand('be quiet')).toBe(true);
    expect(h.isShutUpCommand('go silent')).toBe(true);
  });
  it('ignores non-shutup utterances', () => {
    expect(h.isShutUpCommand('hey agent')).toBe(false);
    expect(h.isShutUpCommand('this is p1')).toBe(false);
  });
});

describe('isCriticalDeclaration', () => {
  it('detects explicit P1/P0 mentions', () => {
    expect(h.isCriticalDeclaration('This is a P1')).toBe(true);
    expect(h.isCriticalDeclaration('critical incident')).toBe(true);
    expect(h.isCriticalDeclaration('production is down')).toBe(true);
  });
  it('detects outage keywords', () => {
    expect(h.isCriticalDeclaration('severe outage in prod')).toBe(true);
    expect(h.isCriticalDeclaration('sev-1 on the api')).toBe(true);
  });
  it('ignores mild statements', () => {
    expect(h.isCriticalDeclaration('there\'s a bug')).toBe(false);
    expect(h.isCriticalDeclaration('p2 defect')).toBe(false);
  });
});

describe('isVagueTechnicalComplaint', () => {
  it('detects "it\'s down" style complaints', () => {
    expect(h.isVagueTechnicalComplaint('it\'s down')).toBe(true);
    expect(h.isVagueTechnicalComplaint('the api is down')).toBe(true);
  });
  it('detects "something\'s broken"', () => {
    expect(h.isVagueTechnicalComplaint('something\'s broken')).toBe(true);
    expect(h.isVagueTechnicalComplaint('something is wrong')).toBe(true);
  });
  it('detects "server is dead"', () => {
    expect(h.isVagueTechnicalComplaint('the server is dead')).toBe(true);
  });
  it('detects "not working"', () => {
    expect(h.isVagueTechnicalComplaint('checkout is not working')).toBe(true);
  });
  it('ignores clear status questions', () => {
    expect(h.isVagueTechnicalComplaint('is the api down?')).toBe(true);
    expect(h.isVagueTechnicalComplaint('what\'s the uptime?')).toBe(false);
  });
});

describe('isFeedback', () => {
  it('detects user/customer feedback statements', () => {
    expect(h.isFeedback('Users hate the new UI')).toBe(true);
    expect(h.isFeedback('customers are unhappy with the flow')).toBe(true);
  });
  it('detects direct "I hate the UI" statements', () => {
    expect(h.isFeedback('I hate the new onboarding')).toBe(true);
    expect(h.isFeedback('they love the redesign')).toBe(true);
  });
  it('ignores non-feedback', () => {
    expect(h.isFeedback('the api is down')).toBe(false);
    expect(h.isFeedback('set priority to high')).toBe(false);
  });
});

describe('paraphraseFeedback', () => {
  it('capitalizes and cleans filler words', () => {
    expect(h.paraphraseFeedback('well users hate the new UI')).toBe('Users hate the new UI.');
  });
  it('strips trailing punctuation and whitespace', () => {
    expect(h.paraphraseFeedback('users love the redesign. ')).toBe('Users love the redesign.');
  });
  it('falls back to "unspecified feedback" for empty input', () => {
    expect(h.paraphraseFeedback('   ')).toBe('Unspecified feedback.');
  });
});

describe('isDirectQuestion', () => {
  it('detects explicit question marks', () => {
    expect(h.isDirectQuestion('what\'s the status of checkout?')).toBe(true);
    expect(h.isDirectQuestion('how do we deploy?')).toBe(true);
  });
  it('detects agent-directed status/data/help queries without question mark', () => {
    expect(h.isDirectQuestion('agent show me the alerts')).toBe(true);
    expect(h.isDirectQuestion('can you pull the logs')).toBe(true);
  });
  it('ignores rhetorical statements', () => {
    expect(h.isDirectQuestion('it is down')).toBe(false);
    expect(h.isDirectQuestion('we are rolling out')).toBe(false);
  });
});

describe('asksForLogs', () => {
  it('detects log/error/stack trace keywords', () => {
    expect(h.asksForLogs('show me the logs')).toBe(true);
    expect(h.asksForLogs('what errors are we seeing')).toBe(true);
    expect(h.asksForLogs('pull cloudwatch')).toBe(true);
    expect(h.asksForLogs('splunk the exceptions')).toBe(true);
  });
  it('ignores status questions', () => {
    expect(h.asksForLogs('what is the status')).toBe(false);
  });
});

describe('extractTicketKey', () => {
  it('extracts a single ticket key', () => {
    expect(h.extractTicketKey('check SUPPORT-42 for context')).toBe('SUPPORT-42');
  });
  it('returns null when there is no ticket', () => {
    expect(h.extractTicketKey('no tickets here')).toBe(null);
  });
  it('returns the first key when multiple appear', () => {
    expect(h.extractTicketKey('SUPPORT-1 and PAY-9')).toBe('SUPPORT-1');
  });
});

describe('isAffirmation / isNegation', () => {
  it('recognizes affirmations', () => {
    expect(h.isAffirmation('yes')).toBe(true);
    expect(h.isAffirmation('go ahead')).toBe(true);
    expect(h.isAffirmation('yeah, go ahead')).toBe(true);
    expect(h.isAffirmation('yes, please restart')).toBe(true);
  });
  it('recognizes negations', () => {
    expect(h.isNegation('no')).toBe(true);
    expect(h.isNegation('nah, skip it')).toBe(true);
    expect(h.isNegation('nah')).toBe(true);
    expect(h.isNegation('never mind')).toBe(true);
  });
  it('does not confuse affirmations with neutral statements', () => {
    expect(h.isAffirmation('maybe later')).toBe(false);
    expect(h.isNegation('not yet')).toBe(false);
  });
});

describe('parsePriority', () => {
  it('maps P0 / critical to P0', () => {
    expect(h.parsePriority('P0')).toBe('P0');
    expect(h.parsePriority('critical')).toBe('P0');
    expect(h.parsePriority('sev-0')).toBe('P0');
  });
  it('maps P1 / urgent to P1', () => {
    expect(h.parsePriority('P1')).toBe('P1');
    expect(h.parsePriority('urgent')).toBe('P1');
    expect(h.parsePriority('high priority')).toBe('P1');
  });
  it('maps P2 / high to P2', () => {
    expect(h.parsePriority('P2')).toBe('P2');
    expect(h.parsePriority('high')).toBe('P2');
  });
  it('maps P3 / medium to P3', () => {
    expect(h.parsePriority('P3')).toBe('P3');
    expect(h.parsePriority('medium')).toBe('P3');
    expect(h.parsePriority('normal')).toBe('P3');
  });
  it('maps P4 / low to P4', () => {
    expect(h.parsePriority('P4')).toBe('P4');
    expect(h.parsePriority('low')).toBe('P4');
    expect(h.parsePriority('minor')).toBe('P4');
  });
  it('returns null for gibberish', () => {
    expect(h.parsePriority('banana')).toBe(null);
  });
});

describe('enforceMaxWords', () => {
  it('keeps short strings unchaged', () => {
    expect(h.enforceMaxWords('hello world', 5)).toBe('hello world');
  });
  it('truncates long strings with ellipsis', () => {
    expect(h.enforceMaxWords('one two three four five six seven eight nine ten', 5)).toBe('one two three four five…');
  });
  it('respects a zero limit gracefully', () => {
    expect(h.enforceMaxWords('hello', 0)).toBe('hello');
  });
});

describe('isArchitectureDeepDive', () => {
  it('detects deep back-and-forth on architecture', () => {
    const window = [
      { speakerId: 'A', text: 'we should refactor the schema' },
      { speakerId: 'B', text: 'what about the service boundary' },
      { speakerId: 'A', text: 'event-driven would be cleaner' },
      { speakerId: 'B', text: 'and the contract' },
    ];
    expect(h.isArchitectureDeepDive(window)).toBe(true);
  });
  it('ignores single-speaker monologue', () => {
    const window = [
      { speakerId: 'A', text: 'we should refactor the schema' },
      { speakerId: 'A', text: 'what about the service boundary' },
      { speakerId: 'A', text: 'event-driven would be cleaner' },
    ];
    expect(h.isArchitectureDeepDive(window)).toBe(false);
  });
  it('ignores short exchanges', () => {
    const window = [
      { speakerId: 'A', text: 'how are you' },
      { speakerId: 'B', text: 'fine' },
    ];
    expect(h.isArchitectureDeepDive(window)).toBe(false);
  });
});

describe('buildLogQuery', () => {
  it('returns last 15 minutes by default', () => {
    const now = 1_000_000;
    const q = h.buildLogQuery('the api', now);
    expect(q.to).toBe(now);
    expect(q.from).toBe(now - 15 * 60_000);
    expect(q.limit).toBe(50);
  });
});