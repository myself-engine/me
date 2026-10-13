# me

여러 코딩 에이전트 하네스를 하나의 localhost 웹에서 지휘하는 개인용 엔진.

커널은 실행기, 중계, 저널, 상태, 권한, 프로토콜만 맡는다. 나머지 기능은 전부 플러그인이다. 웹, 위임(brgr), head(GJC), 판정(slang → summarize → jev)도 마찬가지다.

- 설계: [docs/DESIGN.md](docs/DESIGN.md)
- 플러그인 프로토콜: [docs/PROTOCOL.md](docs/PROTOCOL.md)
- 결정 기록: [docs/DECISIONS.md](docs/DECISIONS.md)

## 릴리스 노트

`me release`는 변경 내용을 한국어 릴리스 노트로 만들고 `docs/releases/`에 함께 넣어요. 특정 구간의 노트만 만들려면 `me release notes --from v0.6.0 --to v0.9.6`을 실행하세요. `--out <파일>`을 붙이면 파일로 저장하고, `--joke`는 첫 문장만 가볍게 바꿉니다.

## 실행

```sh
bun bin/me.ts
```

그냥 실행하면 끝이다. 꺼져 있으면 Herdr pane에서 커널을 띄우고, 켜져 있으면 가만히 둔다. 처음 한 번은 로그인 에이전트를 깔고(되돌리려면 `me autostart uninstall`) `~/.local/bin/me`를 연결한다. 마지막에 로컬 주소(테일넷 serve가 켜져 있으면 폰 주소도)를 보여 주고 브라우저를 연다(`--no-open`으로 생략).

**커널은 에이전트가 없는 Herdr pane에서 실행한다.** brgr는 위임할 때 워커 pane을 이 pane 옆에 연다. 에이전트가 실행 중인 pane에서 띄우면 위임이 실패한다. `me help`를 치면 모든 명령을 한국어로 보여 준다.

### 로그인할 때 자동으로 띄우기

```sh
bun bin/me.ts autostart install     # ~/Library/LaunchAgents/dev.me.autostart.plist
bun bin/me.ts autostart uninstall
```

로그인하면 `me autostart run`이 한 번 돈다. Herdr 서버(자체 LaunchAgent로 뜸)를 기다린 뒤, me가 이미 응답하면 아무것도 하지 않는다. 아니면 "me kernel"이라는 이름의 빈 pane을 다시 쓰거나, 없으면 같은 이름의 Herdr 작업 공간을 새로 열어 그 안에서 커널을 띄운다. 이미 돌고 있는 커널을 멈추거나 다시 시작하지 않는다. 기록은 `~/.me/autostart.log`.

## 바깥 것 붙이기

```sh
bun bin/me.ts adapt mcp <이름> -- <MCP 서버 명령...>
# 예: bun bin/me.ts adapt mcp notion -- npx -y @notionhq/notion-mcp-server
```

범용 MCP 브리지(`bridges/mcp`)로 `mcp-<이름>` 플러그인을 만든다. 먼저 매니페스트가 요구하는 권한(`shell`, `network`)을 보여 주고 승인을 받는다. TTY면 y/N으로 묻고, 아니면 `--yes`가 있어야 한다. 그다음 실제로 띄워서 도구 목록을 확인하고 적합성 테스트를 통과하면 `me.local.json`에 등록한다(`extraPlugins`, `pluginConfig`). 실패하면 만든 디렉터리를 지운다. 다시 시작하면 불러온다. 다른 플러그인은 `tools.list`, `tools.call`, `resources.list`, `resources.read`로 호출한다.

범용 브리지는 네 개다. 설정만 쓰면 플러그인이 된다.

- `bridges/mcp`: MCP 서버 (`me adapt mcp`)
- `bridges/cli`: 명령줄 도구, argv 템플릿 (`me adapt cli`)
- `bridges/http`: HTTP 엔드포인트. 비밀 헤더는 파일 경로로 받는다. [설명](bridges/http/README.md)
- `bridges/acp`: Agent Client Protocol 에이전트. 세션을 열고 프롬프트 진행을 스트리밍한다. [설명](bridges/acp/README.md)

http와 acp는 아직 `me adapt`가 없다. 매니페스트(`renderManifest`)와 `pluginConfig`를 직접 만든다.

## 점검

```sh
bun bin/me.ts doctor          # 표로 출력, 실패가 있으면 exit 1
bun bin/me.ts doctor --json   # 기계용 출력
```

외부 도구 버전(`$ME_HOME/doctor/versions.json`에 기록하고 지난 실행과 비교), 심링크(`node_modules/@me/*`는 저장소 안을 가리켜야 함, `doctor.symlinkRoots`는 깨진 링크만), 플러그인 적합성을 확인한다. 유료 모델을 부르는 플러그인은 `doctor.skipConformance`(기본 `summarize`, `jev`, `gjc-head`)로 건너뛴다. 아무것도 고치지 않는다.

마켓플레이스 레시피(1단계)와 에이전트 작성(3단계):

```sh
bun bin/me.ts adapt market                       # 레시피 목록
bun bin/me.ts adapt --yes git                    # 레시피 설치
bun bin/me.ts adapt filesystem --set dir=~/notes --yes
bun bin/me.ts adapt agent weather -- "날씨 API를 me에 붙여 줘"   # brgr 워커에게 맡김
bun bin/me.ts adapt export cli-git -- "설명"      # 만든 어댑터를 레시피로 반환
```

## 다른 서버의 플러그인 붙이기 (Tailscale)

