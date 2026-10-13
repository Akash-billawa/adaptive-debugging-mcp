#!/usr/bin/env bun
/**
 * Adaptive Debugging Intelligence MCP server entry point.
 *
 * Launched by OpenCode as a local stdio MCP server. All logs go to stderr.
 *
 * Env / args:
 *   ADAPTIVE_DEBUG_DB_PATH  Absolute path to the SQLite database (recommended for OpenCode).
 *   --db <path>             Override the database path on the command line.
 */
import { openDatabase } from "../memory/db.ts";
import { Store } from "../memory/store.ts";
import { buildCatalog } from "./catalog.ts";
import { startStdioServer } from "./transport.ts";
import { SERVER_NAME, SERVER_VERSION } from "./protocol.ts";

function logToStderr(msg: string): void {
  process.stderr.write(`[${SERVER_NAME} ${SERVER_VERSION}] ${msg}\n`);
}

function parseDbArg(): string | undefined {
  const i = process.argv.indexOf("--db");
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

async function main(): Promise<void> {
  const dbPath = parseDbArg() ?? process.env.ADAPTIVE_DEBUG_DB_PATH;
  let store: Store;
  let resolvedPath: string;
  try {
    const opened = openDatabase(dbPath);
    store = new Store(opened.db);
    resolvedPath = opened.path;
  } catch (e) {
    logToStderr(`FATAL: could not open database (${dbPath ?? "default"}): ${e instanceof Error ? e.message : String(e)}`);
    logToStderr("Memory is unavailable. Do NOT assume no history exists.");
    process.exit(1);
    return;
  }

  const catalog = buildCatalog({
    store,
    dbPath: resolvedPath,
    log: logToStderr,
  });

  logToStderr(`database ready at ${resolvedPath}`);
  await startStdioServer(catalog, logToStderr);

  // Clean shutdown when the transport ends.
  try {
    store.db.close();
  } catch {
    /* ignore */
  }
}

void main();
