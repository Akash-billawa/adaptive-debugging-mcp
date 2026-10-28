import { test, expect } from "bun:test";
import { openStore, closeStore } from "./helpers.ts";
import { buildCatalog } from "../../src/server/catalog.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function setup() {
  const store = openStore(":memory:");
  const catalog = buildCatalog({ store, dbPath: ":memory:", log: () => {} });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await catalog.call(name, args);
    return res;
  };
  return { store, call };
}

test("debug_codebase_analyze: target_file cannot traverse outside repo_path", async () => {
  const { store, call } = setup();

  const startRes = (await call("debug_case_start", {
    project: { display_name: "SecApp" },
    title: "Testing path traversal",
    initial_symptom: "Symptom",
  })).structuredContent as any;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admcp-integ-traversal-"));
  const outsideFile = path.join(os.tmpdir(), `admcp-outside-file-${Date.now()}.txt`);
  fs.writeFileSync(outsideFile, "super sensitive outside content");

  try {
    const res = (await call("debug_codebase_analyze", {
      incident_id: startRes.incident_id,
      analysis_type: "file_snippet",
      repo_path: tmpDir,
      target_file: outsideFile,
    })).structuredContent as any;

    expect(res.ok).toBe(true);
    expect(res.finding.snippet).toContain("[Refused:");
    expect(res.finding.snippet).toContain("is outside repo_path");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(outsideFile)) fs.unlinkSync(outsideFile);
    closeStore(store);
  }
});

test("debug_codebase_analyze: revision starting with '-' is rejected", async () => {
  const { store, call } = setup();

  const startRes = (await call("debug_case_start", {
    project: { display_name: "SecApp" },
    title: "Testing git option injection",
    initial_symptom: "Symptom",
  })).structuredContent as any;

  const res = (await call("debug_codebase_analyze", {
    incident_id: startRes.incident_id,
    analysis_type: "git_diff",
    revision: "--output=/tmp/evil",
  })).structuredContent as any;

  expect(res.ok).toBe(true);
  expect(res.finding.summary).toContain("Invalid revision");
  expect(res.finding.summary).toContain("must not start with \"-\"");

  closeStore(store);
});

test("debug_codebase_analyze: enforces project canonical_root boundary", async () => {
  const { store, call } = setup();

  const canonDir = fs.mkdtempSync(path.join(os.tmpdir(), "admcp-canon-root-"));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "admcp-other-root-"));

  try {
    const startRes = (await call("debug_case_start", {
      project: {
        display_name: "BoundApp",
        canonical_root: canonDir,
      },
      title: "Testing canonical_root restriction",
      initial_symptom: "Symptom",
    })).structuredContent as any;

    // repo_path outside canonical_root should throw validationError
    let err: any;
    try {
      await call("debug_codebase_analyze", {
        incident_id: startRes.incident_id,
        analysis_type: "manifest_versions",
        repo_path: otherDir,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toContain("must be within the project's canonical root");
  } finally {
    fs.rmSync(canonDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
    closeStore(store);
  }
});

test("debug_codebase_analyze: emits secrets_redacted warning when secrets stripped", async () => {
  const { store, call } = setup();

  const startRes = (await call("debug_case_start", {
    project: { display_name: "SecApp" },
    title: "Testing secret redaction warnings",
    initial_symptom: "Symptom",
  })).structuredContent as any;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admcp-sec-warn-"));
  const secretFile = path.join(tmpDir, "credentials.env");
  fs.writeFileSync(secretFile, "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n");

  try {
    const res = (await call("debug_codebase_analyze", {
      incident_id: startRes.incident_id,
      analysis_type: "file_snippet",
      repo_path: tmpDir,
      target_file: "credentials.env",
    })).structuredContent as any;

    expect(res.ok).toBe(true);
    expect(res.finding.secrets_redacted).toBe(true);
    expect(res.warnings).toContain("secrets_redacted_from_codebase_output");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    closeStore(store);
  }
});

test("debug_data_export: out_file refuses to overwrite existing files and rejects unconfined paths", async () => {
  const { store, call } = setup();

  const startRes = (await call("debug_case_start", {
    project: { display_name: "ExportSecApp" },
    title: "Testing export safety",
    initial_symptom: "Symptom",
  })).structuredContent as any;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admcp-export-test-"));
  const existingFile = path.join(tmpDir, "existing.json");
  fs.writeFileSync(existingFile, JSON.stringify({ important: "do not overwrite" }));

  try {
    // 1. Attempt to overwrite an existing file -> must be rejected
    let overwriteErr: any;
    try {
      await call("debug_data_export", {
        incident_id: startRes.incident_id,
        format: "json",
        out_file: existingFile,
      });
    } catch (e) {
      overwriteErr = e;
    }
    expect(overwriteErr).toBeDefined();
    expect(overwriteErr.message).toContain("already exists and cannot be overwritten");

    // Verify existing file was preserved
    const fileContent = JSON.parse(fs.readFileSync(existingFile, "utf-8"));
    expect(fileContent.important).toBe("do not overwrite");

    // 2. Attempt to export to an unconfined root path outside allowed dirs
    // E.g., on Windows or Linux, a path in another arbitrary directory
    const unconfinedFile = path.resolve(process.platform === "win32" ? "C:\\admcp-unconfined.json" : "/admcp-unconfined.json");
    let unconfinedErr: any;
    try {
      await call("debug_data_export", {
        incident_id: startRes.incident_id,
        format: "json",
        out_file: unconfinedFile,
      });
    } catch (e) {
      unconfinedErr = e;
    }
    expect(unconfinedErr).toBeDefined();
    expect(unconfinedErr.message).toContain("out_file must be within an allowed export directory");

    // 3. New file in allowed directory (tmpdir) succeeds
    const newFile = path.join(tmpDir, "new_export.json");
    const successRes = (await call("debug_data_export", {
      incident_id: startRes.incident_id,
      format: "json",
      out_file: newFile,
    })).structuredContent as any;

    expect(successRes.ok).toBe(true);
    expect(fs.existsSync(newFile)).toBe(true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    closeStore(store);
  }
});
