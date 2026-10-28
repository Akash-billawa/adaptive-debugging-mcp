#!/usr/bin/env bun
/**
 * Adaptive Debugging MCP — Cross-Project Visual Retrieval UI & Export Dashboard CLI.
 *
 * Usage:
 *   bun run src/cli/dashboard.ts [--out <path>] [--project <id>] [--incident <id>] [--open]
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { openDatabase, resolveDbPath } from "../memory/db.ts";
import { Store } from "../memory/store.ts";
import { generateDashboardHtml } from "../dashboard/generator.ts";

function printHelp(): void {
  console.log(`
Adaptive Debugging MCP — Visual Retrieval & Dashboard CLI

Usage:
  bun run src/cli/dashboard.ts [options]

Options:
  --db <path>        Path to SQLite database (default: system ADIM database)
  --out <path>       Output HTML destination path (default: ./adim-dashboard.html)
  --project <id>     Filter dashboard to a specific project_id
  --incident <id>    Focus dashboard on a specific incident_id
  --title <text>     Custom title for the dashboard report
  --open             Automatically open the generated dashboard in your default browser
  --help, -h         Show this help message
`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function openInBrowser(filePath: string): void {
  const absPath = resolve(filePath);
  const platform = process.platform;

  let child;
  if (platform === "win32") {
    child = spawn("cmd.exe", ["/c", "start", "", absPath], { detached: true, stdio: "ignore" });
  } else if (platform === "darwin") {
    child = spawn("open", [absPath], { detached: true, stdio: "ignore" });
  } else {
    child = spawn("xdg-open", [absPath], { detached: true, stdio: "ignore" });
  }

  child.on("error", (err) => {
    console.warn(`[WARN] Could not automatically open browser: ${err.message}`);
  });
  child.unref();
  console.log(`[INFO] Dashboard opened in browser.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printHelp();
    process.exit(0);
  }

  const dbPath = getArg(args, "--db") || resolveDbPath();
  const outPath = getArg(args, "--out") || "./adim-dashboard.html";
  const projectId = getArg(args, "--project");
  const incidentId = getArg(args, "--incident");
  const title = getArg(args, "--title");
  const shouldOpen = hasFlag(args, "--open");

  console.log(`[INFO] Connecting to ADIM database: ${dbPath}`);
  const { db } = openDatabase(dbPath);
  const store = new Store(db);

  try {
    console.log(`[INFO] Generating standalone visual dashboard...`);
    const html = generateDashboardHtml(store, {
      projectId,
      incidentId,
      title,
    });

    const resolvedOut = resolve(outPath);
    mkdirSync(dirname(resolvedOut), { recursive: true });
    writeFileSync(resolvedOut, html, "utf-8");
    console.log(`[SUCCESS] Interactive dashboard written to: ${resolvedOut} (${(html.length / 1024).toFixed(1)} KB)`);

    if (shouldOpen) {
      openInBrowser(resolvedOut);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[ERROR] Dashboard generation failed: ${err.message}`);
    process.exit(1);
  });
}