```sh
# Mac (me.local.json): "tcp": { "host": "<Mac의 tailnet IP>", "port": 7421 }
# 서버: ~/.me/connect.token을 Mac에서 복사해 온 뒤
bun bin/me.ts connect plugins/<플러그인> --host <Mac의 tailnet IP> --token-file ~/.me/connect.token
```

## 하네스 설정 한 곳에서 관리

```sh
bun bin/me.ts config import            # 지금 설정에서 초안 보기 (읽기 전용)
bun bin/me.ts config import --write    # ~/.me/harness-config/source.draft.json 저장 → 검토 후 source.json으로
bun bin/me.ts config plan              # 하네스별 바뀔 내용
bun bin/me.ts config apply --yes       # 백업 후 적용
```

원본(`~/.me/harness-config/source.json`)은 MCP 서버, 지시문 조각, Skills, Hook을 한곳에 둔다. 항목마다 `share`(`"all"` 또는 하네스 목록)로 어느 하네스에 보낼지 정한다.

```json
{
  "mcpServers":   { "notion": { "url": "https://mcp.notion.com/mcp", "share": "all" } },
  "instructions": { "style":  { "file": "fragments/style.md", "share": ["claude-code", "codex"] } },
  "skills": {
    "review": { "dir": "skills/review", "share": "all" },
    "fmt":    { "dir": "skills/fmt", "mode": "copy", "share": ["codex"] }
  },
  "hooks": {
    "fmt-after-edit": { "event": "PostToolUse", "matcher": "Edit|Write", "command": "bunx prettier --write .", "timeout": 30, "share": "all" }
  }
}
```

- Skill: `SKILL.md`가 든 폴더. 기본은 심볼릭 링크이고 `"mode": "copy"`면 복사한다. 각 하네스의 skills 폴더(`~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`, `~/.gjc/agent/skills`)에 같은 이름으로 링크하거나 복사한다. 원본이 선언하지 않은 이름은 건드리지 않는다. 바꾸기 전 항목은 skills 폴더 옆 `skills.me-backup-<시각>/`에 남긴다.
- Hook: 이벤트에 붙는 셸 명령 한 줄. Claude Code(`~/.claude/settings.json`)와 Codex(`~/.codex/hooks.json`)에만 쓴다. 명령 끝에 `# me:harness-config <이름>` 표식을 붙여 원본이 소유한 항목을 알아본다. 표식 없는 Hook은 사용자 것이라 건드리지 않는다.
- OpenCode와 GJC는 명령형 Hook 형식이 없다(둘 다 JS/TS 플러그인). 추측해서 쓰지 않고, `plan`의 `unsupported`에 건너뛴 항목을 보여 준다.
- Codex는 새 Hook이나 바뀐 Hook을 처음 실행할 때 신뢰 여부를 다시 물을 수 있다. Codex는 신뢰 상태를 Hook 순번으로 기억해서, 앞쪽의 관리 Hook을 지우면 뒤에 있던 사용자 Hook도 다시 물을 수 있다. `config.toml`의 `[features]`와 `[hooks.state]`는 손대지 않는다.

## 폰에서 쓰기 (Tailscale, 공개 아님)

```sh
# me.local.json
#   "web": { "tailscale": { "enabled": true, "allowedLogins": ["<tailscale 로그인>"] } }
bun bin/me.ts tailscale on      # https://<기기>.<tailnet>.ts.net:8443 → 127.0.0.1:7420
bun bin/me.ts tailscale status
bun bin/me.ts tailscale off
```

funnel(공개 노출)은 거부한다. 이미 쓰이는 포트는 덮어쓰지 않는다.

## 설정

- `me.config.json`: 공용 기본값이다. 플러그인 목록과 모델, 하네스, 포트를 담는다.
- `me.local.json`: 이 머신 전용 값이다. 커밋하지 않는다. 같은 구조의 일부만 적으면 덮어쓴다.

```json
{
  "pluginConfig": {
    "web": { "githubRepo": "<owner>/me", "projects": ["~/dev/me", "~/dev/other"] },
    "brgr": { "ownerSession": "me:mac" }
  }
}
```
- 자식 환경: 플러그인과 브리지 자식은 부모 환경을 통째로 받지 않고 기본값(`PATH`, `HOME`, `LC_*`, `XDG_*` 등)만 받는다. 자식이 꼭 봐야 하는 변수는 `me.config.json`의 `env.pass: ["GH_TOKEN", "MYAPP_*"]`에 적는다(`"*"` 통째 와일드카드는 안 된다). 비밀 값 자체는 파일(`~/.config/me/secrets/…`)로만 넘긴다.

- 데이터: `~/.me`. 저널과 엔티티는 `me.sqlite`, 플러그인 로그는 `logs/`에 남는다. `ME_HOME`으로 바꿀 수 있다.
- Jev: `~/.config/me/secrets/openrouter.key`에 OpenRouter 키를 두면 Jev(`typesafe/jev-router`)로 판정한다. 키가 없으면 head 모델로 같은 형식의 대체 판정을 한다.

## 제약

- Claude 모델은 Claude Code 안에서만 쓴다. GJC는 Anthropic 모델을 거부한다(`lib/gjc`).
- head는 코드를 만지지 않는다. GJC는 `--no-mcp`에 도구 없이 실행되고, 도구 실행이 감지되면 그 실행을 중단한다.
- 위임 대상 저장소에 커밋되지 않은 변경이 있으면 brgr가 위임을 거부한다.

## 개발

```sh
bun test                 # 커널, 슬랭 테스트
bunx tsc --noEmit -p .   # 타입 검사
bun scripts/smoke-head.ts  # 실제 모델로 head 흐름 확인 (가짜 brgr)
```

`me.local.json`에 `"web": { "dev": true }`를 넣으면 웹 화면이 HMR로 동작한다.
