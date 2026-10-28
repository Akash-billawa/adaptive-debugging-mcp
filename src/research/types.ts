import type { ResearchType } from "../vocab.ts";

export type ResearchQuestionType =
  | "version_check"
  | "recent_regression"
  | "error_signature"
  | "compatibility_constraint"
  | "workaround_discovery";

export interface ResearchQuestion {
  question_id: string;
  query_type: ResearchQuestionType;
  question: string;
  recommended_source: ResearchType;
  target_entity: string;
  priority: "high" | "medium" | "low";
  rationale: string;
}

export interface ResearchPlan {
  incident_id: string;
  focus_summary: string;
  questions: ResearchQuestion[];
  recommended_sources: ResearchType[];
  unresolved_hypotheses_count: number;
  guidelines: string[];
}

export interface ResearchEnvironment {
  runtime_name?: string;
  runtime_version?: string;
  packages?: Record<string, string>;
  os_name?: string;
  os_version?: string;
}

export type CodebaseAnalysisType =
  | "manifest_versions"
  | "git_log"
  | "git_blame"
  | "git_diff"
  | "file_snippet";

export interface CodebaseAnalysisRequest {
  repo_path?: string;
  analysis_type: CodebaseAnalysisType;
  target_file?: string;
  line_start?: number;
  line_end?: number;
  max_results?: number;
  revision?: string;
}

export interface GitCommitRecord {
  commit_hash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitBlameRecord {
  line_number: number;
  commit_hash: string;
  author: string;
  content: string;
}

export interface GitDiffSummary {
  files_changed: number;
  additions: number;
  deletions: number;
  diff_snippet: string;
  /** Set when git could not produce the diff (bad revision, not a repository, ...). */
  error?: string;
}

export interface CodebaseFinding {
  analysis_type: CodebaseAnalysisType;
  target_path?: string;
  summary: string;
  version_info?: Record<string, string>;
  commits?: GitCommitRecord[];
  blame_lines?: GitBlameRecord[];
  diff_summary?: GitDiffSummary;
  snippet?: string;
  secrets_redacted: boolean;
  untrusted_data: boolean;
}

export interface CandidateSourceInput {
  source_title: string;
  source_uri?: string;
  source_type: ResearchType;
  excerpt: string;
  claimed_version?: string;
  claims: string[];
  published_at?: string;
  reliability_note?: string;
}

export type SourceVerdict =
  | "highly_relevant"
  | "contextual"
  | "low_relevance"
  | "contradicted"
  | "unverified";

export interface SourceEvaluation {
  source_title: string;
  source_type: ResearchType;
  authority_score: number;
  version_match_score: number;
  symptom_match_score: number;
  overall_quality: number;
  verdict: SourceVerdict;
  reasons: string[];
  reliability_note: string;
  conflicts_detected: string[];
  untrusted_warning: string;
}
