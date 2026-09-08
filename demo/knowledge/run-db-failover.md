# Database failover

When the primary database is unreachable, promote the replica instead of
restarting the primary.

## Verify lag first

Check replication lag is zero before promoting the replica database —
promoting a lagging replica loses writes.

## Promote

Promote the replica, then re-point the application connection string and
watch error rates for five minutes.
