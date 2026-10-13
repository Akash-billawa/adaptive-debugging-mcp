import type { Database } from "bun:sqlite";
import { ids } from "./ids.ts";
import { now, safeParseJson } from "../util.ts";
import type { CaptureSource, RelationshipType } from "../vocab.ts";
import type { EntityLink, TimelineEvent } from "../types.ts";

/** Append-only audit timeline. The investigation history is never erased. */

export interface AppendEventInput {
  incident_id: string;
  event_type: string;
  actor: CaptureSource;
  summary: string;
  related_entity_type?: string | null;
  related_entity_id?: string | null;
  details?: Record<string, unknown> | null;
  evidence_refs?: string[] | null;
}

export function appendTimelineEvent(db: Database, input: AppendEventInput): TimelineEvent {
  const ev: TimelineEvent = {
    event_id: ids.event(),
    incident_id: input.incident_id,
    event_type: input.event_type,
    actor: input.actor,
    related_entity_type: input.related_entity_type ?? null,
    related_entity_id: input.related_entity_id ?? null,
    summary: input.summary,
    details: input.details ? JSON.stringify(input.details) : null,
    evidence_refs: input.evidence_refs ? JSON.stringify(input.evidence_refs) : null,
    created_at: now(),
  };
  db.query(
    `INSERT INTO timeline_events
     (event_id, incident_id, event_type, actor, related_entity_type, related_entity_id, summary, details, evidence_refs, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ev.event_id,
    ev.incident_id,
    ev.event_type,
    ev.actor,
    ev.related_entity_type,
    ev.related_entity_id,
    ev.summary,
    ev.details,
    ev.evidence_refs,
    ev.created_at,
  );
  return ev;
}

export function listTimeline(db: Database, incidentId: string): TimelineEvent[] {
  return db
    .query("SELECT * FROM timeline_events WHERE incident_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(incidentId) as unknown as TimelineEvent[];
}

// --- Entity links ----------------------------------------------------------

export interface CreateLinkInput {
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  relationship_type: RelationshipType;
  rationale?: string | null;
  actor: CaptureSource;
}

export function createLink(db: Database, input: CreateLinkInput): EntityLink {
  const link: EntityLink = {
    link_id: ids.link(),
    source_type: input.source_type,
    source_id: input.source_id,
    target_type: input.target_type,
    target_id: input.target_id,
    relationship_type: input.relationship_type,
    rationale: input.rationale ?? null,
    actor: input.actor,
    created_at: now(),
  };
  db.query(
    `INSERT INTO entity_links
     (link_id, source_type, source_id, target_type, target_id, relationship_type, rationale, actor, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    link.link_id,
    link.source_type,
    link.source_id,
    link.target_type,
    link.target_id,
    link.relationship_type,
    link.rationale,
    link.actor,
    link.created_at,
  );
  return link;
}

export function parseEvidenceRefs(link: { evidence_refs: string | null }): string[] {
  return safeParseJson<string[]>(link.evidence_refs, []);
}
