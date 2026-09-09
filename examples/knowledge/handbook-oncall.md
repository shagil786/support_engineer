# On-call handbook

## Disk space

Disk space on the API hosts fills from log retention, not from traffic. If
free disk drops below 15%, rotate application logs first; do not restart the
hosts. We are okay on disk whenever the alert channel is quiet and last
night's rotation job succeeded.

## Escalation

Pages route through PagerDuty. Acknowledge within five minutes; escalate to
the secondary after fifteen.
