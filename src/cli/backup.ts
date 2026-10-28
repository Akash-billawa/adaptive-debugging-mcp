#!/usr/bin/env bun
/**
 * Adaptive Debugging MCP — Backup, Restore, and Retention CLI.
 *
 * Usage:
 *   bun run src/cli/backup.ts backup [--db <path>] [--out <path>] [--dir <path>]
 *   bun run src/cli/backup.ts verify <backup-path>
 *   bun run src/cli/backup.ts restore <backup-path> [--target <path>] [--no-snapshot]
 *   bun run src/cli/backup.ts prune [--db <path>] [--days <n>] [--dry-run]
 */

import { createBackup, verifyBackup, restoreBackup, applyRetention } from "../memory/backup.ts";
import { resolveDbPath } from "../memory/db.ts";

function printHelp(): void {
  console.log(`
Adaptive Debugging MCP — Backup, Restore & Retention CLI

Usage:
  bun run src/cli/backup.ts <command> [options]

Commands:
  backup   Create a point-in-time SQLite snapshot with integrity check and manifest
           Options:
             --db <path>    Source database path (defaults to standard APPDATA path)
             --out <path>   Explicit destination backup file path
             --dir <path>   Destination directory for backup (default: <dbDir>/backups)

  verify   Verify a backup's SQLite integrity, schema version, and SHA-256
           Arguments:
             <backup-path>  Path to backup .db file to verify

  restore  Restore database from verified backup with automatic safety snapshot
           Arguments:
             <backup-path>  Path to backup .db file
           Options:
             --target <path> Target database path to overwrite (defaults to standard DB)
             --no-snapshot   Skip creating a pre-restore safety snapshot of the target DB

  prune    Apply retention policy to purge transient observations/evidence
           Options:
             --db <path>    Database path
             --days <n>     Retention threshold in days (default: 30)
             --dry-run      Report candidates without deleting
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || hasFlag(args, "--help") || hasFlag(args, "-h") || command === "help") {
    printHelp();
    process.exit(0);
  }

  try {
    if (command === "backup") {
      const dbPath = getArg(args, "--db");
      const outPath = getArg(args, "--out");
      const backupDir = getArg(args, "--dir");

      console.log(`Creating backup of database: ${resolveDbPath(dbPath)}...`);
      const res = createBackup({ dbPath, outPath, backupDir });
      console.log(`\n✓ Backup created successfully!`);
      console.log(`  File:     ${res.backup_path}`);
      console.log(`  Manifest: ${res.manifest_path}`);
      console.log(`  Size:     ${(res.file_size_bytes / 1024).toFixed(1)} KB`);
      console.log(`  SHA-256:  ${res.sha256}`);
      console.log(`  Schema:   v${res.schema_version}`);
      console.log(`  Counts:   ${JSON.stringify(res.counts)}`);
      process.exit(0);
    }

    if (command === "verify") {
      const backupPath = args[1];
      if (!backupPath || backupPath.startsWith("-")) {
        console.error("Error: Path to backup file required: bun run src/cli/backup.ts verify <backup-path>");
        process.exit(1);
      }

      console.log(`Verifying backup: ${backupPath}...`);
      const res = verifyBackup(backupPath);
      if (res.ok) {
        console.log(`\n✓ Backup is VALID!`);
        console.log(`  Integrity: ${res.integrity_output}`);
        console.log(`  Schema:    v${res.schema_version}`);
        console.log(`  SHA-256:   ${res.sha256}`);
        console.log(`  Manifest:  ${res.manifest_found ? (res.manifest_matched ? "MATCHED" : "MISMATCH") : "Not found"}`);
        console.log(`  Counts:    ${JSON.stringify(res.counts)}`);
        process.exit(0);
      } else {
        const reason = res.valid && res.manifest_matched === false
          ? "Manifest SHA-256 mismatch (tampered or mismatched backup)"
          : `Integrity: ${res.integrity_output}`;
        console.error(`\n✗ Backup verification FAILED! ${reason}`);
        process.exit(1);
      }
    }

    if (command === "restore") {
      const backupPath = args[1];
      if (!backupPath || backupPath.startsWith("-")) {
        console.error("Error: Path to backup file required: bun run src/cli/backup.ts restore <backup-path>");
        process.exit(1);
      }

      const targetDbPath = getArg(args, "--target");
      const noSnapshot = hasFlag(args, "--no-snapshot");

      console.log(`Restoring database from: ${backupPath}...`);
      const res = restoreBackup({
        backupPath,
        targetDbPath,
        createSafetySnapshot: !noSnapshot,
      });

      console.log(`\n✓ Database restored successfully!`);
      console.log(`  Target DB:        ${res.target_db_path}`);
      if (res.safety_snapshot_path) {
        console.log(`  Pre-restore copy: ${res.safety_snapshot_path}`);
      }
      console.log(`  Schema:           v${res.schema_version}`);
      console.log(`  Counts:           ${JSON.stringify(res.counts)}`);
      process.exit(0);
    }

    if (command === "prune") {
      const dbPath = getArg(args, "--db");
      const daysArg = getArg(args, "--days");
      const olderThanDays = daysArg ? parseInt(daysArg, 10) : 30;
      const dryRun = hasFlag(args, "--dry-run");

      console.log(`Evaluating retention policy (older than ${olderThanDays} days)...`);
      const res = applyRetention({ dbPath, olderThanDays, dryRun });
      console.log(`\n${res.details}`);
      process.exit(0);
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  } catch (err: any) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
