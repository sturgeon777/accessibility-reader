const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// 1순위 후보. 여기서 모두 실패하면 API에 실제 사용 가능한 목록을 물어본다.
const MODEL_CANDIDATES = ['gemini-3.6-flash', 'gemini-2.5-flash'];
// 목록에서 추가로 시도해 볼 모델 수. 너무 많으면 사용자가 오래 기다린다.
const MAX_DISCOVERED_TRIES = 4;
const MAX_INPUT_CHARS = 8000;

// 서버 혼잡/일시 장애. 재시도하면 대개 풀린다.
const TRANSIENT_STATUS = [429, 500, 502, 503, 504];
// 총 3회 시도. 서비스 워커가 유휴 상태로 종료되지 않도록 대기 시간은 짧게 유지한다.
const RETRY_DELAYS_MS = [1200, 3500];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function buildPrompt(sourceText) {
  // 독일 Deutschlandfunk의 쉬운 언어 뉴스 Nachrichtenleicht가 따르는
  // 'Leichte Sprache' 규칙을 한국어에 맞게 옮긴 것.
  // 독일어 전용 규칙(복합어 하이픈 분리, 속격/접속법 회피)은 제외했다.
  return `당신은 '쉬운 언어'(Leichte Sprache) 원칙에 따라 글을 다시 쓰는 전문가입니다.
독일 공영방송의 쉬운 언어 뉴스처럼, 아래 [원문]을 누구나 읽을 수 있는 글로 바꾸어 주세요.

[반드시 지킬 작성 규칙]
- 한 문장에는 한 가지 내용만 담습니다.
- 한 문장을 쓴 뒤에는 반드시 줄을 바꿉니다. 한 줄에 두 문장을 쓰지 않습니다.
- 문장을 짧게 씁니다. 한 문장에 서술어는 하나만 씁니다.
- 능동으로 씁니다. '~되어진다', '~하여진다' 같은 피동 표현을 피합니다.
- 어려운 한자어 대신 일상에서 쓰는 말을 씁니다.
- 어려운 말을 꼭 써야 한다면, 바로 다음 줄에서 그 뜻을 풀어 설명합니다.
- 같은 대상은 늘 같은 단어로 부릅니다. 다른 말로 바꾸어 쓰지 않습니다.
- 비유, 관용구, 사자성어, 반어법을 쓰지 않습니다.
- 줄임말과 약자는 풀어서 씁니다.
- 큰 수나 백분율은 '많은 사람', '열 명 가운데 한 명'처럼 알기 쉽게 바꿉니다.
- 부정문보다 긍정문으로 씁니다. 이중 부정은 쓰지 않습니다.
- 날짜와 시간은 빠뜨리지 않고 씁니다.
- 읽는 사람에게 말하듯 존댓말로 씁니다.

1. [쉬운 말 변환 본문]
- 원문의 내용을 위 규칙에 따라 처음부터 끝까지 다시 씁니다.
- 원문에 있는 내용을 빠뜨리지 않고, 나온 순서대로 옮깁니다.
- 원문에 없는 내용을 새로 지어내지 않습니다.

2. [어려운 용어 사전]
- 원문에 나온 어려운 단어, 한자어, 전문 용어를 3~5개 고릅니다.
- 각 단어의 뜻을 쉬운 말로 풀어 씁니다.
- 형식 예시:
  • 단어명: 쉬운 뜻풀이 설명

---
[원문]:
${sourceText}`;
}

