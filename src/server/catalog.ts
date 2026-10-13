import type { Tool, ToolContext } from "./context.ts";
import type { ToolCatalog, ToolResult, ToolDef } from "./protocol.ts";
import { ValidationArg } from "./context.ts";
import { validationError, McpError } from "../errors.ts";
import { caseTools } from "./tools/caseTools.ts";
import { searchTools } from "./tools/searchTools.ts";
import { planTools } from "./tools/planTools.ts";
import { attemptTools } from "./tools/attemptTools.ts";
import { evidenceTools } from "./tools/evidenceTools.ts";
import { treeTools } from "./tools/treeTools.ts";
import { validationTools } from "./tools/validationTools.ts";
import { metaTools } from "./tools/metaTools.ts";
import { budgetTools } from "./tools/budgetTools.ts";
import { nextActionTools } from "./tools/nextActionTools.ts";

/** All server tools, in a stable, grouped order. */
export const ALL_TOOLS: Tool[] = [
  ...caseTools,
  ...searchTools,
  ...planTools,
  ...attemptTools,
  ...evidenceTools,
  ...treeTools,
  ...validationTools,
  ...metaTools,
  ...budgetTools,
  ...nextActionTools,
];

/** Build a callable catalog bound to a context (store, db path, logger). */
export function buildCatalog(ctx: ToolContext): ToolCatalog {
  const byName = new Map<string, Tool>();
  for (const t of ALL_TOOLS) byName.set(t.def.name, t);

  return {
    list(): ToolDef[] {
      return ALL_TOOLS.map((t) => t.def);
    },
    async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const tool = byName.get(name);
      if (!tool) {
        throw new McpErrorNotDefined(name);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await tool.handle(ctx, args);
      } catch (e) {
        if (e instanceof ValidationArg) throw validationError(e.message);
        throw e;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      };
    },
  };
}

class McpErrorNotDefined extends McpError {
  constructor(name: string) {
    // Category 404-style; surfaced as -32601 by protocol via NOT_FOUND mapping is not used here —
    // the protocol treats thrown tool errors as isError results.
    super("NOT_FOUND" as any, `Unknown tool: ${name}`);
    this.name = "UnknownToolError";
  }
}
