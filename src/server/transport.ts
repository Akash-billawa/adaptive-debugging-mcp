import type { ToolCatalog } from "./protocol.ts";
import { handleMessage, SERVER_NAME } from "./protocol.ts";

const decoder = new TextDecoder();

function writeMessage(obj: unknown): void {
  const line = JSON.stringify(obj);
  process.stdout.write(line + "\n");
}

/**
 * Run an MCP server over stdio. Reads newline-delimited JSON-RPC messages from
 * stdin, writes one JSON response per line to stdout. All diagnostics go to
 * stderr so they never corrupt the protocol stream.
 */
export async function startStdioServer(catalog: ToolCatalog, log: (msg: string) => void): Promise<void> {
  log("stdio transport ready");

  async function processLine(line: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    if (Array.isArray(msg)) {
      const responses = [];
      for (const item of msg) {
        const res = await handleMessage(catalog, item);
        if (res) responses.push(res);
      }
      if (responses.length > 0) writeMessage(responses);
      return;
    }

    const res = await handleMessage(catalog, msg);
    if (res) writeMessage(res);
  }

  const stream = (Bun.stdin.stream() as unknown) as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) await processLine(line);
      }
    }
    // flush any residual (no trailing newline)
    const tail = buffer.trim();
    if (tail.length > 0) await processLine(tail);
  } catch (e) {
    log(`stdin stream error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    log("stdin closed; shutting down");
  }
}

export { SERVER_NAME };
