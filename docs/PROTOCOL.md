# myself-engine 플러그인 프로토콜 v1 (초안)

커널과 플러그인 사이의 계약이다. 플러그인이 늘어난 뒤에는 바꾸기 가장 어려운 부분이므로, 결정마다 **버린 대안**도 함께 적는다.

- 상태: 초안, 구현 전
- 타입 정의: [`protocol/types.ts`](../protocol/types.ts)
- 상위 설계: [DESIGN.md](DESIGN.md)

## 0. 원칙

1. **커널이 유일한 통로다.** 플러그인은 다른 플러그인의 주소를 모른다. 모든 호출과 이벤트는 커널을 거치고, 커널이 권한을 확인하고 저널에 남긴 뒤 전달한다.
2. **커널은 도메인을 모른다.** 동사 이름에 "에이전트", "작업", "하네스" 같은 도메인 단어가 들어가지 않는다. 그런 개념은 플러그인이 엔티티 종류로 등록한다.
3. **권한은 코드보다 먼저 정해진다.** 플러그인 코드가 실행되기 전에 매니페스트만 보고 거부할 수 있어야 한다.

## 1. 전송과 프레이밍

**결정**: JSON-RPC 2.0. 프레임 하나가 한 줄인 NDJSON으로 주고받는다.
- 커널이 띄우는 플러그인(실행 방식 A): 플러그인의 stdin/stdout. stderr는 커널이 로그로 수집한다.
- 스스로 접속하는 플러그인(실행 방식 B, 나중): Unix 소켓 위에서 같은 프레임을 쓴다. **바뀌는 건 전송뿐이다.**

**버린 대안**
- HTTP/WebSocket: 로컬 프로세스 사이에서 불필요하게 무겁고 포트가 생긴다.
- 길이 접두 프레이밍(LSP 방식): 디버깅할 때 `cat`이나 `jq`로 바로 못 읽는다.

## 2. 매니페스트 (`plugin.json`)

**결정**: 플러그인 폴더에 정적 파일로 둔다. 커널은 **실행 전에** 이 파일을 읽고 권한을 확정한다. 핸드셰이크에서 권한을 늘릴 수 없다.

```json
{
  "id": "gjc-head",
  "version": "0.1.0",
  "protocol": { "min": 1, "max": 1 },
  "run": { "command": ["bun", "run", "src/main.ts"], "cwd": "." },
  "permissions": ["read-state", "emit", "subscribe", "call:slang", "call:summarize", "call:jev", "call:brgr", "approve.request"],
  "provides": {
    "methods": ["chat.send"],
    "events": ["chat.turn"],
    "kinds": ["chat.thread"]
  },
  "subscribes": ["brgr.task.*"],
  "restart": { "policy": "on-failure", "maxRestarts": 5, "windowSec": 300 }
}
```

**버린 대안**: 핸드셰이크에서 권한을 선언하는 방식. 이 방식은 플러그인 코드가 이미 실행된 뒤에야 권한을 알 수 있다.

## 3. 생명주기

```
커널: 매니페스트 읽기 → 권한 확정 → 프로세스 실행
커널 → 플러그인: initialize {protocolVersion, pluginId, grantedPermissions, config}
플러그인 → 커널: 응답 {protocolVersion, ready: true}
커널: 매니페스트의 provides를 라우팅 표에 등록 → 이벤트 plugin.started
...
커널 → 플러그인: shutdown {reason}  (응답 후 5초 안에 종료하지 않으면 강제 종료)
```

- 플러그인이 죽으면 커널은 `restart` 정책에 따라 다시 띄운다. 정해진 시간 안에 재시작 횟수를 넘기면 **격리**하고 `plugin.quarantined` 이벤트를 낸다.
- 버전 협상: 커널은 매니페스트의 `protocol` 범위와 자기 버전을 비교한다. 겹치지 않으면 실행하지 않는다.

## 4. 호출 (요청과 응답)

**결정**: 플러그인은 `invoke`로 다른 플러그인의 메서드를 부른다. 대상은 **플러그인 ID와 메서드 이름**으로만 지정한다.

커널 자신의 메서드(`emit`, `subscribe`, `entity.*`, `approval.*`, `journal.query`, `op.*`)는 `invoke`를 거치지 않고 직접 호출한다. 다른 플러그인의 메서드만 `invoke`로 부른다.

