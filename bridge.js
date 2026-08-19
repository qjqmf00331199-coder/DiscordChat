require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const { channels, bots, settings } = config;

// "!help"로 봇이 직접 올리는 안내문. 사람이 보낸 일반 메시지는 clearChannelSessions가
// 다음 턴에 자동 삭제하지만, 봇이 보낸 메시지는 그 정리 로직이 건드리지 않아 계속 남는다.
const HELP_TEXT = `📖 사용 가능한 명령어

【기본 동작 — 아무 접두어 없이 그냥 메시지】
→ 토론(debate) 모드 자동 실행
  1) claude(owner)가 초안 작성
  2) codex(reviewer)가 검토 → 문제없으면 즉시 채택, 문제있으면 수정 지시
  3) 최대 3라운드 반복해도 합의 안 되면 agy(moderator)가 다수결로 최종 채택
※ 이전 턴 메시지는 새 메시지 올 때 자동 정리됨 (최신 턴만 채널에 남음)

【!quick <질문>】
→ 토론 건너뛰고 claude·codex·agy 3명이 각자 독립적으로 즉시 답변
예) !quick 이 함수 버그 어디 있어?

【특정 봇 한 명만 지목해서 1:1 대화】
→ 접두어 또는 멘션으로 지목, debate 없이 그 봇만 답변
  - claude : "클로드:" / "claude:" / "c:"
  - codex  : "코덱스:" / "codex:" / "x:"
  - agy    : "agy:" / "a:" / "antigravity:"
  - 또는 봇 계정 @멘션
예) c: 여기 이 코드 리팩터링 해줘

【!stop [봇명]】
→ 해당 봇(생략 시 자신)이 실행 중인 작업 즉시 취소
예) !stop / !stop codex

【!restart [봇명]】
→ 해당 봇의 대화 세션(이어가기 컨텍스트) 초기화, 다음 질문부터 새 대화로 시작
예) !restart / !restart agy

【!start [봇명]】
→ 안내용(봇은 항상 대기 중이라 실제 동작 없음, 확인 메시지만 응답)

【!usage】
→ 봇별 실시간 사용량 잔량(%) 확인 (usage-coach 연동 켜져 있을 때만)

【!help】
→ 이 안내문 다시 보기 (이 메시지는 자동 삭제되지 않으니 디스코드에서 직접 고정해도 됨)

⚙️ 참고
- 일일 호출 한도: 봇당 100회(자정 리셋), 80% 넘으면 답변에 ⚠️ 경고 포함
- 한도 초과 시 🚫 메시지로 알려주고 그날은 응답 안 함
- 작업 중엔 ⏳ 상태 메시지가 15초마다 경과시간 갱신, 끝나면 ✅ 완료(N초)로 표시
- 사용량 가드 켜져 있으면: 봇 하나가 임계치 밑으로 떨어질 때 debate 역할을 자동으로 다른 봇에게 넘김`;

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;:<=>?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '');
}

function chunkText(text, maxLen) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

// 메시지에서 타겟 봇 뽑아내기 (접두어 "claude: ..." 또는 @멘션). 없으면 전체 브로드캐스트.
function resolveTargets(message, botsCfg) {
  const raw = message.content.trim();
  let cleaned = raw;
  const matched = new Set();

  for (const b of botsCfg) {
    for (const alias of b.aliases) {
      const re = new RegExp('^' + alias + '\\s*[:,]\\s*', 'i');
      if (re.test(cleaned)) {
        matched.add(b.key);
        cleaned = cleaned.replace(re, '');
        break;
      }
    }
  }

  if (message.mentions.users.size) {
    for (const b of botsCfg) {
      if (b.userId && message.mentions.users.has(b.userId)) matched.add(b.key);
    }
    cleaned = cleaned.replace(/<@!?\d+>/g, '').trim();
  }

  if (matched.size === 0) return { targets: 'all', cleaned };
  return { targets: matched, cleaned };
}

// 제어 명령 파싱: "!stop", "!stop claude", "!restart", "!restart codex" ...
function parseControl(cleaned) {
  const m = cleaned.trim().match(/^!(stop|start|restart)\s*([a-zA-Z]+)?$/i);
  if (!m) return null;
  return { action: m[1].toLowerCase(), alias: m[2] ? m[2].toLowerCase() : null };
}

// 예외 명령 파싱: "!quick <질문>" (기본 debate 모드 건너뛰고 각 봇이 독립적으로 바로 답변)
function parseQuick(cleaned) {
  const m = cleaned.match(/^!quick\s+([\s\S]+)/i);
  return m ? m[1].trim() : null;
}

