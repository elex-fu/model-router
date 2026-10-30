/**
 * Prometheus metrics aggregation + text-exposition renderer (format 0.0.4). Zero dependencies.
 *
 * ── WIRING GUIDE for src/server/proxy.ts / src/server/index.ts (follow-up change) ──
 * The public API is designed so wiring is ONE call per site, all on the request
 * completion path (never per-chunk):
 *
 *   const metrics = createMetricsRegistry();   // singleton, created in src/server/index.ts
 *
 *   1. Request admitted (after auth + rate limit, before the upstream loop):
 *        metrics.addInFlight();                 // +1; pair with addInFlight(-1) in the
 *                                               //   same finally block that calls (2)
 *      (or track the count yourself and call metrics.setInFlight(n) on change)
 *
 *   2. Request completion — once, in the success/failure/finally path of the proxy
 *      handler (this is also where in-flight is decremented):
 *        metrics.observeRequest(
 *          { proto, upstream, status },         // proto: 'anthropic'|'openai'|'gemini'|...
 *          durationMs,                          // end-to-end Date.now() delta; omit to
 *        );                                     //   skip the histogram sample
 *      - upstream: upstream config name; pass 'none' when no upstream was attempted
 *      - status: HTTP status number (or 'error' when no response was produced)
 *      - If a completion path has no duration available: metrics.incRequest({...})
 *        counts only, and metrics.observeDuration({proto, upstream}, ms) exists for
 *        split call-sites.
 *
 *   3. Usage accounting — once per request, where usage is parsed from the response:
 *        metrics.addTokens('input', upstream, inputTokens);
 *        metrics.addTokens('output', upstream, outputTokens);
 *        metrics.addTokens('cache_read', upstream, cacheReadTokens);      // optional
 *        metrics.addTokens('cache_creation', upstream, cacheCreateTokens); // optional
 *
 *   4. Circuit breaker state change (next to cb.allow()/state transitions):
 *        metrics.setCircuitState(upstream, 0 | 1 | 2);  // 0 closed, 1 half-open, 2 open
 *
 *   5. Exposition — the /metrics endpoint handler (registered before /healthz):
 *        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
 *        res.end(metrics.render());
 *
 * Hot-path cost: one small object allocation + a few Map lookups per request
 * completion; nothing per chunk. Node executes JS single-threaded per process, so
 * plain `+=` increments are atomic with respect to JS execution — no locks needed
 * (there is no shared-memory worker involvement in this registry).
 *
 * Label values are sanitized to [a-zA-Z0-9_.:-] and each metric folds excess
 * label-sets (default cap 200) into a single `overflow` series so cardinality
 * stays bounded even under hostile label inputs.
 */

export interface MetricsLogger {
  /** Called at most once per metric family when the label-set cap is first hit. */
  warn(message: string): void;
}

export interface MetricsRegistryOptions {
  /** Metric name prefix. Default 'model_router_'. */
  prefix?: string;
  /** Histogram upper bounds in ms. Default [5,10,25,50,100,250,500,1000,2500,5000,10000]. */
  durationBuckets?: readonly number[];
  /** Max distinct label-sets per metric before folding into the overflow series. Default 200. */
  maxLabelSets?: number;
  /** Optional logger for the one-time cardinality-overflow warning. No console.log fallback. */
  logger?: MetricsLogger;
}

export interface RequestLabels {
  proto: string;
  upstream: string;
  status: number | string;
}

export interface DurationLabels {
  proto: string;
  upstream: string;
}

export type CircuitState = 0 | 1 | 2;

export interface MetricsRegistry {
  /** Count a completed request and (optionally) record its duration. One call per request. */
  observeRequest(labels: RequestLabels, durationMs?: number): void;
  /** Count a completed request without a histogram sample. */
  incRequest(labels: RequestLabels): void;
  /** Record only a duration sample (for split call-sites). */
  observeDuration(labels: DurationLabels, durationMs: number): void;
  /** Accumulate token usage. direction: 'input' | 'output' | 'cache_read' | 'cache_creation' | ... */
  addTokens(direction: string, upstream: string, tokens: number): void;
  /** Overwrite the in-flight gauge. */
  setInFlight(value: number): void;
  /** Adjust the in-flight gauge (default +1). */
  addInFlight(delta?: number): void;
  /** Overwrite the circuit-state gauge for one upstream (0 closed / 1 half-open / 2 open). */
  setCircuitState(upstream: string, state: CircuitState): void;
  /** Render the Prometheus text exposition format 0.0.4 string. */
  render(): string;
  /** Clear all series and gauges (for tests). */
  reset(): void;
}

const DEFAULT_PREFIX = 'model_router_';
const DEFAULT_BUCKETS: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const DEFAULT_MAX_LABEL_SETS = 200;
const OVERFLOW_LABEL = 'overflow';
const SANITIZE_CACHE_LIMIT = 4096;

const REQUEST_LABEL_NAMES = ['proto', 'status', 'upstream'] as const;
const TOKEN_LABEL_NAMES = ['direction', 'upstream'] as const;
const DURATION_LABEL_NAMES = ['proto', 'upstream'] as const;
const CIRCUIT_LABEL_NAMES = ['upstream'] as const;

