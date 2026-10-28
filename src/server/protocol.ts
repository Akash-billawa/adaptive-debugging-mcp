/**
 * MCP JSON-RPC 2.0 protocol handling over stdio.
 *
 * A deliberately dependency-free implementation of the MCP server surface:
 * initialize handshake, ping, tools/list, tools/call (plus empty resource/prompt
 * capability advertisement). Protocol-level faults return JSON-RPC errors; tool
 * business errors return isError results with a structured error object.
 */

export const SERVER_NAME = "adaptive-debugging-mcp";
export const SERVER_VERSION = "0.1.0";

// Protocol versions this server can speak, newest first. We echo the client's
// requested version when supported, otherwise fall back to our newest.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  [k: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface PromptArgumentDef {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  description?: string;
  arguments?: PromptArgumentDef[];
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
  _meta?: Record<string, unknown>;
}

export interface ToolCatalog {
  list(): ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  listResources?(): ResourceDef[];
  listResourceTemplates?(): ResourceTemplateDef[];
  readResource?(uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> | { contents: Array<{ uri: string; mimeType: string; text: string }> };
  listPrompts?(): PromptDef[];
  getPrompt?(name: string, args: Record<string, string>): Promise<{ description?: string; messages: Array<{ role: string; content: { type: string; text: string } }> }> | { description?: string; messages: Array<{ role: string; content: { type: string; text: string } }> };
}

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: unknown;
}
interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function ok(id: number | string | null, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: number | string | null, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/** Handle a single parsed JSON value. Returns a response or null (for notifications). */
export async function handleMessage(
  catalog: ToolCatalog,
  msg: unknown,
): Promise<RpcResponse | null> {
  if (typeof msg !== "object" || msg === null) {
    return err(null, INVALID_REQUEST, "Expected a JSON-RPC object");
  }
  const req = msg as RpcRequest;
  const id = req.id ?? null;

  // Notifications have no id and expect no response.
  const isNotification = req.id === undefined || req.id === null;

  switch (req.method) {
    case "initialize": {
      const params = (req.params ?? {}) as { protocolVersion?: string };
      const version = SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion ?? "")
        ? params.protocolVersion!
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case "notifications/initialized":
    case "initialized":
      return null; // notification, ack

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: catalog.list() });

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!params.name) return err(id, INVALID_PARAMS, "tools/call requires a tool name");
      try {
        const result = await catalog.call(params.name, params.arguments ?? {});
        return ok(id, result);
      } catch (e: any) {
        if (
          e?.name === "UnknownToolError" ||
          (e?.category === "NOT_FOUND" && typeof e?.message === "string" && e.message.startsWith("Unknown tool"))
        ) {
          return err(id, METHOD_NOT_FOUND, e.message ?? `Unknown tool: ${params.name}`);
        }
        const r = e as { category?: string; message?: string; details?: unknown };
        const result: ToolResult = {
          content: [{ type: "text", text: `Error: ${r.message ?? "unknown error"}` }],
          structuredContent: { ok: false, error: { category: r.category ?? "INTERNAL_ERROR", message: r.message ?? String(e), details: r.details ?? {} } },
          isError: true,
          _meta: { category: r.category ?? "INTERNAL_ERROR" },
        };
        return ok(id, result);
      }
    }

    case "resources/list":
      return ok(id, { resources: catalog.listResources ? catalog.listResources() : [] });

    case "resources/templates/list":
      return ok(id, { resourceTemplates: catalog.listResourceTemplates ? catalog.listResourceTemplates() : [] });

    case "resources/read": {
      const params = (req.params ?? {}) as { uri?: string };
      if (!params.uri) return err(id, INVALID_PARAMS, "resources/read requires a 'uri' parameter");
      if (!catalog.readResource) return err(id, METHOD_NOT_FOUND, "resources are not supported");
      try {
        const result = await catalog.readResource(params.uri);
        return ok(id, result);
      } catch (e: any) {
        return err(id, -32002, e.message ?? "Resource not found", { uri: params.uri });
      }
    }

    case "prompts/list":
      return ok(id, { prompts: catalog.listPrompts ? catalog.listPrompts() : [] });

    case "prompts/get": {
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, string> };
      if (!params.name) return err(id, INVALID_PARAMS, "prompts/get requires a 'name' parameter");
      if (!catalog.getPrompt) return err(id, METHOD_NOT_FOUND, "prompts are not supported");
      try {
        const result = await catalog.getPrompt(params.name, params.arguments ?? {});
        return ok(id, result);
      } catch (e: any) {
        return err(id, -32002, e.message ?? "Prompt error", { name: params.name });
      }
    }

    default:
      if (isNotification) return null; // unknown notifications are ignored
      return err(id, METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
}