async function callModel(model, apiKey, prompt) {
  const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

// 일시적 오류(혼잡/장애)면 같은 모델로 잠시 뒤 다시 시도한다.
// 모델을 바꾸면 결과 품질이 달라지므로 여기서는 모델을 유지한다.
async function callModelWithRetry(model, apiKey, prompt) {
  let last = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    last = await callModel(model, apiKey, prompt);
    if (last.res.ok || !TRANSIENT_STATUS.includes(last.res.status)) {
      return last;
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      console.warn(`[acc-reader] ${model} HTTP ${last.res.status} - ${RETRY_DELAYS_MS[attempt]}ms 후 재시도`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  return last;
}

// 모델 이름이 틀렸을 때만 다음 후보로 넘어간다.
// 인증 실패(401/403), 할당량 초과(429), 서버 오류(5xx)는 모델과 무관하므로 그대로 보고한다.
function isModelNotFound(res, json) {
  if (res.status === 404) return true;
  const message = (json && json.error && json.error.message) || '';
  const status = (json && json.error && json.error.status) || '';
  return status === 'NOT_FOUND' || /is not found|not supported|unsupported/i.test(message);
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
    if (reason === 'SAFETY') {
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

  if (candidate.finishReason === 'MAX_TOKENS') {
    return `${text}\n\n(안내: 응답이 길이 제한에 걸려 도중에 끊겼습니다.)`;
  }
  return text;
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

function pickExtraModels(discovered, alreadyTried, limit) {
  return discovered
    .filter(name => !alreadyTried.has(name))
    .map(name => ({ name, score: rankModel(name) }))
    .filter(entry => entry.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(entry => entry.name);
}

// 성공하면 응답을, 실패하면 null을 돌려주고 실패 사유를 state에 남긴다.
async function tryOneModel(model, apiKey, prompt, state, withRetry) {
  const { res, json } = withRetry
    ? await callModelWithRetry(model, apiKey, prompt)
    : await callModel(model, apiKey, prompt);

  if (res.ok) return json;

  if (isModelNotFound(res, json)) {
    state.lastNotFound = (json.error && json.error.message) || `HTTP ${res.status}`;
    return null;
  }
  if (TRANSIENT_STATUS.includes(res.status)) {
    console.warn(`[acc-reader] ${model} 혼잡(HTTP ${res.status}) - 다음 모델 시도`);
    state.lastTransient = `HTTP ${res.status}`;
    state.switchedForLoad = true;
    return null;
  }
  const detail = (json.error && json.error.message) || '(응답 본문 없음)';
  throw new Error(`API 오류 (HTTP ${res.status}): ${detail}`);
}

// 성공한 모델 id를 저장해 두었다가 다음 요청에서 먼저 시도한다.
async function generate(prompt, apiKey) {
  const cached = (await chrome.storage.local.get('geminiModel')).geminiModel;
  const primary = cached
    ? [cached, ...MODEL_CANDIDATES.filter(m => m !== cached)]
    : [...MODEL_CANDIDATES];

  const state = { lastNotFound: null, lastTransient: null, switchedForLoad: false };

  const finish = async (json, model) => {
    // 혼잡으로 넘어온 모델은 기본값으로 저장하지 않는다. 잠깐 붐빈 것뿐이므로.
    if (!state.switchedForLoad && model !== cached) {
      await chrome.storage.local.set({ geminiModel: model });
    }
    console.log('[acc-reader] 사용 모델:', model);
    return { text: extractText(json), model, switchedForLoad: state.switchedForLoad };
  };

  for (const model of primary) {
    const json = await tryOneModel(model, apiKey, prompt, state, true);
    if (json) return finish(json, model);
  }

  // 모델은 시간이 지나면 폐기된다. 하드코딩한 후보가 모두 실패하면
  // API에 실제 사용 가능한 목록을 물어보고 그중에서 이어서 시도한다.
  const discovered = await listUsableModels(apiKey);
  const extra = pickExtraModels(discovered, new Set(primary), MAX_DISCOVERED_TRIES);

  if (extra.length) {
    console.log('[acc-reader] 목록에서 추가 시도:', extra.join(', '));
    // 여기서 switchedForLoad를 켜지 않는다. 폐기된 모델 때문에 넘어온 경우에는
    // 새로 찾은 모델을 기본값으로 저장해야 다음 요청에서 헛걸음하지 않는다.
    for (const model of extra) {
      // 이미 시간을 많이 썼으므로 여기서는 재시도 없이 한 번씩만 빠르게 훑는다.
      const json = await tryOneModel(model, apiKey, prompt, state, false);
      if (json) return finish(json, model);
    }
  }

  await chrome.storage.local.remove('geminiModel');

  if (state.lastTransient && !state.lastNotFound) {
    throw new Error(
      `Gemini 서버가 혼잡합니다 (${state.lastTransient}).\n` +
      `시도할 수 있는 모델을 모두 시도했지만 실패했습니다. 잠시 후 다시 시도해 주세요.`
    );
  }

  const tried = [...primary, ...extra];
  const hint = discovered.length
    ? `\n\n이 API Key로 사용 가능한 모델:\n${discovered.slice(0, 15).join('\n')}`
    : '';
  throw new Error(
    `변환에 성공한 모델이 없습니다.\n시도한 모델: ${tried.join(', ')}\n마지막 응답: ${state.lastNotFound || state.lastTransient || '알 수 없음'}${hint}`
  );
}

async function handleTransform(sourceText) {
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

  try {
    const result = await generate(buildPrompt(used), apiKey);
    return {
      ok: true,
      text: result.text,
      truncatedFrom,
      model: result.model,
      switchedForLoad: result.switchedForLoad
    };
  } catch (err) {
    console.error('[acc-reader]', err);
    return { ok: false, error: err.message || 'AI 변환 처리 중 오류가 발생했습니다.' };
  }
}

// 콘텐트 스크립트의 fetch는 페이지의 CSP(connect-src)를 따르기 때문에
// CSP가 엄격한 사이트에서 차단된다. API 호출은 여기서 대신 수행한다.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'callGemini') {
    handleTransform(request.text).then(sendResponse);
    return true;
  }
});