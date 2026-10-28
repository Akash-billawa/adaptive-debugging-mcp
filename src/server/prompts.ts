/**
 * MCP Prompts surface (Tool Catalogue §7.2).
 *
 * Exposes reusable, structured debugging prompts to guide the agent through
 * adaptive investigation workflows without relying on hardcoded model defaults.
 */

import type { Store } from "../memory/store.ts";
import type { PromptDef } from "./protocol.ts";
import { notFound, validationError } from "../errors.ts";
import { listTimeline } from "../memory/audit.ts";

export interface PromptGetResult {
  description: string;
  messages: Array<{
    role: "user" | "assistant";
    content: {
      type: "text";
      text: string;
    };
  }>;
}

const PROMPT_DEFINITIONS: PromptDef[] = [
  {
    name: "debug_investigate_failure",
    description: "Start deep debugging: capture baseline, search history, and establish competing hypotheses.",
    arguments: [
      { name: "incident_id", description: "Target incident ID (e.g. inc_...)", required: true },
      { name: "symptom", description: "Observed error or symptom to investigate", required: false },
    ],
  },
  {
    name: "debug_resume_investigation",
    description: "Resume an ongoing debugging investigation: review audit timeline, inspect open attempts, and continue from recorded evidence.",
    arguments: [
      { name: "incident_id", description: "Target incident ID to resume", required: true },
    ],
  },
  {
    name: "debug_review_failures",
    description: "Review failed attempts in an incident: detect shared flawed assumptions and identify untried alternative strategies.",
    arguments: [
      { name: "incident_id", description: "Target incident ID", required: true },
    ],
  },
  {
    name: "debug_prepare_variant",
    description: "Prepare a differentiated variation node: require explicit reason_for_difference, expected_observation, and near-duplicate check.",
    arguments: [
      { name: "incident_id", description: "Incident ID", required: true },
      { name: "parent_experiment_id", description: "Parent experiment ID being refined", required: true },
    ],
  },
  {
    name: "debug_verify_fix",
    description: "Verify a candidate fix against the incident's explicit acceptance criteria before declaring resolution.",
    arguments: [
      { name: "incident_id", description: "Incident ID", required: true },
      { name: "experiment_id", description: "Experiment ID that implemented the fix candidate", required: true },
    ],
  },
];

export function listPromptsCatalog(): PromptDef[] {
  return PROMPT_DEFINITIONS;
}

