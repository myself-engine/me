# me

여러 코딩 에이전트 하네스를 하나의 localhost 웹에서 지휘하는 개인용 엔진.

커널은 실행기, 중계, 저널, 상태, 권한, 프로토콜만 맡는다. 나머지 기능은 전부 플러그인이다. 웹, 위임(brgr), head(GJC), 판정(slang → summarize → jev)도 마찬가지다.

- 설계: [docs/DESIGN.md](docs/DESIGN.md)
- 플러그인 프로토콜: [docs/PROTOCOL.md](docs/PROTOCOL.md)
- 결정 기록: [docs/DECISIONS.md](docs/DECISIONS.md)

## 실행

```sh
bun install
bun start            # = bun kernel/src/main.ts me.config.json
```

브라우저에서 http://127.0.0.1:7420 을 연다.

**커널은 에이전트가 없는 Herdr pane에서 실행한다.** brgr는 위임할 때 워커 pane을 이 pane 옆에 연다. 에이전트가 실행 중인 pane에서 띄우면 위임이 실패한다.

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
