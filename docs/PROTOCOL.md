# me 플러그인 프로토콜 v1 (초안)

커널과 플러그인 사이의 계약이다. 플러그인이 늘어난 뒤에는 바꾸기 가장 어려운 부분이므로, 결정마다 **버린 대안**도 함께 적는다.

- 상태: 초안, 구현 전
- 규격 원본: [`spec/protocol.schema.json`](../spec/protocol.schema.json) (14절)
- 타입 정의: [`protocol/types.ts`](../protocol/types.ts)
- 상위 설계: [DESIGN.md](DESIGN.md)

## 0. 원칙

1. **커널이 유일한 통로다.** 플러그인은 다른 플러그인의 주소를 모른다. 모든 호출과 이벤트는 커널을 거치고, 커널이 권한을 확인하고 저널에 남긴 뒤 전달한다.
2. **커널은 도메인을 모른다.** 동사 이름에 "에이전트", "작업", "하네스" 같은 도메인 단어가 들어가지 않는다. 그런 개념은 플러그인이 엔티티 종류로 등록한다.
3. **권한은 코드보다 먼저 정해진다.** 플러그인 코드가 실행되기 전에 매니페스트만 보고 거부할 수 있어야 한다.

## 1. 전송과 프레이밍

**결정**: JSON-RPC 2.0. 프레임 하나가 한 줄인 NDJSON으로 주고받는다.
- 커널이 띄우는 플러그인(실행 방식 A): 플러그인의 stdin/stdout. stderr는 커널이 로그로 수집한다.
- 스스로 접속하는 플러그인(실행 방식 B): 커널이 여는 Unix 소켓 위에서 같은 프레임을 쓴다. **바뀌는 건 전송뿐이다.**
  - 소켓: `$ME_HOME/kernel.sock`, 파일 모드 0600. `me.config.json`의 `socket`으로 경로를 바꾸고, `socket: false`면 열지 않는다.
  - 첫 줄은 반드시 `hello`다: `{"jsonrpc":"2.0","id":0,"method":"hello","params":{"manifest":{...},"token":"..."}}`
  - `token`은 `$ME_HOME/connect.token`의 내용이다. 커널이 처음 시작할 때 없으면 만든다(0600, 32바이트 난수 hex).
  - 응답: `{protocolVersion, grantedPermissions}`. 그다음은 실행 방식 A와 똑같이 `initialize`부터 시작한다.
  - SDK: `connect({socketPath?, tokenPath?, manifest, plugin})` 또는 `plugin.connect({...})`. 기본 전송은 여전히 stdio다.
- 다른 머신의 플러그인(실행 방식 B, TCP): 서버 여러 대를 Mac 한 곳의 커널에 붙일 때 쓴다. 프레임, `hello`, 토큰은 Unix 소켓과 같다.
  - 설정: `me.config.json`(또는 `me.local.json`)의 `tcp`. 기본값은 `false`이고, 켜려면 `{"host": "<ip>", "port": 7421}`.
  - 바인딩 제한: `host`는 IP여야 하고 loopback, Tailscale CGNAT(`100.64.0.0/10`), Tailscale IPv6(`fd7a:115c:a1e0::/48`)만 허용한다. `0.0.0.0`, `::`, LAN 주소, 호스트 이름은 `tcp.allowAnyHost: true`가 없으면 커널이 시작하지 않는다.
  - TLS는 없다. 암호화는 Tailscale(WireGuard)에 맡긴다. 그래서 tailnet 밖 주소를 막는다.
  - SDK: `connect({tcp: {host, port}, token? | tokenPath?, manifest, plugin})`. 토큰은 커널 머신의 `connect.token`을 복사해 쓴다.
  - `me connect`(`tools/remote/connect.ts`의 `runRemote({pluginDir, host, port, tokenPath, config})`): 서버에서 고치지 않은 플러그인(어떤 언어든)을 커널과 똑같이 stdio로 띄우고, 그 매니페스트로 `hello`한 뒤 프레임을 그대로 중계한다. `initialize.config`만 서버 쪽 `config`로 바꾼다. 커널 연결이 끊기면 백오프로 다시 접속하고(플러그인 프로세스는 유지), 플러그인이 죽으면 다시 띄운다. 토큰이 틀리면 재시도하지 않고 멈춘다.

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

