/** Sample runbook actions for demos and tests.
 *
 * These are NOT production configuration. `createAgent()` defaults to an
 * empty runbook registry; hosts wire their real runbook registry through
 * `SupportVoiceAgentConfig.runbooks`.
 */

import type { RunbookAction } from '../support-voice-agent/integrations/runbook';

export const SAMPLE_RUNBOOK_ACTIONS: RunbookAction[] = [
  { id: 'restart-checkout-pod', name: 'Restart checkout pod', description: 'restart the checkout pod', destructive: false },
  { id: 'restart-payment-pod', name: 'Restart payment pod', description: 'restart the payment pod', destructive: false },
  { id: 'restart-cache-pod', name: 'Restart cache pod', description: 'restart the cache pod', destructive: false },
  { id: 'restart-all', name: 'Restart all pods', description: 'restart all pods', destructive: true },
  { id: 'clear-cache', name: 'Clear Redis cache', description: 'clear Redis cache', destructive: false },
];
