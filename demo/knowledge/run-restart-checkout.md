# Restart the checkout pod

Use this runbook when the checkout service stops responding or throws 5xx.

## Step 1 — check saturation

Check the payments dashboard. If CPU is above 90%, scale the deployment before
restarting; a restart alone will not hold.

## Step 2 — rolling restart

Restart the checkout pod one instance at a time and watch healthz between
restarts. Run restart-all only for a full outage; prefer the single-pod path.