interface CounterSeries {
  /** Sanitized label values in the family's fixed label order. */
  values: string[];
  value: number;
}

interface HistogramSeries {
  values: string[];
  /** Per-bucket (non-cumulative) counts, aligned with the sorted bucket bounds. */
  bucketCounts: number[];
  sum: number;
  count: number;
}

/** Memoized label sanitization; bounded so hostile inputs cannot grow it forever. */
const sanitizeCache = new Map<string, string>();

function sanitizeLabelValue(raw: string): string {
  const cached = sanitizeCache.get(raw);
  if (cached !== undefined) return cached;
  const clean = raw.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (sanitizeCache.size < SANITIZE_CACHE_LIMIT) sanitizeCache.set(raw, clean);
  return clean;
}

function toLabelValue(raw: number | string): string {
  if (raw === undefined || raw === null) return '';
  return sanitizeLabelValue(String(raw));
}

function normalizeBuckets(raw: readonly number[] | undefined): number[] {
  const source = raw !== undefined && raw.length > 0 ? raw : DEFAULT_BUCKETS;
  const finite = source.filter((b) => Number.isFinite(b) && b > 0).sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const bound of finite) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== bound) deduped.push(bound);
  }
  return deduped.length > 0 ? deduped : [...DEFAULT_BUCKETS];
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

function formatBucketBound(bound: number): string {
  return String(bound);
}

