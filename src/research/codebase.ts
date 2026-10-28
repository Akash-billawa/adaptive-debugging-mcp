import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { redact } from "../security/redaction.ts";
import type {
  CodebaseAnalysisRequest,
  CodebaseFinding,
  GitBlameRecord,
  GitCommitRecord,
  GitDiffSummary,
} from "./types.ts";

// analyzeCodebase() is synchronous, so a module-level counter is safe: it is reset at the start of every call.
let redactionHits = 0;

/** Redact `text`, remembering that something was removed so the finding can report `secrets_redacted`. */
function scrub(text: string): string {
  const r = redact(text);
  if (r.status === "redacted") redactionHits++;
  return r.text;
}

/** Largest file file_snippet will read into memory. */
const MAX_SNIPPET_FILE_BYTES = 2 * 1024 * 1024;

/** A git revision / range: no leading "-" (it would be parsed as an option, e.g. --output=<file>), no spaces or control characters. */
const SAFE_REVISION = /^[A-Za-z0-9_][A-Za-z0-9_.\/~^@{}:+-]*$/;

/**
 * Parses package manifests (package.json, requirements.txt, pyproject.toml, Cargo.toml)
 * in the target directory to extract declared dependency versions and engine constraints.
 */
export function parseManifestVersions(rootDir: string): Record<string, string> {
  const versions: Record<string, string> = {};

  // 1. package.json
  const pkgJsonPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const raw = fs.readFileSync(pkgJsonPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.name && pkg.version) {
        versions[`@root/${pkg.name}`] = String(pkg.version);
      }
      if (pkg.engines && typeof pkg.engines === "object") {
        for (const [k, v] of Object.entries(pkg.engines)) {
          versions[`engine:${k}`] = String(v);
        }
      }
      if (pkg.dependencies && typeof pkg.dependencies === "object") {
        for (const [k, v] of Object.entries(pkg.dependencies)) {
          versions[k] = String(v);
        }
      }
      if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
        for (const [k, v] of Object.entries(pkg.devDependencies)) {
          if (!versions[k]) versions[k] = String(v);
        }
      }
    } catch {
      // Ignore parse failure on malformed json
    }
  }

  // 2. requirements.txt
  const reqTxtPath = path.join(rootDir, "requirements.txt");
  if (fs.existsSync(reqTxtPath)) {
    try {
      const raw = fs.readFileSync(reqTxtPath, "utf-8");
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = trimmed.match(/^([a-zA-Z0-9_\-.]+)\s*([=><~^!].*)?$/);
        if (match) {
          const pkgName = match[1];
          const constraint = match[2]?.trim() ?? "any";
          if (!versions[pkgName]) versions[pkgName] = constraint;
        }
      }
    } catch {
      // Ignore
    }
  }

  // 3. pyproject.toml
  const pyprojPath = path.join(rootDir, "pyproject.toml");
  if (fs.existsSync(pyprojPath)) {
    try {
      const raw = fs.readFileSync(pyprojPath, "utf-8");
      const lines = raw.split(/\r?\n/);
      let inDeps = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          inDeps =
            trimmed.includes("dependencies") ||
            trimmed.includes("tool.poetry.dependencies");
          continue;
        }
        if (inDeps && trimmed && !trimmed.startsWith("#")) {
          const parts = trimmed.split("=");
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const val = parts.slice(1).join("=").trim().replace(/['"]/g, "");
            if (!versions[key]) versions[key] = val;
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  // 4. Cargo.toml
  const cargoPath = path.join(rootDir, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    try {
      const raw = fs.readFileSync(cargoPath, "utf-8");
      const lines = raw.split(/\r?\n/);
      let inDeps = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          inDeps = trimmed.includes("dependencies");
          continue;
        }
        if (inDeps && trimmed && !trimmed.startsWith("#")) {
          const parts = trimmed.split("=");
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const val = parts.slice(1).join("=").trim().replace(/['"]/g, "");
            if (!versions[key]) versions[key] = val;
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  return versions;
}

/**
 * Executes a git command safely in the specified directory.
 */
function runGit(repoPath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    if (res.error) {
      return { ok: false, stdout: "", stderr: res.error.message };
    }
    return {
      ok: res.status === 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: err?.message ?? String(err) };
  }
}

/**
 * Retrieves git commit log for the repository or a specific file.
 */
export function getGitLog(
  repoPath: string,
  targetFile?: string,
  maxResults = 10,
): GitCommitRecord[] {
  const count = Math.max(1, Math.min(50, maxResults));
  const args = [
    "log",
    `-n`,
    String(count),
    `--pretty=format:%H|||%an|||%ad|||%s`,
    `--date=short`,
  ];
  if (targetFile) {
    args.push("--", targetFile);
  }

  const res = runGit(repoPath, args);
  if (!res.ok || !res.stdout.trim()) {
    return [];
  }

  const commits: GitCommitRecord[] = [];
  const lines = res.stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("|||");
    if (parts.length >= 4) {
      commits.push({
        commit_hash: parts[0].trim(),
        author: parts[1].trim(),
        date: parts[2].trim(),
        message: scrub(parts[3].trim()),
      });
    }
  }
  return commits;
}

/**
 * Retrieves git blame records for a target file across an optional line range.
 */
export function getGitBlame(
  repoPath: string,
  targetFile: string,
  lineStart?: number,
  lineEnd?: number,
): GitBlameRecord[] {
  const args = ["blame", "--date=short"];
  if (lineStart !== undefined && lineEnd !== undefined && lineStart > 0 && lineEnd >= lineStart) {
    args.push(`-L`, `${lineStart},${lineEnd}`);
  }
  args.push("--", targetFile);

  const res = runGit(repoPath, args);
  if (!res.ok || !res.stdout.trim()) {
    return [];
  }

  const records: GitBlameRecord[] = [];
  const lines = res.stdout.split(/\r?\n/);
  let lineCounter = lineStart ?? 1;

  for (const line of lines) {
    if (!line.trim()) continue;
    // Format: <hash> (<author> <date> <lineno>) <content>
    const match = line.match(/^([0-9a-fA-F^]+)\s+\((.*?)\s+(\d{4}-\d{2}-\d{2})\s+(\d+)\)\s?(.*)$/);
    if (match) {
      records.push({
        commit_hash: match[1],
        author: match[2].trim(),
        line_number: Number(match[4]),
        content: scrub(match[5]),
      });
    } else {
      // Fallback
      records.push({
        commit_hash: "unknown",
        author: "unknown",
        line_number: lineCounter++,
        content: scrub(line),
      });
    }
  }
  return records;
}

/**
 * Retrieves git diff summary and bounded diff snippet.
 */
export function getGitDiff(
  repoPath: string,
  revision = "HEAD",
  targetFile?: string,
): GitDiffSummary {
  const statArgs = ["diff", "--stat", revision];
  if (targetFile) statArgs.push("--", targetFile);

  const statRes = runGit(repoPath, statArgs);
  let filesChanged = 0;
  let additions = 0;
  let deletions = 0;

  if (statRes.ok && statRes.stdout.trim()) {
    // E.g. " 3 files changed, 45 insertions(+), 12 deletions(-)"
    const match = statRes.stdout.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
    if (match) {
      filesChanged = Number(match[1] ?? 0);
      additions = Number(match[2] ?? 0);
      deletions = Number(match[3] ?? 0);
    }
  }

  const patchArgs = ["diff", "-U2", revision];
  if (targetFile) patchArgs.push("--", targetFile);
  const patchRes = runGit(repoPath, patchArgs);

  // A bad revision used to look like an empty diff ("0 files changed"), which reads as "nothing changed".
  const failure = !statRes.ok && !patchRes.ok ? (statRes.stderr || patchRes.stderr).trim().split(/\r?\n/)[0] : "";

  let snippet = patchRes.stdout ?? "";
  if (snippet.length > 4000) {
    snippet = snippet.slice(0, 4000) + "\n... [diff truncated]";
  }

  return {
    files_changed: filesChanged,
    additions,
    deletions,
    diff_snippet: scrub(snippet),
    ...(failure ? { error: scrub(failure) } : {}),
  };
}

/**
 * Safely slices a file snippet from disk with bounded line numbers.
 */
export function getFileSnippet(
  repoPath: string,
  targetFile: string,
  lineStart = 1,
  lineEnd = 100,
): string {
  const fullPath = path.isAbsolute(targetFile) ? targetFile : path.join(repoPath, targetFile);
  if (!fs.existsSync(fullPath)) {
    return `[File not found: ${targetFile}]`;
  }
  try {
    // The file must live inside repo_path. An absolute target_file or "../" used to read any file the server can
    // (/etc/passwd, ~/.ssh/...), and symlinks are resolved so a link inside the repo cannot point out of it.
    const realRoot = fs.realpathSync(repoPath);
    const realFile = fs.realpathSync(fullPath);
    const rel = path.relative(realRoot, realFile);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) {
      return `[Refused: ${targetFile} is outside repo_path]`;
    }
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) return `[Refused: ${targetFile} is not a regular file]`;
    if (stat.size > MAX_SNIPPET_FILE_BYTES) return `[Refused: ${targetFile} is larger than ${MAX_SNIPPET_FILE_BYTES} bytes]`;
    const raw = fs.readFileSync(realFile, "utf-8");
    const lines = raw.split(/\r?\n/);
    const startIdx = Math.max(0, lineStart - 1);
    const endIdx = Math.min(lines.length, Math.max(startIdx + 1, lineEnd));
    const slice = lines.slice(startIdx, endIdx);
    const numbered = slice.map((l, i) => `${startIdx + i + 1}: ${l}`).join("\n");
    return scrub(numbered);
  } catch (err: any) {
    return `[Failed to read file: ${err?.message ?? String(err)}]`;
  }
}

/**
 * Main dispatcher for codebase analysis.
 */
export function analyzeCodebase(req: CodebaseAnalysisRequest): CodebaseFinding {
  const repoPath = req.repo_path ? path.resolve(req.repo_path) : process.cwd();
  redactionHits = 0;

  switch (req.analysis_type) {
    case "manifest_versions": {
      const versions = parseManifestVersions(repoPath);
      const count = Object.keys(versions).length;
      return {
        analysis_type: "manifest_versions",
        target_path: repoPath,
        summary: `Extracted ${count} dependency/engine version constraints from package manifests.`,
        version_info: versions,
        secrets_redacted: false,
        untrusted_data: true,
      };
    }

    case "git_log": {
      const commits = getGitLog(repoPath, req.target_file, req.max_results ?? 10);
      const summary = commits.length > 0
        ? `Found ${commits.length} recent commits${req.target_file ? ` affecting ${req.target_file}` : ""}. Latest: ${commits[0]?.commit_hash.slice(0, 7)} by ${commits[0]?.author}.`
        : `No git commit history found or target not in a git repository.`;
      return {
        analysis_type: "git_log",
        target_path: req.target_file ?? repoPath,
        summary,
        commits,
        secrets_redacted: redactionHits > 0,
        untrusted_data: true,
      };
    }

    case "git_blame": {
      if (!req.target_file) {
        return {
          analysis_type: "git_blame",
          summary: "target_file is required for git_blame analysis.",
          secrets_redacted: false,
          untrusted_data: true,
        };
      }
      const records = getGitBlame(repoPath, req.target_file, req.line_start, req.line_end);
      const authors = Array.from(new Set(records.map((r) => r.author)));
      return {
        analysis_type: "git_blame",
        target_path: req.target_file,
        summary: `Blame for ${req.target_file} (${records.length} lines, contributors: ${authors.join(", ")}).`,
        blame_lines: records,
        secrets_redacted: redactionHits > 0,
        untrusted_data: true,
      };
    }

    case "git_diff": {
      const revision = req.revision ?? "HEAD";
      if (!SAFE_REVISION.test(revision)) {
        return {
          analysis_type: "git_diff",
          summary: `Invalid revision ${JSON.stringify(revision)}: it must not start with "-" or contain whitespace.`,
          secrets_redacted: false,
          untrusted_data: true,
        };
      }
      const diff = getGitDiff(repoPath, revision, req.target_file);
      return {
        analysis_type: "git_diff",
        target_path: req.target_file ?? repoPath,
        summary: diff.error
          ? `Git diff against ${revision} failed: ${diff.error}`
          : `Git diff against ${revision}: ${diff.files_changed} files changed (+${diff.additions}, -${diff.deletions}).`,
        diff_summary: diff,
        secrets_redacted: redactionHits > 0,
        untrusted_data: true,
      };
    }

    case "file_snippet": {
      if (!req.target_file) {
        return {
          analysis_type: "file_snippet",
          summary: "target_file is required for file_snippet analysis.",
          secrets_redacted: false,
          untrusted_data: true,
        };
      }
      const snippet = getFileSnippet(repoPath, req.target_file, req.line_start ?? 1, req.line_end ?? 100);
      return {
        analysis_type: "file_snippet",
        target_path: req.target_file,
        summary: `Extracted lines ${req.line_start ?? 1}-${req.line_end ?? 100} from ${req.target_file}.`,
        snippet,
        secrets_redacted: redactionHits > 0,
        untrusted_data: true,
      };
    }

    default:
      return {
        analysis_type: req.analysis_type,
        summary: `Unsupported analysis type: ${req.analysis_type}`,
        secrets_redacted: false,
        untrusted_data: true,
      };
  }
}
