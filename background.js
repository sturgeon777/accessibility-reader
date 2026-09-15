const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// 1순위 후보. 여기서 모두 실패하면 API에 실제 사용 가능한 목록을 물어본다.
// 기본 모델은 3.5-flash. 3.6-flash는 무료 사용량이 금방 차서 시험 중 자주 한도(429)에 걸렸다.
// 같은 모델로 프롬프트를 비교할 수 있도록 오늘 쓸 수 있는 모델을 앞에 둔다.
const MODEL_CANDIDATES = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
// 목록에서 추가로 시도해 볼 모델 수. 너무 많으면 사용자가 오래 기다린다.
// 목록에는 폐기된 구버전이 남아 있기도 하므로 여유 있게 훑는다.
// 이 단계는 재시도 없이 한 번씩만 부르고, 전체 시간 제한이 따로 있어 안전하다.
const MAX_DISCOVERED_TRIES = 8;
// 없는 모델(404)로 확인되면 이 시간 동안만 건너뛴다. 그 뒤에는 다시 확인한다.
const UNAVAILABLE_TTL_MS = 12 * 60 * 60 * 1000;
// 사용량 한도(429)에 걸린 모델을 건너뛰는 시간. 무료 등급의 한도는 모델마다 따로라서
// 한 모델이 막혀도 다른 모델은 쓸 수 있다. 서버가 알려준 대기 시간이 있으면 그것을 따른다.
const QUOTA_COOLDOWN_MS = 60 * 1000;
const QUOTA_DAILY_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_INPUT_CHARS = 8000;

// 서버 혼잡/일시 장애. 재시도하면 대개 풀린다.
const TRANSIENT_STATUS = [429, 500, 502, 503, 504];
// 모델당 2회 시도. 호출 하나가 수 초씩 걸리므로 재시도를 늘리면 전체가 너무 길어진다.
const RETRY_DELAYS_MS = [1500];
// 요청 하나에 쓸 수 있는 전체 시간. 긴 단락은 좋은 모델이 다시 쓰는 데 1분이 넘기도 한다.
const REQUEST_DEADLINE_MS = 150000;
// 첫 조각을 기다리는 시간. 모델이 먼저 생각하느라 첫 조각이 늦게 온다.
const FIRST_CHUNK_TIMEOUT_MS = 60000;
// 조각과 조각 사이가 이만큼 끊기면 멈춘 것으로 본다.
const CHUNK_IDLE_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// MV3 서비스 워커는 30초간 활동이 없으면 종료된다. setTimeout 대기는 활동으로
// 치지 않으므로, 긴 작업 도중 워커가 죽어 sendResponse가 영영 불리지 않는다.
// 주기적으로 확장 API를 불러 유휴 타이머를 초기화한다.
let keepAliveTimer = null;
let keepAliveHolders = 0;

function startKeepAlive() {
  keepAliveHolders++;
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
}

function stopKeepAlive() {
  keepAliveHolders = Math.max(0, keepAliveHolders - 1);
  if (keepAliveHolders === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

const INJECTABLE_URL = /^(https?|file):/;

// 확장 프로그램을 다시 불러오면 이미 열려 있던 탭의 콘텐트 스크립트는 죽지만
// 새 스크립트가 자동으로 들어가지는 않는다. 그래서 열린 탭에 직접 다시 주입한다.
// 이것이 없으면 수정할 때마다 모든 탭을 새로고침해야 한다.
async function reinjectOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    console.warn('[acc-reader] 탭 목록 조회 실패:', err);
    return;
  }

  const results = await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !INJECTABLE_URL.test(tab.url || '')) return false;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return true;
    } catch (err) {
      // 크롬 웹스토어처럼 주입이 금지된 페이지는 건너뛴다.
      return false;
    }
  }));

  console.log(`[acc-reader] 열린 탭 재주입: ${results.filter(Boolean).length}/${tabs.length}`);
}

