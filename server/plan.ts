// Query plans: which statements Explain takes, and EXPLAIN's JSON as a tree that shows where the cost is.

/** The statements PREPARE takes, and so the ones Explain plans. Anything else is refused before it is sent. */
const EXPLAINABLE = new Set(["select", "with", "values", "table", "insert", "update", "delete", "merge"]);

/** The statement without the comments before it and the semicolons after it, or why it cannot be explained. */
export function explainable(sql: string): { sql: string } | { error: string } {
  if (sql.length > 100_000) return { error: "The statement is at most 100,000 characters." };
  let rest = sql;
  // Leading whitespace and comments, which may hide the first word.
  for (;;) {
    const before = rest;
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("--")) rest = rest.slice(rest.includes("\n") ? rest.indexOf("\n") : rest.length);
    else if (rest.startsWith("/*")) rest = rest.includes("*/") ? rest.slice(rest.indexOf("*/") + 2) : "";
    if (rest === before) break;
  }
  const body = sql.trim().replace(/[\s;]+$/, "");
  const word = /^[A-Za-z]+/.exec(rest)?.[0]?.toLowerCase();
  if (!word) return { error: "There is no statement to explain." };
  if (!EXPLAINABLE.has(word)) return { error: "Explain takes SELECT, WITH, VALUES, TABLE, INSERT, UPDATE, DELETE and MERGE." };
  return { sql: body };
}

export interface PlanNode {
  /** As EXPLAIN's text shows it, such as "Index Scan using orders_pkey on orders". */
  op: string;
  /** Conditions and keys, such as "Filter: (status = 'open'::text)". */
  detail: string[];
  startupCost: number;
  totalCost: number;
  rows: number;
  /** The node's own cost: its total less its children's. */
  selfCost: number;
  /** selfCost as a share of the whole plan's cost, 0 to 1. */
  share: number;
  /** The node that costs the most, when it is a large part of the plan. */
  hot: boolean;
  children: PlanNode[];
}

export interface Plan {
  root: PlanNode;
  totalCost: number;
  rows: number;
}

type Raw = Record<string, unknown>;

const DETAILS: Array<[string, string]> = [
  ["Index Cond", "Index Cond"],
  ["Recheck Cond", "Recheck Cond"],
  ["Hash Cond", "Hash Cond"],
  ["Merge Cond", "Merge Cond"],
  ["Join Filter", "Join Filter"],
  ["Filter", "Filter"],
  ["One-Time Filter", "One-Time Filter"],
  ["Sort Key", "Sort Key"],
  ["Group Key", "Group Key"],
  ["Cache Key", "Cache Key"],
];

const AGGREGATE: Record<string, string> = { Hashed: "HashAggregate", Sorted: "GroupAggregate", Mixed: "MixedAggregate" };

/** The node's name as EXPLAIN's text format writes it. */
function opName(n: Raw): string {
  const type = String(n["Node Type"] ?? "Unknown");
  let op = type;
  if (type === "Aggregate") op = AGGREGATE[String(n.Strategy)] ?? "Aggregate";
  if (type === "ModifyTable") op = String(n.Operation ?? "Modify");
  if (type === "SetOp") op = n.Strategy === "Hashed" ? "HashSetOp" : "SetOp";
  if (/Join$|^Nested Loop$/.test(type) && n["Join Type"] && n["Join Type"] !== "Inner") {
    op = type === "Nested Loop" ? `Nested Loop ${String(n["Join Type"])} Join` : type.replace(/ Join$/, ` ${String(n["Join Type"])} Join`);
  }
  if (n["Index Name"]) op += ` using ${String(n["Index Name"])}`;
  const target = n["Relation Name"] ?? n["CTE Name"] ?? n["Function Name"];
  if (target) {
    op += ` on ${String(target)}`;
    if (n.Alias && n.Alias !== target) op += ` ${String(n.Alias)}`;
  } else if (type === "Subquery Scan" && n.Alias) op += ` on ${String(n.Alias)}`;
  return op;
}

function details(n: Raw): string[] {
  return DETAILS.flatMap(([key, label]) => {
    const v = n[key];
    if (v === undefined || v === null || v === "") return [];
    return [`${label}: ${Array.isArray(v) ? v.join(", ") : String(v)}`];
  });
}

function build(n: Raw): PlanNode {
  const children = Array.isArray(n.Plans) ? (n.Plans as Raw[]).map(build) : [];
  const totalCost = Number(n["Total Cost"] ?? 0);
  // A Limit stops its child early, so a child can cost more than its parent: the parent's own cost is then nothing.
  const selfCost = Math.max(0, totalCost - children.reduce((s, c) => s + c.totalCost, 0));
  return {
    op: opName(n),
    detail: details(n),
    startupCost: Number(n["Startup Cost"] ?? 0),
    totalCost,
    rows: Number(n["Plan Rows"] ?? 0),
    selfCost,
    share: 0,
    hot: false,
    children,
  };
}

/** A node is hot when it alone is at least this share of the plan's cost. */
const HOT_SHARE = 0.3;

/** EXPLAIN (FORMAT JSON)'s answer as a tree, each node with its share of the cost and the costliest one marked. */
export function parsePlan(json: unknown): Plan {
  const top = (Array.isArray(json) ? json[0] : json) as Raw | undefined;
  const raw = top?.Plan as Raw | undefined;
  if (!raw || typeof raw !== "object") throw new Error("EXPLAIN did not answer with a plan.");
  const root = build(raw);
  const all: PlanNode[] = [];
  const walk = (n: PlanNode) => (all.push(n), n.children.forEach(walk));
  walk(root);
  const total = root.totalCost || 1;
  for (const n of all) n.share = Math.min(1, n.selfCost / total);
  const top1 = all.reduce((a, b) => (b.selfCost > a.selfCost ? b : a), root);
  if (top1.share >= HOT_SHARE && root.totalCost > 0) top1.hot = true;
  return { root, totalCost: root.totalCost, rows: root.rows };
}
