// Regenerates protocol/types.generated.ts from spec/protocol.schema.json.
// Usage: bun spec/generate.ts [--check]   (--check exits 1 if the file is stale)
import { GENERATED_PATH, generate, loadSchema } from "./schema.ts";

const code = generate(await loadSchema());
const file = Bun.file(GENERATED_PATH);
const current = (await file.exists()) ? await file.text() : "";

if (process.argv.includes("--check")) {
  if (current !== code) {
    console.error(`${GENERATED_PATH} is stale; run: bun spec/generate.ts`);
    process.exit(1);
  }
  console.log("types.generated.ts is up to date");
} else {
  await Bun.write(GENERATED_PATH, code);
  console.log(`wrote ${GENERATED_PATH}`);
}
