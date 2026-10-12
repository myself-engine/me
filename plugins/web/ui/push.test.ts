import { describe, expect, test } from "bun:test";
import { pushSupport, urlBase64ToUint8Array } from "./push.ts";

describe("push client helpers", () => {
  test("url-safe base64 becomes the same bytes", () => {
    const bytes = urlBase64ToUint8Array("SGVsbG8td29ybGQ_");
    expect(Array.from(bytes)).toEqual(Array.from(Buffer.from("Hello-world?", "utf8")));
    expect(urlBase64ToUint8Array("YWI").length).toBe(2);
  });
  test("no window means unsupported", () => {
    // bun:test has no DOM: the settings row must explain instead of throwing.
    expect(pushSupport()).toBe("unsupported");
  });
});
