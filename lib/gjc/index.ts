// GJC-only surface. The implementation moved to @me/runner, which GJC and
// OMP share (same CLI shape, same json event envelope); this package stays
// so existing imports keep working.
import { gjcRunner, type RunnerOptions } from "@me/runner";

export {
  assertAllowedModel,
  withModelFallback,
  parseJsonObject,
  RunnerError as GjcError,
  type RunnerUpdate as GjcUpdate,
  type RunnerOptions as GjcRunOptions,
  type RunnerResult as GjcRunResult,
  type ModelFallback,
  type WarmRunner as WarmGjc,
} from "@me/runner";

/** Runs GJC headless in json mode (see @me/runner). */
export function runGjc(opts: RunnerOptions) {
  return gjcRunner().run(opts);
}

/** Starts GJC before the prompt is known (see @me/runner). */
export function prepareGjc(opts: Omit<RunnerOptions, "prompt" | "onUpdate" | "signal">) {
  return gjcRunner().prepare(opts);
}
