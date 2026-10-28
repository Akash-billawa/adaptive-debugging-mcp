/**
 * MCP Read-Only Resources surface (Tool Catalogue §7.1).
 *
 * Exposes read-only `debug://` resources for presenting existing investigation state:
 * - `debug://incident/{incident_id}/summary`
 * - `debug://incident/{incident_id}/tree`
 * - `debug://attempt/{attempt_id}/evidence`
 * - `debug://project/{project_id}/recent`
 */

import type { Store } from "../memory/store.ts";
import type { ResourceDef, ResourceTemplateDef } from "./protocol.ts";
import { notFound, validationError } from "../errors.ts";
import { generateDashboardHtml } from "../dashboard/generator.ts";

export function listResourceTemplates(): ResourceTemplateDef[] {
  return [
    {
      uriTemplate: "debug://dashboard",
      name: "Interactive Visual Dashboard",
      description: "Self-contained interactive HTML visual dashboard across all debugging projects and incidents.",
      mimeType: "text/html",
    },
    {
      uriTemplate: "debug://project/{project_id}/dashboard",
      name: "Project Visual Dashboard",
      description: "Interactive HTML visual dashboard scoped to a specific project.",
      mimeType: "text/html",
    },
    {
      uriTemplate: "debug://incident/{incident_id}/dashboard",
      name: "Incident Inspector Dashboard",
      description: "Interactive HTML deep inspector and experiment tree for a specific incident.",
      mimeType: "text/html",
    },
    {
      uriTemplate: "debug://incident/{incident_id}/summary",
      name: "Incident Summary",
      description: "Authoritative incident summary with explicit uncertainty, symptoms, status, and open hypotheses.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "debug://incident/{incident_id}/tree",
      name: "Experiment Tree",
      description: "Nested strategy and experiment branch tree with outcomes and truncation disclosure.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "debug://attempt/{attempt_id}/evidence",
      name: "Attempt Evidence",
      description: "Attached evidence references, observations, and interpretations for a specific experiment node.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "debug://evidence/{evidence_id}/content",
      name: "Evidence Raw Content",
      description: "Stored, redacted, and bounded raw content payload for an evidence record.",
      mimeType: "text/plain",
    },
    {
      uriTemplate: "debug://project/{project_id}/recent",
      name: "Recent Project Incidents",
      description: "Recent investigations and current unresolved incidents for a given project.",
      mimeType: "application/json",
    },
  ];
}

export function listConcreteResources(store: Store): ResourceDef[] {
  const resources: ResourceDef[] = [
    {
      uri: "debug://dashboard",
      name: "Interactive Visual Dashboard",
      description: "Self-contained interactive HTML visual dashboard across all debugging projects and incidents.",
      mimeType: "text/html",
    },
  ];

  try {
    const active = store.db.query("SELECT incident_id, title FROM incidents ORDER BY updated_at DESC LIMIT 15").all() as Array<{ incident_id: string; title: string }>;
    for (const inc of active) {
      resources.push({
        uri: `debug://incident/${inc.incident_id}/summary`,
        name: `Incident: ${inc.title.slice(0, 50)}`,
        description: `Current summary for incident ${inc.incident_id}`,
        mimeType: "application/json",
      });
      resources.push({
        uri: `debug://incident/${inc.incident_id}/tree`,
        name: `Tree: ${inc.title.slice(0, 50)}`,
        description: `Experiment branch tree for incident ${inc.incident_id}`,
        mimeType: "application/json",
      });
    }
  } catch {
    /* ignore if DB is not yet populated */
  }

  return resources;
}