// 라운드 간 컨텍스트 누적 없이(항상 hasSession=false), 필요한 내용만 딱 넣어서 1회 호출
function askOnce(botCfg, cwd, prompt, session) {
  return runCli(botCfg, cwd, `${prompt}\n\n(항상 한국어로만 답변할 것)`, false, session);
}

// 리뷰어 답변 첫 줄에서 STATUS 파싱
function parseReviewStatus(text) {
  const m = text.match(/STATUS:\s*(APPROVE|REVISE)/i);
  const status = m ? m[1].toUpperCase() : 'REVISE'; // 상태 못 읽으면 안전하게 재검토로 취급
  const feedback = text.replace(/^.*STATUS:\s*(APPROVE|REVISE)\s*/is, '').trim();
  return { status, feedback };
}

// 모더레이터 답변에서 VERDICT 파싱 ("DRAFT" = 초안 그대로 채택, "REWRITE" = 직접 작성한 답변 채택)
function parseVerdict(text) {
  const m = text.match(/VERDICT:\s*(DRAFT|REWRITE)/i);
  const verdict = m ? m[1].toUpperCase() : 'REWRITE'; // 못 읽으면 안전하게 직접 작성분 사용
  const body = text.replace(/^.*VERDICT:\s*(DRAFT|REWRITE)\s*/is, '').trim();
  return { verdict, body };
}

// 봇 하나의 턴 실행: 기존 1:1 대화랑 똑같은 포맷(⏳ 작업중 -> ✅ 완료(N초) -> 자기 답변)으로
// 그 봇 자신의 세션/채널을 통해 올림. 즉 debate도 평소 채팅과 동일한 봇별 아바타/말풍선으로 보임.
async function runDebateTurn(sessions, chId, key, cwd, botCfg, prompt) {
  const session = sessions.get(`${chId}:${key}`);
  await session.clearPreviousAnswers();
  const statusMsg = await session.ensurePinnedStatus();
  const startedAt = Date.now();
  await statusMsg.edit(`⏳ [${key}] 작업 시작함...`).catch(() => {});
  const result = await askOnce(botCfg, cwd, prompt, session);
  const totalSec = Math.round((Date.now() - startedAt) / 1000);
  await statusMsg.edit(`✅ [${key}] 완료 (${totalSec}초 소요)`).catch(() => {});
  session.lastAnswerMsgs = await session.send(result.text);
  session.appendLog(prompt, result.text);
  return result.text;
}

// 모더레이터 패널(1개 이상) 병렬 호출 후 다수결. DRAFT 다수면 추가 호출 없이 초안 그대로 채택(토큰 0 추가).
async function runModeratorPanel(moderatorKeys, chCfg, botsByKey, sessions, prompt, draft, feedback, maxRounds) {
  const votes = await Promise.all(moderatorKeys.map(async (key) => {
    const text = await runDebateTurn(
      sessions, chCfg.id, key, chCfg.cwd[key], botsByKey[key],
      `요청: ${prompt}\n\n최종 초안:\n${draft}\n\n리뷰어의 마지막 지적:\n${feedback}\n\n` +
      `${maxRounds}라운드 동안 합의가 안 됐다. 첫 줄에 "VERDICT: DRAFT"(초안 그대로 채택) 또는 "VERDICT: REWRITE" 적고, ` +
      `REWRITE면 다음 줄부터 네가 직접 작성한 최종 답변만 적어라. 판단 과정 설명 금지.`
    );
    return { key, ...parseVerdict(text) };
  }));

  const draftVotes = votes.filter((v) => v.verdict === 'DRAFT').length;
  const rewriteVotes = votes.filter((v) => v.verdict === 'REWRITE');
  const tally = votes.map((v) => `${v.key}:${v.verdict}`).join(', ');

  // 최종 채택 알림은 LLM 호출 없이 순수 디스코드 메시지로만 (토큰 비용 0)
  if (draftVotes >= rewriteVotes.length) {
    appendDecisionLog(chCfg, 'moderator_verdict', { tally, adopted: 'draft' });
    const ownerSession = sessions.get(`${chCfg.id}:${chCfg.debate.owner}`);
    ownerSession.lastAnswerMsgs.push(await ownerSession.channel.send(`⭐ 최종 채택: 초안 그대로 [${tally}]`));
  } else {
    const winner = rewriteVotes[0];
    appendDecisionLog(chCfg, 'moderator_verdict', { tally, adopted: winner.key });
    const winnerSession = sessions.get(`${chCfg.id}:${winner.key}`);
    winnerSession.lastAnswerMsgs.push(await winnerSession.channel.send(`⭐ 최종 채택: [${winner.key}]의 재작성 [${tally}]`));
  }
}

