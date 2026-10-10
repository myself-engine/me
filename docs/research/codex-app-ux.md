# Codex 앱 UX → me 「대화에서 끝내기」 조사

조사일: 2026-10-11, Asia/Seoul. 모드: mixed. 명확화 질문: 0회. 판정: **승인된 프리셋 유지, 맥락·승인 결과·검토 범위를 더 명확하게 다듬기.** 제품 구현이나 프리셋 변경 승인이 아니라 조사 결과다.

## 0. 증거와 판정 기준

- **공식 문서에서 확인한 동작**, **설치 번들에 있는 문자열**, **me 코드/승인된 설계**, **조사자의 추천**을 구분한다. 문서의 예시·설명은 사용자 계정의 실제 기능 제공 여부를 증명하지 않는다.
- 2026년 2월 출시 글의 `threads`와 현재 문서의 `chats`를 섞어 하나의 고정 UI로 설명하지 않는다. 기존 `developers.openai.com/codex/...` 문서 주소는 이번 조회에서 `learn.chatgpt.com/docs/...`로 이동했다. 최신 문서도 desktop/app, web, CLI, IDE 조건을 구분해야 한다.[S1][S2][S3]
- 설치 앱은 표시 이름 `ChatGPT`, 식별자 `com.openai.codex`, 버전 `26.930.61225`, 빌드 `13232`다. ASAR package의 `productName`은 `Codex`다. 이 차이만으로 모든 Codex/ChatGPT 기능의 통합 범위를 단정하지 않는다.[L1][L2]
- me 기준은 **최종 승인 설계** [M1]이며 현행 코드가 이미 전부 구현했다고 가정하지 않는다. 조사 시작 시 `app.css`, `approvals.tsx`, `chat.tsx`, `shared.tsx`에는 기존 변경이 있었다. 보존했고 실행 중인 me와 비교하지 않았다.
- adopt = 기존 패턴을 그대로 채택·유지, adapt = me의 데이터/폰/한국어에 맞춰 변형, skip = 이번 범위에서 제외. 모든 추천에는 근거를 붙인다. 우선순위는 실측 점수가 아닌 단일 개발자의 폰·맥 과업에 대한 설계 판단이다.

### 출처 목록