function renderLabels(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([name, value]) => `${name}="${value}"`).join(',')}}`;
}

function zipLabels(names: readonly string[], values: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < names.length; i++) pairs.push([names[i] as string, values[i] as string]);
  return pairs;
}

export function createMetricsRegistry(options: MetricsRegistryOptions = {}): MetricsRegistry {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const maxLabelSets = options.maxLabelSets ?? DEFAULT_MAX_LABEL_SETS;
  const logger: MetricsLogger | undefined = options.logger;
  const buckets = normalizeBuckets(options.durationBuckets);

  const requestsName = `${prefix}requests_total`;
  const durationName = `${prefix}request_duration_ms`;
  const tokensName = `${prefix}tokens_total`;
  const inFlightName = `${prefix}in_flight`;
  const circuitName = `${prefix}upstream_circuit_state`;
  const rssName = `${prefix}process_resident_memory_bytes`;
  const overflowName = `${prefix}metrics_cardinality_overflow_total`;

  const requestSeries = new Map<string, CounterSeries>();
  const durationSeries = new Map<string, HistogramSeries>();
  const tokenSeries = new Map<string, CounterSeries>();
  const circuitSeries = new Map<string, CounterSeries>();
  const overflowCounts = new Map<string, number>();
  const overflowWarned = new Set<string>();

  let inFlight = 0;

  function noteOverflow(family: string): void {
    overflowCounts.set(family, (overflowCounts.get(family) ?? 0) + 1);
    if (logger !== undefined && !overflowWarned.has(family)) {
      overflowWarned.add(family);
      logger.warn(
        `metrics: label-set cap (${maxLabelSets}) reached for ${family}; further increments fold into the "overflow" series`,
      );
    }
  }

  function getOrCreateSeries<T extends { values: string[] }>(
    map: Map<string, T>,
    values: readonly string[],
    family: string,
    create: (foldedValues: string[]) => T,
  ): T {
    const key = values.join(' ');
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    if (map.size >= maxLabelSets) {
      noteOverflow(family);
      const foldedValues = values.map(() => OVERFLOW_LABEL);
      const foldedKey = foldedValues.join(' ');
      const folded = map.get(foldedKey);
      if (folded !== undefined) return folded;
      const created = create(foldedValues);
      map.set(foldedKey, created);
      return created;
    }
    const created = create([...values]);
    map.set(key, created);
    return created;
  }

  function makeCounter(values: string[]): CounterSeries {
    return { values, value: 0 };
  }

  function makeHistogram(values: string[]): HistogramSeries {
    return { values, bucketCounts: new Array<number>(buckets.length).fill(0), sum: 0, count: 0 };
  }

  function incRequest(labels: RequestLabels): void {
    const values = [toLabelValue(labels.proto), toLabelValue(labels.status), toLabelValue(labels.upstream)];
    const series = getOrCreateSeries(requestSeries, values, requestsName, makeCounter);
    series.value += 1;
  }

  function observeDuration(labels: DurationLabels, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const values = [toLabelValue(labels.proto), toLabelValue(labels.upstream)];
    const series = getOrCreateSeries(durationSeries, values, durationName, makeHistogram);
    // First bucket whose upper bound >= the observed value (buckets sorted ascending).
    for (let i = 0; i < buckets.length; i++) {
      if (durationMs <= (buckets[i] as number)) {
        series.bucketCounts[i] = (series.bucketCounts[i] as number) + 1;
        break;
      }
    }
    series.count += 1;
    series.sum += durationMs;
  }

  function observeRequest(labels: RequestLabels, durationMs?: number): void {
    incRequest(labels);
    if (durationMs !== undefined) observeDuration(labels, durationMs);
  }

  function addTokens(direction: string, upstream: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const values = [toLabelValue(direction), toLabelValue(upstream)];
    const series = getOrCreateSeries(tokenSeries, values, tokensName, makeCounter);
    series.value += tokens;
  }

  function setInFlight(value: number): void {
    if (!Number.isFinite(value)) return;
    inFlight = value;
  }

  function addInFlight(delta = 1): void {
    setInFlight(inFlight + delta);
  }

  function setCircuitState(upstream: string, state: CircuitState): void {
    if (!Number.isFinite(state)) return;
    const values = [toLabelValue(upstream)];
    const key = values.join(' ');
    const existing = circuitSeries.get(key);
    if (existing !== undefined) {
      existing.value = state;
      return;
    }
    // Gauges: no cardinality folding — a bounded upstream set is expected; still cap defensively.
    if (circuitSeries.size >= maxLabelSets) {
      noteOverflow(circuitName);
      const foldedValues = [OVERFLOW_LABEL];
      const folded = circuitSeries.get(OVERFLOW_LABEL);
      if (folded !== undefined) {
        folded.value = state;
        return;
      }
      circuitSeries.set(OVERFLOW_LABEL, { values: foldedValues, value: state });
      return;
    }
    circuitSeries.set(key, { values, value: state });
  }

  function renderCounterFamily(
    name: string,
    help: string,
    series: Map<string, CounterSeries>,
    labelNames: readonly string[],
    out: string[],
  ): void {
    if (series.size === 0) return;
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} counter`);
    for (const s of series.values()) {
      out.push(`${name}${renderLabels(zipLabels(labelNames, s.values))} ${formatValue(s.value)}`);
    }
  }

  function render(): string {
    const out: string[] = [];

    renderCounterFamily(
      requestsName,
      'Total proxy requests by protocol, upstream and response status.',
      requestSeries,
      REQUEST_LABEL_NAMES,
      out,
    );

    if (durationSeries.size > 0) {
      out.push(`# HELP ${durationName} Request duration in milliseconds by protocol and upstream.`);
      out.push(`# TYPE ${durationName} histogram`);
      for (const s of durationSeries.values()) {
        const basePairs = zipLabels(DURATION_LABEL_NAMES, s.values);
        let cumulative = 0;
        for (let i = 0; i < buckets.length; i++) {
          cumulative += s.bucketCounts[i] as number;
          const bound = buckets[i] as number;
          out.push(
            `${durationName}_bucket${renderLabels([['le', formatBucketBound(bound)], ...basePairs])} ${formatValue(cumulative)}`,
          );
        }
        out.push(`${durationName}_bucket${renderLabels([['le', '+Inf'], ...basePairs])} ${formatValue(s.count)}`);
        out.push(`${durationName}_sum${renderLabels(basePairs)} ${formatValue(s.sum)}`);
        out.push(`${durationName}_count${renderLabels(basePairs)} ${formatValue(s.count)}`);
      }
    }

    renderCounterFamily(
      tokensName,
      'Total tokens observed by direction and upstream.',
      tokenSeries,
      TOKEN_LABEL_NAMES,
      out,
    );

    out.push(`# HELP ${inFlightName} Number of requests currently being processed by the proxy.`);
    out.push(`# TYPE ${inFlightName} gauge`);
    out.push(`${inFlightName} ${formatValue(inFlight)}`);

    if (circuitSeries.size > 0) {
      out.push(`# HELP ${circuitName} Upstream circuit breaker state (0 closed, 1 half-open, 2 open).`);
      out.push(`# TYPE ${circuitName} gauge`);
      for (const s of circuitSeries.values()) {
        out.push(`${circuitName}${renderLabels(zipLabels(CIRCUIT_LABEL_NAMES, s.values))} ${formatValue(s.value)}`);
      }
    }

    out.push(`# HELP ${rssName} Resident memory size of the proxy process in bytes.`);
    out.push(`# TYPE ${rssName} gauge`);
    out.push(`${rssName} ${formatValue(process.memoryUsage().rss)}`);

    if (overflowCounts.size > 0) {
      out.push(
        `# HELP ${overflowName} Increments folded into the overflow series after the per-metric label-set cap was reached.`,
      );
      out.push(`# TYPE ${overflowName} counter`);
      for (const [family, count] of overflowCounts) {
        out.push(`${overflowName}${renderLabels([['metric', sanitizeLabelValue(family)]])} ${formatValue(count)}`);
      }
    }

    return out.length > 0 ? `${out.join('\n')}\n` : '';
  }

  function reset(): void {
    requestSeries.clear();
    durationSeries.clear();
    tokenSeries.clear();
    circuitSeries.clear();
    overflowCounts.clear();
    overflowWarned.clear();
    inFlight = 0;
  }

  return {
    observeRequest,
    incRequest,
    observeDuration,
    addTokens,
    setInFlight,
    addInFlight,
    setCircuitState,
    render,
    reset,
  };
}