// owner(초안 작성) <-> reviewer(검토) 순차 릴레이. 매 라운드 직전 결과물만 넘겨서 토큰 누적 방지.
// APPROVE 나오면 즉시 종료(라운드 최소화), maxRounds 넘도록 못 정하면 모더레이터 패널이 1회만 개입해서 마무리.
// codev:true면 reviewer가 review-only 아니라 owner cwd 공유해서 실제 파일을 직접 고침(동시개발).
async function runDebate(chCfg, botsByKey, sessions, prompt) {
  const { maxRounds, codev } = chCfg.debate;
  let owner = chCfg.debate.owner;
  let reviewer = chCfg.debate.reviewer;
  let moderatorKeys = chCfg.debate.moderators || [chCfg.debate.moderator]; // 구설정 호환

  if (usageGuardCfg.enabled) {
    const swaps = [];
    let ok;

    ({ key: owner, found: ok } = await pickAvailableBot(owner, [], botsByKey));
    if (owner !== chCfg.debate.owner) swaps.push(`owner ${chCfg.debate.owner}→${owner}`);
    if (!ok && usageGuardCfg.action === 'stop') {
      await sessions.get(`${chCfg.id}:${owner}`).channel.send(
        `🚫 사용량 임계치(${usageGuardCfg.threshold}%) 미만 봇뿐이라 작업을 보류합니다. 잠시 후 다시 시도해주세요.`
      );
      return;
    }

    const origReviewer = reviewer;
    ({ key: reviewer, found: ok } = await pickAvailableBot(reviewer, [owner], botsByKey));
    if (reviewer !== origReviewer) swaps.push(`reviewer ${origReviewer}→${reviewer}`);
    if (!ok && usageGuardCfg.action === 'stop') {
      await sessions.get(`${chCfg.id}:${owner}`).channel.send(
        `🚫 사용량 임계치(${usageGuardCfg.threshold}%) 미만 봇뿐이라 작업을 보류합니다. 잠시 후 다시 시도해주세요.`
      );
      return;
    }

    const newModerators = [];
    for (const m of moderatorKeys) {
      const { key: mKey } = await pickAvailableBot(m, [owner, reviewer], botsByKey);
      if (mKey !== m) swaps.push(`moderator ${m}→${mKey}`);
      newModerators.push(mKey);
    }
    moderatorKeys = newModerators;

    if (swaps.length) {
      appendDecisionLog(chCfg, 'usage_guard_swap', { swaps });
      await sessions.get(`${chCfg.id}:${owner}`).channel.send(`🔁 사용량 부족으로 역할 자동 교체: ${swaps.join(', ')}`);
    }
  }

  const ownerCfg = botsByKey[owner];
  const reviewerCfg = botsByKey[reviewer];
  const reviewerCwd = codev ? chCfg.cwd[owner] : chCfg.cwd[reviewer];

  let draft = await runDebateTurn(sessions, chCfg.id, owner, chCfg.cwd[owner], ownerCfg, prompt);

  let review = { status: 'REVISE', feedback: '' };
  let round = 1;
  for (; round <= maxRounds; round++) {
    const reviewPrompt = codev
      ? `요청: ${prompt}\n\n${owner}가 작성한 결과:\n${draft}\n\n` +
        `너는 review만 하지 말고 같은 작업폴더에서 실제 문제 되는 파일을 직접 열어서 고쳐라. ` +
        `고칠 게 없으면 첫 줄에 "STATUS: APPROVE"만 적어라. ` +
        `고쳤으면 첫 줄에 "STATUS: REVISE", 다음 줄부터 "이 부분은 이렇게 오류가 있어서 내가 수정했다" 식으로 ` +
        `파일:라인 단위로 뭘 왜 고쳤는지만 짧게 적어라. 판단 과정 설명 금지.`
      : `요청: ${prompt}\n\n검토 대상 답변:\n${draft}\n\n` +
        `문제 없으면 첫 줄에 "STATUS: APPROVE"만 적어라. ` +
        `문제 있으면 첫 줄에 "STATUS: REVISE", 다음 줄부터 구체적 수정 지시만 짧게 적어라. 불필요한 설명 금지.`;

    const reviewText = await runDebateTurn(sessions, chCfg.id, reviewer, reviewerCwd, reviewerCfg, reviewPrompt);
    review = parseReviewStatus(reviewText);
    appendDecisionLog(chCfg, 'debate_review', { round, reviewer, status: review.status, codev: !!codev });

    if (review.status === 'APPROVE') break;
    if (round === maxRounds) break; // 다음 owner 재작성 없이 바로 모더레이터 패널로

    draft = await runDebateTurn(
      sessions, chCfg.id, owner, chCfg.cwd[owner], ownerCfg,
      codev
        ? `요청: ${prompt}\n\n리뷰어(${reviewer})가 방금 코드 직접 수정함:\n${review.feedback}\n\n` +
          `수정 내용 확인하고 남은 작업 있으면 이어서 진행. 없으면 최종 결과 요약만 짧게.`
        : `요청: ${prompt}\n\n이전 답변:\n${draft}\n\n리뷰어 피드백:\n${review.feedback}\n\n피드백 반영해서 답변을 개선하라.`
    );
  }

  if (review.status !== 'APPROVE') {
    await runModeratorPanel(moderatorKeys, chCfg, botsByKey, sessions, prompt, draft, review.feedback, maxRounds);
  }

  if (codev) await finalizeCodev(chCfg, moderatorKeys, botsByKey, sessions, prompt, draft);
}

