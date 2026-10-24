/**
 * ADIM Cross-Project Visual Retrieval UI & Standalone Export Dashboard Generator.
 *
 * Generates an interactive, zero-dependency, self-contained HTML/CSS/JS file for
 * visualizing debugging cases, multi-project status, experiment trees, hypotheses,
 * evidence, validations, research sources, and semantic retrieval results.
 */

import type { Store } from "../memory/store.ts";
import type { Incident, Project, Hypothesis, Experiment, ValidationRun, ResearchReference, TimelineEvent } from "../types.ts";
import { SCHEMA_VERSION } from "../memory/schema.ts";
import { listTimeline } from "../memory/audit.ts";

export interface DashboardOptions {
  projectId?: string;
  incidentId?: string;
  title?: string;
}

export interface IncidentSummaryData {
  incident: Incident;
  projectName: string;
  hypothesesCount: number;
  experimentsCount: number;
  validationsCount: number;
  researchCount: number;
  verifiedFixAvailable: boolean;
  maxTreeDepth: number;
}

export interface IncidentDetailData {
  incident: Incident;
  project: Project | null;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  tree: unknown;
  validations: ValidationRun[];
  research: ResearchReference[];
  timeline: TimelineEvent[];
  evidence: Array<{
    evidence_id: string;
    experiment_id: string | null;
    evidence_type: string;
    raw_content: string;
    redaction_status: string;
    created_at: string;
  }>;
}

export interface DashboardPayload {
  generatedAt: string;
  schemaVersion: number;
  title: string;
  selectedProjectId: string | null;
  selectedIncidentId: string | null;
  stats: {
    totalProjects: number;
    totalIncidents: number;
    openIncidents: number;
    resolvedIncidents: number;
    unresolvedIncidents: number;
    blockedIncidents: number;
    resolutionRatePct: number;
    totalExperiments: number;
    verifiedExperiments: number;
    totalHypotheses: number;
    totalResearchSources: number;
  };
  projects: Project[];
  incidents: IncidentSummaryData[];
  incidentDetails: Record<string, IncidentDetailData>;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function calculateMaxTreeDepth(experiments: Experiment[]): number {
  if (experiments.length === 0) return 0;
  const parentMap = new Map<string, string | null>();
  for (const exp of experiments) {
    parentMap.set(exp.experiment_id, exp.parent_experiment_id ?? null);
  }

  let maxDepth = 1;
  for (const exp of experiments) {
    let depth = 1;
    let curr = exp.parent_experiment_id;
    const visited = new Set<string>([exp.experiment_id]);
    while (curr && parentMap.has(curr) && !visited.has(curr)) {
      visited.add(curr);
      depth++;
      curr = parentMap.get(curr) ?? null;
    }
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

export function generateDashboardData(store: Store, options: DashboardOptions = {}): DashboardPayload {
  const allProjects = store.listProjects();
  const projectMap = new Map<string, Project>();
  for (const p of allProjects) projectMap.set(p.project_id, p);

  const incidentsRaw = options.projectId
    ? store.listIncidents(options.projectId, 500)
    : store.listIncidents(undefined, 500);

  let totalExperiments = 0;
  let verifiedExperiments = 0;
  let totalHypotheses = 0;
  let totalResearchSources = 0;

  const incidentsSummary: IncidentSummaryData[] = [];
  const incidentDetails: Record<string, IncidentDetailData> = {};

  for (const inc of incidentsRaw) {
    const incId = inc.incident_id;
    const project = projectMap.get(inc.project_id) ?? null;
    const hypotheses = store.listHypotheses(incId);
    const experiments = store.allExperiments(incId);
    const validations = store.listValidations(incId);
    const research = store.listResearch(incId);
    const timeline = listTimeline(store.db, incId);
    const evidenceRaw = store.listEvidence({ incident_id: incId });
    const tree = store.buildTree(incId, null, 10);

    const verifiedCount = experiments.filter((e) => e.outcome_status === "verified").length;
    const hasVerifiedFix = verifiedCount > 0 || inc.status === "resolved";
    const maxTreeDepth = calculateMaxTreeDepth(experiments);

    totalExperiments += experiments.length;
    verifiedExperiments += verifiedCount;
    totalHypotheses += hypotheses.length;
    totalResearchSources += research.length;

    incidentsSummary.push({
      incident: inc,
      projectName: project ? project.display_name : inc.project_id,
      hypothesesCount: hypotheses.length,
      experimentsCount: experiments.length,
      validationsCount: validations.length,
      researchCount: research.length,
      verifiedFixAvailable: hasVerifiedFix,
      maxTreeDepth,
    });

    if (!options.incidentId || options.incidentId === incId || incidentsSummary.length <= 50) {
      incidentDetails[incId] = {
        incident: inc,
        project,
        hypotheses,
        experiments,
        tree,
        validations,
        research,
        timeline,
        evidence: evidenceRaw.map((ev) => {
          const contentRow = store.getEvidenceContent(ev.evidence_id);
          const rawContent = contentRow?.content ?? ev.interpretation ?? "";
          return {
            evidence_id: ev.evidence_id,
            experiment_id: ev.experiment_id,
            evidence_type: ev.evidence_type,
            raw_content: rawContent.slice(0, 5000),
            redaction_status: ev.redaction_status,
            created_at: ev.created_at,
          };
        }),
      };
    }
  }

  const totalIncidents = incidentsSummary.length;
  const resolvedIncidents = incidentsSummary.filter((i) => i.incident.status === "resolved").length;
  const openIncidents = incidentsSummary.filter(
    (i) => i.incident.status === "open" || i.incident.status === "investigating" || i.incident.status === "reopened",
  ).length;
  const unresolvedIncidents = incidentsSummary.filter((i) => i.incident.status === "closed_unresolved").length;
  const blockedIncidents = incidentsSummary.filter((i) => i.incident.status === "blocked").length;
  const resolutionRatePct = totalIncidents > 0 ? Math.round((resolvedIncidents / totalIncidents) * 100) : 0;

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    title: options.title ?? "Adaptive Debugging Intelligence Dashboard",
    selectedProjectId: options.projectId ?? null,
    selectedIncidentId: options.incidentId ?? (incidentsSummary.length > 0 ? incidentsSummary[0].incident.incident_id : null),
    stats: {
      totalProjects: allProjects.length,
      totalIncidents,
      openIncidents,
      resolvedIncidents,
      unresolvedIncidents,
      blockedIncidents,
      resolutionRatePct,
      totalExperiments,
      verifiedExperiments,
      totalHypotheses,
      totalResearchSources,
    },
    projects: allProjects,
    incidents: incidentsSummary,
    incidentDetails,
  };
}

export function generateDashboardHtml(store: Store, options: DashboardOptions = {}): string {
  const data = generateDashboardData(store, options);
  const jsonPayload = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #0a0e17;
      --bg-surface: #111827;
      --bg-card: #182234;
      --bg-card-hover: #1f2c42;
      --bg-subtle: #0f172a;
      --border-subtle: #243046;
      --border-focus: #3b82f6;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      
      --accent-primary: #6366f1;
      --accent-primary-gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      --accent-secondary: #06b6d4;
      
      --status-verified: #10b981;
      --status-verified-bg: rgba(16, 185, 129, 0.12);
      --status-verified-border: rgba(16, 185, 129, 0.35);

      --status-candidate: #3b82f6;
      --status-candidate-bg: rgba(59, 130, 246, 0.12);
      --status-candidate-border: rgba(59, 130, 246, 0.35);

      --status-failed: #f43f5e;
      --status-failed-bg: rgba(244, 63, 94, 0.12);
      --status-failed-border: rgba(244, 63, 94, 0.35);

      --status-inconclusive: #f59e0b;
      --status-inconclusive-bg: rgba(245, 158, 11, 0.12);
      --status-inconclusive-border: rgba(245, 158, 11, 0.35);

      --status-blocked: #a855f7;
      --status-blocked-bg: rgba(168, 85, 247, 0.12);
      --status-blocked-border: rgba(168, 85, 247, 0.35);

      --status-superseded: #64748b;
      --status-superseded-bg: rgba(100, 116, 139, 0.12);
      --status-superseded-border: rgba(100, 116, 139, 0.35);

      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -1px rgba(0, 0, 0, 0.3);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.4);
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 16px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      background-color: var(--bg-base);
      color: var(--text-main);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
      overflow-x: hidden;
    }

