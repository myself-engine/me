# ACP 브리지 (`bridges/acp`)

Agent Client Protocol(ACP)을 말하는 에이전트 하나를 플러그인으로 노출한다. 브리지가 에이전트 명령을 자식 프로세스로 띄우고, 표준 입출력 위의 JSON-RPC 2.0(한 줄에 메시지 하나)으로 대화한다. 브리지는 ACP의 **클라이언트** 쪽이다.

## 기준 규격

- `@agentclientprotocol/sdk` 1.3.0의 `schema/schema.json`(ACP **버전 1**, 안정판)을 오프라인으로 읽고 맞췄다. SDK 패키지에 의존하지는 않는다. 같은 패키지의 `schema/v2`는 불안정판이라 따르지 않는다.
- 줄 단위 JSON-RPC 처리는 커널과 SDK가 쓰는 `@me/protocol`의 `Peer`를 그대로 쓴다.
- 확인한 메시지: `initialize`, `session/new`, `session/prompt`(결과 `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`), `session/update` 알림, `session/cancel` 알림, `session/request_permission` 요청.

## 메서드

| 메서드 | ACP | 설명 |
|---|---|---|
| `agent.info` | `initialize` 결과 | 시작할 때 한 번 초기화한다. `protocolVersion`, `agentCapabilities`, `agentInfo`, `authMethods` |
| `session.new` | `session/new` | `{ cwd? }` → `{ sessionId, ... }`. `cwd`는 절대 경로. 없으면 설정의 `cwd`, `agent.cwd`, 플러그인 작업 디렉터리 순으로 쓴다. MCP 서버는 넘기지 않는다(`mcpServers: []`). |
| `session.prompt` | `session/prompt` | `{ sessionId?, prompt, cwd? }`. `prompt`는 문자열이나 ACP 콘텐츠 블록 배열. `sessionId`가 없으면 새 세션을 열어 쓴다. |
| `session.cancel` | `session/cancel` | `{ sessionId }` → `{}`. 돌고 있는 `session.prompt`는 `stopReason: "cancelled"`로 끝난다. |

### `session.prompt` 스트리밍

`stream: true`로 부르면 `session/update`의 `update`가 그대로 `op.update`로 온다(`{ "sessionUpdate": "agent_message_chunk", "content": {...} }` 등). 권한 요청에 자동으로 답한 내용은 `{ "permission": { toolCall, options, outcome } }`로 온다.

끝나면 결과는 다음과 같다.

```json
{ "sessionId": "...", "stopReason": "end_turn", "text": "agent_message_chunk 텍스트를 이어 붙인 것", "usage": { "...": "..." } }
```

- 한 턴이 길 수 있으니 **스트리밍으로 부른다.** 스트리밍이 아닌 호출은 커널의 호출 제한 시간(기본 30초)에 걸린다.
- `op.cancel`로 스트리밍 호출을 취소하면 `session/cancel`을 보낸다. 에이전트가 턴을 끝내면 `-32004`(`data.stopReason`)로 끝난다. `cancelGraceMs` 안에 끝내지 않으면 기다리지 않고 `-32004`로 끝낸다.
- 한 세션에는 한 번에 한 턴만 돌린다. 겹치면 `-32602`.

## 설정

```json
{
  "agent": {
    "command": "gjc",
    "args": ["--mode", "acp"],
    "env": { "NO_COLOR": "1" },
    "envFiles": { "OPENAI_API_KEY": "~/.config/me/secrets/openai.key" },
    "cwd": "/Users/me/dev/project"
  },
  "cwd": "/Users/me/dev/project",
  "permission": "reject",
  "initTimeoutMs": 30000,
  "promptTimeoutMs": 1800000,
  "cancelGraceMs": 5000
}
```

| 필드 | 뜻 |
|---|---|
| `agent.command`, `args` | 에이전트 실행 명령. 셸을 거치지 않는다. |
| `agent.env` | 비밀이 아닌 추가 환경 변수 |
| `agent.envFiles` | 파일에서 읽어 넣는 환경 변수(API 키 등). 띄울 때 읽고 앞뒤 공백을 지운다. 값은 어디에도 남기지 않는다. |
| `cwd` | 새 세션의 기본 작업 디렉터리. 절대 경로 |
| `permission` | `reject`(기본) 또는 `allow`. 아래 참고 |
| `initTimeoutMs` | `initialize`, `session/new` 제한 시간. 기본 30초 |
| `promptTimeoutMs` | 한 턴의 상한. 기본 30분, `0`이면 없음. 넘으면 `session/cancel`을 보내고 `-32003` |
| `cancelGraceMs` | 취소 뒤 에이전트를 기다리는 시간. 기본 5초 |

## 가정과 제한

정확한 규격 문서는 SDK 스키마뿐이어서 다음은 보수적으로 정했다.

- **권한 요청은 정책으로 자동 응답한다.** `reject`는 `reject_once`, 없으면 `reject_always`를 고른다. `allow`는 `allow_once`, 없으면 `allow_always`를 고른다. 맞는 선택지가 없거나 이미 취소한 턴이면 `cancelled`로 답한다. 커널 승인 관문으로 사람에게 묻는 방식은 아직 없다.
- **클라이언트 기능을 제공하지 않는다.** `initialize`에서 `fs.readTextFile`, `fs.writeTextFile`, `terminal`을 모두 `false`로 알린다. 그래도 `fs/*`, `terminal/*` 등을 요청하면 `-32601`로 답한다. 에이전트는 자기 프로세스 안에서만 일한다.
- **인증(`authenticate`), `session/load`, 모드·설정 변경은 노출하지 않는다.** 키가 필요하면 `envFiles`로 넘긴다.
- 에이전트가 버전 1이 아닌 `protocolVersion`으로 답하면 시작하지 않는다.
- 에이전트가 죽으면 진행 중인 호출은 `-32002`로 끝난다. 다음 호출 때 다시 띄우고 초기화한다. 이전 세션은 사라진다.
- 메서드 이름은 me 관례대로 점(`session.prompt`)을 쓴다. ACP 이름은 빗금(`session/prompt`)이다.
- 에이전트의 stdout은 ACP 전용이다. stderr는 플러그인 로그로 간다.
- 매니페스트 권한은 `shell`이다(자식 프로세스를 띄운다). 에이전트가 네트워크를 쓰는지는 브리지가 알 수 없다.

## 매니페스트

`renderManifest(pluginId, config, bridgeMain)`이 만든다. 메서드 목록은 고정이다.

```json
{ "run": { "command": ["bun", "../../bridges/acp/src/main.ts"] }, "permissions": ["shell"], "provides": { "methods": ["agent.info", "session.new", "session.prompt", "session.cancel"] } }
```

`me adapt`는 아직 이 브리지를 쓰지 않는다. 매니페스트와 설정은 직접 만든다.

## 테스트

`bun test bridges/acp`. `test/fixtures/agent.ts`의 가짜 에이전트만 쓰고 모델이나 네트워크는 쓰지 않는다.
