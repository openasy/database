import {
  AppShell,
  Badge,
  BarList,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  OverviewGrid,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  TimeSeriesChart,
  toLocale,
  useLocalePreference,
  usePath,
  useThemePreference,
  type Column,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  Activity,
  Cable,
  Database,
  FileSearch,
  Gauge,
  KeyRound,
  LayoutGrid,
  Lock,
  LogIn,
  LogOut,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Server,
  TableProperties,
  Trash2,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  type Connections,
  type Instance,
  type InstanceSummary,
  type Locks,
  type LockNode,
  type Plan,
  type PlanNode,
  type ProductLink,
  type QueryDetail,
  type QueryList,
  type QueryStat,
  type Replication,
  type Sample,
  type Session,
  type Summary,
  type Tls,
} from "./api.ts";
import { useT } from "./i18n.ts";
import { search } from "./search.ts";

const PAGES = ["queries", "locks", "replication", "connections", "explain", "instances", "setup", "account", "members", "signin", "tokens"] as const;
type Page = "overview" | (typeof PAGES)[number];
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parsePage(path: string): Page {
  const page = path.replace(/^\//, "").split("/")[0] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "overview";
}

/** A query parameter of the address. */
const param = (name: string) => new URLSearchParams(window.location.search).get(name);

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

/** Loads a path now, again every `every` ms when set, and on demand; keeps its error to show. */
function useLoad<T>(call: Call, path: string | null, every?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    if (!path) return;
    void call<T>(path).then(
      (d) => (setData(d), setError(undefined)),
      (err: Error) => setError(err.message),
    );
  }, [call, path]);
  useEffect(() => {
    setData(undefined);
    setError(undefined);
    load();
    if (!every) return;
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [load, every]);
  return [data, error, load] as const;
}

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${v.toFixed(1)} ms` : `${v.toFixed(2)} ms`);
const hours = (msTotal: number) => {
  const s = msTotal / 1000;
  return s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`;
};
const seconds = (v: number | null) => (v === null ? "–" : v < 1 ? `${Math.round(v * 1000)} ms` : v < 60 ? `${v.toFixed(1)} s` : formatDuration(Math.round(v)));
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const short = (s: Session) => `${s.pid}${s.application ? ` · ${s.application}` : ""}`;

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-fg">{children}</pre>;
}

function ErrorText({ message }: { message?: string }) {
  return message ? <p className="m-0 text-xs text-danger">{message}</p> : null;
}

/** An instance that did not answer a live view: why, from the API. */
function Unreachable({ message }: { message: string }) {
  const t = useT();
  return (
    <Callout tone="danger" title={t("product.unreachable")}>
      {message}
    </Callout>
  );
}

const RANGES = ["1", "24", "168"] as const;
type Range = (typeof RANGES)[number];

function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const t = useT();
  return <SegmentedControl label={t("ranges.label")} value={value} onChange={onChange} options={RANGES.map((r) => ({ value: r, label: t(`ranges.${r}`) }))} />;
}

