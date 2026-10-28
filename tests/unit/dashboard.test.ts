import { test, expect, describe } from "bun:test";
import { openStore } from "../integration/helpers.ts";
import { generateDashboardData, generateDashboardHtml } from "../../src/dashboard/generator.ts";

describe("Dashboard Generator", () => {
  test("generates cross-project dashboard data and statistics correctly", () => {
    const store = openStore(":memory:");
    try {
      const incA = store.createIncident({
        project: { display_name: "Project Alpha", project_id: "prj_alpha" },
        title: "Alpha Network Timeout",
        initial_symptom: "Connection timed out on port 8080",
        actor: "agent",
      }).incident;

      const incB = store.createIncident({
        project: { display_name: "Project Beta", project_id: "prj_beta" },
        title: "Beta Cache Miss",
        initial_symptom: "High latency due to cache misses",
        actor: "agent",
      }).incident;

      // Add hypotheses
      store.createHypothesis({
        incident_id: incA.incident_id,
        statement: "Firewall is dropping packets",
        rationale: "Packets sent are never acknowledged",
        actor: "agent",
      });

      // Add experiments (nested tree)
      const exp1 = store.createExperiment({
        incident_id: incA.incident_id,
        node_kind: "experiment",
        title: "Check iptables drop count",
        actor: "agent",
        proposed_change: "iptables -L -n -v",
      }).experiment;

      const exp2 = store.createExperiment({
        incident_id: incA.incident_id,
        node_kind: "variant",
        parent_experiment_id: exp1.experiment_id,
        title: "Check nftables ruleset",
        actor: "agent",
        proposed_change: "nft list ruleset",
        reason_for_difference: "System uses nftables backend",
      }).experiment;

      // Add evidence with secret
      store.recordEvidence({
        project_id: incA.project_id,
        incident_id: incA.incident_id,
        experiment_id: exp1.experiment_id,
        evidence_type: "stdout",
        content: "Connection failed for user key [REDACTED:apikey]",
        capture_source: "agent",
      });

      const data = generateDashboardData(store);

      expect(data.stats.totalProjects).toBe(2);
      expect(data.stats.totalIncidents).toBe(2);
      expect(data.stats.totalExperiments).toBe(2);
      expect(data.stats.totalHypotheses).toBe(1);

      const incDataA = data.incidents.find((i) => i.incident.incident_id === incA.incident_id);
      expect(incDataA).toBeDefined();
      expect(incDataA?.projectName).toBe("Project Alpha");
      expect(incDataA?.hypothesesCount).toBe(1);
      expect(incDataA?.experimentsCount).toBe(2);
      expect(incDataA?.maxTreeDepth).toBe(2);

      // Scoped query for single project
      const betaData = generateDashboardData(store, { projectId: "prj_beta" });
      expect(betaData.incidents.length).toBe(1);
      expect(betaData.incidents[0].projectName).toBe("Project Beta");
    } finally {
      store.db.close();
    }
  });

  test("generates complete, well-formed, standalone HTML with all components", () => {
    const store = openStore(":memory:");
    try {
      const inc = store.createIncident({
        project: { display_name: "Visual Test App", project_id: "prj_vis" },
        title: "Payment Gateway 502 <script>alert(1)</script>",
        initial_symptom: "HTTP 502 Bad Gateway during checkout & payment",
        actor: "tester",
      }).incident;

      store.createHypothesis({
        incident_id: inc.incident_id,
        statement: "Upstream payment service is restarting",
        rationale: "Service restarts produce intermittent 502",
        actor: "tester",
      });

      // Add a rejected hypothesis to verify rejected status handling
      store.createHypothesis({
        incident_id: inc.incident_id,
        statement: "Database disk is full",
        rationale: "Checked df -h and found 80% free",
        actor: "tester",
      });
      const rejectedHypo = store.listHypotheses(inc.incident_id).find((h) => h.statement === "Database disk is full");
      if (rejectedHypo) {
        store.updateHypothesisStatus(rejectedHypo.hypothesis_id, "rejected", "verified df -h has ample space", "tester");
      }

      // Add a research reference
      store.recordResearch({
        incident_id: inc.incident_id,
        source_title: "Upstream Service Outage Advisory",
        source_uri: "https://status.payment.internal/incidents/123",
        source_type: "incident_postmortem",
        relevant_summary: "Rolling restarts caused transient 502 Bad Gateway responses",
        reliability_note: "primary vendor status log",
        claim_supported_or_challenged: "Supports upstream service restart hypothesis",
        actor: "tester",
      });

      const exp = store.createExperiment({
        incident_id: inc.incident_id,
        node_kind: "experiment",
        title: "Verify health check endpoint",
        actor: "tester",
        proposed_change: "curl -v https://api.payment.internal/health",
      }).experiment;

      store.recordEvidence({
        project_id: inc.project_id,
        incident_id: inc.incident_id,
        experiment_id: exp.experiment_id,
        evidence_type: "stdout",
        content: "HTTP/1.1 502 Bad Gateway [REDACTED:secret_token]",
        capture_source: "tester",
      });

      const html = generateDashboardHtml(store, { incidentId: inc.incident_id });

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("Adaptive Debugging Intelligence");
      expect(html).toContain("Visual Test App");
      // Script tags in user content must be escaped (prevent XSS in embedded json)
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain(String.raw`\u003cscript>alert(1)\u003c/script>`);

      // Verify hermeticity: zero external font or script dependencies
      expect(html).not.toContain("fonts.googleapis.com");
      expect(html).not.toContain("fonts.gstatic.com");
      expect(html).not.toContain("cdn.jsdelivr.net");
      expect(html).not.toContain("unpkg.com");
      expect(html).not.toContain("cdnjs.cloudflare.com");
      expect(html).toContain("font-family: system-ui");

      // Verify hypothesis formatting (no NaN% and proper status classes)
      expect(html).not.toContain("NaN%");
      expect(html).toContain("pill-failed"); // rejected hypothesis styled as failed

      // Verify research citations render title and summary
      expect(html).toContain("Upstream Service Outage Advisory");
      expect(html).toContain("Rolling restarts caused transient 502");

      // Verify essential sections exist
      expect(html).toContain("id=\"panel-overview\"");
      expect(html).toContain("id=\"panel-incidents\"");
      expect(html).toContain("id=\"panel-inspector\"");
      expect(html).toContain("id=\"panel-search\"");
      expect(html).toContain("id=\"treeContainer\"");
      expect(html).toContain("id=\"evidenceContainer\"");
      expect(html).toContain("id=\"timelineContainer\"");
      expect(html).toContain("id=\"hypothesesContainer\"");
    } finally {
      store.db.close();
    }
  });
});
