# llm-discord-bridge

Discord 채널을 여러 LLM CLI(Claude Code, Codex, Antigravity/Gemini)를 잇는 다중 에이전트 브릿지로 씁니다. 한 채널에 메시지를 보내면 설정된 "토론(debate)" 파이프라인이 돌아가거나, 특정 봇을 지목해 1:1로 대화할 수 있습니다.

## 동작 개요

- 채널마다 `config.json`에 참여 봇(owner/reviewer/moderators)을 지정합니다.
- 기본 동작은 **debate 모드**: owner가 초안을 쓰고 reviewer가 검토, `maxRounds` 안에 합의 안 되면 moderator 패널이 다수결로 최종안을 채택합니다.
- `!quick <질문>` 접두사를 쓰면 debate를 건너뛰고 각 봇이 독립적으로 즉시 답합니다.
- `클로드:`, `코덱스:` 같은 별명 접두어나 `@멘션`으로 특정 봇만 지목해 1:1 대화도 가능합니다.
- 각 봇은 비대화형(one-shot) CLI 호출로 동작하며(`claude -p`, `codex exec`, `agy --print`), 세션 컨텍스트는 브릿지가 직접 관리합니다.
- 각 봇의 CLI 호출은 `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` 류 플래그로 승인 없이 실행됩니다 — 신뢰된 로컬 환경에서만 쓰세요.

## 기능

- **세션 제어**: `!stop`, `!start`, `!restart` (+ 특정 봇 alias)로 봇 실행 중단/초기화.
- **명령어 안내**: `!help`로 사용 가능한 명령어 목록을 봇이 직접 올림. 사람이 보낸 일반 메시지와
  달리 `clearChannelSessions`가 정리하지 않으니 계속 남아있고, 필요하면 디스코드에서 직접 고정(핀) 가능.
- **일일 사용량 가드**: `settings.usageDailyLimit` 기준으로 봇별 호출 횟수를 `logs/usage-counts.json`에 누적, 자정에 리셋. `usageWarnRatio` 넘으면 경고.
- **결정 로그**: debate 라운드, moderator 투표, 최종 채택 결과를 `logs/*-decisions.jsonl`에 append-only로 기록 (감사 추적용).
- **핀 고정 상태 메시지**: 작업 중/완료/소요 시간을 채널에 실시간 업데이트.
- **usage-coach 웹훅**: `scripts/create-webhooks.js`로 채널별 사용량 알림용 웹훅 생성.
- **사용량 가드(자동 역할 교체)**: `usage-coach`의 `coach.py --json --once`를 조회해서 봇 사용량이
  임계치(기본 30%) 밑이면 debate의 owner/reviewer/moderator 역할을 여유 있는 다른 봇으로 자동 교체.
  특정 봇을 직접 지목(`c:`, `@멘션`, `!quick`)한 경우엔 교체 대신 경고만 답변에 붙음. 자세한 설정은
  아래 `settings.usageGuard` 참고, `!usage`로 현재 잔량 확인 가능.

## 설치

```bash
npm install
cp .env.example .env
```

`.env`에 각 봇의 Discord 봇 토큰을 채웁니다:

```
DISCORD_TOKEN_CLAUDE=...
DISCORD_TOKEN_CODEX=...
DISCORD_TOKEN_AGY=...
```

`config.json`에서 채널 ID, 각 봇의 작업 디렉터리(`cwd`), CLI 실행 경로(`command`)를 환경에 맞게 수정합니다.

## 실행

```bash
node bridge.js
```

Windows에서 콘솔 창 없이 백그라운드로 띄우려면 `run-hidden.vbs`를 더블클릭하거나 스케줄러에 등록하세요. 로그는 `logs/bridge-stdout.log`, `logs/bridge-stderr.log`에 쌓입니다.

## 설정 (`config.json`)

| 필드 | 설명 |
|---|---|
| `channels[].id` | 대상 Discord 채널 ID |
| `channels[].cwd` | 봇별 작업 디렉터리(각 CLI가 실행될 경로) |
| `channels[].debate` | `owner`(초안 작성), `reviewer`(검토), `moderators`(동률 시 다수결 패널), `maxRounds` |
| `bots[].tokenEnv` | 해당 봇 토큰이 담긴 환경변수 이름 |
| `bots[].aliases` | 채팅에서 이 봇을 지목할 때 쓰는 접두어 |
| `bots[].command` / `args` | 실행할 CLI 경로와 고정 인자 |
| `settings.execTimeoutMs` | 봇 CLI 호출 타임아웃 |
| `settings.usageDailyLimit` / `usageWarnRatio` | 일일 호출 한도 및 경고 임계치 |
| `settings.usageGuard.enabled` | 사용량 가드 켜기/끄기 (기본 꺼짐) |
| `settings.usageGuard.pythonCommand` / `coachScript` | `coach.py` 실행할 파이썬 경로 / `coach.py` 절대경로 |
| `settings.usageGuard.threshold` | 이 % 미만이면 "낮음"으로 판단(기본 30) — 봇의 여러 윈도우(5h/7d/1d 등) 중 최소값 기준 |
| `settings.usageGuard.action` | `"handoff"`(기본, 다른 봇으로 자동 교체) 또는 `"stop"`(교체할 봇도 없으면 작업 보류) |
| `settings.usageGuard.providerMap` | 봇 키(`claude`/`codex`/`agy`) → coach.py provider 이름(`claude`/`codex`/`antigravity`) 매핑 |
| `settings.usageGuard.fallbackOrder` | 교체 시도 우선순위 |

사용량 가드는 `coach.py --json --once` 조회 결과(`{"providers": {...}}`)를 60초(`checkIntervalMs`) 캐시로
읽습니다. 조회 실패/미설정 시에는 항상 "정상"으로 간주해 평소처럼 동작합니다(페일 오픈). 활성화하려면
`enabled: true`로 바꾸고, `pythonCommand`/`coachScript`를 실제 실행 환경에 맞춰 조정하세요(WSL/Linux면
보통 `python3` + `~/usage-coach/coach.py`, Windows 네이티브면 `python` 또는 `python.exe` 전체 경로 +
`D:\usage-coach\coach.py`처럼). `!usage`로 봇별 잔량을 바로 확인할 수 있습니다.

## 주의

- `.env`는 절대 커밋하지 마세요 (`.gitignore`에 포함됨).
- 모든 봇 CLI가 승인 프롬프트 없이(`--dangerously-*`) 실행되므로, 신뢰할 수 없는 입력이 흘러들 수 있는 채널에는 연결하지 마세요.
- `logs/`는 로컬 감사 로그이며 커밋 대상에서 제외되어 있습니다.