**자식 환경 allowlist** (2026-10-12): 자식 프로세스는 부모 환경을 통째로 물려받지 않는다. 커널이 띄우는 플러그인, MCP/ACP/CLI 브리지가 띄우는 자식, brgr가 띄우는 `git`·하네스 CLI는 `lib/env`의 `childEnv`로 만든 환경만 받는다. 항상 남는 것은 `PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_*, TZ, TMPDIR, TERM, COLORTERM, XDG_*, SSH_AUTH_SOCK, HERDR_*, ME_*`와 커널이 정하는 `ME_PLUGIN_ID/ME_DATA_DIR`뿐이다. 토큰은 파일 경로(`~/.config/me/secrets/…`)로만 넘기고, 명시 값(`run.env`, 브리지 `env/envFiles`)은 allowlist보다 항상 우선한다.
- 플러그인 매니페스트 `run`에 `envPass: ["GH_TOKEN", "MYAPP_*"]`를 두면 그 이름(정확한 이름이나 `PREFIX_*`)이 추가로 남는다. `"*"`는 거부한다.
- 브리지 설정에도 같은 `envPass`가 있다(MCP 서버별, ACP `agent`, CLI 공용).
- 사용자 전용 탈출구는 최상위 설정 `env.pass` 배열로, 모든 자식에 더해진다. `me.local.json`의 `env`로 덮어쓸 수 있다. 모자란 값은 여기에 적고, 커밋되는 파일에는 비밀 값을 절대 적지 않는다.
- 버린 대안: 부모 환경 전체 상속(밤새 도는 위임에 비밀 유출), 자식마다 셸 래퍼로 가리기(규칙이 흩어지고 감사할 수 없음).

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

**스스로 접속하는 플러그인(실행 방식 B)**
```
플러그인 → 커널:  hello {manifest, token}         (소켓의 첫 줄, id 0)
커널:            토큰 확인 → validateManifest → 권한 = 선언 ∩ connectPermissions
커널 → 플러그인:  응답 {protocolVersion, grantedPermissions}
이후:            initialize부터 실행 방식 A와 같다
```
- 거부(JSON-RPC 오류 후 연결 종료): 토큰이 틀림(-32001), 매니페스트가 잘못됨(-32602), 첫 프레임이 `hello`가 아님 또는 같은 id가 이미 실행 중이거나 커널이 띄우는 플러그인의 id임(-32600), 버전 불일치(-32005)
- 권한 상한: `me.config.json`의 `connectPermissions`. 기본값은 `["read-state", "emit", "subscribe"]`. 실제로 준 권한은 `kernel.plugin` 엔티티의 `permissions`와 저널(`connect: "accepted"`, `declared`, `granted`)에 남는다.
- TCP로 접속한 플러그인의 상한은 `remotePermissions`다(기본값은 `connectPermissions`). `kernel.plugin` 엔티티에 `remote: {address, port}`가 붙고, `mode`는 그대로 `connected`다. 저널의 `connect` 항목에도 `remote`가 남는다.
- 속도 제한(TCP만): 한 주소에서 60초 안에 `hello`가 5번 실패하면(거부 또는 `hello` 시간 초과) 그 주소의 새 연결을 60초 동안 응답 없이 끊는다. 저널에 `connect: "rate-limited"`를 남긴다. `hello` 전에 1MiB를 넘게 보내는 연결도 끊는다.
- 커널은 이 플러그인을 다시 띄우지 않는다. 소켓이 닫히면 `stopped`가 되고, 같은 id로 다시 접속할 수 있다.
- `kernel.plugin` 엔티티의 `mode`: `spawned`(실행 방식 A), `attached`(같은 프로세스 안의 전송), `connected`(실행 방식 B)

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
- `traceId`와 `causationId`는 호출하는 쪽이 지금 처리 중인 프레임의 `ctx`에서 이어받아 넘긴다. SDK가 자동으로 채운다. `traceId`가 없으면 커널이 새로 만든다.

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

