// Keeps protocol/types.ts (the public TS import) and spec/protocol.schema.json (the language-neutral source) in agreement.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import * as handwritten from "../protocol/types.ts";
import { GENERATED_PATH, generate, loadSchema } from "./schema.ts";

const TYPES_PATH = join(import.meta.dir, "..", "protocol", "types.ts");
const schema = await loadSchema();

/** Exported type names → structural fingerprint, for each file. Values (consts) are compared separately. */
function fingerprints(...paths: string[]): Map<string, string>[] {
  const program = ts.createProgram(paths, {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  return paths.map((path) => {
    const sf = program.getSourceFile(path)!;
    const out = new Map<string, string>();
    for (const sym of checker.getExportsOfModule(checker.getSymbolAtLocation(sf)!)) {
      if (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) out.set(sym.name, shape(checker, checker.getDeclaredTypeOfSymbol(sym)));
    }
    return out;
  });
}

/**
 * Structural fingerprint: field names and required-ness, recursively.
 * Primitive, literal, unknown and type-parameter types collapse to "_" so generics (P = unknown) and literal enums do not cause noise.
 */
function shape(checker: ts.TypeChecker, type: ts.Type, stack: ts.Type[] = []): string {
  if (stack.includes(type) || stack.length > 6) return "@";
  const next = [...stack, type];
  if (type.isUnion()) {
    const parts = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
    const shapes = [...new Set(parts.map((t) => shape(checker, t, next)))].sort();
    return shapes.length === 1 ? shapes[0]! : `(${shapes.join("|")})`;
  }
  if (type.flags & ts.TypeFlags.Never) return "never";
  if (!(type.flags & ts.TypeFlags.Object) && !type.isIntersection()) return "_";
  if (checker.isArrayType(type)) return `${shape(checker, checker.getTypeArguments(type as ts.TypeReference)[0]!, next)}[]`;
  const fields = checker
    .getPropertiesOfType(type)
    .map((p) => {
      const opt = p.flags & ts.SymbolFlags.Optional ? "?" : "";
      return `${p.name}${opt}:${shape(checker, checker.getTypeOfSymbol(p), next)}`;
    })
    .sort();
  const index = checker.getIndexInfosOfType(type).map((i) => `[k]:${shape(checker, i.type, next)}`);
  return `{${[...fields, ...index].join(",")}}`;
}

const [hand, gen] = fingerprints(TYPES_PATH, GENERATED_PATH) as [Map<string, string>, Map<string, string>];

describe("protocol schema", () => {
  test("types.generated.ts is up to date with the schema", async () => {
    expect(await Bun.file(GENERATED_PATH).text()).toBe(generate(schema));
  });

  test("schema defines exactly the types exported by protocol/types.ts", () => {
    expect([...gen.keys()].sort()).toEqual(Object.keys(schema.$defs).sort());
    expect([...hand.keys()].sort()).toEqual([...gen.keys()].sort());
  });

  test("constants agree", () => {
    expect(handwritten.PROTOCOL_VERSION).toBe(schema["x-protocolVersion"] as 1);
    expect({ ...handwritten.ErrorCode }).toEqual(schema["x-errorCodes"] as typeof handwritten.ErrorCode);
  });

  for (const name of hand.keys()) {
    test(`${name}: field names and required-ness match`, () => {
      expect(gen.has(name)).toBe(true);
      expect(gen.get(name)).toBe(hand.get(name)!);
    });
  }

  test("a schema that drifts from types.ts is caught", async () => {
    const drifted = structuredClone(schema);
    drifted.$defs.ApprovalDecision!.required!.push("amend"); // required-ness
    delete drifted.$defs.InvokeParams!.properties!.timeoutMs; // field name
    const dir = mkdtempSync(join(tmpdir(), "me-schema-"));
    try {
      const path = join(dir, "drifted.ts");
      await Bun.write(path, generate(drifted));
      const [h, d] = fingerprints(TYPES_PATH, path) as [Map<string, string>, Map<string, string>];
      expect(d.get("ApprovalDecision")).not.toBe(h.get("ApprovalDecision")!);
      expect(d.get("InvokeParams")).not.toBe(h.get("InvokeParams")!);
      expect(d.get("Manifest")).toBe(h.get("Manifest")!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