chrome.runtime.onInstalled.addListener(async () => {
  // 예전에는 성공한 모델을 저장해 다음부터 먼저 썼다. 그 방식은 한 번 대체 모델로
  // 넘어가면 기본 모델이 살아나도 다시 시도하지 않아 제거했다. 남은 값을 지운다.
  await chrome.storage.local.remove('geminiModel');
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "transformSelectionMenu",
    title: "쉬운 글로 변환 (선택 영역)",
    contexts: ["selection"]
  });
  reinjectOpenTabs();
});

chrome.runtime.onStartup.addListener(reinjectOpenTabs);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "transformSelectionMenu" || !tab || !tab.id) return;

  const message = { action: "transformFromContextMenu", text: info.selectionText };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    // 콘텐트 스크립트가 없는 탭이면 주입한 뒤 다시 보낸다.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (injectErr) {
      console.warn('[acc-reader] 콘텐트 스크립트 주입 실패:', injectErr);
    }
  }
});

// 결과 창에 어떤 규칙으로 변환했는지 표시한다. 시험할 때 어떤 프롬프트가 돌았는지 헷갈리지 않게.
const PROMPT_LABEL = '간단한 언어';

function buildPrompt(sourceText) {
  // 대상은 수행평가를 준비하며 논문을 찾아 읽는 고등학생이다. 논문 본문이 어려워
  // 초록만 읽고 넘어가는 문제에서 출발했다. 목적은 논문의 내용을 이해하는 것이다.
  // 초록은 이미 요약이므로, 또 요약하지 않고 본문을 줄이지 않은 채 쉽게 바꾼다.
  //
  // 규칙은 Nachrichtenleicht(Deutschlandfunk)가 쓰는 'Einfache Sprache'(간단한 언어)를
  // 따른다. 간단한 언어는 규칙집 없이 대략적인 지침만 있다(bpb 소개 글 기준).
  // - 한 문장에 종속절은 최대 하나까지
  // - 외래어는 피한다
  // - 어려운 개념의 설명은 본문에 넣지 않고 따로 사전으로 뺀다
  // - 쉽게 풀면 오히려 글이 길어질 수 있다 (줄이는 것이 목표가 아니다)
  // Deutschlandfunk는 복잡한 정치 기사에 더 강한 'Leichte Sprache'(쉬운 언어)를
  // 적용하기 어려워 간단한 언어를 골랐다. 논문도 같은 이유로 간단한 언어가 맞다.
  //
  // 이전에는 Leichte Sprache 규칙집을 뼈대로 논문용 규칙을 덧붙였다. 다크패턴 선행연구
  // 단락으로 세 번 시험하며 규칙이 60줄을 넘자, AI가 뜻은 지켜도 낱말은 거의 바꾸지
  // 않았다(규칙이 많을수록 아무것도 바꾸지 않는 쪽이 안전해진다). 그래서 간단한 언어로
  // 옮기면서 규칙을 최소한으로 줄였다. 숫자는 연구 결과 자체이므로 그대로 두게 했다.
  //
  // 학술 용어는 쉬운 말로 바꾸지 않는다. 바꿔 버리면 같은 용어를 다른 글에서 만났을 때
  // 또 알아보지 못한다. 뜻은 사전에 넣고, 화면에서 낱말을 누르면 뜨게 한다(content.js).
  // 사전의 낱말이 본문에 쓴 모양과 같아야 화면에서 찾아 밑줄을 그을 수 있다.
  return `아래 [원문]은 논문의 일부입니다.
고등학생이 처음 읽어도 이해할 수 있도록 '간단한 언어'(Einfache Sprache)로 다시 써 주세요.
요약하지 말고, 원문의 모든 내용을 순서대로 옮깁니다.

- 문장을 짧게 씁니다. 한 문장에 종속절은 하나까지만 씁니다.
- 한 문장을 쓴 뒤에는 줄을 바꿉니다.
- 어려운 한자어, 외래어, 딱딱한 표현은 일상에서 쓰는 말로 바꿉니다.
- 학술 용어는 그대로 두고, 뜻은 본문이 아니라 아래 사전에 적습니다.
- 숫자와 인용 번호는 원문 그대로 씁니다. (예: '참가자 300명 가운데 42명', '[5]')
- 원문의 뜻을 바꾸거나 원문에 없는 내용을 덧붙이지 않습니다.
- '~습니다' 체로 씁니다.

출력 형식:
1. [쉬운 말 변환 본문]
(다시 쓴 글)

2. [어려운 용어 사전]
• 낱말: 뜻
(사전의 낱말은 조사를 떼고, 본문에 쓴 모양 그대로 적습니다.)

[원문]:
${sourceText}`;
}

