// Minimal JSON Schema subset for entity validation: type, required, properties.type, enum.
// Enough to catch plugin bugs early; not a full validator.
import type { JsonValue } from "@myself/protocol";

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

function matchesType(expected: string | string[], v: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(v);
  return types.some((t) => t === actual || (t === "number" && actual === "integer"));
}

export function validateAgainstSchema(schema: JsonValue, data: unknown, path = "$"): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const s = schema as Record<string, any>;
  if (s.type && !matchesType(s.type, data)) return `${path} should be ${s.type}, got ${typeOf(data)}`;
  if (Array.isArray(s.enum) && !s.enum.includes(data as any)) return `${path} should be one of ${s.enum.join(", ")}`;
  if (typeOf(data) === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of s.required ?? []) if (!(key in obj)) return `${path}.${key} is required`;
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in obj) {
        const problem = validateAgainstSchema(sub as JsonValue, obj[key], `${path}.${key}`);
        if (problem) return problem;
      }
    }
  }
  return null;
}
