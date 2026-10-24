import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseManifestVersions,
  getFileSnippet,
  analyzeCodebase,
} from "../../src/research/codebase.ts";

describe("codebase analysis helpers", () => {
  it("parseManifestVersions: parses package.json, requirements.txt, and pyproject.toml", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admcp-codebase-test-"));

    try {
      // 1. package.json
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({
          name: "my-test-app",
          version: "1.2.3",
          engines: { node: ">=18.0.0" },
          dependencies: { express: "^4.18.2", lodash: "4.17.21" },
          devDependencies: { typescript: "^5.0.0" },
        }),
      );

      // 2. requirements.txt
      fs.writeFileSync(
        path.join(tmpDir, "requirements.txt"),
        `# A comment\nrequests>=2.28.0\npytest==7.4.0\n`,
      );

      // 3. pyproject.toml
      fs.writeFileSync(
        path.join(tmpDir, "pyproject.toml"),
        `[project.dependencies]\nfastapi = ">=0.100.0"\n`,
      );

      const versions = parseManifestVersions(tmpDir);

      expect(versions["@root/my-test-app"]).toBe("1.2.3");
      expect(versions["engine:node"]).toBe(">=18.0.0");
      expect(versions["express"]).toBe("^4.18.2");
      expect(versions["lodash"]).toBe("4.17.21");
      expect(versions["typescript"]).toBe("^5.0.0");
      expect(versions["requests"]).toBe(">=2.28.0");
      expect(versions["pytest"]).toBe("==7.4.0");
      expect(versions["fastapi"]).toBe(">=0.100.0");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getFileSnippet: slices lines accurately and redacts secrets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "admcp-snippet-test-"));
    try {
      const filePath = path.join(tmpDir, "sample.ts");
      const content = [
        "line 1: import express from 'express';",
        "line 2: const apiKey = 'AKIAIOSFODNN7EXAMPLE';",
        "line 3: export function run() {",
        "line 4:   console.log('running');",
        "line 5: }",
      ].join("\n");
      fs.writeFileSync(filePath, content);

      const snippet = getFileSnippet(tmpDir, "sample.ts", 2, 4);
      expect(snippet).toContain("2: line 2:");
      expect(snippet).toContain("[REDACTED:apikey]");
      expect(snippet).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(snippet).toContain("4: line 4:");
      expect(snippet).not.toContain("5: line 5");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("analyzeCodebase: runs manifest_versions analysis and sets untrusted_data flag", () => {
    const result = analyzeCodebase({
      analysis_type: "manifest_versions",
      repo_path: path.resolve(import.meta.dir, "../../"),
    });

    expect(result.analysis_type).toBe("manifest_versions");
    expect(result.untrusted_data).toBe(true);
    expect(result.version_info).toBeDefined();
    // This repo has package.json with name "adaptive-debugging-mcp"
    expect(result.version_info!["@root/adaptive-debugging-mcp"]).toBeDefined();
  });

  it("analyzeCodebase: handles non-existent file gracefully", () => {
    const result = analyzeCodebase({
      analysis_type: "file_snippet",
      target_file: "non-existent-file-12345.ts",
    });

    expect(result.analysis_type).toBe("file_snippet");
    expect(result.snippet).toContain("[File not found:");
  });
});