// git add+commit만 실행 (push는 안 함, 별도 "!push" 명령으로 사용자가 직접 확인 후 실행)
function gitCommit(cwd, message) {
  return new Promise((resolve) => {
    const add = spawn('git', ['add', '-A'], { cwd });
    add.on('close', () => {
      const commit = spawn('git', ['commit', '-m', message], { cwd });
      let out = '';
      commit.stdout.on('data', (d) => { out += d; });
      commit.stderr.on('data', (d) => { out += d; });
      commit.on('close', (code) => resolve({ code, out: stripAnsi(out).trim() }));
    });
  });
}

// 토론 끝나면 모더레이터(gemini/agy)가 전체 내용 한 문단 요약 + commit 메시지 뽑아서 커밋까지 자동 실행.
async function finalizeCodev(chCfg, moderatorKeys, botsByKey, sessions, prompt, draft) {
  const summarizerKey = moderatorKeys[0];
  const summarizerCfg = botsByKey[summarizerKey];
  const ownerKey = chCfg.debate.owner;
  const ownerCwd = chCfg.cwd[ownerKey];
  const ownerSession = sessions.get(`${chCfg.id}:${ownerKey}`);

  const summaryText = await runDebateTurn(
    sessions, chCfg.id, summarizerKey, ownerCwd, summarizerCfg,
    `요청: ${prompt}\n\n최종 결과:\n${draft}\n\n` +
    `이 작업 전체를 한 문단으로 요약해라. 마지막 줄에 git commit 메시지 한 줄(제목만, 50자 이내, ` +
    `conventional commits 형식)을 "COMMIT: <메시지>" 형태로 적어라.`
  );

  const m = summaryText.match(/COMMIT:\s*(.+)/i);
  const commitMsg = m ? m[1].trim() : 'chore: codev session update';

  const result = await gitCommit(ownerCwd, commitMsg);
  appendDecisionLog(chCfg, 'codev_commit', { commitMsg, code: result.code });

  const note = result.code === 0
    ? `📦 커밋 완료: "${commitMsg}"\npush 하려면 "!push" 입력.`
    : `⚠️ 커밋 안 됨(변경사항 없거나 오류):\n${result.out.slice(0, 500)}`;
  ownerSession.lastAnswerMsgs.push(await ownerSession.channel.send(note));
}

