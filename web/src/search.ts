// What the search window (Cmd+K) finds in Database: instances by their name and host. They are read whole and
// filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Server } from "lucide-react";
import type { Instance } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const { instances } = await call<{ instances: Instance[] }>("/api/v1/instances", { signal });
    return instances
      .filter((i) => `${i.name} ${i.host}`.toLowerCase().includes(q))
      .slice(0, 8)
      .map((i): SearchResult => ({
        id: `instance:${i.id}`,
        label: i.name,
        detail: `${i.host}:${i.port}`,
        kind: t("search.instance"),
        icon: Server,
        severity: i.status && !i.status.ok ? "high" : undefined,
        href: `/overview?instance=${i.id}`,
      }));
  };
}