// 응답을 조각조각(스트리밍) 받는다.
//
// 예전에는 완성본을 한 번에 기다리며 30초가 지나면 끊었다. 그런데 gemini-3.6-flash는
// 긴 단락을 다시 쓰는 데 30초를 넘기곤 해서, 잘 쓰고 있던 요청까지 끊고 같은 모델로
// 다시 부르다 전체 제한 시간을 다 썼다("시간 안에 변환을 마치지 못했습니다").
// 이제 글이 들어오는 동안은 기다리고, 조각이 멈췄을 때만 끊는다.
// 모든 대기 시간은 전체 마감 시각을 넘지 않게 잘라서 쓴다.
async function callModel(model, apiKey, prompt, deadline) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const seconds = (ms) => Math.round(ms / 1000);
  let timer = null;
  let firstChunkAt = 0;
  let text = '';
  let events = 0;
  let textParts = 0;
  let thoughtParts = 0;
  let finishReason = null;
  let promptFeedback = null;

  const arm = (ms) => {
    clearTimeout(timer);
    const left = deadline - Date.now();
    timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(ms, left)));
  };

  try {
    arm(FIRST_CHUNK_TIMEOUT_MS);
    const res = await fetch(`${API_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
      signal: controller.signal
    });

    // 오류는 스트림이 아니라 일반 JSON으로 온다.
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return { res, json };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handleEvent = (payload) => {
      let data;
      try {
        data = JSON.parse(payload);
      } catch (err) {
        return;
      }
      events += 1;
      if (data.promptFeedback) promptFeedback = data.promptFeedback;
      const candidate = data.candidates && data.candidates[0];
      if (!candidate) return;
      if (candidate.finishReason) finishReason = candidate.finishReason;
      const parts = (candidate.content && candidate.content.parts) || [];
      parts.forEach(part => {
        if (typeof part.text !== 'string') return;
        // 모델이 생각한 과정은 결과에 넣지 않는다. 다만 몇 개였는지는 센다.
        if (part.thought) {
          thoughtParts += 1;
          return;
        }
        textParts += 1;
        text += part.text;
      });
    };

    const handleLine = (raw) => {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstChunkAt) firstChunkAt = Date.now();
      arm(CHUNK_IDLE_TIMEOUT_MS);
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);

    // 정상적으로 끝난 응답은 마지막 조각에 끝맺음 표시(finishReason)가 있다.
    // 표시 없이 스트림이 닫혔다면 도중에 끊긴 것이므로 사용자에게 알린다.
    if (text && !finishReason) finishReason = 'INCOMPLETE';

    const meta = {
      finishReason,
      events,
      textParts,
      thoughtParts,
      chars: text.length,
      firstChunkSec: firstChunkAt ? seconds(firstChunkAt - startedAt) : null,
      totalSec: seconds(Date.now() - startedAt)
    };
    console.log(`[acc-reader] ${model} 응답`, meta);

    // 한 번에 받은 응답과 같은 모양으로 합쳐서 돌려준다. extractText가 그대로 읽는다.
    const json = {
      candidates: (text || finishReason) ? [{ content: { parts: [{ text }] }, finishReason }] : [],
      promptFeedback,
      meta
    };
    return { res: { ok: true, status: 200 }, json };
  } catch (err) {
    if (err.name === 'AbortError') {
      // 첫 응답이 아예 안 왔는지, 쓰다가 멈췄는지 구분해 적는다. 대처가 다르기 때문이다.
      const elapsed = seconds(Date.now() - startedAt);
      const stage = firstChunkAt
        ? `응답 도중 멈춤(${elapsed}초, ${text.length}자 받음)`
        : `첫 응답 없음(${elapsed}초)`;
      return { res: { ok: false, status: 504 }, json: { error: { message: stage }, timedOut: true } };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 일시적 오류(혼잡/장애)면 같은 모델로 잠시 뒤 다시 시도한다.
// 모델을 바꾸면 결과 품질이 달라지므로 여기서는 모델을 유지한다.
async function callModelWithRetry(model, apiKey, prompt, deadline) {
  let last = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    last = await callModel(model, apiKey, prompt, deadline);
    if (last.res.ok || !TRANSIENT_STATUS.includes(last.res.status)) {
      return last;
    }
    // 느려서 끊긴 모델은 다시 불러도 또 끊긴다. 재시도하지 않고 다음 모델로 넘긴다.
    if (last.json && last.json.timedOut) return last;
    // 사용량 한도(429)는 잠깐 기다린다고 풀리지 않는다. 다시 부르면 사용량만 버린다.
    if (last.res.status === 429) return last;
    if (attempt >= RETRY_DELAYS_MS.length) break;
    // 남은 시간이 없으면 대기 없이 곧바로 다시 부르지 말고 여기서 끝낸다.
    // 간격 없는 재호출은 특히 429(할당량)에서 상황을 악화시킨다.
    if (Date.now() + RETRY_DELAYS_MS[attempt] >= deadline) break;
    console.warn(`[acc-reader] ${model} HTTP ${last.res.status} - ${RETRY_DELAYS_MS[attempt]}ms 후 재시도`);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }

  return last;
}

// 모델이 없거나 폐기되었을 때만 '사용 불가'로 본다.
// 인증 실패(401/403), 할당량 초과(429), 서버 오류(5xx)는 모델과 무관하다.
// 예전에는 문구에 'not supported'만 있어도 모델 없음으로 보았는데, 그러면
// "이 지역에서는 지원하지 않음" 같은 400 오류까지 모델 문제로 잘못 분류했다.
function isModelNotFound(res, json) {
  if (res.status === 404) return true;
  const message = (json && json.error && json.error.message) || '';
  const status = (json && json.error && json.error.status) || '';
  return status === 'NOT_FOUND' || /is not found|no longer available/i.test(message);
}

// 429 응답에서 한도 종류와 대기 시간을 읽는다.
// 예: details[].quotaId = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
//     details[].retryDelay = '43s'
function quotaCooldownMs(json) {
  const details = (json && json.error && json.error.details) || [];
  let retryMs = 0;
  let daily = false;
  details.forEach(d => {
    if (typeof d.retryDelay === 'string') {
      const sec = parseFloat(d.retryDelay);
      if (!isNaN(sec)) retryMs = Math.max(retryMs, sec * 1000);
    }
    (d.violations || []).forEach(v => {
      if (/PerDay/i.test(v.quotaId || '')) daily = true;
    });
  });
  if (daily) return Math.max(retryMs, QUOTA_DAILY_COOLDOWN_MS);
  return retryMs || QUOTA_COOLDOWN_MS;
}

async function loadCooldowns() {
  const { quotaCooldowns = {} } = await chrome.storage.local.get('quotaCooldowns');
  const now = Date.now();
  const fresh = {};
  Object.keys(quotaCooldowns).forEach(name => {
    if (quotaCooldowns[name] > now) fresh[name] = quotaCooldowns[name];
  });
  return fresh;
}

async function loadUnavailable() {
  const { unavailableModels = {} } = await chrome.storage.local.get('unavailableModels');
  const now = Date.now();
  const fresh = {};
  Object.keys(unavailableModels).forEach(name => {
    if (now - unavailableModels[name] < UNAVAILABLE_TTL_MS) fresh[name] = unavailableModels[name];
  });
  return fresh;
}

async function listUsableModels(apiKey) {
  try {
    const res = await fetch(`${API_BASE}/models?key=${encodeURIComponent(apiKey)}`);
    const json = await res.json();
    return (json.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace('models/', ''))
      .filter(Boolean);
  } catch (err) {
    console.warn('[acc-reader] 모델 목록 조회 실패:', err);
    return [];
  }
}

function extractText(json) {
  if (json.promptFeedback && json.promptFeedback.blockReason) {
    throw new Error(`원문이 안전 필터에 의해 차단되었습니다. (사유: ${json.promptFeedback.blockReason})`);
  }

  const candidate = json.candidates && json.candidates[0];
  if (!candidate) {
    throw new Error('AI가 응답을 생성하지 못했습니다. 다른 문단으로 다시 시도해 주세요.');
  }

  const text = candidate.content
    && candidate.content.parts
    && candidate.content.parts[0]
    && candidate.content.parts[0].text;

  if (!text) {
    const reason = candidate.finishReason;
    if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(reason)) {
      throw new Error('응답이 안전 필터에 의해 차단되었습니다. 다른 문단으로 시도해 주세요.');
    }
    if (reason === 'RECITATION') {
      throw new Error('저작권 보호 정책에 의해 응답이 차단되었습니다. 다른 문단으로 시도해 주세요.');
    }
    if (reason === 'MAX_TOKENS') {
      throw new Error('원문이 너무 길어 응답이 잘렸습니다. 더 짧은 범위를 선택해 주세요.');
    }
    throw new Error('AI가 빈 응답을 반환했습니다. 잠시 후 다시 시도해 주세요.');
  }

  if (candidate.finishReason === 'INCOMPLETE') {
    return `${text}\n\n(안내: 응답이 도중에 끊겨 뒷부분이 빠졌을 수 있습니다. 다시 변환해 주세요.)`;
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    return `${text}\n\n(안내: 응답이 길이 제한에 걸려 도중에 끊겼습니다.)`;
  }
  return text;
}

// 이름에서 버전을 뽑는다. 'latest'는 구글이 최신 모델을 가리키는 별칭이므로 가장 높게 본다.
function modelVersion(name) {
  if (/latest/i.test(name)) return 99;
  const m = name.match(/(\d+)\.(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) / 10 : 0;
}

// 텍스트 변환에 쓸 수 없는 모델을 걸러내고 우선순위를 매긴다. 점수가 낮을수록 먼저 시도한다.
function rankModel(name) {
  if (/embedding|aqa|imagen|veo|tts|audio|image|vision|live/i.test(name)) return null;
  let score = 0;
  if (/flash/i.test(name)) score -= 30;
  else if (/pro/i.test(name)) score -= 10;
  if (/lite/i.test(name)) score += 5;
  if (/preview|exp|thinking/i.test(name)) score += 20;
  if (/gemma|learnlm/i.test(name)) score += 15;
  return score;
}

// 성능 등급. 낮을수록 먼저 시도한다.
// 예전에는 버전만 먼저 보았는데, 'latest' 별칭을 가장 새 버전으로 치는 바람에
// 성능이 낮은 flash-lite-latest가 gemini-2.5-pro보다 앞에 섰다.
function modelTier(name) {
  if (/gemma|learnlm/i.test(name)) return 3;
  if (/preview|exp|thinking/i.test(name)) return 2;
  if (/lite/i.test(name)) return 1;
  return 0;
}

function pickExtraModels(discovered, exclude, limit) {
  return discovered
    .filter(name => !exclude.has(name))
    .map(name => ({ name, score: rankModel(name), version: modelVersion(name), tier: modelTier(name) }))
    .filter(entry => entry.score !== null)
    // 등급을 먼저 보고, 같은 등급 안에서 버전을 본다. 버전을 보는 이유는 폐기된
    // 구버전이 앞자리를 차지해 살아 있는 최신 모델까지 순서가 오지 않는 것을 막기 위해서다.
    .sort((a, b) => (a.tier - b.tier) || (b.version - a.version) || (a.score - b.score))
    .slice(0, limit)
    .map(entry => entry.name);
}

// 성공하면 응답을, 실패하면 null을 돌려주고 실패 사유를 state에 남긴다.
// 성공하면 응답을, 실패하면 null을 돌려주고 실패 사유를 state에 남긴다.
// 사유는 결과 창 안내에 그대로 들어가므로 짧게 적고, 자세한 내용은 콘솔에 남긴다.
async function tryOneModel(model, apiKey, prompt, state, withRetry) {
  if (Date.now() > state.deadline) {
    state.timedOut = true;
    return null;
  }

  if (state.unavailable[model]) {
    state.skipped.push(model);
    state.failures.push({ model, reason: '최근 사용 불가로 건너뜀' });
    return null;
  }

  if (state.cooldowns[model] > Date.now()) {
    const minutes = Math.ceil((state.cooldowns[model] - Date.now()) / 60000);
    state.failures.push({ model, reason: `사용량 한도로 건너뜀(${minutes}분 뒤 다시 시도)` });
    state.lastTransient = 'HTTP 429';
    state.switchedForLoad = true;
    return null;
  }

  const { res, json } = withRetry
    ? await callModelWithRetry(model, apiKey, prompt, state.deadline)
    : await callModel(model, apiKey, prompt, state.deadline);

  if (res.ok) {
    const candidate = json.candidates && json.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const hasText = parts.some(p => typeof p.text === 'string' && p.text.trim());
    const blockReasons = ['SAFETY', 'RECITATION', 'MAX_TOKENS', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'];
    const blocked = (json.promptFeedback && json.promptFeedback.blockReason)
      || (candidate && blockReasons.includes(candidate.finishReason));

    // 글자 없이 끝난 응답은 차단이 아니라면 모델 쪽 문제일 수 있으므로 다음 모델로 넘어간다.
    // 예전에는 여기서 곧바로 "빈 응답" 알림을 띄우고 포기했다.
    if (!hasText && !blocked) {
      const m = json.meta || {};
      const ending = m.finishReason || (candidate && candidate.finishReason) || '없음';
      const reason = `빈 응답(끝맺음 ${ending}, 글 조각 ${m.textParts || 0}개, 생각 조각 ${m.thoughtParts || 0}개)`;
      state.lastTransient = 'EMPTY';
      state.switchedForLoad = true;
      state.failures.push({ model, reason });
      console.warn(`[acc-reader] ${model} ${reason}`, json.meta);
      return null;
    }
    return json;
  }

  const apiMessage = (json && json.error && json.error.message) || '';

  if (isModelNotFound(res, json)) {
    state.lastNotFound = apiMessage || `HTTP ${res.status}`;
    // 영구히 저장하지 않고 일정 시간만 건너뛴다. 모델은 다시 열리기도 한다.
    state.unavailable[model] = Date.now();
    state.unavailableChanged = true;
    state.failures.push({ model, reason: `사용 불가(${res.status})` });
    console.warn(`[acc-reader] ${model} 사용 불가:`, apiMessage);
    return null;
  }

  if (TRANSIENT_STATUS.includes(res.status)) {
    let reason;
    if (json && json.timedOut) {
      reason = (json.error && json.error.message) || '응답 시간 초과';
    } else if (res.status === 429) {
      reason = '사용량 한도 초과(429)';
      // 다음 요청에서도 곧바로 건너뛰도록 기억한다.
      state.cooldowns[model] = Date.now() + quotaCooldownMs(json);
      state.cooldownsChanged = true;
    } else if (res.status === 503) {
      reason = '서버 혼잡(503)';
    } else {
      reason = `서버 오류(${res.status})`;
    }
    state.lastTransient = `HTTP ${res.status}`;
    state.switchedForLoad = true;
    state.failures.push({ model, reason });
    console.warn(`[acc-reader] ${model} ${reason}:`, apiMessage);
    return null;
  }

  const detail = (json.error && json.error.message) || '(응답 본문 없음)';
  throw new Error(`API 오류 (HTTP ${res.status}): ${detail}`);
}

// 매번 기본 모델부터 시도한다.
//
// 예전에는 성공한 모델을 저장해 다음 요청에서 가장 먼저 썼다. 그런데 기본 모델이 한 번
// 실패해 대체 모델(gemini-flash-lite-latest)로 넘어간 날 그 모델이 저장되자, 이후에는
// 기본 모델이 멀쩡해져도 다시 시도하지 않고 성능이 낮은 대체 모델만 계속 썼다.
// 그래서 '잘 된 모델'을 기억하지 않고 '안 되는 모델'을 12시간만 기억하도록 바꿨다.
async function generate(prompt, apiKey, deadline) {
  const state = {
    lastNotFound: null,
    lastTransient: null,
    switchedForLoad: false,
    timedOut: false,
    failures: [],
    skipped: [],
    unavailable: await loadUnavailable(),
    unavailableChanged: false,
    cooldowns: await loadCooldowns(),
    cooldownsChanged: false,
    deadline
  };

  const saveUnavailable = async () => {
    if (state.unavailableChanged) {
      await chrome.storage.local.set({ unavailableModels: state.unavailable });
    }
    if (state.cooldownsChanged) {
      await chrome.storage.local.set({ quotaCooldowns: state.cooldowns });
    }
  };

  const finish = async (json, model) => {
    const text = extractText(json);
    if (state.unavailable[model]) {
      delete state.unavailable[model];
      state.unavailableChanged = true;
    }
    await saveUnavailable();

    // 기본 모델이 아닌 모델로 답했다면 이유와 함께 알린다. 조용히 바뀌지 않게.
    const preferred = MODEL_CANDIDATES[0];
    let notice = null;
    if (model !== preferred) {
      const why = state.failures
        .map(f => `${f.model} ${f.reason}`)
        .join(', ');
      notice = `기본 모델(${preferred}) 대신 ${model}로 변환했습니다. 결과가 평소와 다를 수 있습니다.`;
      if (why) notice += ` (${why})`;
    }

    console.log('[acc-reader] 사용 모델:', model);
    return { text, model, switchedForLoad: state.switchedForLoad, notice };
  };

  for (const model of MODEL_CANDIDATES) {
    const json = await tryOneModel(model, apiKey, prompt, state, true);
    if (json) return finish(json, model);
  }

  // 모델은 시간이 지나면 폐기된다. 준비한 후보가 모두 실패하면
  // API에 실제 사용 가능한 목록을 물어보고 그중에서 이어서 시도한다.
  const discovered = await listUsableModels(apiKey);
  const cooling = Object.keys(state.cooldowns).filter(name => state.cooldowns[name] > Date.now());
  const exclude = new Set([...MODEL_CANDIDATES, ...Object.keys(state.unavailable), ...cooling]);
  const extra = pickExtraModels(discovered, exclude, MAX_DISCOVERED_TRIES);

  if (extra.length) {
    console.log('[acc-reader] 목록에서 추가 시도:', extra.join(', '));
    for (const model of extra) {
      // 이미 시간을 많이 썼으므로 여기서는 재시도 없이 한 번씩만 빠르게 훑는다.
      const json = await tryOneModel(model, apiKey, prompt, state, false);
      if (json) return finish(json, model);
    }
  }

  // 모두 실패했다면, 이번에 기록 때문에 건너뛴 모델은 다음 요청에서 다시 확인하게 한다.
  state.skipped.forEach(name => {
    delete state.unavailable[name];
    state.unavailableChanged = true;
  });
  await saveUnavailable();

  // 모델마다 무엇이 왜 실패했는지 그대로 보여준다. 사유가 하나로 뭉뚱그려지면 원인을 짚을 수 없다.
  const detail = state.failures.length
    ? state.failures.map(f => `- ${f.model}: ${f.reason}`).join('\n')
    : '- (응답을 받지 못했습니다)';

  if (state.timedOut) {
    throw new Error(
      `시간 안에 변환을 마치지 못했습니다.\n\n${detail}\n\n` +
      `모델이 붐비거나 느린 상태입니다. 잠시 뒤 다시 시도하거나 더 짧은 문단으로 시도해 보세요.`
    );
  }

  if (state.lastTransient && !state.lastNotFound) {
    throw new Error(
      `지금은 쓸 수 있는 모델이 모두 제대로 응답하지 못했습니다.\n\n${detail}\n\n잠시 후 다시 시도해 주세요.`
    );
  }

  const hint = discovered.length
    ? `\n\n이 API Key로 사용 가능한 모델:\n${discovered.slice(0, 15).join(', ')}`
    : `\n\n모델 목록도 가져오지 못했습니다. API Key와 인터넷 연결을 확인해 주세요.`;

  throw new Error(`변환에 성공한 모델이 없습니다.\n\n${detail}${hint}`);
}

async function handleTransform(sourceText) {
  const deadline = Date.now() + REQUEST_DEADLINE_MS;

  // 작업이 끝날 때까지 서비스 워커가 종료되지 않게 붙잡아 둔다.
  startKeepAlive();
  try {
    const apiKey = (await chrome.storage.local.get('geminiApiKey')).geminiApiKey;
    if (!apiKey) {
      return {
        ok: false,
        error: 'Gemini API Key가 설정되지 않았습니다. 확장 프로그램 팝업 창에서 API Key를 입력 후 저장해 주세요.'
      };
    }

    const text = (sourceText || '').trim();
    if (!text) {
      return { ok: false, error: '변환할 글을 찾지 못했습니다.' };
    }

    const used = text.slice(0, MAX_INPUT_CHARS);
    const truncatedFrom = text.length > MAX_INPUT_CHARS
      ? { used: used.length, total: text.length }
      : null;

    const result = await generate(buildPrompt(used), apiKey, deadline);
    return {
      ok: true,
      text: result.text,
      truncatedFrom,
      model: result.model,
      switchedForLoad: result.switchedForLoad,
      notice: result.notice,
      promptLabel: PROMPT_LABEL
    };
  } catch (err) {
    console.error('[acc-reader]', err);
    const message = /Failed to fetch|NetworkError/i.test(err.message || '')
      ? '네트워크에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.'
      : (err.message || 'AI 변환 처리 중 오류가 발생했습니다.');
    return { ok: false, error: message };
  } finally {
    stopKeepAlive();
  }
}

// 콘텐트 스크립트의 fetch는 페이지의 CSP(connect-src)를 따르기 때문에
// CSP가 엄격한 사이트에서 차단된다. API 호출은 여기서 대신 수행한다.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'callGemini') {
    // 여기서 응답하지 않으면 콘텐트 스크립트는 영원히 로딩 화면에 머문다.
    handleTransform(request.text)
      .then(sendResponse)
      .catch(err => {
        console.error('[acc-reader] 처리 실패', err);
        sendResponse({ ok: false, error: (err && err.message) || '알 수 없는 오류가 발생했습니다.' });
      });
    return true;
  }
});