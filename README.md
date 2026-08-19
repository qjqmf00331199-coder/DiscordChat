# llm-discord-bridge

Discord 채널을 여러 LLM CLI(Claude Code, Codex, Antigravity/Gemini)를 잇는 다중 에이전트 브릿지입니다. 채널에 메시지를 보내면 설정된 "토론(debate)" 파이프라인이 돌아가거나, 특정 봇을 지목해 1:1로 대화할 수 있습니다.

한 줄 요약: **Discord 채팅창 = 여러 AI 코딩 CLI를 동시에 부리는 리모컨.**

---

## 목차

1. [이게 뭘 하는 물건인가](#이게-뭘-하는-물건인가)
2. [어디서 동작하나 (실행 환경)](#어디서-동작하나-실행-환경)
3. [설치 전 준비물](#설치-전-준비물)
4. [설치 순서](#설치-순서)
5. [Discord 봇 3개 만들기](#discord-봇-3개-만들기)
6. [LLM CLI 설치 및 로그인](#llm-cli-설치-및-로그인)
7. [프로젝트 설정 (config.json)](#프로젝트-설정-configjson)
8. [실행](#실행)
9. [사용법 (명령어)](#사용법-명령어)
10. [debate 파이프라인 상세](#debate-파이프라인-상세)
11. [codev 모드 (동시 개발)](#codev-모드-동시-개발)
12. [부가 기능](#부가-기능)
13. [일일 사용량 가드 설치 (WSL Ubuntu)](#일일-사용량-가드-설치-wsl-ubuntu)
14. [로그 파일](#로그-파일)
15. [트러블슈팅](#트러블슈팅)
16. [보안 주의사항](#보안-주의사항)

---

## 이게 뭘 하는 물건인가

로컬 PC에 설치된 AI 코딩 CLI(Claude Code, Codex, Google Antigravity/Gemini)를 각각 "봇"으로 만들어 Discord 채널 하나에 초대합니다. Discord 채널에 질문이나 작업 지시를 올리면:

- **기본(debate) 모드**: 한 봇(owner)이 초안을 작성 → 다른 봇(reviewer)이 검토 → 의견 안 맞으면 세 번째 봇(moderator)이 다수결로 최종안을 정합니다. 즉, **PC 앞에 안 앉아 있어도 스마트폰 Discord 앱으로 여러 AI가 서로 검토한 결과물을 받아볼 수 있습니다.**
- **codev 모드**: 검토자가 말로만 지적하지 않고 같은 작업 폴더에서 파일을 직접 고쳐줍니다. 끝나면 자동으로 git commit까지 해줍니다(push는 사람이 확인 후 직접).
- **1:1 모드**: 특정 봇만 콕 집어 평범한 챗봇처럼 대화할 수도 있습니다.
- **사용량 가드**: 봇 하나가 API 한도를 다 써가면 자동으로 다른 봇에게 역할을 넘겨줍니다(선택 기능).

## 어디서 동작하나 (실행 환경)

- **로컬 PC(또는 항상 켜져 있는 서버) 1대**에서 Node.js 프로세스 하나(`bridge.js`)가 계속 떠 있어야 합니다. Discord 서버(디스코드 클라우드)에 뭘 설치하는 게 아니라, **내 컴퓨터가 Discord와 계속 연결을 유지하면서 메시지를 감시**하는 방식입니다 → 이 프로세스가 꺼지면 봇도 오프라인이 됩니다.
- 개발/테스트는 **Windows 10/11**에서 이루어졌고(`run-hidden.vbs` 포함), Node.js가 도는 환경이면 macOS/Linux/WSL에서도 동일하게 동작합니다.
- 브릿지가 실행하는 각 LLM CLI(`claude`, `codex`, `agy`)는 **그 PC에 미리 설치되어 로그인까지 끝나 있어야** 합니다 — 브릿지 자체는 API 키를 직접 다루지 않고, 이미 인증된 CLI를 그대로 실행만 시켜줍니다.
- 각 봇이 작업할 **코드 프로젝트 폴더(`cwd`)** 도 같은 PC 안에 있어야 합니다. CLI가 그 폴더로 이동해서 실제로 파일을 읽고 씁니다.

## 설치 전 준비물

| 항목 | 왜 필요한가 |
|---|---|
| **Node.js 18 이상** (테스트: v24) | `bridge.js`를 실행하는 런타임. `discord.js` 라이브러리가 최신 Node 기능을 씀 |
| **Discord 계정 + 서버(길드) 관리 권한** | 봇을 만들고 초대하려면 해당 서버에 "채널 관리/멤버 초대" 권한이 있는 계정이어야 함 |
| **Claude Code CLI** (`claude`) | owner/reviewer/moderator 중 하나로 쓸 LLM. [claude.com/code](https://claude.com/product/claude-code) 참고 |
| **Codex CLI** (`codex`) | 위와 동일, OpenAI Codex CLI |
| **Antigravity / Gemini CLI** (`agy`) | 위와 동일, Google Antigravity(Gemini) CLI |
| **git** | codev 모드의 자동 커밋/`!push` 기능이 각 봇의 작업 폴더에서 `git` 명령을 그대로 실행함 |
| (선택) **Python 3** | `usage-coach`의 `coach.py`로 사용량 가드를 쓸 때만 필요 |

> CLI 3개를 다 안 써도 됩니다. 봇 1~2개만 등록하고 `config.json`에서 안 쓰는 항목을 지워도 동작합니다. 다만 **debate 모드는 owner/reviewer 최소 2개**가 필요합니다.

## 설치 순서

```bash
git clone <이 저장소 URL>
cd Discordchat
npm install
cp .env.example .env
```

`npm install`이 설치하는 것:
- **discord.js** — Discord 봇 계정으로 로그인하고 메시지를 주고받는 공식 라이브러리(이게 없으면 Discord와 통신 자체가 불가능).
- **dotenv** — `.env` 파일에 적어둔 토큰 같은 비밀값을 `process.env`로 읽어오는 라이브러리(토큰을 코드에 하드코딩하지 않기 위함).

## Discord 봇 3개 만들기

브릿지에 등록할 각 LLM(claude/codex/agy)마다 **별도의 Discord 봇 계정**이 하나씩 필요합니다(구분해서 말하려면 이름/아이콘이 달라야 하니까). 아래 과정을 **봇 개수만큼 반복**합니다.

1. [Discord Developer Portal](https://discord.com/developers/applications) 접속 → 로그인 → **New Application** → 이름 입력(예: `claude-bot`).
2. 왼쪽 메뉴 **Bot** 탭 → **Reset Token**(또는 최초 생성 시 바로 보이는 토큰) → **토큰 복사**. 이 값을 `.env`의 `DISCORD_TOKEN_CLAUDE`(또는 해당 봇 변수)에 붙여넣습니다. **토큰은 딱 한 번만 보여줍니다.**
3. 같은 **Bot** 탭에서 **Privileged Gateway Intents** 중 **MESSAGE CONTENT INTENT**를 켭니다(이게 꺼져 있으면 봇이 메시지 내용을 아예 못 읽습니다).
4. 왼쪽 메뉴 **OAuth2 → URL Generator**:
   - **Scopes**: `bot` 체크.
   - **Bot Permissions**: 최소 `Read Messages/View Channels`, `Send Messages`, `Read Message History` (메시지 핀 고정 기능까지 쓰려면 `Manage Messages`도 체크).
   - 생성된 URL을 브라우저에 열고, 봇을 초대할 서버를 선택 → 권한 승인.
5. 이제 이 봇이 서버 멤버 목록에 오프라인 상태로 보이면 정상입니다(브릿지를 실행하면 온라인으로 바뀝니다).
6. `codex`, `agy` 봇도 1~5번을 반복하고 각각 `.env`의 `DISCORD_TOKEN_CODEX`, `DISCORD_TOKEN_AGY`에 채웁니다.
7. 봇들을 대화시킬 채널의 **채널 ID**를 얻습니다: Discord 앱에서 **설정 → 고급 → 개발자 모드** 켜기 → 채널 우클릭 → **ID 복사**. 이 값이 `config.json`의 `channels[].id`에 들어갑니다.

`.env` 최종 형태:

```
DISCORD_TOKEN_CLAUDE=여기에_claude_봇_토큰
DISCORD_TOKEN_CODEX=여기에_codex_봇_토큰
DISCORD_TOKEN_AGY=여기에_agy_봇_토큰
```

## LLM CLI 설치 및 로그인

브릿지는 각 CLI를 `child_process`로 그냥 실행만 합니다(`claude -p "..."`, `codex exec "..."`, `agy --print "..."` 형태). 그러니 **브릿지를 켜기 전에 터미널에서 CLI가 단독으로 동작하는지부터 확인**하세요.

1. 각 CLI를 공식 문서대로 설치합니다(설치 경로는 OS/버전마다 다르므로 최신 설치 가이드를 따르세요).
2. 설치 후 **로그인/인증을 CLI 자체 기능으로 1회 완료**합니다(예: `claude` 실행 후 브라우저 로그인 플로우, `codex login` 등). 브릿지는 이 로그인 세션을 그대로 재사용하며, 토큰이나 API 키를 별도로 넘기지 않습니다.
3. 터미널에서 아무 프로젝트 폴더로 이동해 CLI가 정상 응답하는지 확인:
   ```bash
   claude -p "hello"
   codex exec "hello"
   agy --print "hello"
   ```
4. 정상 응답이 오면, 그 실행 파일의 **전체 경로**를 확인해 `config.json`의 `bots[].command`에 넣습니다.
   - Windows: `where claude`, `where codex`, `where agy`
   - macOS/Linux: `which claude` 등

## 프로젝트 설정 (`config.json`)

레포에 들어있는 `config.json`은 **예시/개인 환경 값**이 채워진 샘플입니다. 저장소를 그대로 쓰지 말고, 아래 표를 참고해 **본인 PC 경로 / 본인 채널 ID / 본인 CLI 경로**로 전부 바꾸세요.

```json
{
  "channels": [
    {
      "id": "여기에 디스코드 채널 ID",
      "name": "임의 이름(로그 구분용)",
      "cwd": {
        "claude": "이 봇이 작업할 프로젝트 폴더 경로",
        "codex": "reviewer 봇이 작업할 폴더 경로 (codev면 owner와 별도 워크트리 권장)",
        "agy": "moderator 봇 폴더 경로"
      },
      "debate": { "owner": "claude", "reviewer": "codex", "moderators": ["agy"], "maxRounds": 3, "codev": false }
    }
  ],
  "bots": [
    { "key": "claude", "tokenEnv": "DISCORD_TOKEN_CLAUDE", "aliases": ["claude", "c"], "command": "claude 실행파일 전체 경로", "args": [] }
  ],
  "settings": { "...": "아래 표 참고" }
}
```

| 필드 | 설명 |
|---|---|
| `channels[].id` | 대상 Discord 채널 ID (숫자 문자열) |
| `channels[].name` | 로그에 찍히는 구분용 이름, 아무 문자열이나 가능 |
| `channels[].cwd` | 봇 키별 작업 디렉터리(각 CLI가 그 경로로 이동해서 실행됨). **codev 모드**를 쓰려면 owner/reviewer가 같은 git 저장소를 봐야 충돌이 안 나므로, reviewer 폴더를 `git worktree`로 따로 파는 걸 권장 |
| `channels[].debate.owner` | 초안을 작성하는 봇 키 |
| `channels[].debate.reviewer` | 검토(또는 codev면 직접 수정)하는 봇 키 |
| `channels[].debate.moderators` | 동률/미합의 시 다수결 투표할 봇 키 배열 (1개 이상) |
| `channels[].debate.maxRounds` | owner↔reviewer 왕복 최대 횟수 |
| `channels[].debate.codev` | `true`면 reviewer가 owner cwd 공유해서 파일 직접 수정 + 종료 시 자동 커밋 ([codev 모드](#codev-모드-동시-개발) 참고). 기본 `false`(리뷰 코멘트만) |
| `bots[].key` | 채널의 `owner`/`reviewer`/`moderators`, `cwd`에서 참조하는 고유 키 |
| `bots[].tokenEnv` | 이 봇 토큰이 담긴 `.env` 변수 이름 |
| `bots[].aliases` | 채팅에서 `별명:` 형태로 이 봇만 지목할 때 쓰는 접두어 목록 |
| `bots[].command` | 실행할 CLI 실행 파일의 **전체 경로** |
| `bots[].args` | CLI 실행 시 항상 붙일 고정 인자(모델 지정 등) |
| `settings.maxMessageLength` | Discord 메시지 하나의 최대 글자 수로 답변을 자름(디스코드 제한 2000자 이하로) |
| `settings.execTimeoutMs` | 봇 CLI 호출 1회당 최대 대기 시간(ms) |
| `settings.approvalTimeoutMs` | (승인 대기 관련 내부 타임아웃) |
| `settings.usageDailyLimit` / `usageWarnRatio` | 봇별 일일 호출 한도 및 경고 비율(80% 등) |
| `settings.usageGuard.*` | 사용량 낮은 봇을 자동으로 다른 봇으로 교체하는 기능 설정. [부가 기능](#부가-기능) 참고, 기본 `enabled: false` |

## 실행

```bash
node bridge.js
# 또는
npm start
```

정상 기동 시 콘솔에 각 봇의 로그인 완료 로그가 찍히고, Discord 상에서 등록한 봇 3개가 온라인으로 표시됩니다.

**Windows에서 창 없이 백그라운드로 띄우기**: `run-hidden.vbs`를 더블클릭하거나 작업 스케줄러(로그온 시 실행)에 등록하면 콘솔 창 없이 실행되고, 표준출력/에러가 `logs/bridge-stdout.log`, `logs/bridge-stderr.log`에 쌓입니다. 경로가 다르면 `run-hidden.vbs` 안의 `cd /d D:\Discordchat` 부분을 본인 설치 경로로 수정하세요.

**macOS/Linux에서 계속 띄워두기**: `pm2`, `systemd` 서비스, `nohup node bridge.js &`, `tmux`/`screen` 등 원하는 방식으로 상시 실행하면 됩니다(이 저장소엔 별도 스크립트가 없으니 환경에 맞는 방법을 쓰세요).

## 사용법 (명령어)

Discord 채널에서 아래처럼 입력합니다.

| 입력 예 | 동작 |
|---|---|
| `이 함수 버그 좀 찾아줘` (그냥 평문) | debate 모드 시작: owner 초안 → reviewer 검토 → (필요시) moderator 다수결 |
| `!quick 오늘 날짜가 몇이야?` | debate 없이 등록된 봇들이 각자 독립적으로 즉시 답변 |
| `claude: 이거 어떻게 생각해?` / `c: ...` | `claude` 봇만 지목해 1:1 대화 (별명은 `config.json`의 `aliases` 기준) |
| `@봇이름 ...` | 멘션으로 특정 봇 지목 |
| `!help` | 사용 가능한 명령어 안내 |
| `!usage` | 봇별 사용량 잔량(%) 확인 (`usageGuard` 꺼져 있으면 안내만 뜸) |
| `!push` | codev 모드에서 자동 커밋된 변경사항을 실제로 `git push` (owner 봇 채널에서만 동작) |
| `!stop` | 해당(또는 전체) 봇 실행 중단 |
| `!start` | 중단된 봇 재개 |
| `!restart` | 세션(대화 컨텍스트) 초기화 |

## debate 파이프라인 상세

1. **owner 초안**: `cwd[owner]` 경로에서 owner CLI가 사용자 프롬프트로 초안 작성.
2. **reviewer 검토 라운드** (최대 `maxRounds`회 반복):
   - reviewer가 초안을 보고 `STATUS: APPROVE`(승인) 또는 `STATUS: REVISE` + 구체적 수정 지시를 반환.
   - `APPROVE`면 즉시 라운드 종료. `REVISE`면 owner가 피드백 반영해 재작성 후 다음 라운드.
   - 마지막 라운드까지 `REVISE`면 owner 재작성 없이 바로 moderator 패널로 넘어감.
3. **moderator 패널** (APPROVE로 안 끝났을 때만): 각 moderator가 "초안 유지" vs "reviewer 재작성 채택" 중 하나에 투표, 다수결로 최종안 확정. 채택 결과는 `⭐ 최종 채택` 메시지로 안내.
4. **codev 모드**(`debate.codev: true`)면 위 사이클이 끝난 뒤 자동으로 커밋 단계로 이어짐 — 아래 참고.

모든 라운드/투표/채택 결과는 `logs/*-decisions.jsonl`에 append-only로 기록됩니다(감사 추적용).

## codev 모드 (동시 개발)

`config.json`의 해당 채널 `debate.codev`를 `true`로 켜면, reviewer가 "말로 검토만" 하지 않고 **owner와 같은 작업 디렉터리를 공유해서 실제 파일을 직접 고칩니다**.

- reviewer 프롬프트가 review 전용 문구 대신 "직접 문제 파일을 열어서 고쳐라" 지시로 바뀝니다.
  - 고칠 게 없으면 `STATUS: APPROVE`.
  - 고쳤으면 `STATUS: REVISE` + 파일:라인 단위로 뭘 고쳤는지 요약.
- owner는 reviewer가 고친 내용을 확인하고 남은 작업을 이어가거나 요약만 남깁니다.
- 사이클 종료 후 자동으로 다음이 실행됩니다:
  1. moderator 중 첫 번째가 전체 작업을 한 문단으로 요약 + `COMMIT: <메시지>` 형식으로 커밋 메시지 생성.
  2. owner의 작업 디렉터리에서 `git add -A && git commit -m "<메시지>"` 자동 실행.
  3. **push는 자동으로 하지 않습니다** — 커밋 결과와 함께 `!push` 안내 메시지를 채널에 남기고, 사람이 직접 `!push`를 입력해야 실제 push가 나갑니다.
- `!push`는 `debate.owner`로 지정된 봇의 클라이언트에서만 처리되며(중복 push 방지), 해당 봇의 작업 디렉터리에서 `git push` 결과를 답장으로 알려줍니다.

> codev를 켤 채널의 reviewer `cwd`는 owner와 **같은 저장소를 보는 별도 워크트리**(`git worktree add`)로 두는 걸 권장합니다. 완전히 다른 저장소를 넣으면 파일을 서로 못 찾습니다.

## 부가 기능

- **세션 제어**: `!stop`, `!start`, `!restart`(+ 특정 봇 alias 접두)로 봇 실행 중단/재개/초기화.
- **명령어 안내**: `!help`로 사용 가능한 명령어 목록을 대표 봇 하나만 채널에 올림(자동 정리 대상에서 제외되므로 계속 남아있고, 필요하면 디스코드에서 직접 핀 고정 가능).
- **일일 사용량 가드**: `settings.usageDailyLimit` 기준으로 봇별 호출 횟수를 `logs/usage-counts.json`에 누적, 자정에 리셋. `usageWarnRatio` 넘으면 경고.
- **결정 로그**: debate 라운드, moderator 투표, 최종 채택, codev 커밋 결과를 `logs/*-decisions.jsonl`에 기록.
- **핀 고정 상태 메시지**: 작업 중/완료/소요 시간을 채널 메시지로 실시간 업데이트.
- **usage-coach 웹훅**: `scripts/create-webhooks.js`로 채널별 사용량 알림용 Discord 웹훅을 생성.
- **사용량 가드(자동 역할 교체)**: 별도 프로젝트 `usage-coach`의 `coach.py --json --once` 출력을 조회해서 봇 사용량이 임계치(기본 30%) 밑이면 debate의 owner/reviewer/moderator 역할을 여유 있는 다른 봇으로 자동 교체합니다. 특정 봇을 직접 지목(별명/`@멘션`/`!quick`)한 경우엔 교체 대신 경고만 답변에 붙습니다. 설치/설정은 [일일 사용량 가드 설치 (WSL Ubuntu)](#일일-사용량-가드-설치-wsl-ubuntu) 참고, `!usage`로 봇별 현재 잔량을 바로 확인 가능.

## 일일 사용량 가드 설치 (WSL Ubuntu)

`bridge.js`는 `usageGuardCfg.pythonCommand`로 지정한 실행 파일을 `spawn()`으로 **직접** 띄우고, 인자로 `[coachScript, '--json', '--once']`만 넘깁니다(셸을 거치지 않음). 즉 `pythonCommand`는 Windows에서 바로 실행 가능한 명령이어야 하고, `coach.py`가 의존하는 [codexbar](https://github.com/steipete/CodexBar) 등 조회 도구는 리눅스 환경(WSL Ubuntu)에 두는 경우가 많습니다. 아래는 **Windows + WSL2 Ubuntu** 조합으로 `coach.py`를 돌리는 전체 과정입니다.

### 1. WSL2 + Ubuntu 설치

관리자 권한 PowerShell에서:

```powershell
wsl --install -d Ubuntu
```

- 최초 1회 재부팅이 필요할 수 있습니다.
- 재부팅 후 Ubuntu 터미널이 자동으로 뜨면 **유닉스 사용자 이름/비밀번호**를 설정합니다(리눅스 계정, Windows 로그인과 별개).
- 이미 WSL이 깔려 있으면 배포판만 추가: `wsl --install -d Ubuntu` (또는 `wsl --list --online`으로 목록 확인 후 선택).
- 설치 확인: `wsl -l -v` → `Ubuntu`가 `Running`/`Stopped` 상태로 보이고 VERSION이 `2`인지 확인.

### 2. Ubuntu 안에서 Python 3 및 필수 패키지 설치

WSL Ubuntu 터미널(`wsl` 또는 시작 메뉴의 `Ubuntu`)에서:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3 python3-pip git
python3 --version   # 3.10+ 정도면 충분
```

### 3. usage-coach 클론 및 codexbar 연동

```bash
cd ~
git clone https://github.com/netwaif/usage-coach.git
cd usage-coach
# coach.py는 표준 라이브러리만 써서 pip install 불필요
```

`coach.py`는 사용량 데이터를 [codexbar](https://github.com/steipete/CodexBar) CLI에서 읽습니다. codexbar를 WSL Ubuntu 안에 설치하고, 각 LLM 제공자(Claude/Codex/Antigravity) 계정으로 최소 한 번 로그인/연동을 마쳐서 `codexbar --provider claude`(등)이 단독으로 값을 뽑는지 먼저 확인하세요. 배포 방식은 codexbar 저장소의 최신 설치 가이드를 따릅니다.

동작 확인:

```bash
python3 coach.py --once
python3 coach.py --json --once   # bridge.js가 실제로 파싱하는 형태
```

`{"providers": {...}}` 형태의 JSON이 찍히면 정상입니다.

### 4. Windows(bridge.js)에서 WSL 안의 coach.py 호출하기

`bridge.js`는 Windows 프로세스라서 `pythonCommand`에 `python3`만 적으면 **Windows의** `python3`를 찾습니다(WSL 안의 것이 아님). WSL 안에 있는 `coach.py`를 그대로 쓰려면 `wsl.exe`를 통해서 불러야 하는데, `spawn()`이 인자를 셸 없이 그대로 넘기기 때문에 **"명령 하나 + 인자 하나"** 형태로 맞춰야 합니다. 가장 간단한 방법은 **얇은 래퍼 스크립트**를 하나 만들어 그걸 `coachScript` 자리에 넣는 것입니다.

`D:\usage-coach\coach-wsl.cmd` (예시, 실제 사용자명/경로는 본인 환경에 맞게 수정):

```bat
@echo off
wsl -d Ubuntu -e python3 /home/<사용자명>/usage-coach/coach.py %*
```

`config.json`:

```json
"settings": {
  "usageGuard": {
    "enabled": true,
    "pythonCommand": "D:\\usage-coach\\coach-wsl.cmd",
    "coachScript": "",
    "checkIntervalMs": 60000,
    "threshold": 30,
    "action": "handoff",
    "providerMap": { "claude": "claude", "codex": "codex", "agy": "antigravity" },
    "fallbackOrder": ["claude", "codex", "agy"]
  }
}
```

- `pythonCommand`를 래퍼(`.cmd`) 경로로, `coachScript`는 빈 문자열로 둡니다 — 실제 `--json --once`는 여전히 `spawn()`이 뒤에 붙여주므로 래퍼가 `%*`로 그대로 codexbar/coach.py에 전달합니다.
- Windows용 `.cmd` 대신 WSL을 아예 안 거치고 싶다면, Python(x86-64용 공식 설치본)을 **Windows에도** 설치해 `pythonCommand: "python"` + `coachScript: "D:\\usage-coach\\coach.py"`처럼 순수 Windows 경로로 돌리는 방법도 있습니다(단, codexbar가 Windows 네이티브로 안 돌면 이 조합은 값이 안 나올 수 있음 — 그럴 때만 WSL 경유가 필요).
- 래퍼 스크립트가 제대로 동작하는지는 PowerShell/cmd에서 직접 실행해 확인:
  ```
  D:\usage-coach\coach-wsl.cmd --json --once
  ```
  JSON이 찍혀야 `bridge.js`도 정상 조회합니다.

### 5. 최종 확인

1. `config.json`에서 `usageGuard.enabled: true` 저장.
2. 브릿지 재시작(`node bridge.js`).
3. Discord 채널에서 `!usage` 입력 → 봇별 잔량(%)이 나오면 성공.
4. 조회가 계속 실패하면 페일 오픈이라 평소처럼(가드 없이) 동작하니, 콘솔 로그와 3~4단계를 다시 점검하세요.

## 로그 파일

모두 `logs/` 아래(레포엔 커밋 안 됨, `.gitignore` 처리):

| 파일 | 내용 |
|---|---|
| `bridge-stdout.log` / `bridge-stderr.log` | `run-hidden.vbs`로 실행했을 때의 표준출력/에러 |
| `usage-counts.json` | 봇별 일일 호출 횟수 누적치 |
| `*-decisions.jsonl` | 채널별 debate 라운드/투표/채택/codev 커밋 결정 이력 (한 줄에 JSON 하나) |

## 트러블슈팅

| 증상 | 확인할 것 |
|---|---|
| 봇이 Discord에서 계속 오프라인 | `.env`에 정확한 토큰 넣었는지, 서버에 실제로 초대했는지 |
| 봇은 온라인인데 메시지에 반응 없음 | Developer Portal에서 **MESSAGE CONTENT INTENT** 켰는지, `config.json`의 채널 `id`가 맞는지 |
| CLI 호출이 계속 타임아웃 | `settings.execTimeoutMs` 늘리기, 터미널에서 해당 CLI가 단독으로도 그만큼 걸리는지 먼저 확인 |
| `command not found` 류 에러 | `bots[].command`가 실행 파일 **절대 경로**인지 확인(`where`/`which`로 재확인) |
| codev 모드에서 커밋이 안 됨 | owner `cwd`가 실제 git 저장소인지, 변경사항이 있었는지(`logs/*-decisions.jsonl`의 `codev_commit` 항목 확인) |
| `!push` 눌러도 반응 없음 | 그 채널의 `debate.owner` 봇 클라이언트에게 보냈는지(다른 봇에게 보내면 무시됨) |
| 사용량 가드가 항상 무시됨 | `usageGuard.enabled: true`인지, `pythonCommand`/`coachScript` 경로가 실제로 그 PC에서 실행 가능한지 |

## 보안 주의사항

- `.env`는 절대 커밋하지 마세요(`.gitignore`에 포함됨). 토큰이 유출되면 즉시 Developer Portal에서 **Reset Token**.
- 모든 봇 CLI가 승인 프롬프트 없이(`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` 류 플래그) 실행되므로, **본인만 접근 가능한 신뢰된 채널**에만 연결하세요. 아무나 메시지를 보낼 수 있는 서버에 연결하면 임의 코드/명령 실행으로 이어질 수 있습니다.
- `config.json`을 다른 사람과 공유/커밋할 때 실제 채널 ID, 로컬 파일 경로, CLI 설치 경로가 그대로 노출된다는 점을 인지하세요(토큰 자체는 `.env`에만 있어 별도 보호됨).
- `logs/`는 로컬 감사 로그이며 커밋 대상에서 제외되어 있습니다.