// 봇별로 "비대화형 1회 실행" 커맨드 구성 (TUI 없이 순수 답변 텍스트만 받기 위함)
function buildInvocation(botCfg, cwd, prompt, hasSession) {
  const extraArgs = botCfg.args || [];
  if (botCfg.key === 'claude') {
    const args = ['-p', prompt, '--dangerously-skip-permissions', ...extraArgs];
    if (hasSession) args.push('--continue');
    return { args, outputFile: null };
  }
  if (botCfg.key === 'codex') {
    const outputFile = path.join(os.tmpdir(), `codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = ['exec'];
    if (hasSession) args.push('resume', '--last');
    args.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never', '-o', outputFile, ...extraArgs, prompt);
    return { args, outputFile };
  }
  // agy
  const args = ['--print', prompt, '--dangerously-skip-permissions', '--add-dir', cwd, ...extraArgs];
  if (hasSession) args.push('--continue');
  return { args, outputFile: null };
}

// 봇별 일일 호출 한도 가드. logs/usage-counts.json에 날짜별 카운트 영속화, 자정 지나면 자동 리셋.
const usageCountPath = path.join(__dirname, 'logs', 'usage-counts.json');
let usageCounts = { day: null, counts: {} };
try {
  usageCounts = JSON.parse(fs.readFileSync(usageCountPath, 'utf8'));
} catch (e) { /* 첫 실행이면 없음, 기본값 사용 */ }

function checkAndIncrementUsage(botCfg) {
  const limit = botCfg.dailyLimit || settings.usageDailyLimit;
  if (!limit) return { allowed: true };

  const today = new Date().toISOString().slice(0, 10);
  if (usageCounts.day !== today) usageCounts = { day: today, counts: {} };

  const used = usageCounts.counts[botCfg.key] || 0;
  if (used >= limit) return { allowed: false, used, limit };

  usageCounts.counts[botCfg.key] = used + 1;
  try {
    fs.mkdirSync(path.dirname(usageCountPath), { recursive: true });
    fs.writeFileSync(usageCountPath, JSON.stringify(usageCounts), 'utf8');
  } catch (e) { /* no-op */ }

  const warnRatio = settings.usageWarnRatio || 0.8;
  return { allowed: true, used: used + 1, limit, warn: (used + 1) / limit >= warnRatio };
}

// 사용량 가드: coach.py(usage-coach)를 실시간 조회해서 임계치 미만 봇은
// debate 역할에서 자동 제외/교체하거나(action:"handoff"), 전부 낮으면 보류(action:"stop").
// coach.py 경로 미설정/조회 실패 시엔 항상 "정상"으로 취급(페일 오픈) — 이 가드 때문에
// 평소 동작이 막히면 안 됨.
const usageGuardCfg = settings.usageGuard || { enabled: false };
let usageCache = { ts: 0, payload: null };
let usageFetchPromise = null;

function fetchUsagePayload() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(usageGuardCfg.pythonCommand || 'python3', [usageGuardCfg.coachScript, '--json', '--once'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      done(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0 || !out.trim()) { done(null); return; }
      try { done(JSON.parse(out)); } catch (e) { done(null); }
    });
    setTimeout(() => { try { child.kill(); } catch (e) { /* no-op */ } done(null); }, 30000);
  });
}

// 60초(checkIntervalMs) 캐시 + 동시 호출 dedupe (매 메시지마다 3개 봇 클라이언트가 각자 부르므로)
async function getUsageSnapshot() {
  if (!usageGuardCfg.enabled) return null;
  const now = Date.now();
  if (usageCache.payload && now - usageCache.ts < (usageGuardCfg.checkIntervalMs || 60000)) {
    return usageCache.payload;
  }
  if (!usageFetchPromise) {
    usageFetchPromise = fetchUsagePayload().then((payload) => {
      usageCache = { ts: Date.now(), payload };
      usageFetchPromise = null;
      return payload;
    });
  }
  return usageFetchPromise;
}

// provider의 여러 윈도우(5h/7d/1d 등) 중 가장 빡빡한(잔량 최소) % — 하나라도 임계치 밑이면 위험 취급
function minLeftPct(providerEntry) {
  if (!providerEntry || !providerEntry.ok || !providerEntry.windows) return null;
  const pcts = Object.values(providerEntry.windows)
    .map((w) => w.left_pct)
    .filter((p) => typeof p === 'number');
  return pcts.length ? Math.min(...pcts) : null;
}

async function botUsagePct(botKey) {
  const payload = await getUsageSnapshot();
  if (!payload) return null;
  const provKey = (usageGuardCfg.providerMap || {})[botKey] || botKey;
  return minLeftPct(payload.providers && payload.providers[provKey]);
}

async function isBotLow(botKey) {
  const pct = await botUsagePct(botKey);
  return pct !== null && pct < (usageGuardCfg.threshold ?? 30);
}

// preferredKey부터 fallbackOrder 순으로 훑어 임계치 이상인 첫 봇을 고른다.
// 전부 낮으면 found:false와 함께 원래 봇을 그대로 반환(호출부가 stop/handoff 여부 결정).
async function pickAvailableBot(preferredKey, excluded, botsByKey) {
  const order = [preferredKey, ...(usageGuardCfg.fallbackOrder || []).filter((k) => k !== preferredKey)];
  for (const key of order) {
    if (excluded.includes(key) || !botsByKey[key]) continue;
    if (!(await isBotLow(key))) return { key, found: true };
  }
  return { key: preferredKey, found: false };
}

function runCli(botCfg, cwd, prompt, hasSession, session) {
  return new Promise((resolve) => {
    const usage = checkAndIncrementUsage(botCfg);
    if (!usage.allowed) {
      resolve({ ok: false, text: `🚫 [${botCfg.key}] 오늘 사용량 한도 도달 (${usage.used}/${usage.limit}). 내일 리셋됨.` });
      return;
    }

    const { args, outputFile } = buildInvocation(botCfg, cwd, prompt, hasSession);
    const child = spawn(botCfg.command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (session) {
      session.busy = true;
      session.currentChild = child;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => child.kill(), settings.execTimeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (session) {
        session.busy = false;
        session.currentChild = null;
      }
      if (session && session.canceled) {
        session.canceled = false;
        resolve({ ok: false, canceled: true, text: `[${botCfg.key}] 사용자가 취소함` });
        return;
      }
      let answer = '';
      if (outputFile) {
        try { answer = fs.readFileSync(outputFile, 'utf8'); } catch (e) { /* no-op */ }
        try { fs.unlinkSync(outputFile); } catch (e) { /* no-op */ }
        if (!answer.trim() && stdout.trim()) answer = stdout;
      } else {
        answer = stdout;
      }
      answer = stripAnsi(answer).trim();

      if (!answer && code !== 0) {
        resolve({ ok: false, text: `[${botCfg.key}] 실행 오류: ${stripAnsi(stderr).trim().slice(0, 500)}` });
        return;
      }
      const warnPrefix = usage.warn ? `⚠️ [${botCfg.key}] 오늘 사용량 ${usage.used}/${usage.limit} 임박\n\n` : '';
      resolve({ ok: true, text: warnPrefix + (answer || `[${botCfg.key}] 응답 없음`) });
    });
  });
}

// 채널 하나 + 봇 하나 조합의 상태 (작업폴더, 대화 이어가기, 핀 상태메시지, 이전 답변)
class BotSession {
  constructor(botCfg, cwd) {
    this.botCfg = botCfg;
    this.cwd = cwd;
    this.channel = null;
    this.hasSession = false;
    this.busy = false;
    this.currentChild = null;
    this.canceled = false;
    this.pinnedMsg = null;
    this.lastAnswerMsgs = [];
  }

  cancel() {
    if (!this.currentChild) return false;
    this.canceled = true;
    this.currentChild.kill();
    return true;
  }

  async ensurePinnedStatus() {
    if (this.pinnedMsg) return this.pinnedMsg;
    // pin() 호출하면 디스코드가 매번 "OO님이 메시지 고정하셨어요" 시스템 알림을 남겨서(API로 억제 불가) 고정 안 함.
    // 상태 갱신은 캐시된 메시지 참조를 edit()만 해도 동일하게 동작함.
    const msg = await this.channel.send(`⏳ [${this.botCfg.key}] 대기 중`);
    this.pinnedMsg = msg;
    return msg;
  }

  async clearPreviousAnswers() {
    for (const m of this.lastAnswerMsgs) {
      try { await m.delete(); } catch (e) { /* no-op */ }
    }
    this.lastAnswerMsgs = [];
  }

  appendLog(prompt, answer) {
    try {
      const logPath = path.join(this.cwd, 'discord-session-log.md');
      const stamp = new Date().toISOString();
      const entry = `\n## ${stamp} [${this.botCfg.key}]\n\n**지시:** ${prompt}\n\n**결과:**\n\n${answer}\n`;
      fs.appendFileSync(logPath, entry, 'utf8');
    } catch (e) {
      console.error(`[${this.botCfg.key}] 로그 저장 실패:`, e.message);
    }
  }

  async ask(prompt) {
    const withLang = `${prompt}\n\n(항상 한국어로만 답변할 것)`;
    let result = await runCli(this.botCfg, this.cwd, withLang, this.hasSession, this);
    if (!result.ok && this.hasSession && !result.canceled) {
      // 이어가기 실패 시 새 대화로 한 번 재시도
      result = await runCli(this.botCfg, this.cwd, withLang, false, this);
    }
    if (result.ok) this.hasSession = true;
    return result.text;
  }

  resetSession() {
    this.hasSession = false;
  }

  async send(text) {
    if (!this.channel) return [];
    const chunks = chunkText(text, settings.maxMessageLength);
    const sent = [];
    for (const chunk of chunks) {
      try {
        sent.push(await this.channel.send(chunk));
      } catch (e) {
        console.error(`[${this.botCfg.key}] discord send 실패:`, e.message);
      }
    }
    return sent;
  }
}

