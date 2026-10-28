import { describe, expect, it } from "vitest";
import { explainable, parsePlan } from "./plan.ts";

describe("explainable", () => {
  it("takes the statements PREPARE takes, after comments, without trailing semicolons", () => {
    expect(explainable("  SELECT 1;\n ")).toEqual({ sql: "SELECT 1" });
    expect(explainable("-- the order page\n/* slow */ select * from orders where id = $1")).toEqual({
      sql: "-- the order page\n/* slow */ select * from orders where id = $1",
    });
    for (const s of [
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "VALUES (1)",
      "TABLE orders",
      "UPDATE orders SET status = $1 WHERE id = $2",
      "MERGE INTO t USING s ON true WHEN MATCHED THEN DO NOTHING",
    ])
      expect(explainable(s)).toEqual({ sql: s });
  });

  it("refuses anything else before it reaches the database", () => {
    for (const s of [
      "DROP TABLE orders",
      "COMMIT; SELECT 1",
      "SET default_transaction_read_only = off",
      "ANALYZE orders",
      "/* SELECT */ VACUUM",
      "EXPLAIN ANALYZE SELECT 1",
    ])
      expect(explainable(s)).toHaveProperty("error");
    expect(explainable("  -- only a comment")).toEqual({ error: "There is no statement to explain." });
    expect(explainable(`SELECT '${"x".repeat(100_001)}'`)).toHaveProperty("error");
  });
});

describe("parsePlan", () => {
  // EXPLAIN (FORMAT JSON) of the order page's query, cut to what the tree reads.
  const json = [
    {
      Plan: {
        "Node Type": "Limit",
        "Startup Cost": 18412.1,
        "Total Cost": 18421.4,
        "Plan Rows": 20,
        Plans: [
          {
            "Node Type": "Sort",
            "Startup Cost": 18412.1,
            "Total Cost": 18421.4,
            "Plan Rows": 3,
            "Sort Key": ["created_at DESC"],
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Relation Name": "orders",
                Alias: "o",
                "Startup Cost": 0,
                "Total Cost": 18390,
                "Plan Rows": 3,
                Filter: "((customer_id = $1) AND (status = $2))",
              },
            ],
          },
        ],
      },
    },
  ];

  it("names each node as EXPLAIN's text does, with its conditions", () => {
    const { root, totalCost, rows } = parsePlan(json);
    expect(totalCost).toBe(18421.4);
    expect(rows).toBe(20);
    expect(root.op).toBe("Limit");
    expect(root.children[0]!.detail).toEqual(["Sort Key: created_at DESC"]);
    expect(root.children[0]!.children[0]).toMatchObject({ op: "Seq Scan on orders o", detail: ["Filter: ((customer_id = $1) AND (status = $2))"] });
  });

  it("marks the node that costs the most itself", () => {
    const scan = parsePlan(json).root.children[0]!.children[0]!;
    expect(scan.hot).toBe(true);
    expect(scan.share).toBeCloseTo(18390 / 18421.4);
    expect(parsePlan(json).root).toMatchObject({ hot: false, selfCost: 0 });
  });

  it("writes joins, aggregates, index scans and updates the way PostgreSQL does", () => {
    const plan = parsePlan({
      Plan: {
        "Node Type": "ModifyTable",
        Operation: "Update",
        "Relation Name": "orders",
        "Total Cost": 10,
        Plans: [
          {
            "Node Type": "Hash Join",
            "Join Type": "Left",
            "Hash Cond": "(a.id = b.a_id)",
            "Total Cost": 9,
            Plans: [
              { "Node Type": "Index Scan", "Index Name": "orders_pkey", "Relation Name": "orders", Alias: "orders", "Total Cost": 1 },
              { "Node Type": "Aggregate", Strategy: "Hashed", "Group Key": ["a", "b"], "Total Cost": 2 },
            ],
          },
        ],
      },
    });
    const join = plan.root.children[0]!;
    expect(plan.root.op).toBe("Update on orders");
    expect(join.op).toBe("Hash Left Join");
    expect(join.children.map((c) => c.op)).toEqual(["Index Scan using orders_pkey on orders", "HashAggregate"]);
    expect(join.children[1]!.detail).toEqual(["Group Key: a, b"]);
    // The join itself costs 6 of 10.
    expect(join).toMatchObject({ hot: true, selfCost: 6 });
  });

  it("refuses an answer that is not a plan", () => {
    expect(() => parsePlan([{}])).toThrow(/plan/);
  });
});
