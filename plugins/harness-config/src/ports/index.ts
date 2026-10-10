// Ports: what the harness-config plugin needs from the outside world.
import type { Change } from "../domain/diff.ts";
import type { McpServer, Target } from "../domain/model.ts";

/**
 * One harness configuration file, as a codec over its text: no I/O here, the app reads and writes
 * through FileSystem. T is McpServer for MCP sections and the block text for instruction files.
 */
export interface HarnessConfigFile<T = McpServer | string> {
  target: Target;
  /** Absolute path (may be a symlink; FileSystem writes through it). */
  path: string;
  /** Entries this file currently holds in its owned section. `null` text = file missing. */
  read(text: string | null): Record<string, T>;
  /**
   * Merges `change` into `text` and returns the new text. Everything outside the owned entries must
   * survive. Throws RefusedError when that cannot be guaranteed (for example a TOML comment would be
   * lost) unless `force` is set.
   */
  render(text: string | null, change: Change<T>, opts: { force: boolean }): string;
}

export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

export interface FileSystem {
  /** null when the file does not exist. */
  read(path: string): Promise<string | null>;
  /**
   * Writes atomically. A symlink is written through (its target is replaced, the link stays), and an
   * existing file keeps its permission bits; new files are created 0600 since they may hold secrets.
   */
  write(path: string, text: string): Promise<void>;
  /** Copies the current file (through symlinks) to a sibling `<real>.<suffix>`; returns its path, or null if missing. */
  backup(path: string, suffix: string): Promise<string | null>;
}

export interface Clock {
  now(): Date;
}

/** Resolves `${env:NAME}` and `${file:path}` references. Throws when one cannot be resolved. */
export interface SecretResolver {
  resolve(value: string): Promise<string>;
}

export interface Events {
  /** `name` is relative to the plugin, e.g. `applied` becomes `harness-config.applied`. */
  emit(name: string, data: unknown): Promise<void>;
}