// 결정/승인 이력을 채널별 append-only JSONL로 남김 (감사 추적용, 텍스트 로그와 별개)
function appendDecisionLog(chCfg, type, detail) {
  try {
    const logPath = path.join(__dirname, 'logs', `${chCfg.name}-decisions.jsonl`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...detail });
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  } catch (e) {
    console.error('결정 로그 저장 실패:', e.message);
  }
}

const botsByKey = {};
for (const b of bots) botsByKey[b.key] = b;

// key: `${channelId}:${botKey}`
const sessions = new Map();
// 메시지 하나당 채널 정리(clearChannelSessions)를 정확히 한 번만 태우기 위한 공유 promise 캐시.
// (claude/codex/agy 3개 클라이언트가 같은 유저 메시지를 각자 수신하므로 get/set을 동기로 묶어 경쟁 없이 공유)
const clearingPromises = new Map();
const lastUserMessages = new Map(); // chId -> 이전 턴에 사람이 보낸 트리거 메시지 (다음 턴 시작할 때 같이 삭제)
for (const ch of channels) {
  for (const b of bots) {
    sessions.set(`${ch.id}:${b.key}`, new BotSession(b, ch.cwd[b.key]));
  }
}

// 이전 턴에 남은 채널 내 모든 봇의 상태/답변 메시지 + 사람이 보낸 트리거 메시지 삭제 (채팅창엔 최신 턴만 남게)
async function clearChannelSessions(chCfg, currentMessage) {
  const prevUserMsg = lastUserMessages.get(chCfg.id);
  if (prevUserMsg) {
    try { await prevUserMsg.delete(); } catch (e) { /* 메시지 관리 권한 없거나 이미 삭제됨 */ }
  }
  lastUserMessages.set(chCfg.id, currentMessage);

  for (const b of bots) {
    const s = sessions.get(`${chCfg.id}:${b.key}`);
    if (!s) continue;
    if (s.pinnedMsg) {
      try { await s.pinnedMsg.delete(); } catch (e) { /* no-op */ }
      s.pinnedMsg = null;
    }
    await s.clearPreviousAnswers();
  }
}

