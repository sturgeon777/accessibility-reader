const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// 1순위 후보. 여기서 모두 실패하면 API에 실제 사용 가능한 목록을 물어본다.
const MODEL_CANDIDATES = ['gemini-3.6-flash', 'gemini-2.5-flash'];
// 목록에서 추가로 시도해 볼 모델 수. 너무 많으면 사용자가 오래 기다린다.
// 목록에는 폐기된 구버전이 남아 있기도 하므로 여유 있게 훑는다.
// 이 단계는 재시도 없이 한 번씩만 부르고, 전체 시간 제한이 따로 있어 안전하다.
const MAX_DISCOVERED_TRIES = 5;
const MAX_INPUT_CHARS = 8000;

// 서버 혼잡/일시 장애. 재시도하면 대개 풀린다.
const TRANSIENT_STATUS = [429, 500, 502, 503, 504];
// 모델당 2회 시도. 호출 하나가 수 초씩 걸리므로 재시도를 늘리면 전체가 너무 길어진다.
const RETRY_DELAYS_MS = [1500];
// 요청 하나에 쓸 수 있는 전체 시간. 넘으면 중단하고 사용자에게 알린다.
const REQUEST_DEADLINE_MS = 70000;
// 호출 하나가 응답 없이 매달려 예산을 다 먹는 것을 막는다.
const SINGLE_CALL_TIMEOUT_MS = 30000;

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
  // 아래 규칙의 뼈대는 독일의 'Leichte Sprache'(쉬운 언어) 규칙집이다.
  // (Netzwerk Leichte Sprache, 2006년 설립 / 2022 개정판)
  //
  // 이 확장의 착안 계기인 Deutschlandfunk의 Nachrichtenleicht는 한 단계 덜
  // 단순화된 'Einfache Sprache'(간단한 언어)로 기사를 쓴다. 다만 Einfache
  // Sprache는 명확한 규칙집 없이 대략적인 지침만 있어, AI에게 줄 지시로는
  // 규칙이 문서로 정리되어 있는 Leichte Sprache 쪽을 기준으로 삼았다.
  // 독일어 전용 규칙(복합어 하이픈 분리, 속격/접속법 회피)은 제외했다.
  //
  // 대상은 약관과 동의서를 마주하는 초등학생이다. 개인정보 보호법 제22조의2는
  // 만 14세 미만 아동에게 개인정보 관련 사항을 알릴 때 알기 쉬운 언어를 쓰도록
  // 정하고 있다. 그 위에 초등학생을 위한 규칙을 더했다.
  //
  // 약관에 되풀이해 나오는 중요한 낱말은 쉬운 말로 바꾸지 않고 남긴다. 다음 약관에서
  // 같은 낱말을 또 만나기 때문이다. 그 뜻은 본문에서 풀지 않고 사전에 넣어, 화면에서
  // 낱말을 누르면 뜨게 한다(content.js). 사전의 낱말이 본문에 쓴 모양과 같아야
  // 화면에서 찾아 밑줄을 그을 수 있으므로 조사를 떼고 적게 한다.
  return `당신은 독일의 '쉬운 언어'(Leichte Sprache) 원칙에 따라 글을 다시 쓰는 전문가입니다.
아래 [원문]을 초등학생이 혼자 읽어도 이해할 수 있는 글로 바꾸어 주세요.

[반드시 지킬 작성 규칙]
- 한 문장에는 한 가지 내용만 담습니다.
- 한 문장을 쓴 뒤에는 반드시 줄을 바꿉니다. 한 줄에 두 문장을 쓰지 않습니다.
- 문장을 짧게 씁니다. 한 문장에 서술어는 하나만 씁니다.
- 능동으로 씁니다. '~되어진다', '~하여진다' 같은 피동 표현을 피합니다.
- 초등학교 교과서에 나오는 쉬운 낱말을 씁니다. 어려운 한자어는 쉬운 말로 바꿉니다.
- 다만 약관이나 안내문에서 자주 다시 만나게 될 중요한 낱말(예: 개인정보, 동의, 제3자)은 바꾸지 말고 그대로 씁니다. 원문에 나온 낱말만 해당합니다.
- '다만', '~한 경우에는', '~을 제외하고' 같은 조건과 예외는 절대 빠뜨리지 않습니다. 따로 한 문장으로 떼어 씁니다.
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
- 본문 안에서는 낱말의 뜻을 따로 풀어 설명하지 않습니다. 뜻은 사전에 씁니다.

2. [어려운 용어 사전]
- 본문에 바꾸지 않고 남긴 중요한 낱말을 빠짐없이 모두 넣습니다. 보통 4~8개입니다.
- 낱말은 조사를 떼고, 본문에 쓴 모양 그대로 적습니다. (예: '개인정보를'이 아니라 '개인정보')
- 뜻은 초등학생이 알 수 있는 말로 씁니다. 필요하면 생활 속 예를 하나 들어 설명합니다.
- 형식 예시:
  • 낱말: 쉬운 뜻풀이 설명

---
[원문]:
${sourceText}`;
}

