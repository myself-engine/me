# slack 플러그인

Slack에서 me와 대화하는 창구다. Discord 플러그인과 같은 급의 "창"이다. 메시지를 gjc-head `chat.send`로 보내고, 답은 메시지를 고쳐 가며 흘려 보여 준다. 승인 요청과 위임 결과는 버튼으로 처리한다.
연결은 Slack **Socket Mode**로 한다. 공개 URL이나 웹훅 서버가 필요 없다.
신뢰성은 `lib/messenger` 위에 세웠다. 들어온 메시지는 중복을 거르고 대화별로 순서대로 처리한다. 답장은 원장(ledger)에 먼저 기록한 뒤 보낸다.

## 1. 앱 만들기

1. [api.slack.com/apps](https://api.slack.com/apps)에서 **Create New App → From an app manifest**를 고르고 워크스페이스를 정한다.
2. 아래 매니페스트를 JSON 탭에 붙여 넣고 만든다. 이름은 바꿔도 된다.

   ```json
   {
     "display_information": { "name": "me" },
     "features": {
       "bot_user": { "display_name": "me", "always_online": true },
       "app_home": { "messages_tab_enabled": true, "messages_tab_read_only_enabled": false }
     },
     "oauth_config": {
       "scopes": {
         "bot": ["channels:history", "groups:history", "im:history", "mpim:history", "chat:write", "im:write", "reactions:write", "files:write"]
       }
     },
     "settings": {
       "event_subscriptions": { "bot_events": ["message.channels", "message.groups", "message.im", "message.mpim"] },
       "interactivity": { "is_enabled": true },
       "socket_mode_enabled": true,
       "org_deploy_enabled": false,
       "token_rotation_enabled": false
     }
   }
   ```

3. **Basic Information → App-Level Tokens → Generate Token and Scopes**에서 scope `connections:write`로 토큰을 만든다. `xapp-`로 시작하는 이 값이 **앱 토큰**이다.
4. **Install App → Install to Workspace**로 설치한다. **Bot User OAuth Token**(`xoxb-`로 시작)이 **봇 토큰**이다.
5. 채널에서 쓰려면 그 채널에 봇을 초대한다. 예: `/invite @me`. DM은 초대 없이 앱의 **Messages** 탭에서 바로 보낸다.

매니페스트 없이 손으로 만들 때는 아래 세 가지를 같은 값으로 맞춘다.
- **Socket Mode**: 켠다.
- **Interactivity & Shortcuts**: 켠다. Socket Mode에서는 Request URL이 필요 없다.
- **Event Subscriptions**: 켜고 봇 이벤트를 추가한다.

### 필요한 권한

| 종류 | 값 | 이유 |
|---|---|---|
| 앱 토큰 scope | `connections:write` | Socket Mode 연결 |
| 봇 scope | `channels:history`, `groups:history` | 공개·비공개 채널 메시지 받기 |
| 봇 scope | `im:history`, `mpim:history` | DM과 그룹 DM 받기 |
| 봇 scope | `chat:write` | 답장, 카드, 카드 고치기, 나에게만 보이는 응답 |
| 봇 scope | `im:write` | 주인 DM 열기 (`approvalsToOwnerDm`) |
| 봇 scope | `reactions:write` | 진행 표시 리액션 |
| 봇 scope | `files:write` | diff 파일 첨부 |
| 봇 이벤트 | `message.channels`, `message.groups`, `message.im`, `message.mpim` | 위 메시지들을 Socket Mode로 받기 |

`app_mention` 이벤트는 쓰지 않는다. 멘션도 `message.*`로 들어오므로 둘 다 구독하면 같은 메시지가 두 번 온다. 원장이 거르기는 하지만 굳이 받지 않는다.

## 2. 내 Slack 멤버 ID

Slack에서 내 프로필을 열고 **⋮ → 멤버 ID 복사**를 누른다. `U`로 시작하는 이 값이 `ownerId`다.

## 3. 토큰 파일

토큰은 설정에 직접 넣지 않는다. `token`, `appToken`, `botToken` 키가 있으면 플러그인이 시작을 거부한다. 파일에 저장하고 경로만 적는다. 플러그인은 토큰 내용을 로그에 남기지 않는다. 오류 메시지에도 파일 경로만 나온다.

```sh
mkdir -p ~/.config/me/secrets
printf '%s' '여기에-앱-토큰' > ~/.config/me/secrets/slack-app-token
printf '%s' '여기에-봇-토큰' > ~/.config/me/secrets/slack-bot-token
chmod 600 ~/.config/me/secrets/slack-app-token ~/.config/me/secrets/slack-bot-token
```

## 4. 설정

`me.config.json`에는 이 플러그인이 기본으로 들어 있지 않다. 쓰려면 직접 추가한다. 플러그인 목록에 `plugins/slack`을 넣고, `pluginConfig.slack`을 적는다.

```json
{
  "pluginConfig": {
    "slack": {
      "appTokenFile": "~/.config/me/secrets/slack-app-token",
      "botTokenFile": "~/.config/me/secrets/slack-bot-token",
      "ownerId": "U0123ABCDEF",
      "dm": "owner-only",
      "allowlist": [],
      "openGroups": [],
      "approvalsToOwnerDm": false
    }
  }
}
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `appTokenFile` | (필수) | 앱 토큰(`xapp-`)이 든 파일 경로. `~/`를 쓸 수 있다. |
| `botTokenFile` | (필수) | 봇 토큰(`xoxb-`)이 든 파일 경로. `~/`를 쓸 수 있다. |
| `ownerId` | (필수) | 주인의 Slack 멤버 ID. 승인 버튼과 작업 버튼은 이 사람만 누를 수 있다. |
| `dm` | `"owner-only"` | 누구의 말을 받을지 정한다. `owner-only`, `allowlist`(주인과 `allowlist`), `open`(누구나) 중 하나다. 채널에도 같은 기준을 쓴다. |
| `allowlist` | `[]` | `dm: "allowlist"`일 때 허용할 멤버 ID 목록. |
| `openGroups` | `[]` | 멘션 없이도 모든 메시지에 답할 채널. 채널 ID(`C…`, `G…`)나 `slack/group/<채널ID>` 형식으로 적는다. |
| `approvalsToOwnerDm` | `false` | `true`면 Slack이 아닌 곳(예: 웹)에서 생긴 승인 요청도 주인 DM으로 보낸다. |
| `drainIntervalMs` | `5000` | 원장에 남은 답장을 다시 보내 보는 주기. |
| `chatTimeoutMs` | `2000000` | `chat.send` 한 번을 기다리는 최대 시간. 위임은 승인을 기다리므로 승인 만료 시간보다 길게 둔다. |
| `streamIntervalMs` | `1500` | 답을 흘려 보여 줄 때 메시지를 고치는 최소 간격. Slack의 `chat.update` 호출 한도를 넘지 않게 한다. |

설정이 없거나 토큰 파일을 읽지 못하면 플러그인은 종료하지 않는다. 커널에 붙은 채로 대기하고, 이유를 한국어 한 줄로 플러그인 로그(stderr)에 남긴다. 설정을 고친 뒤 me를 다시 시작한다.

원장은 `$ME_DATA_DIR/ledger.sqlite`에 둔다. 이미 올린 승인 카드와 작업 카드 기록도 같은 파일에 둔다.

## 5. 동작

- **대화 단위**
  - DM은 사용자별로 하나의 대화다. 답은 스레드 없이 DM에 바로 단다.
  - 채널에서는 **Slack 스레드 하나가 대화 하나**다. 맨 위 메시지에서 봇을 부르면 그 메시지에 스레드가 생기고, 답과 카드는 그 스레드에 달린다.
  - 대화마다 gjc-head 스레드가 하나씩 붙는다. 이 연결은 엔티티 `slack.conversation`(id는 head 스레드 id)에 기록한다.
- **채널**: 봇을 멘션해야 반응한다. 봇이 이미 답한 스레드 안에서는 멘션 없이 이어서 말해도 된다. `openGroups`에 넣은 채널은 멘션이 필요 없다.
- **`/new`**: 메시지가 정확히 `/new`면 그 대화만 새로 시작한다. 새 epoch와 새 head 스레드를 만든다. 이전 epoch에서 아직 보내지 못한 답장은 버린다.
  - Slack은 `/`로 시작하는 메시지를 슬래시 명령으로 가로챈다. DM에서는 앞에 공백을 하나 넣어 ` /new`로 보낸다. 채널에서는 `@me /new`처럼 멘션 뒤에 쓰면 된다.
- **진행 표시**: 사용자 메시지에 리액션을 단다. 봇이 "입력 중"을 보이는 기능은 Slack에 없다.
  - 👀 `eyes`: 받음
  - 🤔 `thinking_face`: 판정 중
  - ✍️ `writing_hand`: 답하는 중
  - 📤 `outbox_tray`: 위임함
  - ✅ `white_check_mark`: 끝
  - ⚠️ `warning`: 오류
- **흘려 보여 주기**: head가 답을 쓰기 시작하면 미리보기 메시지를 하나 올리고, `streamIntervalMs`마다 고친다. 끝에는 "답하는 중…"이 붙는다. 답이 끝나면 원장을 거친 최종 답으로 그 메시지를 덮어쓴다. 미리보기가 지워졌거나 고칠 수 없으면 최종 답을 새 메시지로 올린다.
- **서식**: head는 Markdown으로 쓰고 Slack은 mrkdwn을 쓴다. 굵게, 기울임, 취소선, 링크, 제목, 목록, 인용, 코드 블록을 바꿔서 보낸다. 표는 그대로 둔다.
- **답장 나누기**: 4000자를 넘으면 줄 단위로 나눈다. 코드 블록 중간에서 나뉘면 앞 조각에서 닫고 다음 조각에서 다시 연다.
- **재시작 복구**: 보내다가 결과를 모르게 된 답장은 재시작 때 한 번 더 보낸다. 이때 끝에 `(중복일 수 있음 — 재시작 후 다시 보냄)`을 붙인다. Slack SDK의 자동 재시도는 껐다. 다시 보내는 일은 원장만 한다.
- **놓친 것 다시 올리기**: Socket Mode는 연결이 끊긴 동안의 이벤트를 쌓아 두지 않는다. 그래서 시작할 때 대기 중인 승인 요청과 봉인된 작업을 다시 훑어 카드를 올린다.
- **승인**: 대화에서 시작된 위임 승인 요청은 그 대화에 카드로 올라온다. 카드에는 **승인/거절** 버튼과 하네스 선택 메뉴가 있다. 다른 하네스를 고르고 승인하면 `amend.harness`로 전달된다. 결정이 나면 카드에서 버튼을 지우고 결과를 적는다.
- **위임 결과**: 작업이 봉인(sealed)되면 결과 요약을 **수락/거절/diff** 버튼과 함께 올린다. 수락은 brgr `task.accept`, 거절은 `task.reject`를 부른다.
- **diff**: 카드가 있는 대화(DM 또는 그 스레드)에 파일로 올린다. Slack에서는 파일을 나에게만 보이게 올릴 수 없다. 그래서 채널 스레드에서는 그 채널 사람들도 볼 수 있다.
- **버튼 권한**: 버튼은 주인만 누를 수 있다. 버튼에 대한 응답은 누른 사람에게만 보인다(`chat.postEphemeral`). 다른 사람이 누르면 거절 메시지가 그 사람에게만 간다.

## 6. 권한 (plugin.json)

- `read-state`
- `subscribe`
- `call:gjc-head`
- `call:brgr`
- `approve.decide`
- `network`

구독하는 이벤트는 `kernel.approval.*`, `brgr.task.*`, `gjc-head.message.*`다.

## 7. 구조

- `src/domain/`: 순수 로직이다. 대화 키, 설정 검사, mrkdwn 변환, 나누기, 카드와 Block Kit, 버튼 id를 다룬다.
- `src/ports/`: 앱이 바깥에 기대하는 것이다. `SlackGateway`와 `Kernel`이 있다.
- `src/adapters/`
  - `slack.ts`: `@slack/socket-mode`와 `@slack/web-api`로 `SlackGateway`를 구현한다.
  - `kernel.ts`: SDK로 `Kernel`을 구현한다.
  - `sqlite-cards.ts`: 올린 카드 기록을 둔다.
- `src/app/service.ts`: 쓰임새를 담는다. 받기, 원장, 흘려 보여 주기, 승인, 작업을 처리한다.

## 8. 테스트

```sh
bun test plugins/slack
```

테스트는 가짜 `SlackGateway`와 가짜 `Kernel`만 쓴다. 네트워크와 실제 토큰은 쓰지 않는다.