```
A → 커널:  invoke {target: "jev", method: "judge", params, traceId?}
커널:      권한 call:jev 확인 → seq/traceId/causationId 부여 → 저널 기록
커널 → B:  call {method: "judge", params, ctx: {caller: "gjc-head", traceId, causationId, seq}}
B → 커널:  응답 {result}
커널 → A:  응답 {result}  (저널 기록)
```

- 메서드 이름은 `<도메인>.<동작>` 형식을 쓴다. 예: `chat.send`, `judge`, `task.delegate`
- 다른 플러그인의 메서드는 매니페스트의 `provides.methods`에 있는 것만 부를 수 있다.
- 타임아웃은 기본 30초이고, 호출할 때 지정할 수 있다.

**버린 대안**: 플러그인끼리 직접 연결. 빠르지만 저널과 권한이 빠져나간다.

## 5. 오래 걸리는 작업과 스트리밍

JSON-RPC의 요청과 응답만으로는 스트리밍을 할 수 없다. 그래서 ACP의 `session/update` 방식을 일반화한다.

**결정**
```
A → 커널:  invoke {target: "gjc-head", method: "chat.send", params, stream: true}
커널 → A:  응답 {opId}                         (즉시)
B → 커널:  op.update {opId, update}            (여러 번)
커널 → A:  op.update {opId, update}            (같은 구독자에게 전달)
B → 커널:  op.end {opId, result | error}
커널 → A:  op.end {opId, result | error}
A → 커널:  op.cancel {opId}                    (선택)
```

- `update`의 형식은 커널이 관여하지 않는다. 형식은 메서드를 제공하는 플러그인이 정한다.
- 예: head는 GJC json 이벤트를 `{kind: "text_delta" | "thought_delta" | "tool_call" | "tool_result" | "delegation", ...}`로 정리해서 보낸다.
- 다른 플러그인(예: 웹의 두 번째 탭)도 `op.subscribe {opId}`로 같은 스트림을 볼 수 있다. 권한은 `subscribe`다.

**저널 처리**: `op.update`는 양이 많다. 저널에는 **원본 전체**를 남기되 플래그로 묶을 수 있게 한다. 묶는 방식은 미해결로 둔다.

## 6. 이벤트

**결정**: 발행과 구독. 이벤트 이름은 `<발행 플러그인>.<이름>` 형식이고, 커널 이벤트는 `kernel.*`이다.

- 발행: `emit {name, data}`. 권한은 `emit`이고, 자기 이름공간(`<자기 id>.*`)에만 발행할 수 있다.
- 구독: 매니페스트의 `subscribes`에 패턴으로 적는다(예: `brgr.task.*`). 런타임에 `subscribe {pattern}`으로 추가할 수 있다. 권한은 `subscribe`다.
- 전달: `event {name, data, ctx: {source, seq, traceId, causationId, ts}}`
- 모든 이벤트는 저널을 거친 **뒤에** 전달된다. 저널에 없는 이벤트는 존재하지 않은 것으로 본다.

커널이 내는 이벤트
- `kernel.plugin.started`, `kernel.plugin.stopped`, `kernel.plugin.quarantined`
- `kernel.approval.pending`, `kernel.approval.decided`
- `kernel.permission.denied`

## 7. 엔티티와 상태

**결정**: 커널은 종류(kind)별로 JSON 문서를 저장하는 일반 저장소만 제공한다. 쿼리 언어는 만들지 않는다.

| 메서드 | 내용 | 권한 |
|---|---|---|
| `entity.registerKind {kind, schema}` | 매니페스트의 `provides.kinds`에 있는 종류만 등록할 수 있다. 스키마는 JSON Schema | 매니페스트 |
| `entity.upsert {kind, id, data}` | 문서를 쓴다. 변경은 저널에 `kernel.entity.changed`로 남는다 | `write-state:<kind>` |
| `entity.get {kind, id}` | 하나를 읽는다 | `read-state` |
| `entity.list {kind, where?, limit?, after?}` | `where`는 최상위 필드의 같음 비교만 지원한다 | `read-state` |

