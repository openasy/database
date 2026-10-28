// Prometheus text exposition, written by hand: a few lines, no client library needed. Each instance's last sample is
// here too, so Metrics can keep it as time series and Alerts can fire on it (ADR 0062).
import type { Sample } from "./monitor.ts";

const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface InstanceGauge {
  name: string;
  up: boolean;
  latest: Sample | null;
}

const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function gauge(name: string, help: string, instances: InstanceGauge[], value: (i: InstanceGauge) => number | null | undefined): string[] {
  const lines = instances.flatMap((i) => {
    const v = value(i);
    return v === null || v === undefined || !Number.isFinite(v) ? [] : [`${name}{instance="${label(i.name)}"} ${v}`];
  });
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...lines];
}

export function renderMetrics(version: string, instances: InstanceGauge[]): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="database",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_database_instances Database servers watched.",
    "# TYPE openasy_database_instances gauge",
    `openasy_database_instances ${instances.length}`,
    ...gauge("openasy_database_up", "1 when the instance answered its last sample.", instances, (i) => (i.up ? 1 : 0)),
    ...gauge("openasy_database_connections", "Client connections at the last sample.", instances, (i) => i.latest?.connections),
    ...gauge("openasy_database_connections_max", "max_connections of the instance.", instances, (i) => i.latest?.maxConnections),
    ...gauge("openasy_database_sessions_blocked", "Sessions waiting on a lock another session holds.", instances, (i) => i.latest?.blocked),
    ...gauge(
      "openasy_database_sessions_idle_in_transaction",
      "Sessions idle inside an open transaction, which hold their locks.",
      instances,
      (i) => i.latest?.idleInTransaction,
    ),
    ...gauge(
      "openasy_database_replication_lag_seconds",
      "A replica: how far behind its primary. A primary: its furthest standby.",
      instances,
      (i) => i.latest?.lagSeconds,
    ),
    ...gauge(
      "openasy_database_transactions_per_second",
      "Commits and rollbacks per second since the sample before.",
      instances,
      (i) => i.latest?.xactPerSecond,
    ),
    ...gauge("openasy_database_cache_hit_ratio", "Blocks found in shared buffers since the sample before, 0 to 1.", instances, (i) => i.latest?.cacheHit),
    ...gauge("openasy_database_size_bytes", "The size of every database of the instance.", instances, (i) => i.latest?.sizeBytes),
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