async function callModel(model, apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SINGLE_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  } catch (err) {
    if (err.name === 'AbortError') {
      // 일시적 오류와 같게 다루어 다음 후보로 넘어가게 한다.
      return { res: { ok: false, status: 504 }, json: { error: { message: '응답 시간 초과' } } };
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
    last = await callModel(model, apiKey, prompt);
    if (last.res.ok || !TRANSIENT_STATUS.includes(last.res.status)) {
      return last;
    }
    if (attempt >= RETRY_DELAYS_MS.length) break;
    // 남은 시간이 없으면 대기 없이 곧바로 다시 부르지 말고 여기서 끝낸다.
    // 간격 없는 재호출은 특히 429(할당량)에서 상황을 악화시킨다.
    if (Date.now() + RETRY_DELAYS_MS[attempt] >= deadline) break;
    console.warn(`[acc-reader] ${model} HTTP ${last.res.status} - ${RETRY_DELAYS_MS[attempt]}ms 후 재시도`);
    await sleep(RETRY_DELAYS_MS[attempt]);
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

function pickExtraModels(discovered, alreadyTried, limit) {
  return discovered
    .filter(name => !alreadyTried.has(name))
    .map(name => ({ name, score: rankModel(name), version: modelVersion(name) }))
    .filter(entry => entry.score !== null)
    // 버전을 먼저 본다. 이름에 flash가 들어갔다는 이유로 폐기된 구버전이
    // 앞자리를 차지하면, 정작 살아 있는 최신 모델까지 순서가 오지 않는다.
    .sort((a, b) => (b.version - a.version) || (a.score - b.score))
    .slice(0, limit)
    .map(entry => entry.name);
}

// 성공하면 응답을, 실패하면 null을 돌려주고 실패 사유를 state에 남긴다.
async function tryOneModel(model, apiKey, prompt, state, withRetry) {
  if (Date.now() > state.deadline) {
    state.timedOut = true;
    return null;
  }

  const { res, json } = withRetry
    ? await callModelWithRetry(model, apiKey, prompt, state.deadline)
    : await callModel(model, apiKey, prompt);

  if (res.ok) return json;

  const apiMessage = (json && json.error && json.error.message) || '';

  if (isModelNotFound(res, json)) {
    const reason = apiMessage || `HTTP ${res.status}`;
    state.lastNotFound = reason;
    // 저장해 둔 모델이 사라진 경우에만 캐시를 비운다.
    if (model === state.cached) state.cachedModelMissing = true;
    state.failures.push({ model, reason: `사용 불가 - ${reason}` });
    console.warn(`[acc-reader] ${model} 사용 불가:`, reason);
    return null;
  }
  if (TRANSIENT_STATUS.includes(res.status)) {
    const reason = `HTTP ${res.status}${apiMessage ? ' - ' + apiMessage : ''}`;
    state.lastTransient = `HTTP ${res.status}`;
    state.switchedForLoad = true;
    state.failures.push({ model, reason });
    console.warn(`[acc-reader] ${model} 일시적 실패:`, reason);
    return null;
  }
  const detail = (json.error && json.error.message) || '(응답 본문 없음)';
  throw new Error(`API 오류 (HTTP ${res.status}): ${detail}`);
}

// 성공한 모델 id를 저장해 두었다가 다음 요청에서 먼저 시도한다.
async function generate(prompt, apiKey, deadline) {
  const cached = (await chrome.storage.local.get('geminiModel')).geminiModel;
  const primary = cached
    ? [cached, ...MODEL_CANDIDATES.filter(m => m !== cached)]
    : [...MODEL_CANDIDATES];

  const state = {
    lastNotFound: null,
    lastTransient: null,
    switchedForLoad: false,
    timedOut: false,
    cachedModelMissing: false,
    failures: [],
    cached,
    deadline
  };

  const finish = async (json, model) => {
    // 쓸 수 있는 응답인지 먼저 확인한 뒤에 저장한다.
    const text = extractText(json);
    // 혼잡으로 넘어온 모델은 기본값으로 저장하지 않는다. 잠깐 붐빈 것뿐이므로.
    if (!state.switchedForLoad && model !== cached) {
      await chrome.storage.local.set({ geminiModel: model });
    }
    console.log('[acc-reader] 사용 모델:', model);
    return { text, model, switchedForLoad: state.switchedForLoad };
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

  // 저장해 둔 모델이 실제로 사라졌을 때만 캐시를 비운다.
  // 단순히 붐볐을 뿐인데 지우면 다음 요청이 또 처음부터 탐색하게 된다.
  if (state.cachedModelMissing) {
    await chrome.storage.local.remove('geminiModel');
  }

  if (state.timedOut) {
    throw new Error(
      `시간 안에 변환을 마치지 못했습니다.\n` +
      `Gemini 응답이 너무 느리거나 서버가 붐비는 상태입니다. 더 짧은 문단을 선택해 다시 시도해 보세요.`
    );
  }

  if (state.lastTransient && !state.lastNotFound) {
    throw new Error(
      `Gemini 서버가 혼잡합니다 (${state.lastTransient}).\n` +
      `시도할 수 있는 모델을 모두 시도했지만 실패했습니다. 잠시 후 다시 시도해 주세요.`
    );
  }

  // 모델마다 무엇이 왜 실패했는지 그대로 보여준다.
  // 사유가 하나로 뭉뚱그려지면 원인을 짚을 수 없다.
  const detail = state.failures.length
    ? state.failures
        .map(f => `- ${f.model}: ${String(f.reason).slice(0, 160)}`)
        .join('\n')
    : '- (응답을 받지 못했습니다)';

  const hint = discovered.length
    ? `\n\n이 API Key로 사용 가능한 모델:\n${discovered.slice(0, 15).join(', ')}`
    : `\n\n모델 목록도 가져오지 못했습니다. API Key와 인터넷 연결을 확인해 주세요.`;

  throw new Error(
    `변환에 성공한 모델이 없습니다.\n\n` +
    `${detail}${hint}`
  );
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
      switchedForLoad: result.switchedForLoad
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