- 종류의 이름은 등록한 플러그인 이름공간을 쓴다. 예: `brgr.task`, `gjc-head.chat.thread`
- 쓰기는 기본적으로 등록한 플러그인만 할 수 있다. 다른 플러그인에 주려면 매니페스트에 `write-state:<kind>`를 명시하고, 그 종류를 소유한 플러그인 매니페스트의 `allowWriters`에도 적혀 있어야 한다.

**버린 대안**: 커널에 "에이전트", "작업" 같은 고정 스키마를 두는 방식. 새 종류의 플러그인이 올 때마다 커널을 고쳐야 한다.

## 8. 권한

**결정**: 굵은 단위로 시작한다.

| 권한 | 의미 |
|---|---|
| `read-state` | 엔티티 읽기 |
| `write-state:<kind>` | 해당 종류 쓰기 |
| `emit` | 자기 이름공간에 이벤트 발행 |
| `subscribe` | 이벤트, 스트림 구독 |
| `call:<plugin>` 또는 `call:*` | 해당 플러그인의 메서드 호출 |
| `approve.request` | 사용자 승인 요청 |
| `approve.decide` | 승인 결정 전달. 사용자 화면을 가진 플러그인만 가진다 |
| `journal.read` | 저널 조회 (이슈 스냅샷용) |
| `shell` | 셸 실행이 필요한 플러그인임을 선언한다. 커널이 막을 수는 없지만, 사용자에게 보이고 감사 대상이 된다 |
| `network` | 외부 네트워크가 필요한 플러그인임을 선언한다. 위와 같다 |

- `shell`과 `network`는 프로세스 수준의 일이라 커널이 직접 막지 못한다. 대신 **선언하지 않은 플러그인이 이런 일을 하면 버그로 본다.** 웹에 플러그인별 권한을 표시한다.
- head(`gjc-head`)는 `shell`과 코드 관련 `write-state`를 갖지 않는다. GJC `--tools` 화이트리스트가 완전하지 않으므로(FINDINGS 참고), 이것이 **두 번째 방어선**이다. head 플러그인은 GJC 이벤트에서 허용 목록 밖의 도구를 발견하면 실행을 중단하고 `gjc-head.guard.violation`을 발행한다.
- 거부되면 JSON-RPC 오류 `-32001 PermissionDenied`를 돌려주고 `kernel.permission.denied`를 저널에 남긴다.

## 9. 승인 관문

**결정**: 승인은 커널만 해결할 수 있다. 플러그인은 요청만 한다.

```
head → 커널:  approval.request {summary, risk: "low"|"medium"|"high", payload, expiresInSec?}
커널:         저널 기록 → 이벤트 kernel.approval.pending {approvalId, requester, summary, risk}
웹:           승인 카드 표시 → 사용자 결정
웹 → 커널:    approval.decide {approvalId, decision: "approve"|"reject", note?}   (권한 approve.decide)
커널:         저널 기록 → 이벤트 kernel.approval.decided → head의 원래 요청에 응답 {decision, note}
```

- `approval.request`는 오래 걸리는 작업이다(5절). 결정이 날 때까지 `op.end`가 오지 않는다.
- 만료되면 `reject`로 처리한다(`note: "expired"`).
- 요청한 플러그인과 결정한 플러그인이 같을 수 없다.

## 10. 저널

- 커널을 지나는 모든 프레임(호출, 응답, 이벤트, 스트림 업데이트, 승인, 권한 거부, 생명주기)을 SQLite에 순서대로 남긴다.
- 모든 항목에 `seq`(전역 증가), `ts`, `source`, `traceId`, `causationId`가 있다.
- `traceId`: 하나의 사용자 턴에서 시작된 모든 일을 묶는다. 웹에서 "이 대화에서 일어난 일"을 그룹으로 보여 줄 때 쓴다.
- `causationId`: 바로 앞의 원인이 되는 항목의 `seq`다.
- 조회: `journal.query {traceId? | sinceSeq? | source?, limit}` (권한 `journal.read`)
- 저널은 지우지 않는다. 보존과 압축은 미해결로 둔다.

## 11. 오류 코드