| ID | 출처 · 확인 범위 |
|---|---|
| S1 | [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/): 프로젝트별 스레드, 스레드 안 diff·댓글, 격리 worktree, 기본 보안, 자동화 결과 검토 큐. 출시 시점 설명. |
| S2 | [Projects and chats](https://learn.chatgpt.com/docs/projects): 현재 앱/웹 구분, New chat, 프로젝트 없는 대화, 짧은 결과 중심 이름, pin/archive, 로컬 폴더·주 작업 폴더. |
| S3 | [Code review](https://learn.chatgpt.com/docs/code-review?surface=app): 앱 로컬 diff 범위, 파일·hunk 작업, 인라인 댓글, PR 리뷰와 로컬 리뷰의 차이. |
| S4 | [Permissions](https://learn.chatgpt.com/docs/permission-modes): 입력창 아래 권한 선택, Ask for approval / Approve for me, 환경·정책별 가용성. |
| S5 | [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security): sandbox와 승인 정책의 구분, 파일/네트워크 경계. |
| S6 | [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review): 별도 검토자가 요청을 평가하며 권한 경계를 넓히지는 않음. |
| S7 | [Long-running work](https://learn.chatgpt.com/docs/long-running-work): 같은 대화에서 후속 지시, 목표·제약·검증, 앱 입력창 위 진행 행과 목표 제어. |
| S8 | [Notifications](https://learn.chatgpt.com/docs/notifications): 제공되는 경우 Activity의 unread/running/waiting 대화, 알림 종류, Mark all as read. |
| S9 | [Codex on mobile](https://learn.chatgpt.com/docs/mobile): 실행 기기·프로젝트 선택, 진행 확인, 명령 승인, 파일 diff·테스트 결과 검토. 롤아웃 조건 명시. |
| S10 | [Local environments](https://learn.chatgpt.com/docs/environments/local-environment): 로컬 설정·action, 앱 내 stage/revert/commit/push/PR. |
| S11 | [Codex Cloud](https://learn.chatgpt.com/docs/cloud): Work in > Cloud, Select environment, 환경 준비·게시와 작업 시작의 구분. |
| S12 | [Changelog](https://learn.chatgpt.com/docs/changelog): 2026-10-07 iOS 승인 선택기·기기 선택 유지·상태를 질문으로 잘못 표시하던 문제 개선; 10-02 복귀 시 목록 갱신·제목 유지; 09-18 thinking timer 초기화 수정. 날짜는 문서 표기를 그대로 인용. |
| L1 | `/Applications/ChatGPT.app/Contents/Info.plist`: 위의 표시 이름·식별자·버전·빌드. 실행하지 않고 읽음. |
| L2 | `/Applications/ChatGPT.app/Contents/Resources/app.asar`, 내부 `package.json`, `native-menu-locales/ko-KR.json`: package 식별 및 아래 용어표의 한국어 메뉴 문자열. 메모리에서 읽었으며 자산·코드 추출 파일 없음. |
| M1 | [승인된 최종 프리셋](../design/ux-easier-preset.md), 특히 §1, §3–4: 3탭·인라인 승인/적용·배지·용어·상태·모바일 규칙. |
| M2 | [기존 UX 발견](../design/ux-easier-discovery.md): F1–F9 마찰. 일부 데이터 출처는 M1에서 정정됨. |
| M3 | [390px 승인 미리보기](../design/ux-easier-preview-390.png): 직접 눈으로 확인. 승인·실행 도구·위험·요청 내용·composer가 한 화면에 있음. 실제 동작/터치 크기 검증은 아님. |
| M4 | `plugins/web/ui/chat.tsx`, `tasks.tsx`, `review.tsx`, `state.ts`: 현재 대화·작업·diff·상태 코드. |
| M5 | `plugins/web/ui/main.tsx`, `shared.tsx`, `ops.tsx`, `api.ts`: 현재 5탭/배지·공통 상태/경로·연결/점검·사용 가능한 데이터. |
| M6 | `AGENTS.md`, `docs/DECISIONS.md` §20–21, `docs/PROTOCOL.md` §15, `docs/DONE.md`: 시각 규칙, 단계·trace·점검 갱신과 완료 기준. |

## 1. 메시지에서 일 시작하기

**Codex가 하는 일.** 출시 앱은 프로젝트별 스레드로 일을 나눈다.[S1] 현재 앱 문서는 `New chat`으로 프로젝트 없이 시작하는 경로와, 폴더가 필요한 일을 로컬 프로젝트에서 시작하는 경로를 구분한다. 서로 다른 결과는 별도 대화로 관리하고 짧은 결과 중심 제목을 권한다.[S2] Cloud는 환경을 선택한 뒤 요청을 보내며, 환경 생성/게시 자체는 별도 준비 단계다.[S11]

**프리셋과 이미 맞는 것.** 폰 대화 목록 아래 새 대화 composer, 기존 스레드에서 이어쓰기, 사용자 원문 제목, 프로젝트 칩이 같은 방향이다.[M1] 현행 `main.tsx`의 `chat.send`는 첫 응답의 threadId로 새 대화 URL을 바꾸므로 새 대화 시작을 위해 별도 생성 화면이 필수는 아니다.[M5]

| 판정 | 구체 추천 · 이유 · 근거 |
|---|---|
| adopt | `ChatScreen` 목록 composer를 프리셋대로 유지. 빈 화면에서 바로 입력하고 전송할 수 있어야 한다. 프로젝트 생성 마법사를 첫 과업에 끼워 넣지 않는다. 프로젝트 없는 시작과 기존 맥락의 이어쓰기를 모두 살린다.[S2][M1] |
| adapt | composer 주변에 선택된 프로젝트명을 한 번만 표시하고 `작업할 프로젝트`로 선택 의미를 설명한다. 전체 경로는 상세 정보로. 폰에서 이전 선택을 잃지 않게 하되, 현재 연결/프로젝트가 달라졌으면 전송 전 알려야 한다. 기기/프로젝트 선택 유지라는 패턴만 취한다.[S9][S12][M1][M5] |
| skip | `Work in > Cloud`, 환경 게시, worktree 모드를 기본 composer에 그대로 추가하지 않는다. Codex Cloud의 실행 구조이지 me의 기존 데이터 계약이 아니다.[S10][S11][M5] |

## 2. 실행 중 작업: 진행·단계·출력·경과 시간

**Codex가 하는 일.** 현재 앱의 Goal mode는 composer 위 진행 행에 pause/resume/edit/clear를 두며 같은 대화에서 후속 메시지로 지시를 조정한다.[S7] 모바일은 작업을 열어 진행을 보고 지시를 보낼 수 있다.[S9] 릴리스 노트는 thinking timer 리셋과 상태 업데이트가 질문처럼 보이는 문제를 수정했다고 명시한다.[S12] **고정 단계 이름, 정확한 경과 시간 위치, progress 백분율 규칙은 확인하지 못했다.**

**프리셋과 이미 맞는 것.** 점+단계+경과 시간, 클릭 시 기존 TraceDrawer, 완료 시 한 줄 접근성 통지가 있다.[M1] me에는 phase/label/progress와 op 시작·종료 데이터가 있고, `shared.tsx`는 `useNow`/`elapsed`를 제공한다.[M5][M6]

| 판정 | 구체 추천 · 이유 · 근거 |
|---|---|
| adopt | `PhaseLine`을 현재 대화 안의 요약으로 유지하고 raw 출력·호출 트리는 TraceDrawer로 보낸다. 상태를 알기 위해 작업 탭으로 옮기게 하지 않는다.[S7][S9][M1] |
| adapt | `승인 대기 · 확인이 필요해요`와 `진행 중 · 테스트 실행 중 · 2분 10초`를 구별한다. 예시 시간/단계는 추천 문구이며 Codex 원문이 아니다. 숫자 진행률은 실제 progress가 있을 때만, 경과 시간은 실행 시각을 기준으로, 완료 후에는 고정한다. 출력이 잠깐 없다는 이유로 실패라고 바꾸지 않는다.[S12][M5][M6] |
| skip | Goal mode의 pause/resume/clear를 me에 즉시 복제하지 않는다. 기존 phase/trace는 관찰 기능이지 작업 제어 API의 증거가 아니다. 취소·재개 지원과 안전 의미를 먼저 확인해야 한다.[S7][M5][M6] |

## 3. 행동 전 승인·권한 요청

**Codex가 하는 일.** 입력창 아래 권한 선택이 있고 `Ask for approval`과 `Approve for me`를 구분한다. sandbox는 접근 범위, 승인 정책은 경계 넘는 행동을 누가 검토하는지를 정한다.[S4][S5] 자동 검토자가 생겨도 권한 경계는 넓어지지 않는다.[S6] 폰에서도 계속 실행하기 전에 요청 명령·행동을 검토한다.[S9]

**프리셋과 이미 맞는 것.** 카드 첫 줄 요약+위험 라벨, 프로젝트·실행 도구, `승인하고 시작`/`거절`, 요청 내용 접기, 실패 시 카드 안 오류가 정확한 방향이다.[M1][M3] me의 위임 시작 승인은 Codex의 개별 명령 sandbox 승인과 **다른 단계**다.[M4][M5]

| 판정 | 구체 추천 · 이유 · 근거 |
|---|---|
| adopt | 대화 카드에서 바로 승인하고 같은 화면에 남는 프리셋을 유지한다. 모아 처리할 때는 작업 탭의 `승인 요청` 및 `확인 필요`로 접근한다. 비-위임 승인도 빠뜨리지 않는다.[S9][M1] |
| adapt | 승인 카드의 `a.summary`를 행동 중심 첫 문장으로 노출한다. `승인하면 선택한 실행 도구가 이 프로젝트에서 작업을 시작해요`처럼 **시작 승인의 효과**를 설명한다. 이미 승인된 설계의 요약 전면 배치를 강화하되, payload에 없는 실제 명령·삭제·외부 전송을 만들어내지 않는다.[S5][S9][M1][M5] |
| skip | `위험 보통`을 `코드 수정`이라고 번역하거나 `Approve for me`를 실행 도구 선택과 같은 뜻으로 쓰지 않는다. risk만으로 행위를 추론할 수 없고 도구 선택은 권한 부여가 아니다. 자동 승인 전역 토글도 이번 추천에서 제외한다.[S4][S6][M1] |

## 4. 결과 검토: 요약·파일 diff·적용·커밋·PR·거절·후속

**Codex가 하는 일.** 스레드 안에서 변경과 diff 댓글을 볼 수 있다는 것이 출시 핵심이다.[S1] 현재 로컬 review pane은 기본 `Unstaged`이며 Codex 변경뿐 아니라 사용자/다른 도구의 미커밋 변경도 포함한다. `Staged`, `Commit`, `Branch`, `Last turn`으로 범위를 구분하고 파일/hunk 단위 stage/revert를 제공한다.[S3] 로컬 환경 문서는 commit/push/PR도 지원한다고 설명한다.[S10] 인라인 댓글 뒤에는 의도를 명확히 하는 후속 메시지를 보내도록 한다. PR의 `Approve`는 로컬 변경 적용과 같은 동작이 아니다.[S3]

**프리셋과 이미 맞는 것.** 결과 요약 → 파일 통계/diff → 액션, 메타 접기, 대화 카드의 `전체 diff ›`, `변경사항 적용`과 `거절`이 맞는다.[M1] me의 기존 apply 동작은 적용+커밋을 뜻하므로 버튼을 간단히 바꾸더라도 부수 효과를 숨기면 안 된다.[M1][M4]

| 판정 | 구체 추천 · 이유 · 근거 |
|---|---|
| adopt | 결과 카드 `+N -N · 파일 N개`와 `전체 diff ›`를 유지. 작업 상세는 한 줄 결과와 변경 파일을 위에 두고 실행 도구·경로·시간은 접는다. 요약만 본 채 정확한 변경을 찾지 못하는 상황을 막는다.[S1][S3][M1] |
| adapt | `Review` 액션 바로 옆에 `이 작업의 변경사항을 적용하고 커밋해요`를 상시 표시한다. 수락 응답만으로 완료 처리하지 말고 `accepted`는 `적용 중`, 실제 `applied`에서 `적용 완료`로 표시한다. 실제 commitSha가 있으면 그 식별자를 보여준다. diff가 어느 작업/기준인지 명시하고, 검토 실패/빈 diff를 성공과 혼동하지 않는다.[S3][S10][M1][M4][M5] |
| adapt | 결과 카드에 `수정 요청은 아래 메시지로 보내 주세요`라는 짧은 안내를 둔다. 기존 composer로 파일명·원하는 수정사항을 보내게 한다. 새로운 댓글 저장/라인 주석 API를 먼저 만들 필요는 없다.[S3][S7][M1] |
| skip | per-hunk stage/revert, `Push`, `Create PR`를 현재 수락 바에 붙이지 않는다. me의 봉인된 작업 단위 수락과 Codex의 checkout 전체 Git 조작은 범위가 다르다. `거절`도 `Revert all`로 번역하지 않는다. 사용자 변경까지 되돌리는 뜻으로 오인할 수 있다.[S3][S10][M4] |

## 5. 작업 목록·인박스·배지

**Codex가 하는 일.** 현재 앱 문서에서 Activity는 **제공되는 경우** unread/running/waiting 대화를 모으며 `Mark all as read`를 지원한다.[S8] 출시 글은 자동화 완료 결과의 review queue를 설명한다.[S1] 프로젝트 문서는 pin/archive로 활성 작업과 종료 작업을 분리한다.[S2] 이것만으로 정확한 숫자 배지 계산 규칙은 알 수 없다.

**프리셋과 이미 맞는 것.** 작업 탭 한 곳의 배지 = 확인 필요+비-위임 승인 요청, 대화 목록의 확인 필요 표시는 진입 신호다.[M1] 현행 `main.tsx`에는 아직 작업/승인 별도 배지와 5탭이 있어 목표 설계와 구별해야 한다.[M5]

| 판정 | 구체 추천 · 이유 · 근거 |
|---|---|
| adopt | 승인된 `대화 / 작업 / 상태`와 작업 탭 단일 배지를 유지. 위임 승인·결과 검토·비-위임 승인마다 고유 식별자로 세고 같은 일을 이중 계산하지 않는다.[S8][M1][M5] |
| adapt | `TasksScreen` 행은 사용자 원문 제목 + `승인해 주세요`/`변경사항을 검토해 주세요`처럼 **내가 해야 할 일**을 설명한다. `진행 중`, `완료`, `실패`는 확인 필요와 분리한다. 메시지를 읽었다는 이유만으로 승인/검토 필요를 지우지 않는다.[S2][S8][M1][M4] |
| skip | `Mark all as read`를 me의 `확인 필요 모두 지우기`로 복제하지 않는다. unread와 승인 대기는 별도 의미다. pet, 팀 PR inbox, 자동화 전용 탭도 단일 개발자 핵심 과업에는 불필요하다.[S3][S8][M1] |

## 6. 환경·연결·상태

**Codex가 하는 일.** 폰에서 Cloud 또는 연결된 컴퓨터와 프로젝트를 고르고, 로컬 작업은 컴퓨터를 켜 두어야 한다.[S9] 현재 프로젝트 문서는 대화 sync와 폴더 접근은 다르며, 기기가 사용 불가할 때 일부 적격 작업만 cloud로 이어질 수 있고 turn 도중에는 전환할 수 없다고 구분한다.[S2] 환경 설정에는 setup/actions/Git 도구가 별도로 있다.[S10][S11]

**프리셋과 이미 맞는 것.** 상태 탭의 기기·요약과 고급 진단 분리, 프로젝트명 칩·전체 경로 접기가 맞는다.[M1] `api.ts`의 connection 상태와 OpsCheck는 다른 신호이며 checks에 `checkedAt`이 있다. 저장 점검은 변경 없을 때 최대 10분+점검 주기 늦을 수 있다.[M5][M6]

| 판정 | 구체 추천 · 이유 · 근거 |
|---|---|
| adopt | 상태 첫 화면은 `정상`/`점검 필요`와 기기별 상태를 보여주고 plugin id·pid·권한은 고급 진단에 남긴다. 내부 실행 구조를 composer의 기본 선택지로 늘리지 않는다.[S9][S10][M1] |
| adapt | 대화 연결이 끊기면 `연결이 끊겼어요 · 다시 연결하는 중…`을 유지하고, 마지막 표시된 진행/점검이 실시간이 아님을 분명히 한다. `OpsScreen` 점검 요약에는 `마지막 확인`을 표시한다. 폰에서 웹 연결 정상과 워커 기기 정상은 서로 같지 않다.[S2][S9][M5][M6] |
| skip | me가 연결 끊김 때 자동으로 Cloud에서 실행을 이어간다는 문구를 쓰지 않는다. Codex의 조건부 동작을 me의 보장으로 옮길 수 없다. 새 remote pairing/sync 기능도 조사 범위 밖이다.[S2][S9][M5] |

## 7. 용어·빈 상태·폰 동작

**Codex가 하는 일.** 문서는 `New chat`, `Projects`, `Activity`, `Ask for approval`, review scope처럼 사용자 목적을 이름으로 쓴다.[S2][S3][S4][S8] 번들 한국어 메뉴에는 아래 정확한 문자열이 존재한다.[L2] 모바일 문서는 시작·승인·diff 검토를 같은 폰에서 수행하는 과업을 설명하고, iOS 릴리스는 키보드 전환·목록 복귀·제목 유지 문제를 개선한다.[S9][S12] **문서만으로 390px 배치, 탭 수, 터치 크기, 빈 상태 원문은 확인할 수 없다.**

**프리셋과 이미 맞는 것.** 실행 도구/작업 결과/변경사항 적용이라는 한국어, 원문 제목, 목록 composer, 44px, hover 전용 금지, 점+글자가 있다.[M1][M6] 미리보기는 카드로 처리하는 방향을 보여주지만, composer의 긴 경로와 내부 용어 `위임 ›`도 남아 있어 최종 용어·경로 규칙의 완료 증거는 아니다.[M3]

| 판정 | 구체 추천 · 이유 · 근거 |
|---|---|
| adopt | 승인된 한국어 용어·점+글자·상태에만 색·760px 분기·44px 목표를 유지한다. Codex 아이콘/색/자산은 복사하지 않는다.[L2][M1][M6] |
| adapt | `ChatScreen` 빈 목록: `무엇을 도와드릴까요?` + `아래에 메시지를 보내 새 대화를 시작하세요`. 작업 확인 필요 빈 상태: `지금 확인할 일이 없어요`; 필터 결과 없음: `이 프로젝트에 해당하는 작업이 없어요`. 모두 **추천 문구**, Codex 빈 상태 인용 아님. 빈 상태에서 다음 행동을 설명하되 프로젝트/권한 흐름과 혼동하지 않는다.[S2][S9][M1][M5] |
| adapt | 폰에서 복귀 시 제목·프로젝트·작성 중 메시지를 잃지 않는 것을 검증 항목으로 삼는다. 파일 diff는 hover 없이 파일 행을 눌러 펼치게 유지한다. reconnect 때 중복 전송이나 성공 추정을 피한다. Codex 릴리스에서 드러난 실패 종류를 me의 검증 시나리오로 변형한다.[S3][S12][M1] |
| skip | desktop의 hover `+` 댓글이나 Git 단축키를 폰의 유일한 접근 경로로 삼지 않는다. 번들에 문자열이 있다고 현재 메뉴가 보인다고 단정하지도 않는다.[S3][L2][M6] |

### 용어표: 정확한 Codex 근거 → me 추천

`문서`는 공식 문서의 표기이며 설치 앱 버튼을 직접 관찰한 것이 아니다. `번들`은 해당 key의 저장 문자열이며 실제 노출 여부는 미확인이다.

| Codex 표기 | 증거 | me 표기 추천 · 의미 |
|---|---|---|
| New chat / 새 채팅 | 문서 S2; 번들 `codex.command.newThread` L2 | `새 대화` — me 전체 용어와 일치.[M1] |
| 새 독립형 채팅 | 번들 `codex.command.newProjectlessTask` L2 | `새 대화`로 통합; 별도 독립형 유형을 늘리지 않음.[S2][M1] |
| Projects | 문서 S2 | `프로젝트` — 선택 칩과 상태 탭 등록 목록.[M1] |
| Activity | 문서 S8 | `작업` — 미독 인박스가 아닌 승인/검토 포함 백로그.[M1] |
| Running / Needs input / Ready / Blocked | 문서 S8의 pet 상태 | `진행 중 / 확인 필요 / 검토 대기 / 진행 불가`라는 의미 참고만; Ready를 무조건 적용 완료로 번역하지 않음.[M1][M4] |
| Ask for approval | 문서 S4 | `승인 요청`(섹션), `승인 대기`(상태); 시작 버튼은 `승인하고 시작`.[M1] |
| Approve for me | 문서 S4·S6 | `자동 승인 검토`라는 설명상의 번역만. 지금 UI에 새 권한 모드를 만들지 않음.[M1] |
| 변경 사항 패널 표시/숨기기 | 번들 `codex.command.toggleReviewPanel` L2 | `전체 diff ›` — 상세 진입. 파일 본문은 `변경사항`.[M1] |
| Unstaged / Staged / Commit / Branch / Last turn | 문서 S3 | `이 작업의 변경사항` — 현재 작업 단위 범위를 먼저 설명; 미지원 scope 선택기는 제외.[M4] |
| Stage all / Revert all | 문서 S3 | 직역 버튼 추가하지 않음; `변경사항 적용`/`거절`과 Git stage/revert를 구별.[M1] |
| commit / push / create a pull request | 동작 설명 S10, S11 | 현행은 `변경사항 적용` + `적용하고 커밋해요`; push/PR는 별도 미지원 행위.[M1][M4] |
| 채팅 보관 / 채팅 이름 변경 | 번들 `codex.command.archiveThread`, `codex.commandMenuTitle.renameThread` L2 | 개념은 `대화 보관 / 대화 이름 변경`; 이번 우선 구현에는 넣지 않음.[S2][M1] |
| Settings / 설정 | 문서 S4; 번들 `codex.command.settings` L2 | 운영 확인은 `상태`, 설정 변경은 `설정`. 둘을 동의어로 취급하지 않음.[M1] |
| Work in > Cloud / Select environment | 문서 S11 | me의 `프로젝트`/`실행 도구`와 구별. Cloud 선택기로 복제하지 않음.[M5] |

## 8. 폰·맥 단일 개발자에게 가치 높은 5개

새 설계로 갈아엎는 순서가 아니다. 승인 프리셋의 구현·검증에서 먼저 챙길 순서다. `가치/비용`은 정성 판단이다.

| 순위 | 변경 · 판정 | 폰 / 맥 가치 | 완료를 눈으로 확인하는 기준 | 근거 |
|---|---|---|---|---|
| 1 | 인라인 승인·결과 적용 완결, 행동과 효과 설명 — adopt/adapt | 폰 탭 왕복 제거 / 맥 대화 맥락 유지. 가치 높음, 프리셋 필수. | 승인 뒤 같은 대화 URL에서 진행 중; 결과 카드에서 전체 diff 접근; 적용 버튼 옆 커밋 고지; 오류는 카드에 남음. | S1·S5·S9·S10, M1 §1.2·§4.2 |
| 2 | 단일 확인 필요 배지와 행동 중심 작업 행 — adopt/adapt | 폰 작은 화면에서 우선순위 즉시 파악 / 맥 병렬 작업의 중복 제거. | 같은 위임은 한 번만 계산, 비-위임 승인 포함, 읽음으로 승인/검토가 사라지지 않음. | S8, M1 §1.1, M5 main/state |
| 3 | 작업 범위가 명확한 결과 우선 diff·커밋 효과 — adapt | 폰 요약→파일 검토 / 맥 기존 사용자 변경과 작업 변경 구별. | 상단 결과·파일 통계, 상세 정보 접기, 실제 diff 기준 명시, 적용 후 커밋 식별자 확인 가능. | S3·S10, M1 §1.6·§3, M4 review |
| 4 | 목록 composer와 프로젝트/원문 제목 유지 — adopt/adapt | 폰 첫 화면에서 말 걸기 / 맥 같은 프로젝트 이어쓰기. | 새 대화 버튼을 먼저 누르지 않아도 전송 가능, 복귀/재연결 뒤 제목·선택 유지, 전체 경로 노이즈 없음. | S2·S9·S12, M1 §1.4–1.6 |
| 5 | 진행/승인 대기/연결 끊김을 별개 신호로 표시 — adapt | 폰에서 방치와 완료를 혼동하지 않음 / 맥 장애 진단 접근 유지. | 점+단계+경과, 실제 progress만 사용, 연결 끊김 배너, 마지막 점검 시각, 상세 trace 진입. | S7·S9·S12, M5 shared/api/ops, M6 |

### 현행 코드에서 확인한 구현 주의점

읽기 전용 코드 조사 결과다. 아래 항목을 이번에 고쳤다는 뜻은 아니다. 기존 발견 문서의 행 번호나 설명보다 현재 코드를 우선한다.

| 관찰 | 프리셋을 구현할 때의 추천 · 판정 | 근거 |
|---|---|---|
| `chat.tsx:270`은 이미 `ApprovalCard`를 인라인 렌더한다. 뒤의 `승인하기` 링크는 선행 return 때문에 해당 조건에서 도달하지 않는다. | adopt: 인라인 승인 방향을 유지하되 이미 있는 구현을 처음부터 없는 것으로 취급하지 않는다. 승인/수락 전체가 완료됐다는 주장도 하지 않는다. | M4 `chat.tsx:256–285`, M1 §1.2, S9 |
| `accepted`를 done tone으로 묶고 elapsed도 종료 취급하지만 목록 설명은 `수락했어요 · 적용 중`이다. | adapt: `accepted`는 적용 중 피드백, `applied`만 완료. 프리셋의 낙관적 전환은 요청 수락 표시이지 커밋 성공 보장이 아니다. | M4 `state.ts:125–134`, `tasks.tsx:16–33`, `chat.tsx:249–260`; S3·S10 |
| `PhaseLine`은 답변 텍스트가 생기면 렌더 조건에서 빠진다. | adapt: 계속 실행 중인 작업의 상태를 스트리밍 본문과 별개로 확인할 수 있게 한다. 프리셋의 실시간 진행 요구가 현재 모든 턴에서 충족된다고 가정하지 않는다. | M4 `chat.tsx:181–188`, M1 §3 interaction, S7·S9 |
| 대화 대표 상태 계산은 failed와 muted 모두 none으로 바꾼다. | adapt: 거절·취소는 숨길 수 있어도 실패는 대화 목록에도 점+글자로 남긴다. 실패를 승인 숫자에 자동 합산하지는 않는다. | M4 `state.ts:194–206`, M1 상태 규칙, S8·S9 |
| review는 전체 diff를 받아 닫힌 파일 details에도 Markdown 본문을 렌더한다. | adapt: 큰 diff의 폰 복귀/열기 시나리오를 별도 검증하고 닫힌 파일 본문 렌더를 늦추는 후보를 검토한다. 서버 파일별 paging은 새 계약이 필요한 별도 과제이며 성능 개선 수치는 아직 없다. | M4 `review.tsx:18–27,73–81`, M1 폰 기준, S3·S12 |

## 9. 확인하지 못한 것과 적용 한계

1. 사용자 앱·ChatGPT/Codex 계정·로그인된 브라우저를 열지 않았다. 설치 버전의 화면 노출, 계정별 rollout, 원격 접근 제공 여부는 검증하지 않았다.
2. Codex 공개 페이지의 텍스트/illustration 설명과 출시 글을 읽었다. Codex 제품 화면 이미지·동영상을 직접 시각 검증한 것은 아니다. 직접 본 이미지는 me의 M3뿐이다. Codex의 정확한 타이포·간격·390px 레이아웃·빈 상태·배지 수식은 모른다.
3. ASAR header와 package/native-menu JSON만 읽어 식별/메뉴 증거를 확보했다. 두 한국어 JS locale에 대한 제한된 key/value 정규식 조회는 일치 0건이었다. locale가 없거나 기능이 없다는 증거가 아니다. UI 원문은 문서 표기와 native 메뉴 이외에는 단정하지 않았다.
4. Codex의 live output 접기 규칙, 고정 phase 목록, elapsed 표시 위치, 취소·재시도 동작을 직접 재현하지 않았다. me의 개선안은 M1/M5/M6 데이터에 기반한 추천이다.
5. 현행 코드/미리보기와 승인 설계를 비교했지 사용자 서버가 어느 revision인지 확인하지 않았다. `127.0.0.1:7420`, `~/.me`, relay에 접속하거나 프로세스를 제어하지 않았다.
6. 성능·사용성 A/B 실험은 하지 않았다. 설치 메뉴 추출 반복성은 UX 개선 수치가 아니다. 새 harness 파일·의존성·제품 코드를 만들지 않았다.
7. `docs/DONE.md`의 이슈·tsc·bun test·conformance·E2E·shots·a11y·release는 제품/화면 구현 게이트다. 이번에는 조사 문서만 작성하므로 실행하지 않았으며 구현 완료·접근성 통과를 주장하지 않는다. 이슈/커밋/배포도 만들지 않았다. 구현 단계에서는 해당 게이트가 여전히 필요하다.[M6]

## 10. 실험 기록과 최종 판정

`gjc autoresearch intake --spec docs/research/codex-app-ux-spec.md`로 mixed 임무를 시작했고, run 기록은 runtime의 append-only ledger에 남긴다. 아래는 보고서가 유지하는 요약이다. `keep`은 증거 채택을 뜻하며 UX 점수 향상을 뜻하지 않는다. primary 수치는 아래 메뉴 관찰의 반복성 확인에만 사용했다.

| run | 판정 | 관찰·한계 |
|---|---|---|
| scope-baseline | checks_failed | 초기 CLI 인자 조회에서 필수 값 누락으로 명령이 실패. 임무/제품 mutation은 없음. 유효한 UX benchmark가 없음을 기록. |
| bundle-baseline | keep (숫자 설명 정정 필요) | 설치 메타데이터·ASAR native-menu 조회와 assert 성공, 실제 stdout `METRIC verified_menu_labels=14`. |
| bundle-repeat | discard (flat) | 동일 workload 실제 stdout `METRIC verified_menu_labels=14`. 새 정보/수치 향상 없음. |
| metric-correction | checks_failed | 앞 두 run 설명에 15라고 잘못 전사한 것을 append-only 정정. 잘못 적힌 설명은 숫자 근거에서 제외; 보고서는 stdout의 14/14만 사용. 구조화 metric 값은 제출하지 않았음. |
| official-docs | keep | 공식 출처로 7개 과업 확인. 출시와 현재, 앱/웹/모바일을 분리. 실제 로그인 사용은 없음. |
| local-ui-audit | keep | 읽기 전용 architect가 5개 UI 파일을 조사하고 주요 조건을 직접 재확인. 인라인 승인 일부 구현, accepted/applied 구분, phase·실패 표시·전체 diff 렌더 주의점을 보고서에 반영. |
| report-validation | keep | 인메모리 검사 성공: `METRIC covered_jobs=7`, `METRIC sourced_recommendation_rows=23`, `METRIC defined_sources=20`. 과업별 추천 출처, 용어표, 상위 5개, 한계, 숫자 정정, 로컬 링크/코드 경로 존재 확인. 이 검사는 인용의 의미나 실제 UI 동작을 자동 증명하지 않음. |

**최종 verdict:** 문서 산출물에 대해서는 conclusive, 설계 추천에 대한 신뢰도는 중간~높음. 「대화에서 끝내기」의 3탭·인라인 승인/적용·결과 우선·프로젝트 칩·한국어를 유지한다. Codex에서 가져올 것은 **대화 맥락 안의 감독, 승인 효과와 권한 경계의 설명, 검토 범위의 명시, 주의가 필요한 작업의 집계, 기기·연결 상태 구별**이다.[S1–S12][M1]

반대로 Cloud/worktree 설정 UI, 자동 승인 모드, PR·hunk 조작, pet/팀 inbox는 현행 me 계약과 단일 사용자 범위를 넘으므로 복제하지 않는다. 이 판정은 위의 미검증 사항을 해결했다는 뜻이 아니며 제품 구현을 승인하지 않는다. 별도의 runtime 구조화 verdict에는 이 보고서 경로, 공식·로컬 증거, caveats와 evaluator를 기록한다.
