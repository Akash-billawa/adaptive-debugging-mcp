import { test, expect, afterAll } from "bun:test";
import { rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDbPath, openStore, closeStore } from "./helpers.ts";
import { createBackup, verifyBackup, restoreBackup, applyRetention } from "../../src/memory/backup.ts";
import { Database } from "bun:sqlite";

const tempPaths: string[] = [];
function getTempPath(suffix = ""): string {
  const p = tempDbPath() + suffix;
  tempPaths.push(p);
  return p;
}

afterAll(() => {
  for (const p of tempPaths) {
    for (const s of ["", "-wal", "-shm", ".manifest.json"]) {
      try { rmSync(p + s, { force: true }); } catch {}
    }
  }
});

test("createBackup and verifyBackup: creates verified snapshot with manifest", () => {
  const dbPath = getTempPath();
  const store = openStore(dbPath);

  // Populate data
  const { incident: inc } = store.createIncident({
    project: { display_name: "BackupTestApp" },
    title: "Crash on startup",
    initial_symptom: "Exit code 1",
    actor: "agent",
  });
  store.createExperiment({
    incident_id: inc.incident_id,
    node_kind: "experiment",
    title: "Check log levels",
    proposed_change: "Enable debug logging",
    expected_observation: "More log output",
    risk_level: "low",
    actor: "agent",
  });
  closeStore(store);

  const backupPath = getTempPath(".bak.db");
  const res = createBackup({ dbPath, outPath: backupPath });

  expect(res.ok).toBe(true);
  expect(existsSync(res.backup_path)).toBe(true);
  expect(existsSync(res.manifest_path)).toBe(true);
  expect(res.counts.incidents).toBe(1);
  expect(res.counts.experiments).toBe(1);
  expect(res.sha256.length).toBe(64);

  // Verify backup
  const v = verifyBackup(backupPath);
  expect(v.ok).toBe(true);
  expect(v.valid).toBe(true);
  expect(v.manifest_found).toBe(true);
  expect(v.manifest_matched).toBe(true);
  expect(v.counts.incidents).toBe(1);
});

test("verifyBackup: detects invalid or corrupted database files", () => {
  const corruptPath = getTempPath(".corrupt.db");
  writeFileSync(corruptPath, "not a valid sqlite header content", "utf8");

  const v = verifyBackup(corruptPath);
  expect(v.valid).toBe(false);
  expect(v.ok).toBe(false);
});

test("restoreBackup: restores database state and creates safety snapshot", () => {
  const originalDbPath = getTempPath(".orig.db");
  const store = openStore(originalDbPath);

  const { incident: inc } = store.createIncident({
    project: { display_name: "OriginalApp" },
    title: "Memory leak in worker",
    initial_symptom: "OOM killer invoked",
    actor: "agent",
  });
  closeStore(store);

  // Take backup
  const backupPath = getTempPath(".restore-source.bak.db");
  createBackup({ dbPath: originalDbPath, outPath: backupPath });

  // Target database starts with different data
  const targetDbPath = getTempPath(".target.db");
  const targetStore = openStore(targetDbPath);
  targetStore.createIncident({
    project: { display_name: "StaleApp" },
    title: "Old issue",
    initial_symptom: "Stale symptom",
    actor: "agent",
  });
  closeStore(targetStore);

  // Perform restore
  const restoreRes = restoreBackup({
    backupPath,
    targetDbPath,
    createSafetySnapshot: true,
  });

  expect(restoreRes.ok).toBe(true);
  expect(restoreRes.safety_snapshot_path).not.toBeNull();
  expect(existsSync(restoreRes.safety_snapshot_path!)).toBe(true);
  tempPaths.push(restoreRes.safety_snapshot_path!);

  // Verify restored target has the backup's data
  const restoredStore = openStore(targetDbPath);
  const restoredInc = restoredStore.getIncident(inc.incident_id);
  expect(restoredInc).not.toBeNull();
  expect(restoredInc?.title).toBe("Memory leak in worker");
  closeStore(restoredStore);
});

