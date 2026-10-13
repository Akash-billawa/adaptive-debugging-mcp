import type { Store } from "../memory/store.ts";
import type { ToolDef, JsonSchema } from "./protocol.ts";

export interface ToolContext {
  store: Store;
  dbPath: string;
  log: (msg: string) => void;
}

export interface Tool {
  def: ToolDef;
  handle(ctx: ToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
}

// --- Small JSON-Schema helpers ---------------------------------------------
type Prop = Record<string, unknown>;

export const str = (description: string, extra: Prop = {}): Prop => ({ type: "string", description, ...extra });
export const num = (description: string, extra: Prop = {}): Prop => ({ type: "number", description, ...extra });
export const bool = (description: string, extra: Prop = {}): Prop => ({ type: "boolean", description, ...extra });
export const arr = (description: string, items: Prop, extra: Prop = {}): Prop => ({ type: "array", description, items, ...extra });
export const objSchema = (description: string, properties: Record<string, Prop>, required: string[] = []): JsonSchema => ({
  type: "object",
  description,
  properties,
  required,
  additionalProperties: false,
});

// --- Arg extraction helpers (defensive; validation errors thrown by callers) --
export function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    // Thrown centrally as VALIDATION_ERROR by helper below.
    throw new ValidationArg(`${key} is required and must be a non-empty string`);
  }
  return v;
}
export function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}
export function optBool(args: Record<string, unknown>, key: string, def = false): boolean {
  const v = args[key];
  return typeof v === "boolean" ? v : def;
}
export function optArr(args: Record<string, unknown>, key: string): unknown[] {
  const v = args[key];
  return Array.isArray(v) ? v : [];
}

// Lightweight internal error for arg validation; mapped to VALIDATION_ERROR by catalog.
export class ValidationArg extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationArg";
  }
}
