// Manifest loading and permission helpers (PROTOCOL §2, §8).
import { dirname, resolve } from "node:path";
import type { Manifest, Permission } from "@myself/protocol";

const ID_RE = /^[a-z][a-z0-9-]*$/;

export interface LoadedManifest extends Manifest {
  /** Absolute directory containing plugin.json. */
  dir: string;
}

export async function loadManifest(path: string): Promise<LoadedManifest> {
  const abs = resolve(path);
  const raw = await Bun.file(abs).json();
  return validateManifest(raw, dirname(abs));
}

export function validateManifest(raw: any, dir: string): LoadedManifest {
  const fail = (msg: string): never => {
    throw new Error(`invalid manifest in ${dir}: ${msg}`);
  };
  if (!raw || typeof raw !== "object") fail("not an object");
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) fail("id must be lowercase kebab-case");
  if (raw.id === "kernel") fail("id 'kernel' is reserved");
  if (typeof raw.version !== "string") fail("version is required");
  if (!raw.protocol || typeof raw.protocol.min !== "number" || typeof raw.protocol.max !== "number") fail("protocol {min,max} is required");
  if (!raw.run || !Array.isArray(raw.run.command) || raw.run.command.length === 0) fail("run.command is required");
  if (!Array.isArray(raw.permissions)) fail("permissions must be an array");
  for (const p of raw.permissions) if (!isPermission(p)) fail(`unknown permission: ${p}`);
  return { ...raw, dir };
}

export function isPermission(p: unknown): p is Permission {
  if (typeof p !== "string") return false;
  return (
    ["read-state", "emit", "subscribe", "call:*", "approve.request", "approve.decide", "journal.read", "shell", "network"].includes(p) ||
    /^write-state:[a-z0-9.-]+$/.test(p) ||
    /^call:[a-z][a-z0-9-]*$/.test(p)
  );
}

export function hasPermission(granted: readonly Permission[], needed: Permission): boolean {
  if (granted.includes(needed)) return true;
  if (needed.startsWith("call:") && granted.includes("call:*")) return true;
  return false;
}

/** `a.b.*` matches `a.b.c` and `a.b.c.d`; `*` alone matches everything. */
export function matchPattern(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}
