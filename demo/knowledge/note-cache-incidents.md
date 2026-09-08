# Cache incidents

Postmortem: the checkout timeout incident was caused by connection pool
exhaustion in the payments service, not by Redis. Mitigation was a deploy
rollback plus a pool-size bump.

Clearing the Redis cache is safe during business hours: it is a
non-destructive runbook action, but expect a latency spike while the cache
warms.
