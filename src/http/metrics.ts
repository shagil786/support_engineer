/**
 * /metrics — Prometheus text format (version 0.0.4) aggregated from the
 * event spine. Every scrape reads the log and aggregates in memory: the
 * JSONL files are the single source of truth, so the endpoint stays correct
 * across restarts and needs no scrape-state machinery. Files are segmented
 * daily and small (a handful of events per utterance); when a deployment
 * outgrows full scans, this function is the seam to add delta caching —
 * callers see the same string either way.
 *
 * Metric set (one family per operational question an on-call actually asks):
 *   llm_calls_total            is the provider up, and how often it fails (by error code)?
 *   llm_tokens_total           what did inference cost (prompt vs completion)?
 *   llm_latency_ms             how slow is the provider (histogram)?
 *   tool_calls_total           which tools run, and how often do they fail?
 *   tool_latency_ms            how slow is each integration (histogram, per tool)?
 *   agent_outcomes_total       how often does a governed run succeed?
 *   governance_decisions_total what does policy decide (allow/deny/approval)?
 *   safety_net_vetoes_total    which guardrail fires?
 *   approvals_total            how many approvals are requested, granted, denied, timed out?
 *   review_retries_total       how often did the reviewer's re-dance save a governed run?
 *   review_retry_depth_total   of those, how many were repaired once vs thrashed (2+ repairs)?
 */
import type { EventLog } from '../event-log/log.js';

/** Cumulative histogram buckets, in ms. */
const LATENCY_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

interface Histogram {
  counts: number[];
  sum: number;
  count: number;
}

function newHistogram(): Histogram {
  return { counts: new Array<number>(LATENCY_BUCKETS.length).fill(0), sum: 0, count: 0 };
}

function observe(h: Histogram, ms: number): void {
  h.sum += ms;
  h.count += 1;
  // counts[] holds per-bucket counts; renderHistogram makes them cumulative.
  const idx = LATENCY_BUCKETS.findIndex((b) => ms <= b);
  if (idx >= 0) h.counts[idx] = (h.counts[idx] ?? 0) + 1;
}

/** Prometheus label-value escaping (backslash, quote, newline). */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderHistogram(name: string, help: string, h: Histogram, extraLabels = ''): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
  // Label-less metrics omit the braces entirely (idiomatic Prometheus).
  const labels = (suffix: string, value: number): string =>
    `${name}_${suffix}${extraLabels ? `{${extraLabels}}` : ''} ${value}`;
  let cumulative = 0;
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    cumulative += h.counts[i] ?? 0;
    const le = `le="${LATENCY_BUCKETS[i]}"`;
    lines.push(`${name}_bucket{${extraLabels ? `${extraLabels},` : ''}${le}} ${cumulative}`);
  }
  lines.push(`${name}_bucket{${extraLabels ? `${extraLabels},` : ''}le="+Inf"} ${h.count}`);
  lines.push(labels('sum', h.sum));
  lines.push(labels('count', h.count));
  return lines.join('\n');
}