| 코드 | 이름 | 의미 |
|---|---|---|
| -32700 ~ -32600 | JSON-RPC 표준 | 파싱, 잘못된 요청 등 |
| -32001 | PermissionDenied | 권한 없음 |
| -32002 | TargetUnavailable | 대상 플러그인이 없거나 격리됨 |
| -32003 | Timeout | 호출 시간 초과 |
| -32004 | Cancelled | `op.cancel`로 취소됨 |
| -32005 | ProtocolMismatch | 버전 불일치 |
| -32006 | SchemaViolation | 엔티티가 등록된 스키마에 맞지 않음 |

## 12. 첫 조각 흐름 검증

첫 조각의 흐름이 모두 위 동사로 표현되는지 확인한다. 하나라도 맞지 않으면 프로토콜이 틀린 것이다.

**흐름 1. 웹에서 메시지를 보내고 답을 스트리밍으로 받는다**
```
web  → invoke {target: gjc-head, method: chat.send, params: {threadId, text}, stream: true}
     ← {opId}
head → op.update {kind: understood, normalizedKo}        "이렇게 이해했어요"
head → op.update {kind: judgement, simpleProb, route}    판정 배지
head → op.update {kind: text_delta | thought_delta | tool_call ...}  (여러 번)
head → op.end {result: {messageId}}
```
✅ `invoke(stream)`, `op.update`, `op.end`

**흐름 2. head 안의 판정 파이프라인**
```
head → invoke {target: slang, method: normalize, params: {text}}          → {normalizedKo}
head → invoke {target: summarize, method: summarize, params: {normalizedKo}} → {summaryEn, brief}
head → invoke {target: jev, method: judge, params: {summaryEn}}           → {simpleProb, route, confidence}
```
같은 `traceId` 아래 `causationId`로 이어진다. ✅ 동기 `invoke`

**흐름 3. 위임 전 승인을 받고 위임한다**
```
head → approval.request {summary: "Claude Code에 X 위임", risk: medium}  (스트림)
커널 → event kernel.approval.pending
web  → approval.decide {approvalId, decision: approve}
커널 → head에 op.end {decision: approve}
head → invoke {target: brgr, method: task.delegate, params: {harness: claude-code, brief}} → {taskId}
```
✅ 9절 승인 관문, `invoke`

**흐름 4. 작업 상태를 보고 결과를 처리한다**
```
brgr → entity.upsert {kind: brgr.task, id: taskId, data: {state, harness, ...}}
brgr → emit {name: brgr.task.sealed, data: {taskId}}
web  (구독 brgr.task.*) → 결과 카드 표시
web  → invoke {target: brgr, method: task.diff, params: {taskId}}   → diff
web  → invoke {target: brgr, method: task.accept | task.reject, params: {taskId, note}}
```
✅ 엔티티, 이벤트, `invoke`. 수락과 거절은 사용자가 직접 누르는 행위이므로 승인 관문을 거치지 않고 웹이 바로 호출한다. 웹의 권한은 `call:brgr`이다.

**흐름 5. 이슈 버튼**
```
web → journal.query {traceId}                       → 해당 턴의 모든 항목
web → entity.list {kind: brgr.task, where: {...}}   → 관련 엔티티
web → (GitHub 이슈 생성은 web 플러그인이 직접 수행, 권한 network 선언)
```
✅ `journal.query`, `entity.list`

**흐름 6. 한눈에 보기**
```
web → entity.list {kind: kernel.plugin}   (커널이 플러그인 상태를 엔티티로 노출)
web → entity.list {kind: brgr.task}
web → subscribe {pattern: "kernel.plugin.*"}, subscribe {pattern: "brgr.task.*"}
```
✅ 커널 자신의 상태도 `kernel.plugin` 종류로 노출한다. 이렇게 하면 웹에 특별한 경로가 필요 없다.

## 13. 미해결

- 대량 `op.update`의 저널 묶음과 압축, 보존 기간
- 역압(backpressure): 웹이 느릴 때 스트림 처리
- 스스로 접속하는 플러그인(실행 방식 B)의 소켓 인증 토큰과 신원
- `entity.list`의 `where`를 같음 비교 이상으로 넓힐지
- 플러그인 설정 값과 비밀 파일 경로 전달 방식 (`initialize.config`의 구조)
- MCP 어댑터의 매핑: MCP tool을 `invoke` 메서드로, MCP notification을 이벤트로 바꾸는 규칙
- 웹이 `approve.decide`를 가질 때 사용자 신원 확인. 첫 조각은 localhost 토큰으로 대신한다