**저널 처리** (2026-10-11): `op.update`는 양이 많다. 스트림 조각(`DeltaUpdate`)은 합쳐서 기록한다.
- 스트림 조각: `{kind: "<이름>_delta", delta: string}`이고 다른 필드가 없는 `update`다. 예: `text_delta`, `thought_delta`
- 구독자에게는 지금처럼 조각 하나하나를 바로 전달한다. 이때 `seq`는 그 op의 마지막 저널 항목 번호다.
- 저널에는 같은 종류의 연속된 조각을 이어 붙여 한 항목으로 남긴다: `{opId, update: {kind, delta: 합친 글}, coalesced: 조각 수}`
- 쌓인 조각은 다음 중 하나가 오면 바로 기록한다: 조각이 아닌 업데이트(단계 포함), `op.end`, 1초 경과, 64KB 초과, 커널 종료. 그래서 저널 안의 순서는 원래 순서와 같다.
- 조각이 아닌 업데이트는 전과 같이 하나씩 기록한다.

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
| `entity.upsert {kind, id, data}` | 문서를 쓴다. 변경은 저널에 `kernel.entity.changed`로 남는다. 저장된 내용과 같으면 아무것도 쓰지 않고 이벤트도 내지 않으며, 기존 `updatedSeq`를 돌려준다 | `write-state:<kind>` |
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
| `call:<plugin>`, `call:<접두어>-*` 또는 `call:*` | 해당 플러그인의 메서드 호출. `call:ops-*`는 id가 `ops-`로 시작하는 플러그인 전부(원격으로 붙은 사본 등) |
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
- 승인할 때 `amend`로 요청 내용 일부를 바꿔 돌려줄 수 있다. 예: 하네스를 다른 것으로 지정. 요청한 플러그인은 `amend`를 반영해서 진행한다. 판단은 다이얼이라는 원칙의 구현이다.
- `approval.list`: 아직 결정되지 않은 승인 목록. 이벤트를 놓친 화면(나중에 접속한 웹 등)을 위한 것이다. 권한은 `approve.decide`다.

## 10. 저널

- 커널을 지나는 모든 프레임(호출, 응답, 이벤트, 스트림 업데이트, 승인, 권한 거부, 생명주기)을 SQLite에 순서대로 남긴다.
- 모든 항목에 `seq`(전역 증가), `ts`, `source`, `traceId`, `causationId`가 있다.
- `traceId`: 하나의 사용자 턴에서 시작된 모든 일을 묶는다. 웹에서 "이 대화에서 일어난 일"을 그룹으로 보여 줄 때 쓴다.
- `causationId`: 바로 앞의 원인이 되는 항목의 `seq`다.
- 조회: `journal.query {traceId? | sinceSeq? | source?, limit}` (권한 `journal.read`)
- 보존 (2026-10-11): 설정 `journal: {maxAgeDays, maxRows, pruneIntervalSec}`. 기본값은 14일, 200,000행, 1시간마다다.
  - 커널이 시작할 때와 주기마다 오래된 항목과 넘치는 항목을 지운다. 지운 뒤 WAL 체크포인트(`TRUNCATE`)를 한다.
  - 0을 주면 그 제한을 끈다. `me.local.json`의 `journal`로 덮어쓸 수 있다.
  - 지워진 trace는 `trace.get`에서 빈 트리로 나온다. 엔티티는 지우지 않는다(`updatedSeq`가 지워진 항목을 가리킬 수 있다).
  - 비운 페이지는 SQLite가 다시 쓴다. 비운 공간이 4MB 이상이고 파일의 절반 이상이면 VACUUM으로 파일을 줄인다.
- 비밀 마스킹 (2026-10-12): 저널에 쓰기 직전 `lib/redact`가 값을 가린다. 비밀스러운 이름의 키(`token/secret/password/api key/authorization/cookie/private key`, 대소문자 무시)의 값과 알려진 토큰 모양(`sk-…`, `ghp_/gho_/github_pat_…`, `xox…-…`, `Bearer …`, `AKIA…`, JWT, PEM 개인키)이 `[REDACTED]`가 된다. 파일 경로(`~/.config/me/secrets/…`)는 경로만 남으므로 그대로 둔다. 비밀 없는 본문은 정규식 한 번으로 통과해서 비용이 없다(`scripts/journal-bench.ts` 전후 수치 동일). 웹 "이슈 올리기"는 저널·엔티티를 첨부하기 전에 한 번 더 가리고, Discord/Slack 발신은 `lib/messenger`에 넣을 때 가린다.

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

- 역압(backpressure): 웹이 느릴 때 스트림 처리
- 실행 방식 B의 신원: 지금은 토큰 하나를 모두가 나눠 쓰고, id는 플러그인이 스스로 밝힌다. TCP는 Tailscale 주소에만 열지만, 플러그인별 토큰, Tailscale 신원 확인, TLS는 아직 없다
- `me connect` 중계: 커널 연결이 끊긴 동안 플러그인이 보낸 프레임은 버린다(플러그인 자신의 타임아웃에 맡긴다)
- `entity.list`의 `where`를 같음 비교 이상으로 넓힐지
- 플러그인 설정 값과 비밀 파일 경로 전달 방식 (`initialize.config`의 구조)
- MCP 어댑터의 매핑: MCP tool을 `invoke` 메서드로, MCP notification을 이벤트로 바꾸는 규칙
- 웹이 `approve.decide`를 가질 때 사용자 신원 확인. 첫 조각은 localhost 토큰으로 대신한다

