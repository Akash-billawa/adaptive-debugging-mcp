import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, optStr, reqStr, optArr, arr } from "../context.ts";
import { listTimeline } from "../../memory/audit.ts";

export const treeTools: Tool[] = [
  {
    def: {
      name: "debug_tree_read",
      description:
        "Read an incident's strategy/experiment tree (or a subtree), preserving parent-child relationships. " +
        "Discloses pagination/depth truncation and never makes a partially-read tree look complete.",
      inputSchema: objSchema(
        "Read the experiment tree",
        {
          incident_id: str("Incident id"),
          root_experiment_id: str("Read only this subtree"),
          max_depth: { type: "number", description: "Max depth to expand", default: 8 },
        },
        ["incident_id"],
      ),
    },
    handle(ctx, args) {
      const incident_id = reqStr(args, "incident_id");
      ctx.store.getIncidentOrFail(incident_id);
      const rootId = optStr(args, "root_experiment_id") ?? null;
      const maxDepth = Math.max(1, Math.min(100, Number(args.max_depth ?? 8)));
      const tree = ctx.store.buildTree(incident_id, rootId, maxDepth);

      const flat = flatten(tree.nodes);
      const byOutcome: Record<string, number> = {};
      const incomplete: string[] = [];
      for (const n of flat) {
        byOutcome[n.outcome_status] = (byOutcome[n.outcome_status] ?? 0) + 1;
        if (n.outcome_status === "pending" || n.outcome_status === "inconclusive") incomplete.push(n.label ?? n.experiment_id);
      }
      const truncated = flat.some((n) => n.truncated);

      return {
        ok: true,
        incident_id,
        tree: tree.nodes,
        total_nodes: tree.total,
        counts_by_outcome: byOutcome,
        incomplete_outcomes: incomplete,
        truncated,
        warnings: truncated ? ["depth_or_pagination_truncated"] : rootId ? ["subtree_only"] : [],
      };
    },
  },

  {
    def: {
      name: "debug_timeline_read",
      description:
        "Read the append-only audit timeline for an incident across attempts and sessions.",
      inputSchema: objSchema(
        "Read the timeline",
        {
          incident_id: str("Incident id"),
          limit: { type: "number", description: "Max events", default: 100 },
          event_types: arr("Only these event types", str("event type")),
        },
        ["incident_id"],
      ),
    },
    handle(ctx, args) {
      const incident_id = reqStr(args, "incident_id");
      ctx.store.getIncidentOrFail(incident_id);
      const limit = Math.max(1, Math.min(500, Number(args.limit ?? 100)));
      const types = new Set(optArr(args, "event_types").map(String));
      let events = listTimeline(ctx.store.db, incident_id);
      if (types.size > 0) events = events.filter((e) => types.has(e.event_type));
      return { ok: true, incident_id, events: events.slice(-limit), returned: Math.min(events.length, limit), warnings: [] };
    },
  },
];

interface FlatNode {
  experiment_id: string;
  label: string | null;
  outcome_status: string;
  truncated: boolean;
}
function flatten(nodes: any[]): FlatNode[] {
  const out: FlatNode[] = [];
  for (const n of nodes) {
    out.push({ experiment_id: n.experiment_id, label: n.label, outcome_status: n.outcome_status, truncated: n.truncated });
    if (n.children?.length) out.push(...flatten(n.children));
  }
  return out;
}
