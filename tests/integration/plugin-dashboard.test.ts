import { test, expect, describe } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PluginDefault, { associateObservation, setActiveIncident } from "../../plugin/index.ts";
import { openDatabase } from "../../src/memory/db.ts";
import { Store } from "../../src/memory/store.ts";
import { generateDashboardHtml } from "../../src/dashboard/generator.ts";

describe("Plugin and Dashboard Fixes (Issue 7)", () => {
  test("plugin does not drop repeated identical commands and assigns distinct call ids", async () => {
    const dbPath = join(tmpdir(), `admcp-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
    process.env.ADAPTIVE_DEBUG_DB_PATH = dbPath;

    const Plugin = PluginDefault as any;
    const toolHooks: Array<[string, (event: any) => Promise<any>]> = [];
    const mockCtx = {
      tool: {
        hook: async (name: string, cb: any) => {
          toolHooks.push([name, cb]);
          return { dispose: async () => {} };
        },
      },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {},
        }),
      },
    };

    const cleanup = await Plugin.setup(mockCtx);
    const before = toolHooks.find(([n]) => n === "execute.before")?.[1]!;
    const after = toolHooks.find(([n]) => n === "execute.after")?.[1]!;

    expect(before).toBeDefined();
    expect(after).toBeDefined();

    try {
      // Execute "bun test" 3 times in succession
      for (let i = 1; i <= 3; i++) {
        await before({ tool: "bash", input: { command: "bun test" }, sessionID: "ses_1" });
        await after({
          tool: "bash",
          input: { command: "bun test" },
          status: "completed",
          result: { output: `run ${i}: 15 passed` },
          sessionID: "ses_1",
        });
      }

      const { db } = openDatabase(dbPath);
      const store = new Store(db);
      try {
        const obs = store.listObservations({ limit: 50 });
        const beforeCalls = obs.filter((o) => o.kind === "tool.execute.before" && o.tool === "bash");
        const afterCalls = obs.filter((o) => o.kind === "tool.execute.after" && o.tool === "bash");

        // All 3 executions must be recorded (not dropped as duplicate)
        expect(beforeCalls.length).toBe(3);
        expect(afterCalls.length).toBe(3);

        // All 3 event keys must be distinct
        const beforeKeys = new Set(beforeCalls.map((c) => c.event_key));
        const afterKeys = new Set(afterCalls.map((c) => c.event_key));
        expect(beforeKeys.size).toBe(3);
        expect(afterKeys.size).toBe(3);
      } finally {
        db.close();
      }
    } finally {
      if (typeof cleanup === "function") cleanup();
      for (const s of ["", "-wal", "-shm"]) {
        try { rmSync(dbPath + s, { force: true }); } catch {}
      }
    }
  });

  test("observation association links observations to incident and validates target incident", async () => {
    const dbPath = join(tmpdir(), `admcp-obs-assoc-${Date.now()}.db`);
    process.env.ADAPTIVE_DEBUG_DB_PATH = dbPath;

    const { db } = openDatabase(dbPath);
    const store = new Store(db);

    try {
      const inc = store.createIncident({
        project: { display_name: "Assoc Project", project_id: "prj_assoc" },
        title: "Assoc Test Incident",
        initial_symptom: "Network timeout in worker",
        actor: "agent",
      }).incident;

      const exp = store.createExperiment({
        incident_id: inc.incident_id,
        node_kind: "experiment",
        title: "Probe worker connection",
        proposed_change: "ping worker.internal",
        actor: "agent",
      }).experiment;

      // 1. Record an unassociated observation
      const obsRes = store.recordObservation({
        event_key: "test:obs:1",
        kind: "tool.execute.after",
        tool: "bash",
        args_summary: "ping worker.internal",
        output_summary: "64 bytes from worker.internal",
        status: "completed",
      });

      expect(obsRes.duplicate).toBe(false);

      // 2. Associate it using store.associateObservation
      store.associateObservation(obsRes.observation_id, inc.incident_id, exp.experiment_id);

      const rows = store.listObservations({ incident_id: inc.incident_id });
      expect(rows.length).toBe(1);
      expect(rows[0].observation_id).toBe(obsRes.observation_id);
      expect(rows[0].incident_id).toBe(inc.incident_id);
      expect(rows[0].experiment_id).toBe(exp.experiment_id);

      // 3. Associating with nonexistent incident throws notFound
      expect(() => {
        store.associateObservation(obsRes.observation_id, "inc_nonexistent_xyz");
      }).toThrow(/incident not found/);

      // 4. Test associateObservation exported from plugin
      const obsRes2 = store.recordObservation({
        event_key: "test:obs:2",
        kind: "tool.execute.after",
        tool: "bash",
        output_summary: "worker ready",
      });
      associateObservation(obsRes2.observation_id, inc.incident_id);
      const rows2 = store.listObservations({ incident_id: inc.incident_id });
      expect(rows2.length).toBe(2);

      // 5. Test active incident tracking in plugin
      setActiveIncident(inc.incident_id, exp.experiment_id);
      const v1Hooks = await (PluginDefault as any).server();
      await v1Hooks["tool.execute.before"]({ tool: "bash", args: "ls", sessionID: "s1" });
      const rows3 = store.listObservations({ incident_id: inc.incident_id });
      expect(rows3.some((r) => r.args_summary?.includes("ls"))).toBe(true);
      setActiveIncident(null);
    } finally {
      db.close();
      for (const s of ["", "-wal", "-shm"]) {
        try { rmSync(dbPath + s, { force: true }); } catch {}
      }
    }
  });

  test("dashboard HTML is 100% hermetic (no external fonts), renders rejected hypotheses and research fields correctly", () => {
    const dbPath = join(tmpdir(), `admcp-dash-hermetic-${Date.now()}.db`);
    const { db } = openDatabase(dbPath);
    const store = new Store(db);

    try {
      const inc = store.createIncident({
        project: { display_name: "Dashboard Test", project_id: "prj_dash" },
        title: "Connection pool exhaustion",
        initial_symptom: "All 50 pooled connections busy under load",
        actor: "tester",
      }).incident;

      // Add rejected hypothesis
      store.createHypothesis({
        incident_id: inc.incident_id,
        statement: "Database has max_connections set too low",
        rationale: "Default PG config is 100",
        actor: "tester",
      });
      const hyp = store.listHypotheses(inc.incident_id)[0];
      store.updateHypothesisStatus(hyp.hypothesis_id, "rejected", "verified max_connections is 500", "tester");

      // Add research reference
      store.recordResearch({
        incident_id: inc.incident_id,
        source_title: "PostgreSQL Connection Pooling Guide",
        source_uri: "https://wiki.postgresql.org/wiki/Connection_Pooling",
        source_type: "documentation",
        relevant_summary: "Idle-in-transaction connections hold pool slots open indefinitely",
        reliability_note: "official wiki documentation",
        claim_supported_or_challenged: "Explains connection leaks during unhandled promise rejections",
        actor: "tester",
      });

      const html = generateDashboardHtml(store, { incidentId: inc.incident_id });

      // Hermeticity
      expect(html).not.toContain("fonts.googleapis.com");
      expect(html).not.toContain("fonts.gstatic.com");
      expect(html).toContain("font-family: system-ui");

      // Hypotheses: rejected is styled as failed, no NaN%
      expect(html).not.toContain("NaN%");
      expect(html).toContain("pill-failed");
      expect(html).toContain("Database has max_connections set too low");

      // Research: fields correctly rendered
      expect(html).toContain("PostgreSQL Connection Pooling Guide");
      expect(html).toContain("Idle-in-transaction connections hold pool slots");
      expect(html).toContain("official wiki documentation");

      // Playground search: no fake vector similarity
      expect(html).not.toContain("dense semantic vector similarity (+15)");
      expect(html).toContain("exact query match (+50)");
    } finally {
      db.close();
      for (const s of ["", "-wal", "-shm"]) {
        try { rmSync(dbPath + s, { force: true }); } catch {}
      }
    }
  });
});
