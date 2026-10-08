import { expect, test } from "bun:test";
import { DEFAULT_DICT, normalize } from "./dict.ts";

test("expands jamo slang anywhere and records replacements", () => {
  const r = normalize("ㅇㅇ 진행 ㄱㄱ", DEFAULT_DICT);
  expect(r.normalized).toBe("응 진행 시작하자");
  expect(r.replaced.map((x) => x.from).sort()).toEqual(["ㄱㄱ", "ㅇㅇ"]);
});

test("expands verb endings marked anywhere", () => {
  expect(normalize("마저하셈", DEFAULT_DICT).normalized).toBe("마저해 줘");
});

test("keeps emphasis when expanding 존나", () => {
  expect(normalize("존나 간단한 거", DEFAULT_DICT).normalized).toBe("정말 간단한 거");
});

test("does not touch word-internal matches for boundary entries", () => {
  expect(normalize("억까", DEFAULT_DICT).normalized).toBe("일부러 반대 입장에서 공격해 봐");
  expect(normalize("기억까지", DEFAULT_DICT).normalized).toBe("기억까지");
});
