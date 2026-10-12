# schedule 플러그인

정해진 시각에 프롬프트를 자동으로 실행해요. 아침 브리핑, 주간 정리처럼 매일 보는 보고서를 예약해 두면, me가 켜져 있을 때 알아서 돌리고 결과를 웹과 메신저로 보내줘요.

## 동작

- **시각**: Mac의 지역 시간대로 봐요. `daily`(매일), `weekdays`(월–금), `weekly`(요일 지정), `cron`(다섯 칸) 종류가 있어요.
- **실행**: 때가 되면 gjc-head `chat.send`로 job마다 따로 있는 대화(`sched-<id>`)에 prompt를 보내요.
- **겹치면 건너뜀**:前の 실행이 아직 돌고 있으면 새로 시작하지 않고 `skipped`으로 남겨요.
- **꺼져 있었으면**: me가 꺼진 동안 지난 시각은 60초 안이면 바로 실행하고, 그보다 오래됐으면 실행하지 않고 `missed`로 한 번만 남겨요.
- **실패하면**: 시작이 실패하면 최대 두 번 다시 시도해요.
- **쓰기 권한**: `project`나 `full` 접근은 실행 때마다 승인을 물어봐요. `allowUnattendedWrite: true`면 묻지 않아요.
- **전달**: 답이 다 되면 앞 600자를 `deliver`에 적힌 곳으로 보내요. 웹은 대화에 그대로 남고, discord/slack은 각 플러그인의 `notifyChannel`로 가요. 메신저 플러그인이 없으면 한 번만 알리고 웹 결과만 남겨요.

## 메서드

- `schedule.add({name, prompt, project?, access?, when, deliver?})` → job을 만들어요. `access` 기본값은 `read`, `deliver` 기본값은 `["web"]`이에요.
- `schedule.update({id, ...바꿀 값})` / `schedule.remove({id})` → 실행 중에 만든 job만 바꿀 수 있어요. 설정 파일의 job은 읽기 전용이라 `runNow`만 돼요.
- `schedule.list()` → job 목록과 다음 실행(`nextRun`), 마지막 실행(`lastRun`)을 돌려줘요. 나중에 예약 실행 화면이 이걸 써요.
- `schedule.runNow({id})` → 시각과 상관없이 지금 한 번 실행해요.

## 설정 (pluginConfig schedule)

| 키 | 기본값 | 뜻 |
|---|---|---|
| `jobs` | `[]` | 고정 job 목록 (id가 그대로 유지돼요, 읽기 전용) |
| `allowUnattendedWrite` | `false` | `true`면 쓰기 접근도 승인 없이 실행해요 |
| `timezone` | 시스템 시간대 | 시각을 볼 시간대 |
| `tickSec` | 30 | 몇 초마다 때를 확인해요 (최소 5) |
| `missGraceSec` | 60 | 꺼져 있던 때로부터 이 안의 시각은 켜지자마자 실행해요 |

job 한 개의 예:

```json
{
  "id": "morning",
  "name": "아침 브리핑",
  "prompt": "오늘 일정과 할 일을 요약해줘",
  "access": "read",
  "when": { "kind": "weekdays", "time": "08:30" },
  "deliver": ["web", "discord"]
}
```

- `when`은 `{kind: "daily", time: "09:00"}`, `{kind: "weekly", time: "09:00", weekday: 5}`(0=일요일), `{kind: "cron", cron: "30 9 * * 1-5"}` 모양이에요.
- `deliver`에는 `web`에 더해 `discord`, `slack`을 붙일 수 있어요. 그 플러그인 설정에 `notifyChannel`(채널 id)을 적어 두세요.

## 알아둘 점

- `schedule.run` 엔티티에 실행 기록(`started`, `done`, `failed`, `skipped`, `missed`)이 남아요.
- 설정이 없어도 빈 목록으로 돌아가고, gjc-head나 메신저 플러그인이 없어도 me가 그대로 돌아가요.
- 실행 기록의 `at`은 예약된 시각이에요. 답이 늦게 와도 바뀌지 않아서, 꺼져 있던 기록이 두 번 남지 않아요.