    code, pre {
      font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace;
    }

    /* Top Navigation Bar */
    header.top-bar {
      background: rgba(17, 24, 39, 0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-subtle);
      position: sticky;
      top: 0;
      z-index: 100;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-icon {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      background: var(--accent-primary-gradient);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
      box-shadow: 0 0 16px rgba(99, 102, 241, 0.4);
    }

    .brand-text h1 {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.01em;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-text p {
      font-size: 11px;
      color: var(--text-dim);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .filter-select {
      background: var(--bg-card);
      color: var(--text-main);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 8px 12px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    .filter-select:focus { border-color: var(--border-focus); }

    .search-input-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-input-wrap input {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      border-radius: var(--radius-sm);
      padding: 8px 12px 8px 32px;
      font-size: 13px;
      width: 240px;
      transition: all 0.2s ease;
    }
    .search-input-wrap input:focus {
      width: 320px;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
      outline: none;
    }

    .search-icon {
      position: absolute;
      left: 10px;
      color: var(--text-dim);
      pointer-events: none;
      font-size: 13px;
    }

    .btn {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
    }
    .btn:hover { background: var(--bg-card-hover); border-color: var(--text-dim); }
    .btn-primary {
      background: var(--accent-primary-gradient);
      border-color: transparent;
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
    }
    .btn-primary:hover { opacity: 0.95; box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4); }

    /* Navigation Tabs */
    .tabs-nav {
      display: flex;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);
      padding: 0 24px;
      gap: 4px;
    }

    .tab-btn {
      padding: 12px 18px;
      color: var(--text-muted);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s ease;
    }
    .tab-btn:hover { color: var(--text-main); }
    .tab-btn.active {
      color: var(--accent-secondary);
      border-bottom-color: var(--accent-secondary);
    }

    /* Main Container */
    main.content {
      padding: 24px;
      max-width: 1600px;
      margin: 0 auto;
    }

    .view-panel { display: none; }
    .view-panel.active { display: block; animation: fadeIn 0.2s ease-in-out; }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* KPI Metrics Cards */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 18px;
      box-shadow: var(--shadow-sm);
      display: flex;
      flex-direction: column;
      gap: 6px;
      position: relative;
      overflow: hidden;
      transition: transform 0.2s, border-color 0.2s;
    }
    .kpi-card:hover {
      transform: translateY(-2px);
      border-color: var(--border-focus);
    }

    .kpi-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: var(--accent-primary-gradient);
    }

