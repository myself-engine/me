import { expect, test } from "bun:test";
import { PROPOSITION, viaJevDecisions } from "./jev.ts";

const fakeFetch = (status: number, body: unknown, seen: { url?: string; body?: any } = {}) =>
  (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

test("sends a noul question to the decisions endpoint and maps the answer", async () => {
  const seen: { url?: string; body?: any } = {};
  const j = await viaJevDecisions(
    "k",
    "~typesafe/jev-latest",
    { request: "hi" },
    undefined,
    fakeFetch(200, { model: "typesafe/jev-1.13", answers: { simple: { type: "noul", noul: 0.9 } } }, seen),
  );
  expect(seen.url).toBe("https://openrouter.ai/api/alpha/decisions");
  expect(seen.body).toEqual({
    model: "~typesafe/jev-latest",
    state: { request: "hi" },
    questions: { simple: { type: "noul", instructions: PROPOSITION } },
  });
  expect(j.simpleProb).toBe(0.9);
  expect(j.confidence).toBeCloseTo(0.8);
  expect(j).toMatchObject({ source: "jev", model: "typesafe/jev-1.13" });
});

test("rejects unexpected answers and HTTP errors without leaking the account id", async () => {
  await expect(viaJevDecisions("k", "m", {}, undefined, fakeFetch(200, { answers: {} }))).rejects.toThrow("unexpected answer");
  await expect(
    viaJevDecisions("k", "m", {}, undefined, fakeFetch(400, { error: { message: "bad" }, user_id: "user_secret" })),
  ).rejects.toThrow(/^jev 400: (?!.*user_secret)/);
});