test("applyRetention: supports dry-run and removes expired transient evidence", () => {
  const dbPath = getTempPath(".retention.db");
  const store = openStore(dbPath);

  const { incident: inc } = store.createIncident({
    project: { display_name: "RetentionApp" },
    title: "Retention test case",
    initial_symptom: "Test symptom",
    actor: "agent",
  });

  // Insert old transient evidence directly into db
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  store.db.run(
    `INSERT INTO evidence (
      evidence_id, project_id, incident_id, evidence_type, storage_reference,
      capture_source, capture_complete, redaction_status, retention_class, captured_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'no_secret_detected', 'transient', ?, ?)`,
    ["ev_old_transient", inc.project_id, inc.incident_id, "terminal_output", "ref1", "agent", oldDate, oldDate],
  );

  // Insert recent transient evidence
  const recentDate = new Date().toISOString();
  store.db.run(
    `INSERT INTO evidence (
      evidence_id, project_id, incident_id, evidence_type, storage_reference,
      capture_source, capture_complete, redaction_status, retention_class, captured_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'no_secret_detected', 'transient', ?, ?)`,
    ["ev_recent_transient", inc.project_id, inc.incident_id, "terminal_output", "ref2", "agent", recentDate, recentDate],
  );

  // Insert old unlinked plugin observation
  store.db.run(
    `INSERT INTO plugin_observations (
      observation_id, event_key, kind, capture_complete, redaction_status, captured_at
    ) VALUES (?, ?, 'tool_call', 1, 'not_checked', ?)`,
    ["obs_old_unlinked", "key_old", oldDate],
  );

  closeStore(store);

  // 1. Dry run (should detect 1 old obs and 1 old evidence, but delete 0)
  const dryRes = applyRetention({ dbPath, olderThanDays: 30, dryRun: true });
  expect(dryRes.dry_run).toBe(true);
  expect(dryRes.pruned_counts.plugin_observations).toBe(1);
  expect(dryRes.pruned_counts.transient_evidence).toBe(1);

  const checkDb1 = new Database(dbPath);
  const evCountBefore = (checkDb1.query("SELECT COUNT(*) as c FROM evidence").get() as any).c;
  expect(evCountBefore).toBe(2);
  checkDb1.close();

  // 2. Real prune
  const pruneRes = applyRetention({ dbPath, olderThanDays: 30, dryRun: false });
  expect(pruneRes.dry_run).toBe(false);
  expect(pruneRes.pruned_counts.plugin_observations).toBe(1);
  expect(pruneRes.pruned_counts.transient_evidence).toBe(1);

  const checkDb2 = new Database(dbPath);
  const evCountAfter = (checkDb2.query("SELECT COUNT(*) as c FROM evidence").get() as any).c;
  expect(evCountAfter).toBe(1); // only recent one remains
  const remainingEv = checkDb2.query("SELECT evidence_id FROM evidence").get() as any;
  expect(remainingEv.evidence_id).toBe("ev_recent_transient");
  checkDb2.close();
});

test("CLI: executes backup, verify, and prune subcommands successfully", async () => {
  const dbPath = getTempPath(".cli-test.db");
  const store = openStore(dbPath);
  store.createIncident({
    project: { display_name: "CliApp" },
    title: "CLI test incident",
    initial_symptom: "Test symptom",
    actor: "agent",
  });
  closeStore(store);

  const backupPath = getTempPath(".cli-backup.bak.db");

  // 1. CLI backup
  const backupProc = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/backup.ts", "backup", "--db", dbPath, "--out", backupPath],
    cwd: join(import.meta.dir, "..", ".."),
  });
  expect(backupProc.exitCode).toBe(0);
  expect(backupProc.stdout.toString()).toContain("Backup created successfully");

  // 2. CLI verify
  const verifyProc = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/backup.ts", "verify", backupPath],
    cwd: join(import.meta.dir, "..", ".."),
  });
  expect(verifyProc.exitCode).toBe(0);
  expect(verifyProc.stdout.toString()).toContain("Backup is VALID");

  // 3. CLI prune dry-run
  const pruneProc = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/backup.ts", "prune", "--db", dbPath, "--dry-run"],
    cwd: join(import.meta.dir, "..", ".."),
  });
  expect(pruneProc.exitCode).toBe(0);
  expect(pruneProc.stdout.toString()).toContain("[Dry Run]");
});

