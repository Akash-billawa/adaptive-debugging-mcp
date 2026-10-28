import type { Tool, ToolContext } from "../context.ts";
import { str, objSchema, optStr, reqStr } from "../context.ts";
import { validationError } from "../../errors.ts";
import { isOneOf, RELATIONSHIP_TYPES } from "../../vocab.ts";
import { readSchemaVersion, SCHEMA_VERSION } from "../../memory/schema.ts";
import { generateDashboardHtml } from "../../dashboard/generator.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

const REL_ENUM = [...RELATIONSHIP_TYPES];

function validateAndWriteExport(
  outFile: string,
  content: string,
  ctx: ToolContext,
  projectId?: string,
): string {
  const allowedRoots: string[] = [
    path.resolve(tmpdir()),
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), "exports"),
  ];

  if (process.env.ADM_EXPORT_DIR) {
    allowedRoots.push(path.resolve(process.env.ADM_EXPORT_DIR));
  }

  if (ctx.dbPath && ctx.dbPath !== ":memory:") {
    allowedRoots.push(path.resolve(path.dirname(ctx.dbPath)));
  }

  if (projectId) {
    const proj = ctx.store.getProject(projectId);
    if (proj?.canonical_root) {
      allowedRoots.push(path.resolve(proj.canonical_root));
    }
  }

  const resolvedOut = path.resolve(outFile);

  const isSubpath = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel));
  };

  const isAllowed = allowedRoots.some((root) => isSubpath(root, resolvedOut));
  if (!isAllowed) {
    throw validationError(`out_file must be within an allowed export directory: ${outFile}`);
  }

  const targetDir = path.dirname(resolvedOut);
  mkdirSync(targetDir, { recursive: true });

  try {
    writeFileSync(resolvedOut, content, { flag: "wx", encoding: "utf-8" });
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      throw validationError(`out_file already exists and cannot be overwritten: ${outFile}`);
    }
    throw err;
  }

  return resolvedOut;
}

