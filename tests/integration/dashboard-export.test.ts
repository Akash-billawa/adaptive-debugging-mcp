import { test, expect, describe } from "bun:test";
import { openStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";
import { readResourceHandler } from "../../src/server/resources.ts";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Dashboard Export & MCP Resources Integration", () => {
  test("debug_data_export supports format='html' and out_file writing", async () => {
    const store = openStore(":memory:");
    try {
      const inc = store.createIncident({
        project: { display_name: "Export Integration App", project_id: "prj_exp" },
        title: "Integration Test Incident",
        initial_symptom: "Mock failure for export verification",
        actor: "agent",
      }).incident;

      const catalog = buildCatalog({
        store,
        dbPath: ":memory:",
        log: () => {},
      });

      // 1. JSON export (default)
      const jsonRes = await catalog.call("debug_data_export", {
        incident_id: inc.incident_id,
      });
      const jsonContent = jsonRes.structuredContent as Record<string, unknown>;
      expect(jsonContent.ok).toBe(true);
      expect(jsonContent.incident).toBeDefined();

      // 2. HTML export returned directly
      const htmlRes = await catalog.call("debug_data_export", {
        incident_id: inc.incident_id,
        format: "html",
      });
      const htmlContent = htmlRes.structuredContent as Record<string, unknown>;
      expect(htmlContent.ok).toBe(true);
      expect(htmlContent.format).toBe("html");
      expect(typeof htmlContent.dashboard_html).toBe("string");
      expect((htmlContent.dashboard_html as string).length).toBeGreaterThan(1000);
      expect((htmlContent.dashboard_html as string)).toContain("Adaptive Debugging Intelligence");

      // 3. HTML export to disk via out_file
      const tempOut = join(tmpdir(), `adim-test-dashboard-${Date.now()}.html`);
      try {
        const fileRes = await catalog.call("debug_data_export", {
          format: "html",
          out_file: tempOut,
        });
        const fileContent = fileRes.structuredContent as Record<string, unknown>;
        expect(fileContent.ok).toBe(true);
        expect(fileContent.out_file).toBe(tempOut);
        expect(existsSync(tempOut)).toBe(true);

        const savedHtml = readFileSync(tempOut, "utf-8");
        expect(savedHtml).toContain("<!DOCTYPE html>");
        expect(savedHtml).toContain("Export Integration App");
      } finally {
        if (existsSync(tempOut)) unlinkSync(tempOut);
      }
    } finally {
      store.db.close();
    }
  });

  test("reads dashboard HTML via MCP debug:// resources", () => {
    const store = openStore(":memory:");
    try {
      const inc = store.createIncident({
        project: { display_name: "Resource Test App", project_id: "prj_res" },
        title: "Resource Test Incident",
        initial_symptom: "Mock failure for resource test",
        actor: "agent",
      }).incident;

      // 1. debug://dashboard
      const allDash = readResourceHandler(store, "debug://dashboard");
      expect(allDash.contents.length).toBe(1);
      expect(allDash.contents[0].mimeType).toBe("text/html");
      expect(allDash.contents[0].text).toContain("Adaptive Debugging Intelligence");

      // 2. debug://project/{project_id}/dashboard
      const projDash = readResourceHandler(store, "debug://project/prj_res/dashboard");
      expect(projDash.contents.length).toBe(1);
      expect(projDash.contents[0].mimeType).toBe("text/html");
      expect(projDash.contents[0].text).toContain("Resource Test App");

      // 3. debug://incident/{incident_id}/dashboard
      const incDash = readResourceHandler(store, `debug://incident/${inc.incident_id}/dashboard`);
      expect(incDash.contents.length).toBe(1);
      expect(incDash.contents[0].mimeType).toBe("text/html");
      expect(incDash.contents[0].text).toContain("Resource Test Incident");
    } finally {
      store.db.close();
    }
  });
});
