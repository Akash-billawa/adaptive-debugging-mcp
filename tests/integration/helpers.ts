import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { openDatabase } from "../../src/memory/db.ts";
import { Store } from "../../src/memory/store.ts";

let counter = 0;
export function tempDbPath(): string {
  counter++;
  return join(tmpdir(), `admcp-test-${Date.now()}-${counter}-${randomBytes(4).toString("hex")}.db`);
}

/** Open a Store on a fresh file-backed DB. Use `closeStore` then reopen the same path to simulate a restart. */
export function openStore(path: string): Store {
  const { db } = openDatabase(path);
  return new Store(db);
}

export function closeStore(store: Store): void {
  try {
    store.db.close();
  } catch {
    /* ignore */
  }
}