async function launchBotClient(botCfg) {
  const token = process.env[botCfg.tokenEnv];
  if (!token) {
    console.error(`${botCfg.tokenEnv} 없음 (.env 확인). ${botCfg.key} 봇 스킵.`);
    return;
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  client.once('clientReady', async () => {
    botCfg.userId = client.user.id;
    console.log(`[${botCfg.key}] 로그인됨: ${client.user.tag}`);
    for (const ch of channels) {
      const session = sessions.get(`${ch.id}:${botCfg.key}`);
      try {
        session.channel = await client.channels.fetch(ch.id);
      } catch (e) {
        console.error(`[${botCfg.key}] 채널(${ch.name}) 접근 실패:`, e.message);
      }
    }
  });

  const seenMessageIds = new Set(); // 게이트웨이 재연결(resume) 시 이벤트 중복 재생 방지
  client.on('messageCreate', (message) => {
    if (seenMessageIds.has(message.id)) return;
    seenMessageIds.add(message.id);
    if (seenMessageIds.size > 500) seenMessageIds.delete(seenMessageIds.values().next().value);

    const chCfg = channels.find((c) => c.id === message.channelId);
    if (!chCfg) return;
    if (message.author.bot) return; // 다른 봇 메시지엔 반응 안 함 (루프 방지)

    const { targets, cleaned } = resolveTargets(message, bots);
    if (targets !== 'all' && !targets.has(botCfg.key)) return;
    if (!cleaned.trim()) return;

    const session = sessions.get(`${chCfg.id}:${botCfg.key}`);

    const control = parseControl(cleaned);
    if (control) {
      if (control.alias && control.alias !== botCfg.key && !botCfg.aliases.includes(control.alias)) return;
      if (control.action === 'stop') {
        if (session.busy) {
          const killed = session.cancel();
          message.reply(`[${botCfg.key}] ${killed ? '실행 취소함' : '취소 실패'}`);
        } else {
          message.reply(`[${botCfg.key}] 대기 중`);
        }
      } else if (control.action === 'start') {
        message.reply(`[${botCfg.key}] 항상 대기 중 (메시지마다 새로 실행됨)`);
      } else if (control.action === 'restart') {
        session.resetSession();
        message.reply(`[${botCfg.key}] 대화 초기화함`);
      }
      return;
    }

    if (/^!push$/i.test(cleaned.trim())) {
      if (!chCfg.debate || botCfg.key !== chCfg.debate.owner) return; // owner 클라이언트만 처리(중복 push 방지)
      const cwd = chCfg.cwd[botCfg.key];
      const push = spawn('git', ['push'], { cwd });
      let out = '';
      push.stdout.on('data', (d) => { out += d; });
      push.stderr.on('data', (d) => { out += d; });
      push.on('close', (code) => {
        message.reply(`${code === 0 ? '✅ push 완료' : '❌ push 실패'}\n${stripAnsi(out).trim().slice(0, 500)}`);
      });
      return;
    }

    if (/^!help$/i.test(cleaned.trim())) {
      // 클라이언트 3개가 같은 메시지를 각자 받으므로, 하나만 올리게 대표 봇(첫 설정 봇)만 응답.
      // channel.send로 직접 보내고 session/lastAnswerMsgs엔 안 담아서 turn 정리 대상이 안 됨.
      if (botCfg.key === bots[0].key) {
        for (const chunk of chunkText(HELP_TEXT, settings.maxMessageLength)) {
          message.channel.send(chunk).catch(() => {});
        }
      }
      return;
    }

    if (/^!usage$/i.test(cleaned.trim())) {
      (async () => {
        const pct = await botUsagePct(botCfg.key);
        if (!usageGuardCfg.enabled) {
          message.reply(`[${botCfg.key}] 사용량 가드 꺼져 있음 (config.json settings.usageGuard.enabled)`);
        } else if (pct === null) {
          message.reply(`[${botCfg.key}] 사용량 조회 실패 (coach.py 경로/실행 확인 필요)`);
        } else {
          message.reply(`[${botCfg.key}] 최소 잔량 ${pct}% (임계치 ${usageGuardCfg.threshold}%)`);
        }
      })();
      return;
    }

    const quickPrompt = parseQuick(cleaned);

    const dispatch = () => {
      // 기본 동작 = debate. 별명/멘션으로 특정 봇 지목 안 했고 "!quick"도 안 붙였으면 owner가 토론 오케스트레이션.
      if (!quickPrompt && targets === 'all' && chCfg.debate) {
        if (botCfg.key !== chCfg.debate.owner) return; // owner 클라이언트만 담당
        runDebate(chCfg, botsByKey, sessions, cleaned);
        return;
      }

      const finalPrompt = quickPrompt || cleaned;

      (async () => {
        const statusMsg = await session.ensurePinnedStatus();
        const startedAt = Date.now();
        statusMsg.edit(`⏳ [${botCfg.key}] 작업 시작함...`).catch(() => {});

        const heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          statusMsg.edit(`⏳ [${botCfg.key}] 작업 중... (${elapsed}초 경과)`).catch(() => {});
        }, 15000);

        const text = await session.ask(finalPrompt);

        clearInterval(heartbeat);
        const totalSec = Math.round((Date.now() - startedAt) / 1000);
        statusMsg.edit(`✅ [${botCfg.key}] 완료 (${totalSec}초 소요)`).catch(() => {});

        // 여기 도달하는 건 항상 이 봇 하나가 직접 답하는 경로(1:1 지목 또는 !quick)라
        // debate처럼 자동 교체는 안 하고 경고만 붙임(사용자가 이 봇을 직접 호출한 거니까)
        let finalText = text;
        if (usageGuardCfg.enabled && (await isBotLow(botCfg.key))) {
          finalText = `⚠️ [${botCfg.key}] 사용량 임계치(${usageGuardCfg.threshold}%) 미만 — 필요하면 다른 봇으로도 요청해보세요.\n\n${finalText}`;
        }

        session.lastAnswerMsgs = await session.send(finalText);
        session.appendLog(finalPrompt, finalText);
      })();
    };

    // 채널 정리(이전 턴 메시지 삭제)는 유저 메시지 하나당 한 번만, 그리고 모든 새 메시지 생성보다 먼저 끝나도록 대기.
    let clearPromise = clearingPromises.get(message.id);
    if (!clearPromise) {
      clearPromise = clearChannelSessions(chCfg, message);
      clearingPromises.set(message.id, clearPromise);
      if (clearingPromises.size > 500) clearingPromises.delete(clearingPromises.keys().next().value);
    }
    clearPromise.then(dispatch);
  });

  await client.login(token);
}

(async () => {
  for (const b of bots) {
    await launchBotClient(b);
  }
})();

process.on('SIGINT', () => {
  process.exit(0);
});
