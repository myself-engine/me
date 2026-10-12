# budget 플러그인

아무도 지켜보지 않을 때 위임이 할당량을 다 쓰지 못하게 막아요. 토큰을 직접 세지 않고, 두 가지를 봐요.

- **위임 횟수**: brgr 작업 이벤트를 세어요. 하루 한도(기본 30건)와 자동 적용 한도(기본 10건)를 넘으면 새 위임을 막아요.
- **제공자 한도**: 로컬 `meter status --json`이 알려 주는 제공자별 남은 양을 봐요. 적게 남으면 승인을 물어보고, 거의 다 쓰면 막아요.

## 메서드

- `budget.check({harness, project, autoApply?, model?})` → `{ok, needsApproval?, reason?}`
  - brgr가 위임을 시작하기 전에 불러요. `ok: false`면 시작하지 말고, `needsApproval`이면 사용자에게 `reason` 그대로 물어봐요.
  - 횟수를 세지 않아요. 횟수는 작업 이벤트에서 알아서 올라가요.
- `budget.status()` → 오늘 횟수, 한도, 제공자별 남은 양, 문제점을 돌려주고 `budget.day`와 `budget.summary` 엔티티에 저장해요. 설정 일반란에 한 줄로 보여요.

## 설정 (pluginConfig budget)

| 키 | 기본값 | 뜻 |
|---|---|---|
| `dailyCap` | 30 | 하루 위임 한도 (지역 자정 초기화) |
| `autoApplyCap` | 10 | 하루 자동 적용 한도 |
| `minRemainingPercent` | 10 | 이 % 밑이면 승인 요청 |
| `hardStopPercent` | 3 | 이 % 밑이면 위임 중단 |
| `providers` | `{"local.codex": "codex", "local.claude-code": "claude"}` | 하네스 → meter 제공자 |
| `opencodeModelPrefix` / `opencodeProvider` | `opencode-go` | 모델 id가 이 말로 시작하면 이 제공자로 봐요 |
| `meterCmd` | `["meter", "status", "--json"]` | meter 실행 방법 |
| `meterTimeoutMs` | 5000 | meter 대기 시간 |
| `cacheSec` | 60 | meter 답 기억 시간 |

## 알아둘 점

- meter가 없거나 답이 이상해도 위임을 막지 않아요. `budget.status()`의 `problem`에 이유가 남아요.
- 하네스에 맞는 제공자가 없으면(모르는 하네스) 한도 확인을 건너뛰어요.
- 설정이 없어도 기본값으로 돌아가서, 플러그인을 빼도 me가 그대로 돌아가요.