## 14. 스키마와 적합성 테스트

**규격 원본은 언어 중립 JSON Schema다.** [`spec/protocol.schema.json`](../spec/protocol.schema.json)(draft 2020-12)의 `$defs`에 모든 프레임과 파라미터 타입이 TS 타입과 같은 이름으로 있다. 오류 코드와 프로토콜 버전은 `x-errorCodes`, `x-protocolVersion`에 둔다.

- 생성: `bun spec/generate.ts`가 `protocol/types.generated.ts`를 만든다. `--check`는 생성 파일이 낡았으면 실패한다.
- TS에서 가져다 쓰는 곳은 그대로 `protocol/types.ts`다. `spec/schema.test.ts`가 두 파일의 타입 이름, 필드 이름, 필수 여부가 다르면 실패한다. 프로토콜을 바꿀 때는 스키마를 먼저 고치고, 생성한 뒤, `types.ts`를 맞춘다.
- 다른 언어의 타입도 이 스키마에서 생성한다.

**적합성 테스트**: 어떤 언어로 쓴 플러그인이든 이것을 통과하면 커널과 호환된다고 본다.

```
bun spec/conformance/run.ts <plugin-dir> [<plugin-dir>...]
```

`<plugin-dir>/plugin.json`을 읽고 커널과 똑같이 실행한다(작업 폴더는 플러그인 폴더, `ME_PLUGIN_ID`, 임시 `ME_DATA_DIR`). 가짜 커널로서 다음을 확인하고 PASS/FAIL 표를 출력한다. 하나라도 실패하면 0이 아닌 코드로 끝난다.

| 확인 | 기준 |
|---|---|
| `initialize` | 10초 안에 `{protocolVersion, ready: true}` |
| `call <method>` | `provides.methods`의 모든 메서드가 `params: {}`에 결과나 JSON-RPC 오류로 답한다. 죽거나 멈추면 실패 |
| 모르는 메서드 | JSON-RPC 오류 |
| 스트리밍 호출 | `stream: true, opId`에 응답하고, 그 opId로 `op.end`를 정확히 한 번 보낸다. 거절한 호출에는 `op.end`가 없다 |
| `shutdown` | 응답하고 5초 안에 종료 |
| stdout | JSON-RPC 2.0 프레임만. 로그는 stderr로 |

- 테스트에서는 `runConformance(dir)`를 가져다 쓴다(`spec/conformance/run.ts`).
- 기준 플러그인: `spec/conformance/fixtures/ts-echo`(SDK), `spec/conformance/fixtures/python-echo`(SDK 없이 표준 라이브러리만 쓴 Python). `bun test`가 이 둘과 `plugins/slang`에 적합성 테스트를 돌린다. `python3`가 없으면 Python 테스트는 건너뛴다.

## 15. 작업 상태와 타임라인 (2026-10-11)

**단계 보고 표준**: 스트리밍 호출을 처리하는 플러그인은 `op.update`의 `update`에 `{ kind: "phase", phase, label?, progress? }`를 보낼 수 있다(SDK: `ctx.phase(phase, label, progress)`). 커널은 이것만 해석하고, 나머지 `update`는 그대로 전달한다.

**`kernel.op` 엔티티**: 커널이 모든 스트리밍 op와 승인을 엔티티로 기록한다.
- 상태: `running`, `waiting`(승인 대기), `done`, `failed`, `cancelled`
- 현재 단계(phase, label, progress), 시작·갱신·종료 시각, 걸린 시간, 오류
- 끝난 op는 최근 500개만 남긴다.
- 커널이 다시 시작되면 살아 있던 op는 `failed`("kernel restarted")로 닫는다.

**플러그인 건강 정보**: `kernel.plugin`에 `activeOps`(지금 처리 중인 op 수)와 `lastError`(마지막 오류의 시각, 메서드, 메시지)가 붙는다.

**`trace.get { traceId }`** (권한 `journal.read`): 저널에서 요청 하나의 호출 트리를 만든다.
- 각 노드에는 호출자, 대상, 메서드, 상태, 시작·종료 시각, 걸린 시간, 단계 목록, 오류, 자식 노드가 있다.
- 부모와 자식은 `causationId`로 잇는다.
- 승인은 `type: "approval"` 노드로 들어간다.

UI는 플러그인이 따로 무언가를 하지 않아도 이것만으로 세밀한 진행 상황을 그릴 수 있다.