/** Aggregate the whole event log into Prometheus text format. */
export async function renderMetrics(log: EventLog): Promise<string> {
  const llmCalls = new Map<string, number>(); // model|ok|errorCode
  const llmTokens = new Map<string, number>(); // model → cumulative tokens
  const llmLatency = newHistogram();
  const toolCalls = new Map<string, number>(); // tool|ok
  const toolLatency = new Map<string, Histogram>(); // per-tool histograms
  let outcomesOk = 0;
  let outcomesFailed = 0;
  const decisions = new Map<string, number>(); // effect
  const vetoes = new Map<string, number>(); // check
  let approvalsRequested = 0;
  let approvalsGranted = 0;
  let approvalsDenied = 0;
  let approvalsTimedOut = 0;
  let approvalsExecuted = 0;
  let reviewRetried = 0;
  let reviewRecovered = 0;
  let reviewFailed = 0;
  // outcome x depth counters (depth: one_shot = 1 repair landed, repeated =
  // 2+ — "did the first repair land?" is the thrash discriminator).
  const reviewByDepth = new Map<string, number>(); // `${outcome}|${depth}` → count
  const bumpDepth = (outcome: 'retried' | 'recovered' | 'failed', retries: number): void => {
    const depth = retries === 1 ? 'one_shot' : 'repeated';
    const key = `${outcome}|${depth}`;
    reviewByDepth.set(key, (reviewByDepth.get(key) ?? 0) + 1);
  };

  for await (const e of log.query({})) {
    switch (e.kind) {
      case 'llm_call': {
        const okKey = `${e.model}|${e.ok ? 'true' : 'false'}|${e.ok ? '' : (e.errorCode ?? 'unknown')}`;
        llmCalls.set(okKey, (llmCalls.get(okKey) ?? 0) + 1);
        llmTokens.set(e.model, (llmTokens.get(e.model) ?? 0) + (e.promptTokens ?? 0) + (e.completionTokens ?? 0));
        observe(llmLatency, e.latencyMs);
        break;
      }
      case 'tool_call': {
        const key = `${e.tool}|${e.result.ok ? 'true' : 'false'}`;
        toolCalls.set(key, (toolCalls.get(key) ?? 0) + 1);
        const h = toolLatency.get(e.tool) ?? newHistogram();
        observe(h, e.latencyMs);
        toolLatency.set(e.tool, h);
        break;
      }
      case 'agent_outcome': {
        if (e.finalResult.ok) outcomesOk += 1;
        else outcomesFailed += 1;
        // Review-repair loop: a run that passed review only after a re-dance
        // (stats.reviewRetries >= 1). Legacy events (stats absent) never count.
        if ((e.stats?.reviewRetries ?? 0) >= 1) {
          reviewRetried += 1;
          if (e.finalResult.ok) reviewRecovered += 1;
          else reviewFailed += 1;
          bumpDepth('retried', e.stats!.reviewRetries!);
          bumpDepth(e.finalResult.ok ? 'recovered' : 'failed', e.stats!.reviewRetries!);
        }
        break;
      }
      case 'governance': {
        const effect = e.decision.effect;
        decisions.set(effect, (decisions.get(effect) ?? 0) + 1);
        break;
      }
      case 'safety_net': {
        if (e.vetoed) vetoes.set(e.check, (vetoes.get(e.check) ?? 0) + 1);
        break;
      }
      case 'approval_request':
        approvalsRequested += 1;
        break;
      case 'approval_granted':
        approvalsGranted += 1;
        break;
      case 'approval_timeout':
        approvalsTimedOut += 1;
        break;
      case 'approval_denied':
        approvalsDenied += 1;
        break;
      case 'approval_executed':
        approvalsExecuted += 1;
        break;
      default:
        break;
    }
  }

  const out: string[] = [];

  out.push('# HELP support_agent_llm_calls_total LLM completions by model and outcome.');
  out.push('# TYPE support_agent_llm_calls_total counter');
  for (const [k, v] of [...llmCalls.entries()].sort()) {
    const [model, ok, errorCode] = k.split('|');
    const labels = `model="${esc(model ?? '')}",ok="${ok}"${ok === 'false' ? `,error_code="${esc(errorCode ?? 'unknown')}"` : ''}`;
    out.push(`support_agent_llm_calls_total{${labels}} ${v}`);
  }

  out.push('# HELP support_agent_llm_tokens_total Inference tokens (prompt + completion) by model.');
  out.push('# TYPE support_agent_llm_tokens_total counter');
  for (const [model, v] of [...llmTokens.entries()].sort()) {
    out.push(`support_agent_llm_tokens_total{model="${esc(model)}"} ${v}`);
  }

  out.push(renderHistogram('support_agent_llm_latency_ms', 'LLM completion latency.', llmLatency));

  out.push('# HELP support_agent_tool_calls_total Governed tool executions by tool and outcome.');
  out.push('# TYPE support_agent_tool_calls_total counter');
  for (const [k, v] of [...toolCalls.entries()].sort()) {
    const [tool, ok] = k.split('|');
    out.push(`support_agent_tool_calls_total{tool="${esc(tool ?? '')}",ok="${ok}"} ${v}`);
  }

  for (const [tool, h] of [...toolLatency.entries()].sort()) {
    out.push(renderHistogram('support_agent_tool_latency_ms', 'Tool execution latency.', h, `tool="${esc(tool)}"`));
  }

  out.push('# HELP support_agent_agent_outcomes_total Governed run outcomes.');
  out.push('# TYPE support_agent_agent_outcomes_total counter');
  out.push(`support_agent_agent_outcomes_total{ok="true"} ${outcomesOk}`);
  out.push(`support_agent_agent_outcomes_total{ok="false"} ${outcomesFailed}`);

  out.push('# HELP support_agent_governance_decisions_total Policy decisions by effect.');
  out.push('# TYPE support_agent_governance_decisions_total counter');
  for (const [effect, v] of [...decisions.entries()].sort()) {
    out.push(`support_agent_governance_decisions_total{effect="${effect}"} ${v}`);
  }

  out.push('# HELP support_agent_safety_net_vetoes_total SafetyNet vetoes by check.');
  out.push('# TYPE support_agent_safety_net_vetoes_total counter');
  for (const [check, v] of [...vetoes.entries()].sort()) {
    out.push(`support_agent_safety_net_vetoes_total{check="${esc(check)}"} ${v}`);
  }

  out.push('# HELP support_agent_approvals_total Human approval lifecycle counts.');
  out.push('# TYPE support_agent_approvals_total counter');
  out.push(`support_agent_approvals_total{outcome="requested"} ${approvalsRequested}`);
  out.push(`support_agent_approvals_total{outcome="granted"} ${approvalsGranted}`);
  out.push(`support_agent_approvals_total{outcome="denied"} ${approvalsDenied}`);
  out.push(`support_agent_approvals_total{outcome="timed_out"} ${approvalsTimedOut}`);
  out.push(`support_agent_approvals_total{outcome="executed"} ${approvalsExecuted}`);

  // Explicit zero series (like the approvals family) so dashboard ratio
  // panels render a number instead of NoData from day one.
  out.push('# HELP support_agent_review_retries_total Governed runs that passed review only after a re-dance, by final result.');
  out.push('# TYPE support_agent_review_retries_total counter');
  out.push(`support_agent_review_retries_total{outcome="retried"} ${reviewRetried}`);
  out.push(`support_agent_review_retries_total{outcome="recovered"} ${reviewRecovered}`);
  out.push(`support_agent_review_retries_total{outcome="failed"} ${reviewFailed}`);
  // Thrash view: the SAME runs split by retry depth as a separate family —
  // a {depth} label on the family above would make label selectors match
  // both granularities and double-count additive queries (e.g. the recovery
  // alert's volume floor). Separate names keep every existing query exact.
  out.push('# HELP support_agent_review_retry_depth_total Governed runs that passed review only after a re-dance, by final result and retry depth (one_shot = first repair landed, repeated = 2+).');
  out.push('# TYPE support_agent_review_retry_depth_total counter');
  for (const outcome of ['retried', 'recovered', 'failed'] as const) {
    for (const depth of ['one_shot', 'repeated'] as const) {
      out.push(`support_agent_review_retry_depth_total{outcome="${outcome}",depth="${depth}"} ${reviewByDepth.get(`${outcome}|${depth}`) ?? 0}`);
    }
  }

  return `${out.join('\n')}\n`;
}