/** Which instance the pages show; only offered when there is more than one. */
function InstancePicker({ instances, value, onChange }: { instances: InstanceSummary[]; value: string; onChange: (id: string) => void }) {
  const t = useT();
  if (instances.length < 2) return null;
  return (
    <SelectField
      aria-label={t("product.instance")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={instances.map((i) => ({ value: i.id, label: i.name }))}
    />
  );
}

function RoleBadge({ role }: { role: "primary" | "replica" | null }) {
  const t = useT();
  return role ? <Badge tone={role === "primary" ? "info" : "neutral"}>{t(`roles.${role}`)}</Badge> : <span className="text-fg-muted">–</span>;
}

function StateBadge({ ok }: { ok: boolean | null }) {
  const t = useT();
  return ok === null ? (
    <StatusBadge tone="neutral">{t("states.unchecked")}</StatusBadge>
  ) : ok ? (
    <StatusBadge tone="success">{t("states.ok")}</StatusBadge>
  ) : (
    <StatusBadge tone="danger">{t("states.unreachable")}</StatusBadge>
  );
}

// ---------------------------------------------------------------- Overview

function OverviewPage({ call, summary, selected, select }: { call: Call; summary: Summary; selected: InstanceSummary; select: (id: string) => void }) {
  const t = useT();
  const s = summary;
  const [series] = useLoad<{ samples: Sample[] }>(call, `/api/v1/instances/${selected.id}/series?hours=24`, 60_000);
  const columns: Column<InstanceSummary>[] = [
    {
      id: "name",
      header: t("overviewPage.instance"),
      sortValue: (i) => i.name,
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{i.name}</span>
          <span className="truncate font-mono text-2xs text-fg-muted">{i.host}</span>
        </span>
      ),
    },
    { id: "role", header: t("overviewPage.role"), width: "100px", cell: (i) => <RoleBadge role={i.role} /> },
    { id: "version", header: t("overviewPage.version"), cell: (i) => <span className="text-xs">{i.version ?? "–"}</span> },
    {
      id: "connections",
      header: t("overviewPage.connections"),
      align: "right",
      mono: true,
      sortValue: (i) => (i.latest ? i.latest.connections / i.latest.maxConnections : 0),
      cell: (i) => (i.latest ? `${i.latest.connections} / ${i.latest.maxConnections}` : "–"),
    },
    {
      id: "tps",
      header: t("overviewPage.tps"),
      align: "right",
      mono: true,
      sortValue: (i) => i.latest?.xactPerSecond ?? 0,
      cell: (i) => (i.latest?.xactPerSecond == null ? "–" : formatNumber(Math.round(i.latest.xactPerSecond))),
    },
    {
      id: "hit",
      header: t("overviewPage.cacheHit"),
      align: "right",
      mono: true,
      cell: (i) =>
        i.latest?.cacheHit == null ? (
          "–"
        ) : (
          <span className={i.latest.cacheHit < 0.95 ? "text-warning-text" : undefined}>{formatPercent(i.latest.cacheHit)}</span>
        ),
    },
    {
      id: "lag",
      header: t("overviewPage.lag"),
      align: "right",
      mono: true,
      sortValue: (i) => i.latest?.lagSeconds ?? -1,
      cell: (i) => <span className={(i.latest?.lagSeconds ?? 0) >= 1 ? "text-warning-text" : undefined}>{seconds(i.latest?.lagSeconds ?? null)}</span>,
    },
    {
      id: "blocked",
      header: t("overviewPage.blocked"),
      align: "right",
      mono: true,
      sortValue: (i) => i.latest?.blocked ?? 0,
      cell: (i) => <span className={i.latest?.blocked ? "text-danger-text" : undefined}>{i.latest?.blocked ?? "–"}</span>,
    },
    { id: "state", header: t("overviewPage.state"), width: "130px", cell: (i) => <StateBadge ok={i.ok} /> },
  ];
  const samples = series?.samples ?? [];
  return (
    <>
      <PageHeader title={t("overviewPage.overview")} description={t("overviewPage.description", { count: s.totals.instances, seconds: s.sampleSeconds })} />
      {s.instances
        .filter((i) => i.ok === false)
        .map((i) => (
          <Callout
            key={i.id}
            tone="danger"
            title={t("overviewPage.down", { name: i.name })}
            action={
              <Button size="sm" onClick={() => navigate("/instances")}>
                {t("product.instances")}
              </Button>
            }
          >
            {i.error}
          </Callout>
        ))}
      {s.instances
        .filter((i) => i.warnings.length)
        .map((i) => (
          <Callout key={`${i.id}-w`} tone="warning" title={t("overviewPage.warnings", { name: i.name })}>
            {i.warnings.join(" ")}
          </Callout>
        ))}
      <KpiGrid minWidth={160}>
        <KpiCard
          label={t("overviewPage.transactions")}
          value={formatNumber(Math.round(s.totals.xactPerSecond), { compact: true })}
          unit={t("overviewPage.perSecond")}
          icon={Activity}
        />
        <KpiCard label={t("overviewPage.blockedNow")} value={s.totals.blocked} icon={Lock} tone={s.totals.blocked ? "danger" : "success"} href="/locks" />
        <KpiCard
          label={t("overviewPage.maxLag")}
          value={seconds(s.totals.maxLagSeconds)}
          icon={Repeat}
          tone={(s.totals.maxLagSeconds ?? 0) >= 1 ? "warning" : undefined}
          href="/replication"
        />
        <KpiCard label={t("overviewPage.storage")} value={formatBytes(s.totals.sizeBytes)} icon={Database} />
      </KpiGrid>
      <Panel title={t("overviewPage.instances")} flush>
        <DataTable
          label={t("overviewPage.instances")}
          columns={columns}
          rows={s.instances}
          getRowId={(i) => i.id}
          activeRowId={selected.id}
          onRowClick={(i) => select(i.id)}
          minWidth={940}
        />
      </Panel>
      <OverviewGrid>
        <Panel title={t("overviewPage.connectionsChart")} description={t("overviewPage.connectionsChartDetail", { name: selected.name })}>
          {samples.length > 1 ? (
            <TimeSeriesChart
              label={t("overviewPage.connectionsChart")}
              labels={samples.map((p) => clock(p.at))}
              height={180}
              stacked
              xTicks={5}
              format={(v) => `${Math.round(v)}`}
              threshold={samples.at(-1) ? { value: samples.at(-1)!.maxConnections, label: `max ${samples.at(-1)!.maxConnections}` } : undefined}
              series={[
                { id: "active", name: t("sessionStates.active"), color: "var(--oa-chart-1)", data: samples.map((p) => p.active) },
                { id: "idle", name: t("sessionStates.idle"), color: "var(--oa-chart-3)", data: samples.map((p) => p.idle) },
                { id: "tx", name: t("sessionStates.idleInTransaction"), color: "var(--oa-chart-4)", data: samples.map((p) => p.idleInTransaction) },
              ]}
            />
          ) : (
            <EmptyState title={t("overviewPage.noSamples")}>{t("overviewPage.noSamplesDetail", { seconds: s.sampleSeconds })}</EmptyState>
          )}
        </Panel>
        <Panel title={t("overviewPage.waitEvents")} description={t("overviewPage.waitEventsDetail", { name: selected.name })}>
          {selected.waitEvents.length ? (
            <BarList
              label={t("overviewPage.waitEvents")}
              format={(v) => `${v}%`}
              items={selected.waitEvents.map((w) => ({
                id: w.event,
                label: w.event,
                value: Math.round(w.share * 100),
                ...(w.event.startsWith("Lock") && { color: "var(--oa-danger)" }),
              }))}
            />
          ) : (
            <EmptyState title={t("overviewPage.idle")} />
          )}
        </Panel>
      </OverviewGrid>
    </>
  );
}

