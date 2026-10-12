// Ports: what the harness-config plugin needs from the outside world.
import type { Change, SkillState } from "../domain/diff.ts";
import type { Hook, McpServer, SkillMode, Target } from "../domain/model.ts";

/**
 * One harness configuration file, as a codec over its text: no I/O here, the app reads and writes
 * through FileSystem. T is McpServer for MCP sections, the block text for instruction files and
 * Hook for hook settings.
 */
export interface HarnessConfigFile<T = McpServer | string | Hook> {
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

/** A harness's skills directory: one entry (directory or symlink) per skill, named like the skill. */
export interface SkillsDir {
  target: Target;
  /** Absolute path of the skills directory (may be a symlink or missing). */
  path: string;
}

/** A harness section the plugin deliberately does not write, with the reason shown in plan and list. */
export interface Unsupported {
  harness: Target["harness"];
  section: Target["section"];
  reason: string;
}

/** Directory-level I/O for skills. Never follows an entry's symlink when replacing or removing it. */
export interface SkillStore {
  /** Entry names directly under `dir`, dot-entries skipped; [] when `dir` is missing. */
  names(dir: string): Promise<string[]>;
  /** What sits at `path` (not followed); null when missing. A link reports its real target. */
  inspect(path: string): Promise<SkillState | null>;
  /** Real path behind any symlinks; null when missing. */
  realpath(path: string): Promise<string | null>;
  /** Copies `<dir>/<name>` (a link stays a link) to `<real dir>.<suffix>/<name>`; returns that path, or null if missing. */
  backup(dir: string, name: string, suffix: string): Promise<string | null>;
  /** Replaces `<dir>/<name>` with a symlink to `source`, or a copy of it. */
  install(dir: string, name: string, source: string, mode: SkillMode): Promise<void>;
  remove(dir: string, name: string): Promise<void>;
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

/** The kernel approval gate, for `apply.request`. Resolves when the user decides (or it expires as a reject). */
export interface Approvals {
  request(req: {
    summary: string;
    risk: "low" | "medium" | "high";
    payload: Record<string, string>;
    expiresInSec: number;
  }): Promise<{ decision: "approve" | "reject"; note?: string; approvalId: string }>;
}