export function getPromptHandler(
  store: Store,
  name: string,
  args: Record<string, string>,
): PromptGetResult {
  const incidentId = args.incident_id;
  if (!incidentId) {
    throw validationError(`Argument 'incident_id' is required for prompt '${name}'`);
  }

  const incident = store.getIncident(incidentId);

  switch (name) {
    case "debug_investigate_failure": {
      const symptom = args.symptom ?? incident?.initial_symptom ?? "Unknown symptom";
      return {
        description: `Start investigation for incident ${incidentId}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `You are conducting an adaptive debugging investigation for incident '${incidentId}'.\n\n` +
                `Initial Symptom:\n<untrusted_data>\n${symptom}\n</untrusted_data>\n` +
                (incident?.acceptance_criteria ? `Acceptance Criteria:\n<untrusted_data>\n${incident.acceptance_criteria}\n</untrusted_data>\n` : "") +
                `\nMANDATORY INVESTIGATION SEQUENCE:\n` +
                `1. Check Memory First: Call 'debug_history_search' with key error tokens or fingerprints to discover if similar failures occurred before.\n` +
                `2. Form Competing Hypotheses: Call 'debug_hypothesis_manage' (op: create_hypothesis) with at least 2 distinct testable claims before fixing.\n` +
                `3. Budget & Plan: Call 'debug_next_experiment_prepare' to verify exploration budget room and evaluate recommended actions.\n` +
                `4. Inspect Code: Locate relevant source files using native tools. Do not guess.\n` +
                `5. Record Before Executing: Create the experiment node with 'debug_attempt_create' including rationale, proposed_change, and expected_observation.\n` +
                `6. Test & Record Evidence: Execute test, attach raw output with 'debug_evidence_record', and update outcome honestly via 'debug_attempt_update'.\n`,
            },
          },
        ],
      };
    }

    case "debug_resume_investigation": {
      if (!incident) throw notFound(`Incident not found: ${incidentId}`);
      const timeline = listTimeline(store.db, incidentId).slice(-10);
      return {
        description: `Resume investigation for incident ${incidentId}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Resuming investigation for incident '${incidentId}' (${incident.title}).\n` +
                `Status: ${incident.status} | Reproduction: ${incident.reproduction_status}\n\n` +
                `Recent Timeline Events:\n` +
                timeline.map((t) => `- [${t.created_at}] (${t.event_type}) ${t.summary}`).join("\n") +
                `\n\nNEXT ACTIONS:\n` +
                `1. Call 'debug_next_experiment_prepare' to inspect the exhaustion state and candidate refinement ranking.\n` +
                `2. Inspect any 'interrupted' or 'inconclusive' attempts before generating new branches.\n` +
                `3. Choose the single best next action and proceed under normal permissions.\n`,
            },
          },
        ],
      };
    }

    case "debug_review_failures": {
      if (!incident) throw notFound(`Incident not found: ${incidentId}`);
      const experiments = store.allExperiments(incidentId);
      const failed = experiments.filter((e) => e.outcome_status === "failed");
      return {
        description: `Review failed attempts for incident ${incidentId}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Reviewing failed attempts for incident '${incidentId}'.\n` +
                `Total Experiments: ${experiments.length} | Failed: ${failed.length}\n\n` +
                `Failed Attempts on Record:\n` +
                failed
                  .map((f) => `- ${f.display_label ?? f.experiment_id}: ${f.title} (Reason: ${f.failure_reason ?? f.actual_observation ?? "unknown"})`)
                  .join("\n") +
                `\n\nADAPTIVE ANALYSIS GOALS:\n` +
                `1. Identify shared assumptions among the failed attempts.\n` +
                `2. If comparing 2 or more prospective fixes, call 'debug_candidate_compare' to inspect pairwise differences and duplicate warnings.\n` +
                `3. Do NOT retry an equivalent approach without new evidence or a materially changed condition.\n`,
            },
          },
        ],
      };
    }

    case "debug_prepare_variant": {
      const parentId = args.parent_experiment_id;
      if (!parentId) throw validationError("Argument 'parent_experiment_id' is required for debug_prepare_variant");
      const parent = store.db.query("SELECT * FROM experiments WHERE experiment_id = ?").get(parentId) as any;
      if (!parent) throw notFound(`Parent experiment not found: ${parentId}`);

      return {
        description: `Prepare variation under parent ${parentId}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Drafting a variation node under parent '${parent.display_label ?? parentId}' (${parent.title}).\n` +
                `Parent Outcome: ${parent.outcome_status} | Reason: ${parent.failure_reason ?? parent.interpretation ?? "none"}\n\n` +
                `VARIATION REQUIREMENTS:\n` +
                `1. State 'reason_for_difference': What specifically changes from the parent attempt and why could this change matter?\n` +
                `2. State 'expected_observation': What observable evidence will indicate the hypothesis is confirmed?\n` +
                `3. Call 'debug_attempt_create' with node_kind: 'variant', parent_experiment_id: '${parentId}', and reason_for_difference.\n`,
            },
          },
        ],
      };
    }

    case "debug_verify_fix": {
      const expId = args.experiment_id;
      if (!expId) throw validationError("Argument 'experiment_id' is required for debug_verify_fix");
      const exp = store.db.query("SELECT * FROM experiments WHERE experiment_id = ?").get(expId) as any;
      if (!exp) throw notFound(`Experiment not found: ${expId}`);

      return {
        description: `Verify fix candidate ${expId}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Verifying candidate fix in experiment '${exp.display_label ?? expId}' (${exp.title}).\n` +
                `Acceptance Criteria: ${incident?.acceptance_criteria ?? "Original failure condition disappears without regression"}\n\n` +
                `VERIFICATION RULES:\n` +
                `1. A green command or successful edit is NOT a verified fix. You must test the original failure condition.\n` +
                `2. Execute reproduction tests via host tools and observe results.\n` +
                `3. Record validation with 'debug_validation_record' (with execution_result: 'pass', criteria_results with each criterion status: 'passed', and evidence_ids).\n` +
                `4. If validation passes and receives resolution_decision: 'verified', call 'debug_case_status_update' with status: 'resolved' and verification_id: validation.validation_id.\n`,
            },
          },
        ],
      };
    }

    default:
      throw notFound(`Unknown prompt: ${name}`);
  }
}