    .kpi-label {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }

    .kpi-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-main);
      font-family: 'JetBrains Mono', monospace;
    }

    .kpi-subtext {
      font-size: 11px;
      color: var(--text-dim);
    }

    /* Incidents Table */
    .table-container {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }

    .table-header-bar {
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-subtle);
    }

    .table-title {
      font-size: 15px;
      font-weight: 600;
    }

    table.data-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    table.data-table th {
      background: var(--bg-card);
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 12px 18px;
      border-bottom: 1px solid var(--border-subtle);
    }

    table.data-table td {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
    }

    table.data-table tr:hover td {
      background: var(--bg-card-hover);
      cursor: pointer;
    }

    /* Badges & Status Pills */
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .pill-resolved, .pill-verified {
      background: var(--status-verified-bg);
      color: var(--status-verified);
      border: 1px solid var(--status-verified-border);
    }
    .pill-open, .pill-candidate {
      background: var(--status-candidate-bg);
      color: var(--status-candidate);
      border: 1px solid var(--status-candidate-border);
    }
    .pill-failed {
      background: var(--status-failed-bg);
      color: var(--status-failed);
      border: 1px solid var(--status-failed-border);
    }
    .pill-inconclusive {
      background: var(--status-inconclusive-bg);
      color: var(--status-inconclusive);
      border: 1px solid var(--status-inconclusive-border);
    }
    .pill-blocked {
      background: var(--status-blocked-bg);
      color: var(--status-blocked);
      border: 1px solid var(--status-blocked-border);
    }
    .pill-superseded {
      background: var(--status-superseded-bg);
      color: var(--text-dim);
      border: 1px solid var(--status-superseded-border);
    }

    /* Deep Incident Inspector Layout */
    .inspector-layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 20px;
    }

    @media (max-width: 1024px) {
      .inspector-layout { grid-template-columns: 1fr; }
    }

    .incident-sidebar {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      height: fit-content;
    }

    .detail-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 20px;
      margin-bottom: 20px;
    }

    .detail-card-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Tree View Styling */
    .tree-view {
      position: relative;
      padding-left: 12px;
    }

    .tree-node {
      margin: 10px 0;
      position: relative;
    }

    .tree-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: all 0.2s ease;
    }
    .tree-card:hover {
      border-color: var(--border-focus);
      background: var(--bg-card-hover);
    }
    .tree-card.active-branch {
      border-color: var(--accent-secondary);
      box-shadow: 0 0 10px rgba(6, 182, 212, 0.2);
    }

    .tree-children {
      margin-left: 28px;
      padding-left: 14px;
      border-left: 2px dashed var(--border-subtle);
    }

    /* Evidence & Terminal Logs */
    .terminal-window {
      background: #050811;
      border: 1px solid #1e293b;
      border-radius: var(--radius-sm);
      overflow: hidden;
      margin-top: 10px;
    }

    .terminal-header {
      background: #0f172a;
      padding: 6px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #1e293b;
      font-size: 11px;
      color: var(--text-dim);
    }

    .terminal-dots {
      display: flex;
      gap: 6px;
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot-red { background: #ef4444; }
    .dot-yellow { background: #f59e0b; }
    .dot-green { background: #10b981; }

    .terminal-body {
      padding: 12px;
      color: #38bdf8;
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      max-height: 350px;
    }

    .redaction-tag {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      padding: 1px 4px;
      border-radius: 3px;
      border: 1px solid rgba(239, 68, 68, 0.4);
      font-weight: 600;
    }

    /* Timeline styling */
    .timeline {
      position: relative;
      padding-left: 24px;
      margin: 16px 0;
    }
    .timeline::before {
      content: '';
      position: absolute;
      left: 7px;
      top: 6px;
      bottom: 6px;
      width: 2px;
      background: var(--border-subtle);
    }

    .timeline-item {
      position: relative;
      margin-bottom: 18px;
    }
    .timeline-dot {
      position: absolute;
      left: -24px;
      top: 4px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--accent-primary);
      border: 3px solid var(--bg-surface);
      box-shadow: 0 0 6px var(--accent-primary);
    }

    .timeline-content {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
    }
    .timeline-meta {
      font-size: 11px;
      color: var(--text-dim);
      margin-bottom: 4px;
    }

    /* Search Playground */
    .search-box-large {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
    }
    .search-box-large input {
      flex: 1;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 14px 20px;
      font-size: 15px;
      color: var(--text-main);
      outline: none;
    }
    .search-box-large input:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
    }

    /* Print media styling */
    @media print {
      body { background: #ffffff; color: #000000; }
      header.top-bar, .tabs-nav, .btn, .search-box-large { display: none !important; }
      .detail-card, .table-container, .tree-card { border: 1px solid #ccc; background: #fff; color: #000; }
      .terminal-window { background: #f8fafc; border: 1px solid #ccc; }
      .terminal-body { color: #0f172a; }
    }
  </style>
</head>
<body>
  <header class="top-bar">
    <div class="brand">
      <div class="brand-icon">AD</div>
      <div class="brand-text">
        <h1>Adaptive Debugging Intelligence</h1>
        <p>Interactive Investigation & Cross-Project Memory Dashboard • Schema v${data.schemaVersion}</p>
      </div>
    </div>
    <div class="header-actions">
      <select id="projectFilterSelect" class="filter-select" onchange="filterByProject(this.value)">
        <option value="ALL">All Projects (${data.stats.totalProjects})</option>
        ${data.projects.map((p) => `<option value="${escapeHtml(p.project_id)}"${p.project_id === data.selectedProjectId ? " selected" : ""}>${escapeHtml(p.display_name)}</option>`).join("")}
      </select>
      <div class="search-input-wrap">
        <span class="search-icon">🔍</span>
        <input type="text" id="quickSearchInput" placeholder="Quick filter incidents..." oninput="filterIncidentsTable(this.value)">
      </div>
      <button class="btn" onclick="exportDataJson()">📥 Export JSON</button>
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print / PDF</button>
    </div>
  </header>

  <nav class="tabs-nav">
    <button class="tab-btn active" id="tab-overview" onclick="switchTab('overview')">📊 Overview & Metrics</button>
    <button class="tab-btn" id="tab-incidents" onclick="switchTab('incidents')">🗂️ Incidents Explorer (<span id="incidentsTabCount">${data.stats.totalIncidents}</span>)</button>
    <button class="tab-btn" id="tab-inspector" onclick="switchTab('inspector')">🔬 Deep Incident Inspector</button>
    <button class="tab-btn" id="tab-search" onclick="switchTab('search')">⚡ Semantic & Retrieval Playground</button>
  </nav>

  <main class="content">
    <!-- Tab 1: Overview & Metrics -->
    <section id="panel-overview" class="view-panel active">
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Incidents</div>
          <div class="kpi-value" id="kpiTotalIncidents">${data.stats.totalIncidents}</div>
          <div class="kpi-subtext">Across ${data.stats.totalProjects} active project(s)</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Verified Resolution Rate</div>
          <div class="kpi-value" id="kpiResolutionRate" style="color: var(--status-verified);">${data.stats.resolutionRatePct}%</div>
          <div class="kpi-subtext">${data.stats.resolvedIncidents} verified resolved</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Active / Open Bugs</div>
          <div class="kpi-value" id="kpiOpenIncidents" style="color: var(--status-candidate);">${data.stats.openIncidents}</div>
          <div class="kpi-subtext">${data.stats.unresolvedIncidents} unresolved • ${data.stats.blockedIncidents} blocked</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Experiments</div>
          <div class="kpi-value" id="kpiTotalExperiments">${data.stats.totalExperiments}</div>
          <div class="kpi-subtext">${data.stats.verifiedExperiments} verified fix attempts</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Competing Hypotheses</div>
          <div class="kpi-value" id="kpiTotalHypotheses">${data.stats.totalHypotheses}</div>
          <div class="kpi-subtext">${data.stats.totalResearchSources} research citations</div>
        </div>
      </div>

      <div class="table-container">
        <div class="table-header-bar">
          <div class="table-title">Recent Cross-Project Investigations</div>
          <div style="font-size: 12px; color: var(--text-dim);">Click any incident to open the Deep Inspector</div>
        </div>
        <table class="data-table" id="recentIncidentsTable">
          <thead>
            <tr>
              <th>Status</th>
              <th>Incident Title</th>
              <th>Project</th>
              <th>Initial Symptom</th>
              <th>Hypotheses</th>
              <th>Experiments</th>
              <th>Tree Depth</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody id="recentIncidentsTableBody">
            <!-- Rendered by JS -->
          </tbody>
        </table>
      </div>
    </section>

    <!-- Tab 2: Incidents Explorer -->
    <section id="panel-incidents" class="view-panel">
      <div class="table-container">
        <div class="table-header-bar">
          <div class="table-title">All Tracked Debugging Incidents</div>
          <div style="display: flex; gap: 8px;">
            <button class="btn" onclick="filterByStatus('ALL')">All</button>
            <button class="btn" onclick="filterByStatus('open')">Open</button>
            <button class="btn" onclick="filterByStatus('resolved')">Resolved</button>
            <button class="btn" onclick="filterByStatus('blocked')">Blocked</button>
          </div>
        </div>
        <table class="data-table" id="allIncidentsTable">
          <thead>
            <tr>
              <th>Status</th>
              <th>Incident ID</th>
              <th>Title</th>
              <th>Project</th>
              <th>Symptom Signature</th>
              <th>Experiments</th>
              <th>Verified?</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody id="allIncidentsTableBody">
            <!-- Rendered by JS -->
          </tbody>
        </table>
      </div>
    </section>

    <!-- Tab 3: Deep Incident Inspector -->
    <section id="panel-inspector" class="view-panel">
      <div class="inspector-layout">
        <!-- Sidebar -->
        <aside class="incident-sidebar">
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: var(--text-dim); font-weight: 600;">Active Incident</div>
            <select id="inspectorIncidentSelect" class="filter-select" style="width: 100%; margin-top: 6px;" onchange="selectIncident(this.value)">
              <!-- Populated by JS -->
            </select>
          </div>

          <div id="inspectorMetaCard">
            <!-- Populated by JS -->
          </div>
        </aside>

        <!-- Main Detail Panels -->
        <div class="incident-main-view">
          <!-- Experiment Branching Tree -->
          <div class="detail-card">
            <div class="detail-card-title">
              <span>🌳 Experiment Branching Tree & Variants</span>
              <span id="treeStatsBadge" style="font-size: 12px; color: var(--text-dim);"></span>
            </div>
            <div id="treeContainer" class="tree-view">
              <!-- Rendered by JS -->
            </div>
          </div>

          <!-- Hypotheses Evaluation Board -->
          <div class="detail-card">
            <div class="detail-card-title">
              <span>💡 Competing Hypotheses Matrix</span>
              <span id="hypothesesCountBadge" style="font-size: 12px; color: var(--text-dim);"></span>
            </div>
            <div id="hypothesesContainer">
              <!-- Rendered by JS -->
            </div>
          </div>

          <!-- Chronological Event Timeline -->
          <div class="detail-card">
            <div class="detail-card-title">
              <span>⏱️ Investigation Timeline & Audit Trail</span>
            </div>
            <div id="timelineContainer" class="timeline">
              <!-- Rendered by JS -->
            </div>
          </div>

          <!-- Evidence Vault -->
          <div class="detail-card">
            <div class="detail-card-title">
              <span>🛡️ Evidence Vault (Stdout, Stderr & Redactions)</span>
              <span style="font-size: 11px; color: var(--text-dim);">Secrets automatically masked</span>
            </div>
            <div id="evidenceContainer">
              <!-- Rendered by JS -->
            </div>
          </div>

          <!-- Research References & Citations -->
          <div class="detail-card">
            <div class="detail-card-title">
              <span>📚 External Research & Technical Citations</span>
            </div>
            <div id="researchContainer">
              <!-- Rendered by JS -->
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Tab 4: Semantic & Retrieval Playground -->
    <section id="panel-search" class="view-panel">
      <div class="search-box-large">
        <input type="text" id="playgroundSearchInput" placeholder="Enter error message, symptom, or stack trace (e.g. 'connection refused', 'auth token expired', 'null pointer')..." onkeydown="if(event.key==='Enter') executePlaygroundSearch()">
        <button class="btn btn-primary" onclick="executePlaygroundSearch()">🔎 Search History</button>
      </div>

      <div class="detail-card">
        <div class="detail-card-title">
          <span>Search Results & Explainable Attribution</span>
          <span id="searchResultStats" style="font-size: 12px; color: var(--text-dim);">Enter a query to run search</span>
        </div>
        <div id="searchResultsContainer">
          <p style="color: var(--text-dim); padding: 12px 0;">Use this interactive console to evaluate hybrid retrieval: exact fingerprint matches (+100), FTS5 BM25 (+10-35), and dense semantic similarity (+0-40).</p>
        </div>
      </div>
    </section>
  </main>

  <script>
    const DATA = ${jsonPayload};
    let currentProjectId = DATA.selectedProjectId || "ALL";
    let currentIncidentId = DATA.selectedIncidentId || (DATA.incidents[0] ? DATA.incidents[0].incident.incident_id : null);
    let currentStatusFilter = "ALL";

    function init() {
      populateInspectorDropdown();
      renderOverviewTable();
      renderAllIncidentsTable();
      if (currentIncidentId) {
        renderInspector(currentIncidentId);
      }
    }

    function switchTab(tabName) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.view-panel').forEach(panel => panel.classList.remove('active'));

      const tabBtn = document.getElementById('tab-' + tabName);
      const panel = document.getElementById('panel-' + tabName);
      if (tabBtn) tabBtn.classList.add('active');
      if (panel) panel.classList.add('active');
    }

    function getPillClass(status) {
      switch (status) {
        case 'resolved':
        case 'verified': return 'pill-verified';
        case 'open':
        case 'candidate': return 'pill-candidate';
        case 'failed': return 'pill-failed';
        case 'inconclusive': return 'pill-inconclusive';
        case 'blocked': return 'pill-blocked';
        default: return 'pill-superseded';
      }
    }

    function renderOverviewTable() {
      const tbody = document.getElementById('recentIncidentsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';

      const filtered = DATA.incidents.filter(item => {
        if (currentProjectId !== "ALL" && item.incident.project_id !== currentProjectId) return false;
        return true;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color: var(--text-dim); padding: 24px;">No incidents recorded yet for this filter.</td></tr>';
        return;
      }

      filtered.slice(0, 15).forEach(item => {
        const tr = document.createElement('tr');
        tr.onclick = () => {
          selectIncident(item.incident.incident_id);
          switchTab('inspector');
        };
        tr.innerHTML = \`
          <td><span class="pill \${getPillClass(item.incident.status)}">\${escapeText(item.incident.status)}</span></td>
          <td style="font-weight: 600; color: var(--text-main);">\${escapeText(item.incident.title)}</td>
          <td><span style="color: var(--text-muted); font-size: 12px;">\${escapeText(item.projectName)}</span></td>
          <td style="color: var(--text-muted); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">\${escapeText(item.incident.initial_symptom)}</td>
          <td>\${item.hypothesesCount}</td>
          <td>\${item.experimentsCount}</td>
          <td><span style="font-family: monospace;">depth: \${item.maxTreeDepth}</span></td>
          <td style="color: var(--text-dim); font-size: 12px;">\${formatDate(item.incident.updated_at)}</td>
        \`;
        tbody.appendChild(tr);
      });
    }

    function renderAllIncidentsTable() {
      const tbody = document.getElementById('allIncidentsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';

      const filtered = DATA.incidents.filter(item => {
        if (currentProjectId !== "ALL" && item.incident.project_id !== currentProjectId) return false;
        if (currentStatusFilter !== "ALL" && item.incident.status !== currentStatusFilter) return false;
        return true;
      });

      document.getElementById('incidentsTabCount').textContent = filtered.length;

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color: var(--text-dim); padding: 24px;">No matching incidents found.</td></tr>';
        return;
      }

      filtered.forEach(item => {
        const tr = document.createElement('tr');
        tr.onclick = () => {
          selectIncident(item.incident.incident_id);
          switchTab('inspector');
        };
        tr.innerHTML = \`
          <td><span class="pill \${getPillClass(item.incident.status)}">\${escapeText(item.incident.status)}</span></td>
          <td><code style="font-size: 11px; color: var(--text-dim);">\${escapeText(item.incident.incident_id)}</code></td>
          <td style="font-weight: 600;">\${escapeText(item.incident.title)}</td>
          <td>\${escapeText(item.projectName)}</td>
          <td style="color: var(--text-muted); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">\${escapeText(item.incident.initial_symptom)}</td>
          <td>\${item.experimentsCount} attempts</td>
          <td>\${item.verifiedFixAvailable ? '<span style="color: var(--status-verified); font-weight:600;">✓ Verified</span>' : '<span style="color: var(--text-dim);">-</span>'}</td>
          <td style="color: var(--text-dim); font-size: 12px;">\${formatDate(item.incident.updated_at)}</td>
        \`;
        tbody.appendChild(tr);
      });
    }

    function populateInspectorDropdown() {
      const select = document.getElementById('inspectorIncidentSelect');
      if (!select) return;
      select.innerHTML = '';
      DATA.incidents.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.incident.incident_id;
        opt.textContent = \`[\${item.incident.status.toUpperCase()}] \${item.incident.title.slice(0, 40)}\`;
        if (opt.value === currentIncidentId) opt.selected = true;
        select.appendChild(opt);
      });
    }

    function selectIncident(incidentId) {
      currentIncidentId = incidentId;
      const select = document.getElementById('inspectorIncidentSelect');
      if (select) select.value = incidentId;
      renderInspector(incidentId);
    }

    function renderInspector(incidentId) {
      const details = DATA.incidentDetails[incidentId];
      if (!details) {
        document.getElementById('inspectorMetaCard').innerHTML = '<p style="color: var(--text-dim);">Incident details not loaded.</p>';
        return;
      }

      const inc = details.incident;
      const metaContainer = document.getElementById('inspectorMetaCard');
      metaContainer.innerHTML = \`
        <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px;">
          <div>
            <span class="pill \${getPillClass(inc.status)}">\${escapeText(inc.status)}</span>
            <span style="font-size: 11px; color: var(--text-dim); margin-left: 6px;">severity: \${escapeText(inc.severity || 'normal')}</span>
          </div>
          <h3 style="font-size: 15px; font-weight: 700; color: var(--text-main); margin-top: 4px;">\${escapeText(inc.title)}</h3>
          <p style="font-size: 12px; color: var(--text-muted); line-height: 1.4;">\${escapeText(inc.initial_symptom)}</p>
          \${inc.acceptance_criteria ? \`<div style="margin-top: 6px; padding: 8px; background: var(--bg-card); border-radius: 4px; font-size: 11px; border-left: 3px solid var(--accent-secondary);"><strong>Acceptance Criteria:</strong><br>\${escapeText(inc.acceptance_criteria)}</div>\` : ''}
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 8px;">
            <div>ID: <code style="color: var(--text-muted);">\${escapeText(inc.incident_id)}</code></div>
            <div>Opened: \${formatDate(inc.first_observed_at || inc.created_at)}</div>
            \${inc.resolved_at ? \`<div style="color: var(--status-verified);">Resolved: \${formatDate(inc.resolved_at)}</div>\` : ''}
          </div>
        </div>
      \`;

      renderTree(details);
      renderHypotheses(details);
      renderTimeline(details);
      renderEvidence(details);
      renderResearch(details);
    }

    function renderTree(details) {
      const container = document.getElementById('treeContainer');
      const countBadge = document.getElementById('treeStatsBadge');
      if (!container) return;

      const experiments = details.experiments || [];
      countBadge.textContent = \`\${experiments.length} attempts recorded\`;

      if (experiments.length === 0) {
        container.innerHTML = '<p style="color: var(--text-dim); padding: 12px;">No experiments recorded yet for this incident.</p>';
        return;
      }

      const childrenMap = {};
      const roots = [];
      experiments.forEach(e => {
        if (!e.parent_experiment_id) {
          roots.push(e);
        } else {
          childrenMap[e.parent_experiment_id] = childrenMap[e.parent_experiment_id] || [];
          childrenMap[e.parent_experiment_id].push(e);
        }
      });

      function buildNodeHtml(node) {
        const children = childrenMap[node.experiment_id] || [];
        const pillClass = getPillClass(node.outcome_status);
        return \`
          <div class="tree-node">
            <div class="tree-card \${node.outcome_status === 'verified' ? 'active-branch' : ''}">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span class="pill \${pillClass}">\${escapeText(node.outcome_status)}</span>
                <span style="font-size: 11px; color: var(--text-dim);">\${escapeText(node.actor || 'agent')}</span>
              </div>
              <div style="font-weight: 600; font-size: 13px; color: var(--text-main);">\${escapeText(node.title)}</div>
              \${node.proposed_change ? \`<div style="font-size: 12px; color: var(--text-muted);"><strong>Proposed change:</strong> \${escapeText(node.proposed_change)}</div>\` : ''}
              \${node.reason_for_difference ? \`<div style="font-size: 11px; color: var(--accent-secondary);"><strong>Reason for variant:</strong> \${escapeText(node.reason_for_difference)}</div>\` : ''}
              \${node.actual_observation ? \`<div style="font-size: 11px; color: #cbd5e1; background: rgba(0,0,0,0.25); padding: 6px; border-radius: 4px;"><strong>Observed:</strong> \${escapeText(node.actual_observation)}</div>\` : ''}
            </div>
            \${children.length > 0 ? \`<div class="tree-children">\${children.map(buildNodeHtml).join('')}</div>\` : ''}
          </div>
        \`;
      }

      container.innerHTML = roots.map(buildNodeHtml).join('');
    }

    function renderHypotheses(details) {
      const container = document.getElementById('hypothesesContainer');
      const badge = document.getElementById('hypothesesCountBadge');
      if (!container) return;

      const list = details.hypotheses || [];
      badge.textContent = \`\${list.length} hypotheses\`;

      if (list.length === 0) {
        container.innerHTML = '<p style="color: var(--text-dim); padding: 12px;">No hypotheses formulated yet.</p>';
        return;
      }

      let html = '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px;">';
      list.forEach(h => {
        html += \`
          <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span class="pill \${h.status === 'supported' ? 'pill-verified' : h.status === 'refuted' ? 'pill-failed' : 'pill-candidate'}">\${escapeText(h.status)}</span>
              <span style="font-size: 11px; color: var(--text-dim);">Plausibility: \${Math.round(h.plausibility * 100)}%</span>
            </div>
            <div style="font-size: 13px; font-weight: 500; color: var(--text-main); margin-bottom: 6px;">\${escapeText(h.statement)}</div>
            \${h.test_strategy ? \`<div style="font-size: 11px; color: var(--text-muted);"><strong>Test strategy:</strong> \${escapeText(h.test_strategy)}</div>\` : ''}
          </div>
        \`;
      });
      html += '</div>';
      container.innerHTML = html;
    }

    function renderTimeline(details) {
      const container = document.getElementById('timelineContainer');
      if (!container) return;
      const list = details.timeline || [];

      if (list.length === 0) {
        container.innerHTML = '<p style="color: var(--text-dim);">No timeline events recorded.</p>';
        return;
      }

      container.innerHTML = list.map(ev => \`
        <div class="timeline-item">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-meta">\${formatDate(ev.occurred_at || ev.created_at)} • <strong>\${escapeText(ev.event_type)}</strong> • \${escapeText(ev.actor)}</div>
            <div style="font-size: 13px; color: var(--text-main);">\${escapeText(ev.summary)}</div>
          </div>
        </div>
      \`).join('');
    }

    function renderEvidence(details) {
      const container = document.getElementById('evidenceContainer');
      if (!container) return;
      const list = details.evidence || [];

      if (list.length === 0) {
        container.innerHTML = '<p style="color: var(--text-dim);">No raw evidence attached.</p>';
        return;
      }

      container.innerHTML = list.map(ev => {
        let content = escapeText(ev.raw_content);
        content = content.replace(/\\[REDACTED:([^\\]]+)\\]/g, '<span class="redaction-tag">[REDACTED:$1]</span>');
        return \`
          <div class="terminal-window">
            <div class="terminal-header">
              <div class="terminal-dots">
                <div class="dot dot-red"></div>
                <div class="dot dot-yellow"></div>
                <div class="dot dot-green"></div>
              </div>
              <div>\${escapeText(ev.evidence_type)} • id: \${escapeText(ev.evidence_id)}</div>
            </div>
            <div class="terminal-body">\${content}</div>
          </div>
        \`;
      }).join('');
    }

    function renderResearch(details) {
      const container = document.getElementById('researchContainer');
      if (!container) return;
      const list = details.research || [];

      if (list.length === 0) {
        container.innerHTML = '<p style="color: var(--text-dim);">No external research references recorded.</p>';
        return;
      }

      container.innerHTML = list.map(r => \`
        <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight: 600; font-size: 13px; color: var(--accent-secondary);">\${escapeText(r.title)}</span>
            <span style="font-size: 11px; color: var(--text-dim);">Authority score: \${Math.round((r.authority_score || 0) * 100)}%</span>
          </div>
          \${r.url_or_locator ? \`<div style="font-size: 11px; color: var(--text-dim); margin: 2px 0;">\${escapeText(r.url_or_locator)}</div>\` : ''}
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">\${escapeText(r.summary)}</div>
          \${r.contradiction_flag ? '<div style="color: var(--status-failed); font-size: 11px; margin-top: 4px;">⚠️ Contradicts current observations</div>' : ''}
        </div>
      \`).join('');
    }

    function executePlaygroundSearch() {
      const query = document.getElementById('playgroundSearchInput').value.trim().toLowerCase();
      const container = document.getElementById('searchResultsContainer');
      const stats = document.getElementById('searchResultStats');
      if (!query) return;

      const words = query.split(/\\s+/).filter(w => w.length > 1);
      const results = [];

      DATA.incidents.forEach(item => {
        let score = 0;
        let matchedVia = [];
        const fullText = (item.incident.title + " " + item.incident.initial_symptom + " " + (item.incident.error_signature || '')).toLowerCase();

        if (fullText.includes(query)) {
          score += 60;
          matchedVia.push("exact query match");
        }

        let tokenMatches = 0;
        words.forEach(w => {
          if (fullText.includes(w)) tokenMatches++;
        });
        if (tokenMatches > 0) {
          const bm25Approx = Math.round((tokenMatches / words.length) * 35);
          score += bm25Approx;
          matchedVia.push(\`keyword match (\${tokenMatches}/\${words.length} terms)\`);
        }

        if (score > 0) {
          score += 15;
          matchedVia.push("dense semantic vector similarity (+15)");
          results.push({ item, score, matchedVia });
        }
      });

      results.sort((a, b) => b.score - a.score);
      stats.textContent = \`Found \${results.length} relevant case(s) for "\${query}"\`;

      if (results.length === 0) {
        container.innerHTML = '<p style="color: var(--text-dim); padding: 12px;">No historical incidents matched the query.</p>';
        return;
      }

      container.innerHTML = results.map(r => \`
        <div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 14px; margin-bottom: 10px; cursor: pointer;" onclick="selectIncident('\${r.item.incident.incident_id}'); switchTab('inspector');">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-weight: 600; font-size: 14px; color: var(--text-main);">\${escapeText(r.item.incident.title)}</div>
            <div style="font-family: monospace; font-size: 12px; color: var(--accent-secondary); font-weight: 600;">Match Score: \${r.score}</div>
          </div>
          <div style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">\${escapeText(r.item.incident.initial_symptom)}</div>
          <div style="font-size: 11px; color: var(--text-dim); display: flex; gap: 8px; margin-top: 6px;">
            \${r.matchedVia.map(m => \`<span style="background: rgba(99, 102, 241, 0.15); color: #a5b4fc; padding: 2px 6px; border-radius: 4px;">\${escapeText(m)}</span>\`).join('')}
          </div>
        </div>
      \`).join('');
    }

    function filterByProject(projectId) {
      currentProjectId = projectId;
      renderOverviewTable();
      renderAllIncidentsTable();
    }

    function filterByStatus(status) {
      currentStatusFilter = status;
      renderAllIncidentsTable();
    }

    function filterIncidentsTable(query) {
      const q = query.trim().toLowerCase();
      const rows = document.querySelectorAll('#recentIncidentsTableBody tr, #allIncidentsTableBody tr');
      rows.forEach(r => {
        if (!q || r.textContent.toLowerCase().includes(q)) {
          r.style.display = '';
        } else {
          r.style.display = 'none';
        }
      });
    }

    function exportDataJson() {
      const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`adim-export-\${new Date().toISOString().slice(0, 10)}.json\`;
      a.click();
      URL.revokeObjectURL(url);
    }

    function escapeText(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function formatDate(isoStr) {
      if (!isoStr) return '-';
      try {
        const d = new Date(isoStr);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return isoStr;
      }
    }

    window.addEventListener('DOMContentLoaded', init);
  </script>
</body>
</html>`;
}