/** The first screen, until an instance is added. */
function WelcomePage() {
  const t = useT();
  return (
    <>
      <PageHeader title={t("welcomePage.getStarted")} description={t("welcomePage.description")} />
      <Panel title={t("welcomePage.steps")}>
        <ol className="database-steps text-sm">
          <li>{t("welcomePage.step1")}</li>
          <li>{t("welcomePage.step2")}</li>
          <li>{t("welcomePage.step3")}</li>
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" icon={<Wrench />} onClick={() => navigate("/setup")}>
            {t("product.setup")}
          </Button>
          <Button icon={<Server />} onClick={() => navigate("/instances")}>
            {t("product.instances")}
          </Button>
        </div>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Plans

function PlanTree({ node, depth = 0 }: { node: PlanNode; depth?: number }) {
  const t = useT();
  return (
    <li>
      <div className="database-tree-row" data-hot={node.hot} style={{ ["--depth" as string]: depth }}>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 gap-1 font-mono">
            {depth > 0 && (
              <span aria-hidden className="text-fg-muted">
                →
              </span>
            )}
            <span className={node.hot ? "font-semibold text-warning-text" : "text-fg"}>{node.op}</span>
          </span>
          {node.detail.map((d) => (
            <span key={d} className="font-mono text-2xs break-words text-fg-muted">
              {d}
            </span>
          ))}
        </span>
        <span className="flex flex-col items-end font-mono text-2xs whitespace-nowrap text-fg-muted">
          <span className={node.hot ? "font-semibold text-warning-text" : "text-fg"}>{t("plan.share", { share: formatPercent(node.share) })}</span>
          <span>{t("plan.numbers", { rows: formatNumber(node.rows), cost: node.totalCost.toFixed(2) })}</span>
        </span>
      </div>
      {node.children.length > 0 && (
        <ul className="database-list">
          {node.children.map((c, i) => (
            <PlanTree key={i} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  const t = useT();
  return (
    <>
      <ul className="database-list" aria-label={t("plan.nodes")}>
        <PlanTree node={plan.root} />
      </ul>
      <p className="m-0 px-3 py-2 text-xs text-fg-muted">{plan.parameters ? t("plan.generic", { count: plan.parameters }) : t("plan.estimated")}</p>
    </>
  );
}

/** Asks for the plan of a statement; editors only, as the API requires. */
function useExplain(call: Call, instanceId: string) {
  const [plan, setPlan] = useState<Plan>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const run = useCallback(
    async (sql: string, database: string) => {
      setRunning(true);
      setError(undefined);
      try {
        setPlan(await call<Plan>(`/api/v1/instances/${instanceId}/explain`, { method: "POST", body: JSON.stringify({ sql, database }) }));
      } catch (err) {
        setPlan(undefined);
        setError((err as Error).message);
      } finally {
        setRunning(false);
      }
    },
    [call, instanceId],
  );
  return { plan, error, running, run, clear: () => (setPlan(undefined), setError(undefined)) };
}

// ---------------------------------------------------------------- Queries

function QueriesPage({ call, header, instance }: { call: Call; header: ReactNode; instance: InstanceSummary }) {
  const t = useT();
  const { can } = useAuth();
  const [range, setRange] = useState<Range>("24");
  const [database, setDatabase] = useState("");
  const [active, setActive] = useState<string>();
  const [list] = useLoad<QueryList>(
    call,
    `/api/v1/instances/${instance.id}/queries?hours=${range}${database ? `&database=${encodeURIComponent(database)}` : ""}`,
    60_000,
  );
  const [detail] = useLoad<QueryDetail>(call, active ? `/api/v1/instances/${instance.id}/queries/${active}?hours=${range}` : null);
  const explain = useExplain(call, instance.id);
  const columns: Column<QueryStat>[] = [
    {
      id: "query",
      header: t("queriesPage.query"),
      width: "44%",
      cell: (q) => (
        <span className="flex min-w-0 flex-col">
          <span className="database-clamp font-mono text-xs" title={q.query}>
            {q.query}
          </span>
          <span className="text-2xs text-fg-muted">{q.database}</span>
        </span>
      ),
    },
    {
      id: "calls",
      header: t("queriesPage.calls"),
      align: "right",
      mono: true,
      sortValue: (q) => q.calls,
      cell: (q) => formatNumber(q.calls, { compact: true }),
    },
    {
      id: "mean",
      header: t("queriesPage.mean"),
      align: "right",
      mono: true,
      sortValue: (q) => q.meanMs,
      cell: (q) => <span className={q.meanMs >= 1000 ? "text-danger-text" : q.meanMs >= 30 ? "text-warning-text" : undefined}>{ms(q.meanMs)}</span>,
    },
    { id: "total", header: t("queriesPage.total"), align: "right", mono: true, sortValue: (q) => q.totalMs, cell: (q) => hours(q.totalMs) },
    { id: "rows", header: t("queriesPage.rows"), align: "right", mono: true, sortValue: (q) => q.rows, cell: (q) => formatNumber(q.rows, { compact: true }) },
    {
      id: "share",
      header: t("queriesPage.share"),
      width: "150px",
      sortValue: (q) => q.share,
      cell: (q) => (
        <span className="flex items-center gap-2">
          <span aria-hidden className="database-share">
            <span style={{ width: `${q.share * 100}%` }} />
          </span>
          <span className="font-mono text-xs">{formatPercent(q.share)}</span>
        </span>
      ),
    },
  ];
  const points = list?.points ?? [];
  return (
    <>
      <PageHeader
        title={t("queriesPage.queries")}
        description={list ? t("queriesPage.description", { count: list.statements }) : t("queriesPage.reading")}
        actions={
          <>
            {header}
            <RangePicker value={range} onChange={setRange} />
          </>
        }
      />
      {list && list.databases.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <SelectField
            aria-label={t("queriesPage.database")}
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            options={[
              { value: "", label: t("queriesPage.allDatabases") },
              ...list.databases.map((d) => ({ value: d.database, label: `${d.database} (${d.count})` })),
            ]}
          />
        </div>
      )}
      {instance.warnings.some((w) => w.includes("pg_stat_statements")) && (
        <Callout tone="warning" title={t("queriesPage.noStatements")}>
          {instance.warnings.find((w) => w.includes("pg_stat_statements"))}
        </Callout>
      )}
      <Panel title={t("queriesPage.latency")} description={t("queriesPage.latencyDetail")}>
        {points.length > 1 ? (
          <TimeSeriesChart
            label={t("queriesPage.latency")}
            labels={points.map((p) => clock(p.at))}
            height={160}
            area={false}
            xTicks={5}
            format={(v) => ms(v)}
            series={[{ id: "mean", name: t("queriesPage.mean"), data: points.map((p) => p.meanMs ?? 0) }]}
          />
        ) : (
          <EmptyState title={t("overviewPage.noSamples")}>{t("queriesPage.notYet")}</EmptyState>
        )}
      </Panel>
      <Panel title={t("queriesPage.top")} description={t(`queriesPage.topDetail.${range}`)} flush>
        <DataTable
          label={t("queriesPage.top")}
          columns={columns}
          rows={list?.queries ?? []}
          loading={!list}
          getRowId={(q) => q.key}
          activeRowId={active}
          onRowClick={(q) => (setActive(q.key), explain.clear())}
          defaultSort={{ id: "total", direction: "desc" }}
          minWidth={980}
          empty={<EmptyState title={t("queriesPage.none")}>{t("queriesPage.notYet")}</EmptyState>}
        />
      </Panel>
      {detail && (
        <Panel
          aria-label={t("queriesPage.selected")}
          title={t("queriesPage.selected")}
          description={t("queriesPage.selectedDetail", { database: detail.database, mean: ms(detail.meanMs), calls: formatNumber(detail.calls) })}
          actions={
            can("editor") && (
              <Button size="sm" icon={<FileSearch />} loading={explain.running} onClick={() => void explain.run(detail.query, detail.database)}>
                {t("queriesPage.explain")}
              </Button>
            )
          }
          flush
        >
          <div className="border-b border-subtle bg-canvas px-2.5 py-2">
            <code className="font-mono text-xs break-words text-fg">{detail.query}</code>
          </div>
          {detail.points.length > 1 && (
            <div className="px-2.5 py-2">
              <TimeSeriesChart
                label={t("queriesPage.selected")}
                labels={detail.points.map((p) => clock(p.at))}
                height={120}
                area={false}
                xTicks={5}
                format={(v) => ms(v)}
                series={[{ id: "mean", name: t("queriesPage.mean"), data: detail.points.map((p) => p.meanMs ?? 0) }]}
              />
            </div>
          )}
          {explain.error && (
            <div className="px-2.5 py-2">
              <ErrorText message={explain.error} />
            </div>
          )}
          {explain.plan && <PlanView plan={explain.plan} />}
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Locks

function LockTree({ node, depth = 0 }: { node: LockNode; depth?: number }) {
  const t = useT();
  return (
    <li>
      <div className="database-tree-row" data-head={depth === 0} style={{ ["--depth" as string]: depth }}>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-mono font-semibold">{node.pid}</span>
            <span className="text-fg-muted">{[node.user, node.application, node.client].filter(Boolean).join(" · ") || t("locksPage.unseen")}</span>
            {node.state && <Badge tone={node.state.startsWith("idle") ? "warning" : "neutral"}>{node.state}</Badge>}
          </span>
          {node.query && (
            <span className="truncate font-mono text-2xs" title={node.query}>
              {node.query}
            </span>
          )}
          {node.waitingFor && <span className="font-mono text-2xs text-fg-muted">{t("locksPage.waitsFor", { lock: node.waitingFor })}</span>}
        </span>
        <span className="font-mono text-2xs whitespace-nowrap">
          {depth === 0 ? t("locksPage.blocking", { count: node.blocking }) : t("locksPage.waiting", { time: seconds(node.stateSeconds) })}
        </span>
      </div>
      {node.waiters.length > 0 && (
        <ul className="database-list">
          {node.waiters.map((w) => (
            <LockTree key={w.pid} node={w} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function LocksPage({ call, header, instance }: { call: Call; header: ReactNode; instance: InstanceSummary }) {
  const t = useT();
  const [locks, error] = useLoad<Locks>(call, `/api/v1/instances/${instance.id}/locks`, 5_000);
  const [series] = useLoad<{ samples: Sample[] }>(call, `/api/v1/instances/${instance.id}/series?hours=1`, 60_000);
  const idle = locks?.chains.find((c) => c.state?.startsWith("idle in transaction"));
  const samples = series?.samples ?? [];
  return (
    <>
      <PageHeader title={t("locksPage.locks")} description={t("locksPage.description")} actions={header} />
      {error && <Unreachable message={error} />}
      <KpiGrid>
        <KpiCard label={t("locksPage.heads")} value={locks?.chains.length ?? "–"} tone={locks?.chains.length ? "danger" : "success"} />
        <KpiCard label={t("locksPage.waitingSessions")} value={locks?.waiting ?? "–"} tone={locks?.waiting ? "warning" : "success"} />
        <KpiCard label={t("locksPage.longest")} value={seconds(locks?.longestWaitSeconds ?? null)} />
      </KpiGrid>
      {samples.length > 1 && (
        <Panel title={t("locksPage.chart")} description={t("locksPage.chartDetail")}>
          <TimeSeriesChart
            label={t("locksPage.chart")}
            labels={samples.map((p) => clock(p.at))}
            height={120}
            xTicks={5}
            series={[{ id: "blocked", name: t("locksPage.waitingSessions"), color: "var(--oa-chart-4)", data: samples.map((p) => p.blocked) }]}
          />
        </Panel>
      )}
      {idle && (
        <Callout tone="warning" title={t("locksPage.idleTitle", { who: short(idle), time: seconds(idle.xactSeconds) })}>
          {t("locksPage.idleDetail")}
        </Callout>
      )}
      <Panel title={t("locksPage.chains")} description={t("locksPage.chainsDetail")} flush>
        {!locks ? (
          <EmptyState title={t("product.loading")} />
        ) : locks.chains.length ? (
          <ul className="database-list" aria-label={t("locksPage.chains")}>
            {locks.chains.map((c) => (
              <LockTree key={c.pid} node={c} />
            ))}
          </ul>
        ) : (
          <EmptyState title={t("locksPage.none")} />
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Replication

function ReplicationPage({ call, header, instance }: { call: Call; header: ReactNode; instance: InstanceSummary }) {
  const t = useT();
  const [r, error] = useLoad<Replication>(call, `/api/v1/instances/${instance.id}/replication`, 15_000);
  const [series] = useLoad<{ samples: Sample[] }>(call, `/api/v1/instances/${instance.id}/series?hours=24`, 60_000);
  const samples = series?.samples ?? [];
  const retained = r?.slots.reduce((s, x) => s + (x.retainedBytes ?? 0), 0) ?? 0;
  const stale = r?.slots.filter((s) => !s.active && (s.retainedBytes ?? 0) > 1024 ** 3) ?? [];
  return (
    <>
      <PageHeader title={t("replicationPage.replication")} description={t("replicationPage.description")} actions={header} />
      {error && <Unreachable message={error} />}
      <KpiGrid>
        <KpiCard label={t("replicationPage.role")} value={r ? t(`roles.${r.role}`) : "–"} />
        <KpiCard
          label={r?.role === "replica" ? t("replicationPage.behind") : t("replicationPage.furthest")}
          value={seconds(r?.lagSeconds ?? null)}
          tone={(r?.lagSeconds ?? 0) >= 1 ? "warning" : undefined}
        />
        <KpiCard label={t("replicationPage.standbys")} value={r?.standbys.length ?? "–"} />
        <KpiCard label={t("replicationPage.retained")} value={formatBytes(retained)} tone={stale.length ? "danger" : undefined} />
      </KpiGrid>
      {samples.some((p) => p.lagSeconds !== null) && (
        <Panel title={t("replicationPage.chart")} description={t("replicationPage.chartDetail")}>
          <TimeSeriesChart
            label={t("replicationPage.chart")}
            labels={samples.map((p) => clock(p.at))}
            height={150}
            xTicks={5}
            format={(v) => seconds(v)}
            series={[{ id: "lag", name: instance.name, data: samples.map((p) => p.lagSeconds ?? 0) }]}
          />
        </Panel>
      )}
      {stale.map((s) => (
        <Callout key={s.name} tone="danger" title={t("replicationPage.staleTitle", { name: s.name, size: formatBytes(s.retainedBytes ?? 0) })}>
          {t("replicationPage.staleDetail")}
        </Callout>
      ))}
      <Panel title={t("replicationPage.standbys")} flush>
        <DataTable
          label={t("replicationPage.standbys")}
          rows={r?.standbys ?? []}
          loading={!r && !error}
          getRowId={(s) => `${s.name}-${s.client}`}
          minWidth={760}
          empty={<EmptyState title={t("replicationPage.noStandbys")} />}
          columns={[
            { id: "name", header: t("replicationPage.standby"), cell: (s) => s.name },
            { id: "client", header: t("replicationPage.client"), mono: true, cell: (s) => s.client ?? "–" },
            { id: "state", header: t("replicationPage.state"), cell: (s) => <Badge>{s.state ?? "–"}</Badge> },
            { id: "sync", header: t("replicationPage.sync"), cell: (s) => s.syncState ?? "–" },
            {
              id: "replay",
              header: t("replicationPage.replayLag"),
              align: "right",
              mono: true,
              sortValue: (s) => s.replayLagSeconds ?? 0,
              cell: (s) => seconds(s.replayLagSeconds),
            },
            {
              id: "behind",
              header: t("replicationPage.behindBytes"),
              align: "right",
              mono: true,
              cell: (s) => (s.behindBytes === null ? "–" : formatBytes(s.behindBytes)),
            },
          ]}
        />
      </Panel>
      <Panel title={t("replicationPage.slots")} flush>
        <DataTable
          label={t("replicationPage.slots")}
          rows={r?.slots ?? []}
          loading={!r && !error}
          getRowId={(s) => s.name}
          minWidth={640}
          empty={<EmptyState title={t("replicationPage.noSlots")} />}
          columns={[
            { id: "name", header: t("replicationPage.slot"), mono: true, cell: (s) => s.name },
            { id: "type", header: t("replicationPage.type"), cell: (s) => <Badge>{s.type}</Badge> },
            { id: "database", header: t("replicationPage.database"), cell: (s) => s.database ?? "–" },
            {
              id: "active",
              header: t("replicationPage.active"),
              cell: (s) => (
                <StatusBadge tone={s.active ? "success" : "danger"}>{s.active ? t("replicationPage.isActive") : t("replicationPage.inactive")}</StatusBadge>
              ),
            },
            {
              id: "retained",
              header: t("replicationPage.walRetained"),
              align: "right",
              mono: true,
              sortValue: (s) => s.retainedBytes ?? 0,
              cell: (s) => (
                <span className={(s.retainedBytes ?? 0) > 10 * 1024 ** 3 ? "text-danger-text" : undefined}>
                  {s.retainedBytes === null ? "–" : formatBytes(s.retainedBytes)}
                </span>
              ),
            },
          ]}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Connections

const STATES = ["all", "active", "idle", "idle in transaction"] as const;
type StateFilter = (typeof STATES)[number];
const stateKey = (s: Exclude<StateFilter, "all">) => (s === "idle in transaction" ? "idleInTransaction" : s);

function ConnectionsPage({ call, header, instance }: { call: Call; header: ReactNode; instance: InstanceSummary }) {
  const t = useT();
  const [c, error] = useLoad<Connections>(call, `/api/v1/instances/${instance.id}/connections`, 10_000);
  const [state, setState] = useState<StateFilter>("all");
  const rows = (c?.sessions ?? []).filter(
    (s) => state === "all" || (state === "idle in transaction" ? s.state?.startsWith("idle in transaction") : s.state === state),
  );
  const columns: Column<Session>[] = [
    { id: "pid", header: t("connectionsPage.pid"), mono: true, align: "right", width: "80px", sortValue: (s) => s.pid, cell: (s) => s.pid },
    { id: "user", header: t("connectionsPage.user"), mono: true, cell: (s) => s.user ?? "–" },
    { id: "application", header: t("connectionsPage.application"), cell: (s) => <span className="text-xs">{s.application || "–"}</span> },
    { id: "client", header: t("connectionsPage.client"), mono: true, cell: (s) => s.client ?? t("connectionsPage.local") },
    { id: "database", header: t("connectionsPage.database"), cell: (s) => s.database ?? "–" },
    {
      id: "state",
      header: t("connectionsPage.state"),
      sortValue: (s) => s.state ?? "",
      cell: (s) =>
        s.state ? <Badge tone={s.state.startsWith("idle in transaction") ? "warning" : s.state === "active" ? "info" : "neutral"}>{s.state}</Badge> : "–",
    },
    {
      id: "since",
      header: t("connectionsPage.inState"),
      align: "right",
      mono: true,
      sortValue: (s) => s.stateSeconds ?? 0,
      cell: (s) => seconds(s.stateSeconds),
    },
    { id: "wait", header: t("connectionsPage.wait"), cell: (s) => <span className="text-xs">{s.waitEvent ?? "–"}</span> },
    {
      id: "query",
      header: t("connectionsPage.query"),
      width: "28%",
      cell: (s) => (
        <span className="database-clamp font-mono text-xs" title={s.query}>
          {s.query}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("connectionsPage.connections")}
        description={c ? t("connectionsPage.description", { used: c.sessions.length, max: c.maxConnections ?? "?" }) : t("connectionsPage.reading")}
        actions={header}
      />
      {error && <Unreachable message={error} />}
      <Panel title={t("connectionsPage.byApplication")} description={t("connectionsPage.now")}>
        {c?.byApplication.length ? (
          <BarList
            label={t("connectionsPage.byApplication")}
            items={c.byApplication
              .slice(0, 10)
              .map((a) => ({ id: a.application || "-", label: a.application || t("connectionsPage.unnamed"), value: a.count }))}
          />
        ) : (
          <EmptyState title={t("connectionsPage.none")} />
        )}
      </Panel>
      <div className="flex flex-wrap gap-2">
        <SegmentedControl
          label={t("connectionsPage.state")}
          value={state}
          onChange={setState}
          options={STATES.map((s) => ({ value: s, label: s === "all" ? t("connectionsPage.all") : t(`sessionStates.${stateKey(s)}`) }))}
        />
      </div>
      <Panel title={t("connectionsPage.sessions")} description={t("connectionsPage.shown", { count: rows.length })} flush>
        <DataTable
          label={t("connectionsPage.sessions")}
          columns={columns}
          rows={rows}
          loading={!c && !error}
          getRowId={(s) => String(s.pid)}
          defaultSort={{ id: "since", direction: "desc" }}
          minWidth={1100}
          empty={<EmptyState title={t("connectionsPage.none")} />}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Explain

function ExplainPage({ call, header, instance, details }: { call: Call; header: ReactNode; instance: InstanceSummary; details?: Instance }) {
  const t = useT();
  const { can } = useAuth();
  const databases = details?.status?.databases.length ? details.status.databases : [details?.database ?? "postgres"];
  const [database, setDatabase] = useState(details?.database ?? databases[0]!);
  const [sql, setSql] = useState("");
  const explain = useExplain(call, instance.id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void explain.run(sql, database);
  };
  return (
    <>
      <PageHeader title={t("explainPage.explain")} description={t("explainPage.description")} actions={header} />
      <div className="database-split">
        <Panel title={t("explainPage.statement")} aria-label={t("explainPage.statement")}>
          {can("editor") ? (
            <form className="flex flex-col gap-2.5" onSubmit={submit}>
              <SelectField
                label={t("explainPage.database")}
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                options={databases.map((d) => ({ value: d, label: d }))}
              />
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t("explainPage.sql")}</span>
                <textarea
                  className="database-textarea"
                  rows={8}
                  value={sql}
                  onChange={(e) => (setSql(e.target.value), explain.clear())}
                  placeholder="SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20"
                />
                <span className="text-xs text-fg-muted">{t("explainPage.sqlHint")}</span>
              </label>
              <ErrorText message={explain.error} />
              <div>
                <Button type="submit" variant="primary" icon={<Play />} loading={explain.running} disabled={!sql.trim()}>
                  {t("explainPage.run")}
                </Button>
              </div>
            </form>
          ) : (
            <EmptyState title={t("explainPage.editorsOnly")}>{t("explainPage.editorsOnlyDetail")}</EmptyState>
          )}
        </Panel>
        <Panel
          title={t("explainPage.plan")}
          description={
            explain.plan
              ? t("explainPage.planDetail", { database: explain.plan.database, cost: explain.plan.totalCost.toFixed(2), rows: formatNumber(explain.plan.rows) })
              : t("explainPage.notRun")
          }
          aria-label={t("explainPage.plan")}
          flush
        >
          {explain.plan ? <PlanView plan={explain.plan} /> : <EmptyState title={t("explainPage.notRun")} />}
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Instances

interface Draft {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  tls: Tls;
  ca: string;
}

const blank: Draft = { name: "", host: "", port: "5432", database: "postgres", user: "openasy_monitor", password: "", tls: "verify", ca: "" };
const draftOf = (i: Instance): Draft => ({
  name: i.name,
  host: i.host,
  port: String(i.port),
  database: i.database,
  user: i.user,
  password: "",
  tls: i.tls,
  ca: i.ca ?? "",
});

function InstanceDialog({ call, editing, onClose, onSaved }: { call: Call; editing: Instance | null | undefined; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [d, setD] = useState<Draft>(blank);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setD(editing ? draftOf(editing) : blank);
    setError(undefined);
  }, [editing]);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        name: d.name,
        host: d.host,
        port: Number(d.port),
        database: d.database,
        user: d.user,
        tls: d.tls,
        ...(d.password && { password: d.password }),
        ...(d.ca.trim() && { ca: d.ca }),
      };
      await call(editing ? `/api/v1/instances/${editing.id}` : "/api/v1/instances", { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      // The password leaves the page with the request; nothing keeps it here.
      setD(blank);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={editing !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title={editing ? t("instancesPage.edit", { name: editing.name }) : t("instancesPage.add")}
      description={t("instancesPage.addDetail")}
      onSubmit={(e) => void save(e)}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t("instancesPage.cancel")}</Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!d.name.trim() || !d.host.trim() || !d.user.trim() || (!editing && !d.password)}>
            {t("instancesPage.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <div className="database-cols-3">
          <TextField label={t("instancesPage.name")} value={d.name} onChange={set("name")} placeholder="db-prod-01" />
          <TextField label={t("instancesPage.host")} value={d.host} onChange={set("host")} placeholder="db1.internal" mono />
          <TextField label={t("instancesPage.port")} value={d.port} onChange={set("port")} inputMode="numeric" mono />
        </div>
        <div className="database-cols-3">
          <TextField label={t("instancesPage.database")} value={d.database} onChange={set("database")} hint={t("instancesPage.databaseHint")} mono />
          <TextField label={t("instancesPage.user")} value={d.user} onChange={set("user")} mono />
          <TextField
            label={t("instancesPage.password")}
            type="password"
            autoComplete="new-password"
            value={d.password}
            onChange={set("password")}
            hint={editing ? t("instancesPage.passwordKeep") : t("instancesPage.passwordHint")}
          />
        </div>
        <SelectField
          label={t("instancesPage.tls")}
          value={d.tls}
          onChange={set("tls")}
          options={(["verify", "require", "disable"] as const).map((v) => ({ value: v, label: t(`tls.${v}`) }))}
        />
        {d.tls === "disable" && (
          <Callout tone="warning" title={t("instancesPage.plainTitle")}>
            {t("instancesPage.plainDetail")}
          </Callout>
        )}
        {d.tls === "verify" && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("instancesPage.ca")}</span>
            <textarea className="database-textarea" rows={3} value={d.ca} onChange={set("ca")} placeholder="-----BEGIN CERTIFICATE-----" />
            <span className="text-xs text-fg-muted">{t("instancesPage.caHint")}</span>
          </label>
        )}
        <ErrorText message={error} />
      </div>
    </Dialog>
  );
}

function InstancesPage({ call, instances, reload }: { call: Call; instances?: Instance[]; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [editing, setEditing] = useState<Instance | null>();
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(undefined);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const columns: Column<Instance>[] = [
    {
      id: "name",
      header: t("instancesPage.name"),
      sortValue: (i) => i.name,
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{i.name}</span>
          <span className="database-wrap font-mono text-2xs text-fg-muted">
            {i.user}@{i.host}:{i.port}/{i.database}
          </span>
        </span>
      ),
    },
    { id: "version", header: t("overviewPage.version"), cell: (i) => <span className="text-xs">{i.status?.version ?? "–"}</span> },
    { id: "role", header: t("overviewPage.role"), cell: (i) => <RoleBadge role={i.status?.role ?? null} /> },
    { id: "tls", header: t("instancesPage.tls"), cell: (i) => <Badge tone={i.tls === "disable" ? "warning" : "neutral"}>{t(`tlsShort.${i.tls}`)}</Badge> },
    {
      id: "state",
      header: t("overviewPage.state"),
      width: "34%",
      cell: (i) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <StateBadge ok={i.status ? i.status.ok : null} />
          {i.status?.error && <span className="database-wrap text-2xs text-danger">{i.status.error}</span>}
          {i.status?.warnings.map((w) => (
            <span key={w} className="database-wrap text-2xs text-warning-text">
              {w}
            </span>
          ))}
          {i.status && <span className="text-2xs text-fg-muted">{t("instancesPage.checked", { when: when(i.status.checkedAt) })}</span>}
        </span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">{t("instancesPage.actions")}</span>,
      label: t("instancesPage.actions"),
      width: "220px",
      align: "right",
      hideable: false,
      cell: (i) => (
        <span className="flex flex-wrap justify-end gap-1.5">
          {can("editor") && (
            <Button size="xs" icon={<RefreshCw />} onClick={() => void act(() => call(`/api/v1/instances/${i.id}/check`, { method: "POST" }))}>
              {t("instancesPage.check")}
            </Button>
          )}
          {can("admin") && (
            <>
              <Button size="xs" icon={<Pencil />} onClick={() => setEditing(i)}>
                {t("instancesPage.change")}
              </Button>
              <IconButton
                size="xs"
                variant="danger"
                label={t("instancesPage.delete", { name: i.name })}
                onClick={() =>
                  window.confirm(t("instancesPage.confirmDelete", { name: i.name })) && void act(() => call(`/api/v1/instances/${i.id}`, { method: "DELETE" }))
                }
              >
                <Trash2 />
              </IconButton>
            </>
          )}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("instancesPage.instances")}
        description={t("instancesPage.description")}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing(null)}>
              {t("instancesPage.add")}
            </Button>
          )
        }
      />
      <ErrorText message={error} />
      <Panel title={t("instancesPage.instances")} flush>
        <DataTable
          label={t("instancesPage.instances")}
          columns={columns}
          rows={instances ?? []}
          loading={!instances}
          getRowId={(i) => i.id}
          minWidth={980}
          empty={<EmptyState title={t("instancesPage.none")}>{t("instancesPage.noneDetail")}</EmptyState>}
        />
      </Panel>
      <InstanceDialog call={call} editing={editing} onClose={() => setEditing(undefined)} onSaved={() => (setEditing(undefined), reload())} />
    </>
  );
}

// ---------------------------------------------------------------- Setup

function SetupPage() {
  const t = useT();
  const host = window.location.host;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.description")} />
      <Panel title={t("setupPage.role")} description={t("setupPage.roleDetail")}>
        <Code>{`-- As a superuser, once per server. pg_monitor reads statistics and nothing else.
CREATE ROLE openasy_monitor LOGIN PASSWORD '<a long random password>' IN ROLE pg_monitor;

-- postgresql.conf, then restart:
--   shared_preload_libraries = 'pg_stat_statements'
-- and in the database Database connects to (postgres unless set):
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`}</Code>
      </Panel>
      <Panel title={t("setupPage.explain")} description={t("setupPage.explainDetail")}>
        <Code>{`-- In each database whose statements you want to explain, for the schemas they use:
GRANT SELECT ON ALL TABLES IN SCHEMA public TO openasy_monitor;`}</Code>
      </Panel>
      <Panel title={t("setupPage.hba")} description={t("setupPage.hbaDetail")}>
        <Code>{`# pg_hba.conf: only from Database's address, only over TLS, only with a password
hostssl  all  openasy_monitor  10.0.0.7/32  scram-sha-256`}</Code>
      </Panel>
      <Panel title={t("setupPage.prometheus")} description={t("setupPage.prometheusDetail")}>
        <Code>{`scrape_configs:
  - job_name: openasy-database
    static_configs:
      - targets: ["${host}"]`}</Code>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settingsPage.${page}.title`)}
        description={t(`settingsPage.${page}.description`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const page = parsePage(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [instances, setInstances] = useState<Instance[]>();
  const [chosen, setChosen] = useState(param("instance") ?? "");
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "database" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<{ instances: Instance[] }>("/api/v1/instances").then(
      (r) => setInstances(r.instances),
      () => setInstances([]),
    );
  }, [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  // The instance the pages show, kept in the address so a link opens the same one.
  const selected = summary?.instances.find((i) => i.id === chosen) ?? summary?.instances[0];
  const select = (id: string) => {
    setChosen(id);
    const url = new URL(window.location.href);
    url.searchParams.set("instance", id);
    window.history.replaceState(null, "", url);
  };
  const header = summary && selected && <InstancePicker instances={summary.instances} value={selected.id} onChange={select} />;
  const blocked = summary?.totals.blocked;

  const nav = [
    { id: "overview", label: msg("product.overview"), icon: LayoutGrid },
    { id: "queries", label: msg("product.queries"), icon: TableProperties },
    { id: "locks", label: msg("product.locks"), icon: Lock, count: blocked || undefined },
    { id: "replication", label: msg("product.replication"), icon: Repeat },
    { id: "connections", label: msg("product.connections"), icon: Cable },
    { id: "explain", label: msg("product.explain"), icon: FileSearch },
    { id: "instances", label: msg("product.instances"), icon: Server, count: summary?.totals.unreachable || undefined },
    { id: "setup", label: msg("product.setup"), icon: Wrench },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const settings = page === "account" || page === "members" || page === "signin" || page === "tokens";
  const needsInstance = page === "overview" || page === "queries" || page === "locks" || page === "replication" || page === "connections" || page === "explain";

  return (
    <AppShell
      product="database"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={page}
      onNavigate={(id) => navigate(`/${id}${selected ? `?instance=${selected.id}` : ""}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings ? (
        <SettingsPage page={page as "account" | "members" | "signin" | "tokens"} />
      ) : page === "instances" ? (
        <InstancesPage call={call} instances={instances} reload={reload} />
      ) : page === "setup" ? (
        <SetupPage />
      ) : !summary ? (
        <EmptyState title={msg("product.loading")} icon={<Gauge />}>
          {msg("product.reading")}
        </EmptyState>
      ) : needsInstance && !selected ? (
        <WelcomePage />
      ) : page === "overview" ? (
        <OverviewPage call={call} summary={summary} selected={selected!} select={select} />
      ) : page === "queries" ? (
        <QueriesPage key={selected!.id} call={call} header={header} instance={selected!} />
      ) : page === "locks" ? (
        <LocksPage key={selected!.id} call={call} header={header} instance={selected!} />
      ) : page === "replication" ? (
        <ReplicationPage key={selected!.id} call={call} header={header} instance={selected!} />
      ) : page === "connections" ? (
        <ConnectionsPage key={selected!.id} call={call} header={header} instance={selected!} />
      ) : (
        <ExplainPage key={selected!.id} call={call} header={header} instance={selected!} details={instances?.find((i) => i.id === selected!.id)} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Database">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
