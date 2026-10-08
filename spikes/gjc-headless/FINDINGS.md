# GJC headless 모드 검증 결과

- 일자: 2026-10-09
- 대상: gjc 0.18.7
- 사용 모델: `commandcode-goat/inclusionai/ling-3.1-flash:free` (Anthropic 모델은 쓰지 않음)
- 대응 항목: DESIGN.md 미해결 1번 "`gjc --mode acp`/`json`이 headless로 쓸 만한 구조화 이벤트를 실제로 내보내는가"

## 결론

| 항목 | json 모드 (`-p --mode json`) | ACP 모드 (`--mode acp`) |
|---|---|---|
| 구조화 이벤트 | ✅ NDJSON | ✅ JSON-RPC `session/update` |
| 답변 스트리밍 | ✅ `text_delta` | ✅ `agent_message_chunk` |
| 생각 스트리밍 | ✅ `thinking_delta` | ✅ `agent_thought_chunk` |
| 도구 호출 | ✅ `toolcall_*`, `tool_execution_start/end` (`intent` 포함) | ✅ `tool_call`, `tool_call_update` (`kind`, `title`, `status` 포함) |
| 세션 유지와 재개 | ✅ 호출마다 프로세스 하나, `--continue`로 맥락이 이어짐 (실측) | ✅ `loadSession`, list/fork/resume/close/delete |
| 모델 지정 | `--model` | `--model` 또는 `session/set_config_option` |
| **편집 도구 차단** | ✅ **`--no-mcp --tools read,ls`를 함께 줄 때만** | ❌ **방법 없음** |

**head는 ACP가 아니라 json 모드로 시작해야 한다.** ACP가 기능은 더 풍부하지만 "head는 코드를 만지지 않는다"를 강제할 수 없다.

## 세부 관찰

### json 모드
- 성공한 실행에서 나온 이벤트 종류
  - 기본 흐름: `session`, `agent_start/end`, `turn_start/end`, `message_start/end`
  - `message_update`의 하위 종류: `thinking_*`, `text_*`, `toolcall_*`
  - 도구 실행: `tool_execution_start/end`
- 웹에서 스트리밍 마크다운, 생각, 도구 카드를 그리기에 충분하다.
- **`--tools`만으로는 쓰기를 막지 못한다.** `--tools read,ls`로 실행해도 자동으로 불러온 MCP 도구(`mcp__aside_repl`)로 파일 쓰기를 시도했다. Aside 샌드박스가 worktree 경로를 거부해서 Aside 세션 폴더에 파일이 생겼다.
- `--no-mcp --tools read,ls`를 함께 주면 쓰기가 막혔다. 모델은 "쓰기 도구가 없다"고 답했다.
- **`--tools` 화이트리스트가 완전하지 않다.** `read,ls`를 지정했지만 노출된 도구는 `read`, `goal`, `generate_image`였다. `ls`는 없고, 지정하지 않은 `goal`과 `generate_image`가 붙었다.

### ACP 모드
- `initialize` 응답에서 확인한 내용
  - `agentInfo`: gajae-code 0.18.7
  - `authMethods`: 로컬 `~/.gjc` 자격 증명을 그대로 쓴다
  - `sessionCapabilities`: list, fork, resume, close, delete
- **ACP 모드는 CLI 옵션 대부분을 거부한다.** `--no-mcp`, `--no-title`, `--tools`를 주면 "Unsupported under SDK-backed ACP" 오류로 종료한다. `--model`은 허용된다.
- `session/new` 응답의 `configOptions`
  - `mode`: default/plan
  - `model`: 558개
  - `thinking`, `steeringMode`, `followUpMode`, `toolInterruptPolicy`
  - **도구를 제한하는 옵션은 없다.**
- **권한 요청 없이 파일을 썼다.** 쓰기를 요청하자 `tool_call`(kind `edit`) 다음 바로 `completed`가 왔고 `hello.txt`가 생겼다. `session/request_permission`은 한 번도 오지 않았다.
- `mode=plan`으로 바꾸려 하자 `-32602 "ACP plan mode is not available because this ACP session has no host plan-mode lifecycle"`로 거부됐다. 이후 파일이 다시 생겼다.
- **모델 목록에 Claude 계열이 노출된다** (예: `cursor/claude-*`). 허용 목록으로 막지 않으면 Claude ToS 제약을 어길 수 있다.

## 함께 발견한 것

- **GJC 기본 모델이 깨져 있다.** `modelRoles.default`가 `commandcode-goat/inclusionai/ling-3.0-flash-sante:free`인데, 이 모델은 무료 제공이 끝나 404를 반환한다.
- **OpenCode Zen 무료 모델은 GJC에서 쓸 수 없다.** 403 "free tier can only be used from within OpenCode"가 나온다. `opencode-zen/jev-1.13-free`도 같은 경로라서, Jev 무료 버전을 GJC 안에서 쓰는 것은 불가능할 것으로 보인다. 직접 확인하지는 않았다.
- 무료 모델은 429(일시 제한)가 자주 난다. head 플러그인에는 재시도와 백오프가 필요하다.
- `gjc quick-lane classify`라는 명령이 있다. 작업을 quick lane과 deep path로 분류한다. Jev 판정과 겹칠 수 있어 비교해 볼 만하다.
- `--no-session`이어도 실행 디렉터리에 `.gjc/`가 생긴다. `.gitignore`에 추가했다.
- **json 모드에서 `--continue`로 맥락이 이어진다.** 첫 호출에서 "PINEAPPLE을 기억해", 두 번째 호출에서 `--continue`로 "코드워드가 뭐였지?"를 물었다. 같은 세션 ID로 `PINEAPPLE`이라고 답했다.
- **아직 확인하지 않은 것: `--tools`에 쓸 수 있는 정확한 도구 이름 목록.** `ls`는 존재하지 않았다. 허용 목록을 만들기 전에 전체 목록을 확인해야 한다.

## 설계에 반영할 것

1. **head 플러그인은 json 모드로 시작한다.** `gjc -p --mode json --no-mcp --tools <허용 목록>`을 쓴다. 대화 맥락은 `--continue`/`--resume`나 세션 파일로 이어 간다.
2. **도구 제한은 두 겹으로 건다.** `--no-mcp`로 MCP 자동 로드를 끄고, `--tools`로 허용 목록을 준다. 그래도 화이트리스트가 완전하지 않으니, **실제로 노출된 도구를 실행마다 이벤트에서 확인**하고 허용 목록 밖의 도구가 보이면 실행을 중단하는 감시를 커널 권한 계층에 둔다.
3. **ACP는 "읽기 전용 head"에는 아직 쓰지 않는다.** 다만 세션 재개와 포크가 좋으니, 워커 하네스와 대화하는 ACP 플러그인에서는 여전히 유력하다.
4. **Anthropic 모델을 허용 목록에서 제외한다.** GJC 설정의 `enabledModels`나 head 플러그인의 모델 검증으로 `claude`, `anthropic` 계열을 거부한다.
5. **head 기본 모델을 명시적으로 고정한다.** GJC 기본값에 의존하지 않는다.

## 재현

```sh
# json 모드
gjc --model "<model>" --mode json -p --no-session --no-title --no-mcp --tools read,ls "<prompt>"

# ACP 모드
bun spikes/gjc-headless/acp-probe.ts "<model>" out.ndjson "<prompt>"
ACP_MODE=plan bun spikes/gjc-headless/acp-probe.ts "<model>" out.ndjson "<prompt>"
```

원본 기록(`*.ndjson`, `*.err`)은 계정 정보가 섞일 수 있어 커밋하지 않는다.