test("createBackup rejects outPath === dbPath without corrupting or truncating database", () => {
  const dbPath = getTempPath(".self-backup.db");
  const store = openStore(dbPath);
  const inc = store.createIncident({
    project: { display_name: "SelfBackupApp" },
    title: "Critical data",
    initial_symptom: "Test symptom",
    actor: "agent",
  }).incident;
  closeStore(store);

  let err: any;
  try {
    createBackup({ dbPath, outPath: dbPath });
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.message).toContain("Cannot backup database to itself");

  // Database must still exist and be intact
  const storeCheck = openStore(dbPath);
  const fetched = storeCheck.getIncident(inc.incident_id);
  expect(fetched).not.toBeNull();
  expect(fetched?.title).toBe("Critical data");
  closeStore(storeCheck);
});

test("restoreBackup rejects tampered backup when manifest SHA mismatches", () => {
  const origDb = getTempPath(".tamper-orig.db");
  const store = openStore(origDb);
  store.createIncident({
    project: { display_name: "OrigApp" },
    title: "Original",
    initial_symptom: "Symptom",
    actor: "agent",
  });
  closeStore(store);

  const backupPath = getTempPath(".tamper.bak.db");
  createBackup({ dbPath: origDb, outPath: backupPath });

  // Tamper with manifest file
  const manifestPath = `${backupPath}.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const v = verifyBackup(backupPath);
  expect(v.valid).toBe(true);
  expect(v.manifest_matched).toBe(false);
  expect(v.ok).toBe(false);

  const targetDb = getTempPath(".tamper-target.db");
  let restoreErr: any;
  try {
    restoreBackup({ backupPath, targetDbPath: targetDb });
  } catch (e) {
    restoreErr = e;
  }
  expect(restoreErr).toBeDefined();
  expect(restoreErr.message).toContain("mismatched manifest SHA-256");
});

test("restoreBackup captures uncheckpointed WAL in safety snapshot via VACUUM INTO", () => {
  const origDb = getTempPath(".wal-orig.db");
  const origStore = openStore(origDb);
  origStore.createIncident({
    project: { display_name: "RestoreSourceApp" },
    title: "Restored from backup",
    initial_symptom: "Symptom",
    actor: "agent",
  });
  closeStore(origStore);

  const backupPath = getTempPath(".wal-backup.bak.db");
  createBackup({ dbPath: origDb, outPath: backupPath });

  // Create target DB with WAL data
  const targetDb = getTempPath(".wal-target.db");
  const targetStore = openStore(targetDb);
  targetStore.createIncident({ project: { display_name: "App1" }, title: "Target Inc 1", initial_symptom: "S1", actor: "agent" });
  targetStore.createIncident({ project: { display_name: "App2" }, title: "Target Inc 2", initial_symptom: "S2", actor: "agent" });
  targetStore.createIncident({ project: { display_name: "App3" }, title: "Target Inc 3", initial_symptom: "S3", actor: "agent" });
  closeStore(targetStore);

  const res = restoreBackup({
    backupPath,
    targetDbPath: targetDb,
    createSafetySnapshot: true,
  });

  expect(res.ok).toBe(true);
  expect(res.safety_snapshot_path).toBeDefined();
  tempPaths.push(res.safety_snapshot_path!);

  // Inspect the safety snapshot database: all 3 target incidents must exist
  const snapshotDb = new Database(res.safety_snapshot_path!, { readonly: true });
  const countRow = snapshotDb.query("SELECT COUNT(*) as c FROM incidents").get() as any;
  expect(countRow.c).toBe(3);
  snapshotDb.close();

  // Restored target DB now has the 1 backup incident
  const restoredDb = new Database(targetDb, { readonly: true });
  const restoredCount = restoredDb.query("SELECT COUNT(*) as c FROM incidents").get() as any;
  expect(restoredCount.c).toBe(1);
  restoredDb.close();
});

test("restoreBackup refuses to corrupt or modify target DB if locked by another process", () => {
  const origDb = getTempPath(".lock-orig.db");
  const origStore = openStore(origDb);
  origStore.createIncident({
    project: { display_name: "LockSourceApp" },
    title: "Source Inc",
    initial_symptom: "Symptom",
    actor: "agent",
  });
  closeStore(origStore);

  const backupPath = getTempPath(".lock-backup.bak.db");
  createBackup({ dbPath: origDb, outPath: backupPath });

  const targetDb = getTempPath(".lock-target.db");
  const targetStore = openStore(targetDb);
  targetStore.createIncident({ project: { display_name: "LockTargetApp" }, title: "Live incident", initial_symptom: "Live symptom", actor: "agent" });
  closeStore(targetStore);

  // Hold exclusive lock on targetDb
  const lockConn = new Database(targetDb);
  lockConn.run("BEGIN EXCLUSIVE;");

  let restoreErr: any;
  try {
    restoreBackup({
      backupPath,
      targetDbPath: targetDb,
    });
  } catch (e) {
    restoreErr = e;
  }
  expect(restoreErr).toBeDefined();
  expect(restoreErr.message).toContain("database is active or locked");

  // Release lock
  lockConn.run("ROLLBACK;");
  lockConn.close();

  // Verify targetDb is completely intact and not malformed
  const checkStore = openStore(targetDb);
  const incs = checkStore.listIncidents();
  expect(incs.length).toBe(1);
  expect(incs[0].title).toBe("Live incident");
  closeStore(checkStore);
});

test("applyRetention deletes orphaned evidence_content rows", () => {
  const dbPath = getTempPath(".retention-content.db");
  const store = openStore(dbPath);

  const { incident: inc } = store.createIncident({
    project: { display_name: "RetentionContentApp" },
    title: "Retention content test",
    initial_symptom: "Symptom",
    actor: "agent",
  });

  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  store.db.run(
    `INSERT INTO evidence (
      evidence_id, project_id, incident_id, evidence_type, storage_reference,
      capture_source, capture_complete, redaction_status, retention_class, captured_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'no_secret_detected', 'transient', ?, ?)`,
    ["ev_transient_with_content", inc.project_id, inc.incident_id, "terminal_output", "ref_content", "agent", oldDate, oldDate],
  );
  store.db.run(
    `INSERT INTO evidence_content (
      evidence_id, content, truncated, original_size_bytes
    ) VALUES (?, ?, 0, 1250)`,
    ["ev_transient_with_content", "Large content that would previously be orphaned for 1250 bytes"],
  );
  closeStore(store);

  // Check evidence_content row exists before retention
  const checkDbBefore = new Database(dbPath);
  const contentBefore = checkDbBefore.query("SELECT COUNT(*) as c FROM evidence_content WHERE evidence_id = 'ev_transient_with_content'").get() as any;
  expect(contentBefore.c).toBe(1);
  checkDbBefore.close();

  // Run retention
  const res = applyRetention({ dbPath, olderThanDays: 30, dryRun: false });
  expect(res.pruned_counts.transient_evidence).toBe(1);

  // Check evidence_content row was deleted along with evidence
  const checkDbAfter = new Database(dbPath);
  const contentAfter = checkDbAfter.query("SELECT COUNT(*) as c FROM evidence_content WHERE evidence_id = 'ev_transient_with_content'").get() as any;
  expect(contentAfter.c).toBe(0);
  const evAfter = checkDbAfter.query("SELECT COUNT(*) as c FROM evidence WHERE evidence_id = 'ev_transient_with_content'").get() as any;
  expect(evAfter.c).toBe(0);
  checkDbAfter.close();
});
