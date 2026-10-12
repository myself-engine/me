import { expect, test } from "bun:test";
import { SendRejected } from "@me/messenger";
import { WebAPIHTTPError, WebAPIPlatformError, WebAPIRateLimitedError, WebAPIRequestError } from "@slack/web-api";
import { classify } from "./slack.ts";

test("Slack errors map onto the ledger's outcomes: refused, retryable, or unknown", () => {
  const refused = classify(new WebAPIPlatformError({ ok: false, error: "channel_not_found" }));
  expect(refused).toBeInstanceOf(SendRejected);
  expect((refused as SendRejected).retryable).toBe(false);
  expect((classify(new WebAPIRateLimitedError(3)) as SendRejected).retryable).toBe(true);
  expect((classify(new WebAPIHTTPError(403, "Forbidden", {})) as SendRejected).retryable).toBe(false);
  // No answer, or a server error: the message may or may not have been posted.
  const lost = new WebAPIRequestError(new Error("socket hang up"));
  expect(classify(lost)).toBe(lost);
  const boom = new WebAPIHTTPError(502, "Bad Gateway", {});
  expect(classify(boom)).toBe(boom);
});