export const metaTools: Tool[] = [
  {
    def: {
      name: "debug_case_link",
      description:
        "Link related entities (e.g. similar incidents, hypothesis contradicted by evidence, experiment superseded by another) " +
        "without merging them. A 'similar' link does not imply identical root cause.",
      inputSchema: objSchema(
        "Create a relationship link",
        {
          source_type: str("Entity type", { enum: ["incident", "experiment", "hypothesis", "strategy", "evidence", "validation_run", "research_reference"] }),
          source_id: str("Source entity id"),
          target_type: str("Entity type", { enum: ["incident", "experiment", "hypothesis", "strategy", "evidence", "validation_run", "research_reference"] }),
          target_id: str("Target entity id"),
          relationship_type: str("Relationship", { enum: REL_ENUM }),
          rationale: str("Why these are related"),
          actor: str("Actor", { default: "agent" }),
        },
        ["source_type", "source_id", "target_type", "target_id", "relationship_type"],
      ),
    },
    handle(ctx, args) {
      const relationship_type = reqStr(args, "relationship_type");
      if (!isOneOf(RELATIONSHIP_TYPES, relationship_type)) throw validationError(`invalid relationship_type: ${relationship_type}`);
      const link = ctx.store.link({
        source_type: reqStr(args, "source_type"),
        source_id: reqStr(args, "source_id"),
        target_type: reqStr(args, "target_type"),
        target_id: reqStr(args, "target_id"),
        relationship_type,
        rationale: optStr(args, "rationale"),
        actor: optStr(args, "actor") ?? "agent",
      });
      return { ok: true, link_id: link.link_id, warnings: ["similar_link_does_not_imply_same_cause"] };
    },
  },

  {
    def: {
      name: "debug_data_export",
      description:
        "Export an incident, project history, or cross-project visual dashboard for backup/review/migration. Read-only. " +
        "Supports 'json' (data structure) or 'html' (standalone interactive visual dashboard) format.",
      inputSchema: objSchema(
        "Export data",
        {
          incident_id: str("Export this incident (with its tree, evidence metadata, validations, timeline)"),
          project_id: str("Or export incident ids / dashboard for this project"),
          format: str("Export format ('json' or 'html')", { enum: ["json", "html"], default: "json" }),
          out_file: str("Optional destination file path to write the exported JSON or HTML"),
        },
        [],
      ),
    },
    handle(ctx, args) {
      const incident_id = optStr(args, "incident_id");
      const project_id = optStr(args, "project_id");
      const format = optStr(args, "format") ?? "json";
      const out_file = optStr(args, "out_file");

      let effectiveProjectId = project_id;
      if (incident_id && !effectiveProjectId) {
        const inc = ctx.store.getIncidentOrFail(incident_id);
        effectiveProjectId = inc.project_id;
      }

      if (format === "html") {
        const html = generateDashboardHtml(ctx.store, {
          projectId: project_id ?? undefined,
          incidentId: incident_id ?? undefined,
        });

        if (out_file) {
          const writtenPath = validateAndWriteExport(out_file, html, ctx, effectiveProjectId);
          return {
            ok: true,
            format: "html",
            out_file: writtenPath,
            html_length: html.length,
            summary: `Interactive visual dashboard exported successfully to ${writtenPath}`,
          };
        }

        return {
          ok: true,
          format: "html",
          html_length: html.length,
          dashboard_html: html,
          summary: "Interactive standalone visual dashboard generated successfully.",
        };
      }

      if (!incident_id && !project_id) throw validationError("provide incident_id or project_id");
      const now = new Date().toISOString();

      let exportPayload: Record<string, unknown>;

      if (incident_id) {
        const inc = ctx.store.getIncidentOrFail(incident_id);
        exportPayload = {
          ok: true,
          schema_version: SCHEMA_VERSION,
          exported_at: now,
          incident: inc,
          hypotheses: ctx.store.listHypotheses(incident_id),
          strategies: ctx.store.listStrategies(incident_id),
          experiments: ctx.store.allExperiments(incident_id).map((e) => ({
            ...e,
            evidence_refs: ctx.store.listEvidence({ experiment_id: e.experiment_id }).map((ev) => ({
              evidence_id: ev.evidence_id, type: ev.evidence_type, redaction_status: ev.redaction_status,
            })),
          })),
          validations: ctx.store.listValidations(incident_id),
          research: ctx.store.listResearch(incident_id),
          warnings: ["raw_evidence_content_is_redacted_and_bounded"],
        };
      } else {
        const incidents = ctx.store.db
          .query("SELECT incident_id FROM incidents WHERE project_id = ? ORDER BY created_at ASC")
          .all(project_id!) as { incident_id: string }[];
        exportPayload = {
          ok: true,
          schema_version: SCHEMA_VERSION,
          exported_at: now,
          project_id,
          incidents: incidents.map((i) => i.incident_id),
          warnings: ["raw_evidence_content_is_redacted_and_bounded"],
        };
      }

      if (out_file) {
        const writtenPath = validateAndWriteExport(out_file, JSON.stringify(exportPayload, null, 2), ctx, effectiveProjectId);
        return {
          ...exportPayload,
          out_file: writtenPath,
          summary: `JSON export written successfully to ${writtenPath}`,
        };
      }

      return exportPayload;
    },
  },

  {
    def: {
      name: "debug_server_health",
      description:
        "Report whether the server can reliably record and retrieve history: schema version, read/write readiness, " +
        "FTS availability, and record counts. Distinguishes required failures from optional unavailability.",
      inputSchema: objSchema("Server health", {}, []),
    },
    handle(ctx) {
      const checks: Record<string, unknown> = {};
      let ok = true;
      try {
        const count = (sql: string) => (ctx.store.db.query(sql).get() as { c: number }).c;
        checks.incidents = count("SELECT COUNT(*) c FROM incidents");
        checks.experiments = count("SELECT COUNT(*) c FROM experiments");
        checks.evidence = count("SELECT COUNT(*) c FROM evidence");
        checks.timeline_events = count("SELECT COUNT(*) c FROM timeline_events");
        checks.schema_version = readSchemaVersion(ctx.store.db);
        // Write probe: test actual write readiness by writing to the meta table in a transaction
        let writeOk = false;
        try {
          ctx.store.db.transaction(() => {
            ctx.store.db
              .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('_health_check_probe', ?)")
              .run(new Date().toISOString());
            writeOk = true;
          })();
        } catch {
          writeOk = false;
        }
        checks.write_ready = writeOk;
        checks.fts = (() => {
          try {
            ctx.store.db.query("SELECT count(*) c FROM incident_fts").get();
            return true;
          } catch {
            return false;
          }
        })();
      } catch (e) {
        ok = false;
        checks.error = e instanceof Error ? e.message : String(e);
      }
      return { ok, database: { path: ctx.dbPath }, checks, warnings: [] };
    },
  },
];
