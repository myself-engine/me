# discord 플러그인

Discord에서 me와 대화하는 창구다. 웹 플러그인과 같은 급의 "창"이다. 메시지를 gjc-head `chat.send`로 보내고, 승인 요청과 위임 결과를 버튼으로 처리한다.
신뢰성은 `lib/messenger` 위에 세웠다. 들어온 메시지는 중복을 거르고 대화별로 순서대로 처리한다. 답장은 원장(ledger)에 먼저 기록한 뒤 보낸다.

## 1. 봇 만들기

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 **New Application**을 만든다.
2. **Bot** 탭에서 **Reset Token**으로 토큰을 받는다. 토큰은 한 번만 보이니 바로 파일에 저장한다(아래 3).
3. 같은 탭의 **Privileged Gateway Intents**에서 **Message Content Intent**를 켠다.
4. **OAuth2 → URL Generator**에서 scope `bot`을 고른다. 권한은 아래를 고른다.
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Add Reactions
   - Attach Files

   만든 URL로 봇을 서버에 초대한다. DM만 쓸 거라면 초대 없이 봇에게 DM을 보내도 된다. 다만 봇과 서버를 하나 이상 같이 쓰고 있어야 DM이 열린다.

### 필요한 인텐트

코드가 요청하는 Gateway Intent는 다음 네 가지다.

| Intent | 이유 |
|---|---|
| `Guilds` | 채널과 스레드 정보 |
| `GuildMessages` | 서버 채널 메시지 받기 |
| `DirectMessages` | DM 받기 |
| `MessageContent` | 메시지 본문 읽기 (포털에서 켜야 하는 특권 인텐트) |

DM을 받으려면 `Partials.Channel`도 필요하다. 어댑터가 이미 켜 두었다.

## 2. 내 Discord 사용자 ID

Discord 설정 → 고급 → **개발자 모드**를 켠다. 그다음 내 프로필을 우클릭해 **사용자 ID 복사**를 누른다. 이 값이 `ownerId`다.

## 3. 토큰 파일

토큰은 설정에 직접 넣지 않는다. `token` 키가 있으면 플러그인이 시작을 거부한다. 파일에 저장하고 경로만 적는다.

```sh
mkdir -p ~/.me/secrets
printf '%s' '여기에-봇-토큰' > ~/.me/secrets/discord-token
chmod 600 ~/.me/secrets/discord-token
```

## 4. 설정

`me.config.json`에는 이 플러그인이 기본으로 들어 있지 않다. 쓰려면 직접 추가한다. 플러그인 목록에 `plugins/discord`를 넣고, `pluginConfig.discord`를 적는다.

```json
{
  "pluginConfig": {
    "discord": {
      "tokenFile": "~/.me/secrets/discord-token",
      "ownerId": "123456789012345678",
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
| `tokenFile` | (필수) | 봇 토큰이 든 파일 경로. `~/`를 쓸 수 있다. |
| `ownerId` | (필수) | 주인의 Discord 사용자 ID. 승인 버튼과 작업 버튼은 이 사람만 누를 수 있다. |
| `dm` | `"owner-only"` | 누구의 말을 받을지 정한다. `owner-only`, `allowlist`(주인과 `allowlist`), `open`(누구나) 중 하나다. 서버 채널에도 같은 기준을 쓴다. |
| `allowlist` | `[]` | `dm: "allowlist"`일 때 허용할 사용자 ID 목록. |
| `openGroups` | `[]` | 멘션 없이도 모든 메시지에 답할 채널. 채널 ID나 `discord/group/<채널ID>` 형식으로 적는다. |
| `notifyChannel` | (없음) | `notify` 메서드가 보낼 기본 채널. 예약 실행(schedule) 전달이 이 채널로 간다. 없으면 `notify`가 거절한다. |
| `approvalsToOwnerDm` | `false` | `true`면 Discord가 아닌 곳(예: 웹)에서 생긴 승인 요청도 주인 DM으로 보낸다. |
| `drainIntervalMs` | `5000` | 원장에 남은 답장을 다시 보내 보는 주기. |
| `chatTimeoutMs` | `2000000` | `chat.send` 한 번을 기다리는 최대 시간. 위임은 승인을 기다리므로 승인 만료 시간보다 길게 둔다. |

원장은 `$ME_DATA_DIR/ledger.sqlite`에 둔다. 이미 올린 승인 카드와 작업 카드 기록도 같은 파일에 둔다.

## 5. 동작

- **대화 단위**: DM은 사용자별로, 서버 채널과 스레드는 채널별로 하나의 대화다. 대화마다 gjc-head 스레드가 하나씩 붙는다. 이 연결은 엔티티 `discord.conversation`(id는 head 스레드 id)에 기록한다.
- **서버 채널**: 봇을 멘션하거나 봇의 메시지에 답장해야 반응한다. `openGroups`에 넣은 채널은 예외다.
- **`/new`**: 메시지가 정확히 `/new`면 그 대화만 새로 시작한다. 새 epoch와 새 head 스레드를 만든다. 이전 epoch에서 아직 보내지 못한 답장은 버린다.
- **진행 표시**: 사용자 메시지에 반응을 단다. 처리하는 동안에는 "입력 중"을 보인다.
  - 👀 받음
  - 🤔 판정 중
  - ✍️ 답하는 중
  - 📤 위임함
  - ✅ 끝
  - ⚠️ 오류
- **답장**: 2000자를 넘으면 줄 단위로 나눈다. 코드 블록 중간에서 나뉘면 앞 조각에서 닫고 다음 조각에서 같은 언어로 다시 연다.
- **재시작 복구**: 보내다가 결과를 모르게 된 답장은 재시작 때 한 번 더 보낸다. 이때 끝에 `(중복일 수 있음 — 재시작 후 다시 보냄)`을 붙인다.
- **승인**: 대화에서 시작된 위임 승인 요청은 그 대화에 카드로 올라온다. 카드에는 **승인/거절** 버튼과 하네스 선택 메뉴가 있다. 다른 하네스를 고르고 승인하면 `amend.harness`로 전달된다.
- **위임 결과**: 작업이 봉인(sealed)되면 결과 요약을 **수락/거절/diff** 버튼과 함께 올린다. diff는 파일로 첨부해서 보여 준다.
- **알림(`notify`)**: 예약 실행(schedule)이 `{text}`를 보내면 `notifyChannel`에 하나로 올려요. 답장과 같은 원장을 써서 비밀이 가려지고, 글은 길이 제한에 맞게 나눠서 보내요.
- **버튼 권한**: 버튼은 주인만 누를 수 있다. 다른 사람이 누르면 그 사람에게만 보이는 거절 메시지가 간다.

## 6. 권한 (plugin.json)

- `read-state`
- `subscribe`
- `call:gjc-head`
- `call:brgr`
- `approve.decide`
- `network`

구독하는 이벤트는 `kernel.approval.*`, `brgr.task.*`, `gjc-head.message.*`다.

## 7. 테스트

```sh
bun test plugins/discord
```

테스트는 가짜 `DiscordGateway`와 가짜 `Kernel`만 쓴다. 네트워크와 실제 토큰은 쓰지 않는다.
