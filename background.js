const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CANDIDATES = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];
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
  return `당신은 웹 접근성 보조 전문 AI입니다. 아래 제공된 [원문]을 분석하여 다음 3가지 항목으로 구성된 쉬운 언어 보고서를 작성해 주세요.

1. [3줄 핵심 요약]
- 전체 내용의 핵심을 초등학생도 이해할 수 있는 쉬운 문장 3개로 요약합니다.

2. [쉬운 말 변환 본문]
- 어려운 한자어, 격식체, 복잡한 문장 구조, 법률/기술 전문 용어를 일상적인 쉬운 언어로 풀어 써 주세요.
- 문장은 짧게 나누고 가독성이 뛰어나게 작성합니다.

3. [어려운 용어 사전]
- 원문에 포함된 어려운 단어, 한자어, 전문 용어를 3~5개 선별하고 각 단어의 쉬운 뜻풀이를 작성해 주세요.
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

// 성공한 모델 id를 저장해 두었다가 다음 요청에서 먼저 시도한다.
async function generate(prompt, apiKey) {
  const cached = (await chrome.storage.local.get('geminiModel')).geminiModel;
  const order = cached
    ? [cached, ...MODEL_CANDIDATES.filter(m => m !== cached)]
    : [...MODEL_CANDIDATES];

  let lastNotFound = null;

  for (const model of order) {
    const { res, json } = await callModelWithRetry(model, apiKey, prompt);

    if (!res.ok) {
      if (isModelNotFound(res, json)) {
        lastNotFound = (json.error && json.error.message) || `HTTP ${res.status}`;
        continue;
      }
      if (TRANSIENT_STATUS.includes(res.status)) {
        throw new Error(
          `Gemini 서버가 일시적으로 혼잡합니다 (HTTP ${res.status}).
` +
          `${RETRY_DELAYS_MS.length + 1}회 시도했지만 실패했습니다. 잠시 후 다시 시도해 주세요.`
        );
      }
      const detail = (json.error && json.error.message) || '(응답 본문 없음)';
      throw new Error(`API 오류 (HTTP ${res.status}): ${detail}`);
    }

    if (model !== cached) {
      await chrome.storage.local.set({ geminiModel: model });
    }
    console.log('[acc-reader] 사용 모델:', model);
    return extractText(json);
  }

  // 후보가 모두 실패했다면 실제로 쓸 수 있는 모델 목록을 뽑아 알려준다.
  await chrome.storage.local.remove('geminiModel');
  const usable = await listUsableModels(apiKey);
  const hint = usable.length
    ? `\n\n이 API Key로 사용 가능한 모델:\n${usable.slice(0, 15).join('\n')}`
    : '';
  throw new Error(
    `사용 가능한 모델을 찾지 못했습니다.\n시도한 모델: ${order.join(', ')}\n마지막 응답: ${lastNotFound || '알 수 없음'}${hint}`
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
    return { ok: true, text: result, truncatedFrom };
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