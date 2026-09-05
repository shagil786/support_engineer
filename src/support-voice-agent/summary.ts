/** End-of-meeting summary rendering (posted to Slack/Jira, never read aloud). */

import type { MeetingSummaryData } from './types';

export function renderMeetingSummary(s: MeetingSummaryData): string {
  const lines: string[] = [
    `# Meeting Summary — ${s.title} (${s.meetingId})`,
    `- Ended: ${new Date(s.endedAt).toISOString()}`,
    `- Participants: ${s.participants.join(', ') || '—'}`,
    `- Agent spoke ${s.spokenResponseCount} time(s)`,
    '',
    '## Vocal feedback',
  ];
  if (s.feedback.length === 0) lines.push('- None');
  for (const f of s.feedback) {
    lines.push(`- [${f.jiraKey ?? 'not filed'}] "${f.original}" (${f.speakerId})`);
  }
  lines.push('', '## Concerns / vague complaints');
  if (s.concerns.length === 0) lines.push('- None');
  for (const c of s.concerns) {
    lines.push(`- "${c.text}" (${c.speakerId})`);
  }
  lines.push('', '## Jira changes');
  if (s.jiraChanges.length === 0) lines.push('- None');
  for (const j of s.jiraChanges) {
    lines.push(`- ${j.type} ${j.issueKey}: ${j.detail}`);
  }
  lines.push('', '## Alerts');
  if (s.alerts.length === 0) lines.push('- None');
  for (const a of s.alerts) {
    lines.push(`- ${a.severity} ${a.source}: ${a.summary}`);
  }
  return lines.join('\n');
}