export function readResourceHandler(
  store: Store,
  uri: string,
): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  if (!uri.startsWith("debug://")) {
    throw validationError(`Unsupported resource URI scheme: ${uri}. Expected 'debug://...'`);
  }

  const path = uri.slice("debug://".length);

  // 0. Dashboard resources
  if (path === "dashboard") {
    const html = generateDashboardHtml(store);
    return { contents: [{ uri, mimeType: "text/html", text: html }] };
  }

  const projectDashboardMatch = path.match(/^project\/([^/]+)\/dashboard$/);
  if (projectDashboardMatch) {
    const projectId = projectDashboardMatch[1];
    const html = generateDashboardHtml(store, { projectId });
    return { contents: [{ uri, mimeType: "text/html", text: html }] };
  }

  const incidentDashboardMatch = path.match(/^incident\/([^/]+)\/dashboard$/);
  if (incidentDashboardMatch) {
    const incidentId = incidentDashboardMatch[1];
    const html = generateDashboardHtml(store, { incidentId });
    return { contents: [{ uri, mimeType: "text/html", text: html }] };
  }

  // 1. debug://incident/{id}/summary
  const summaryMatch = path.match(/^incident\/([^/]+)\/summary$/);
  if (summaryMatch) {
    const incidentId = summaryMatch[1];
    const incident = store.getIncident(incidentId);
    if (!incident) throw notFound(`Incident not found: ${incidentId}`);

    const hypotheses = store.listHypotheses(incidentId);
    const validations = store.listValidations(incidentId);
    const experiments = store.allExperiments(incidentId);

    const payload = {
      incident,
      hypotheses_count: hypotheses.length,
      hypotheses: hypotheses.map((h) => ({ id: h.hypothesis_id, statement: h.statement, status: h.status })),
      experiments_count: experiments.length,
      outcomes_breakdown: experiments.reduce((acc, e) => {
        acc[e.outcome_status] = (acc[e.outcome_status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      validations_count: validations.length,
      recent_validations: validations.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5),
    };

    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
    };
  }

  // 2. debug://incident/{id}/tree
  const treeMatch = path.match(/^incident\/([^/]+)\/tree$/);
  if (treeMatch) {
    const incidentId = treeMatch[1];
    const incident = store.getIncident(incidentId);
    if (!incident) throw notFound(`Incident not found: ${incidentId}`);

    const tree = store.buildTree(incidentId, null, 8);
    const payload = {
      incident_id: incidentId,
      total_nodes: tree.total,
      tree: tree.nodes,
    };

    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
    };
  }

  // 3. debug://attempt/{id}/evidence
  const attemptMatch = path.match(/^attempt\/([^/]+)\/evidence$/);
  if (attemptMatch) {
    const attemptId = attemptMatch[1];
    const expRow = store.db.query("SELECT * FROM experiments WHERE experiment_id = ?").get(attemptId) as Record<string, unknown> | null;
    if (!expRow) throw notFound(`Experiment attempt not found: ${attemptId}`);

    const evidence = store.listEvidence({ experiment_id: attemptId });

    const payload = {
      experiment: expRow,
      evidence_count: evidence.length,
      evidence: evidence.map((e) => {
        const c = store.getEvidenceContent(e.evidence_id);
        return {
          ...e,
          content: c?.content ?? "",
          truncated: c?.truncated ?? false,
        };
      }),
    };

    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
    };
  }

  // 4. debug://evidence/{id}/content
  const evidenceContentMatch = path.match(/^evidence\/([^/]+)\/content$/);
  if (evidenceContentMatch) {
    const evidenceId = evidenceContentMatch[1];
    const ev = store.getEvidence(evidenceId);
    if (!ev) throw notFound(`Evidence not found: ${evidenceId}`);
    const row = store.getEvidenceContent(evidenceId);
    return {
      contents: [{ uri, mimeType: "text/plain", text: row?.content ?? "" }],
    };
  }

  // 5. debug://project/{id}/recent
  const projectMatch = path.match(/^project\/([^/]+)\/recent$/);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const incidents = store.db.query(
      "SELECT * FROM incidents WHERE project_id = ? ORDER BY updated_at DESC LIMIT 20",
    ).all(projectId) as Array<Record<string, unknown>>;

    const payload = {
      project_id: projectId,
      total_recent: incidents.length,
      incidents,
    };

    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
    };
  }

  throw validationError(`Unknown resource URI: ${uri}`);
}
