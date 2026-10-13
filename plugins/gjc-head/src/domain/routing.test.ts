import { describe, expect, test } from "bun:test";
import { FAST_PATH_MAX_CHARS, chooseHarness, decideRoute, fastPathJudgement, hasWorkSignal, isClearlyChat, isFastPath } from "./routing.ts";

describe("isFastPath", () => {
  test.each([
    "안녕", "안녕하세요", "ㅎㅇ", "ㅎㅇ 잘 지내?", "반가워요", "오늘 뭐하지?", "고마워요", "감사해요", "잘 지내요?", "좋아요", "괜찮아?", "ㅇㅇ", "ㅇㅋ", "ㅋㅋ", "  좋아요  ",
    "TCP와 UDP 차이를 한 문장으로 알려 줘", "넌 누구야?", "로그인 방식이 뭐야?", "이 단어 뜻이 뭐야?", "왜 하늘은 파래?", "어떻게 지내?", "무슨 뜻이야?", "이 둘 차이 설명해 줘", "이게 뭔데?",
    "Hi", "Hello!", "Hey", "Thanks", "Thank you", "What's up?", "Who are you?", "What is TCP?", "Why is the sky blue?", "How does this work?", "Difference between TCP and UDP", "Explain this term",
  ])("clearly conversational %p is fast", (t) => {
    expect(isFastPath(t)).toBe(true);
  });

  test.each([
    "여기에 로그인 기능 붙여 줘",
    "README 고쳐줘",
    "src/main.ts 봐줘",
    "main.ts 어때",
    "docs 정리한 거 .md로",
    "이 파일 뭐야",
    "코드 좀 봐",
    "버그 수정해",
    "기능 추가",
    "새 페이지 만들어줘",
    "리뷰 부탁",
    "커밋해",
    "배포 언제?",
    "테스트 돌려",
    "PR 올려줘",
    "repo 상태는?",
    "`ls` 해봐",
    "~/dev/me 열어",
  ])("work signal %p is not fast", (t) => {
    expect(isFastPath(t)).toBe(false);
  });

  test("only clear chat skips judging; uncertain short text goes through the normal route", () => {
    for (const text of ["1", "2", "이거?", "로그인은?", "뭘 고치면 좋을까?"]) {
      expect(isClearlyChat(text)).toBe(false);
      expect(isFastPath(text)).toBe(false);
    }
  });

  test("length limit is on the trimmed text", () => {
    const at = "What is " + "x".repeat(FAST_PATH_MAX_CHARS - 8);
    expect(isFastPath(`  ${at}  `)).toBe(true);
    expect(isFastPath(at + "x")).toBe(false);
  });

  test("empty text is not fast", () => {
    expect(isFastPath("   ")).toBe(false);
  });

  test("plain words containing pr/repo letters are not signals", () => {
    expect(hasWorkSignal("price reporter")).toBe(false);
    expect(hasWorkSignal("PRs")).toBe(true);
  });

  test.each([
    "여기에 로그인 기능 붙여 줘", "버튼 붙여 줘", "새 화면 붙이기", "내용 넣어 줘", "코드 넣기", "로그인 구현해 줘", "화면 개선해 줘", "이름 바꿔 줘", "설정 바꾸기", "API 변경해 줘",
    "파일 지워 줘", "테스트 지우기", "bun 설치해 줘", "스타일 적용해 줘", "문서 정리 해줘", "안내문 작성해 줘", "의존성 업데이트 해줘", "서버 연결해 줘", "리팩터링 해줘", "버그 고쳐 줘",
    "에러 고쳐 줘", "오류 수정해 줘", "기능 추가해 줘", "프로젝트 빌드해 줘", "앱 실행해 줘", "테스트 돌려 줘", "아이콘 생성해 줘", "환경 세팅해 줘", "옵션 설정해 줘", "DB 마이그레이션해 줘",
    "브랜치 올려 줘", "화면 구성해 줘", "Paste this into the editor", "Add a login button", "Implement sign in", "Fix this form", "Refactor the router", "Build the app", "Install bun", "Deploy the site",
    "Update the docs", "Remove the old page", "Create a settings screen", "Set up the project",
  ])("real work request %p is detected", (text) => {
    expect(hasWorkSignal(text)).toBe(true);
    expect(isFastPath(text)).toBe(false);
  });

  test.each(["add", "implement", "fix", "refactor", "build", "install", "deploy", "update", "remove", "create", "set up"])("English work verb %p is recognized", (verb) => {
    expect(hasWorkSignal(`Please ${verb} the login page`)).toBe(true);
  });

  test.each(["adding", "implementing", "fixing", "refactoring", "building", "installing", "deploying", "updating", "removing", "creating"])("English work verb form %p is recognized", (verb) => {
    expect(hasWorkSignal(`I'm ${verb} the login page`)).toBe(true);
  });

  test("fast-path judgement shows a full-simple badge", () => {
    expect(fastPathJudgement()).toMatchObject({ simpleProb: 1, source: "fast-path" });
  });
});

describe("decideRoute", () => {
  test("simple and no code change is direct", () => {
    expect(decideRoute({ needsCodeChange: false, simpleProb: 0.9, threshold: 0.8 })).toBe("direct");
    expect(decideRoute({ needsCodeChange: false, simpleProb: 0.8, threshold: 0.8 })).toBe("direct");
  });
  test("uncertain is delegated", () => {
    expect(decideRoute({ needsCodeChange: false, simpleProb: 0.79, threshold: 0.8 })).toBe("delegate");
  });
  test("code change is always delegated", () => {
    expect(decideRoute({ needsCodeChange: true, simpleProb: 1, threshold: 0.8 })).toBe("delegate");
  });
});

describe("chooseHarness", () => {
  const harnesses = ["local.claude-code", "local.codex", "local.gjc"];
  test("without amend keeps the suggestion", () => {
    expect(chooseHarness({ suggested: "local.codex", harnesses })).toEqual({ harness: "local.codex", amended: false });
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: {} })).toEqual({ harness: "local.codex", amended: false });
  });
  test("amend.harness overrides the suggestion", () => {
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: { harness: "local.claude-code" } })).toEqual({ harness: "local.claude-code", amended: true });
  });
  test("amend equal to the suggestion is not an override", () => {
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: { harness: "local.codex" } })).toEqual({ harness: "local.codex", amended: false });
  });
  test("unknown or malformed amend is ignored", () => {
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: { harness: "remote.evil" } }).harness).toBe("local.codex");
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: { harness: 3 } }).harness).toBe("local.codex");
  });
});
