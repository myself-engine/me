import { describe, expect, test } from "bun:test";
import { REDACTED, hasCandidates, needsRedactPass, redactString, redactValue } from "./index.ts";

describe("redactString value patterns", () => {
  test.each([
    ["key sk-abc123XYZ-_456 here", `key ${REDACTED} here`],
    ["token ghp_abc123XYZ", `token ${REDACTED}`],
    ["token gho_abc123XYZ", `token ${REDACTED}`],
    ["pat github_pat_abc123XYZ_456", `pat ${REDACTED}`],
    ["slack xoxb-123-456-abcdef", `slack ${REDACTED}`],
    ["slack xoxp-123-abc", `slack ${REDACTED}`],
    ["auth Bearer abc.def-123_X", `auth ${REDACTED}`],
    ["aws AKIAIOSFODNN7EXAMPLE", `aws ${REDACTED}`],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c", `jwt ${REDACTED}`],
    ["pem -----BEGIN RSA PRIVATE KEY-----\nMIIBOg==\n-----END RSA PRIVATE KEY----- tail", `pem ${REDACTED} tail`],
    ["password=hunter2", `password=${REDACTED}`],
    ["token: abc123", `token: ${REDACTED}`],
  ])("%p redacts to %p", (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });
});

describe("redactValue key names", () => {
  test("secret-named keys are masked case-insensitively", () => {
    expect(redactValue({ Token: "abc", SECRET: "x", PassWord: "y", api_key: "z", Authorization: "b", Cookie: "c", private_key: "d" })).toEqual({
      Token: REDACTED,
      SECRET: REDACTED,
      PassWord: REDACTED,
      api_key: REDACTED,
      Authorization: REDACTED,
      Cookie: REDACTED,
      private_key: REDACTED,
    });
  });

  test("nested objects and arrays are masked", () => {
    expect(redactValue({ a: { b: { token: "abc" } }, xs: [{ password: "x" }, "plain"] })).toEqual({
      a: { b: { token: REDACTED } },
      xs: [{ password: REDACTED }, "plain"],
    });
  });

  test("token shapes inside innocent keys are still masked", () => {
    expect(redactValue({ note: "call with sk-abc123XYZ-_456" })).toEqual({ note: `call with ${REDACTED}` });
  });

  test("secret paths stay readable", () => {
    expect(redactValue({ tokenFile: "~/.config/me/secrets/openrouter.key" })).toEqual({ tokenFile: "~/.config/me/secrets/openrouter.key" });
    expect(redactString("~/.config/me/secrets/openrouter.key")).toBe("~/.config/me/secrets/openrouter.key");
  });

  test("unchanged values keep their reference", () => {
    const v = { a: 1, b: ["x"] };
    expect(redactValue(v)).toBe(v);
  });
});

describe("no false positives", () => {
  test.each([
    "오늘 회의는 3시에 시작해요. 테스트 잘 부탁해요!",
    "TCP는 연결을 맺는다. 재전송 타이머가 만료되면 패킷을 다시 보낸다.",
    "commit a3f9c21 applied",
    "op 550e8400-e29b-41d4-a716-446655440000 done",
    "~/.config/me/secrets/openrouter.key",
    "/tmp/me-bench-123/trace.json",
  ])("%p passes through", (input) => {
    expect(redactString(input)).toBe(input);
    expect(hasCandidates(input)).toBe(false);
  });

  test("gate detects what matters", () => {
    expect(needsRedactPass(JSON.stringify({ token: "x" }))).toBe(true);
    expect(needsRedactPass(JSON.stringify({ msg: "sk-abc123XYZ" }))).toBe(true);
    expect(needsRedactPass(JSON.stringify({ msg: "안녕하세요" }))).toBe(false);
  });
});
