import os

files = {
    "manifest.json": """{
  "manifest_version": 3,
  "name": "쉬운 글 & 가독성 AI 리더",
  "version": "2.2",
  "description": "드래그 선택/우클릭 변환, Gemini AI 기반 쉬운 언어 변환, 전문용어 사전 및 클릭 위치 TTS 음성 읽기",
  "permissions": ["activeTab", "scripting", "storage", "contextMenus"],
  "host_permissions": ["https://generativelanguage.googleapis.com/*"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"]
    }
  ],
  "action": {
    "default_popup": "popup.html"
  }
}""",

    "background.js": """const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CANDIDATES = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];
const MAX_INPUT_CHARS = 8000;

// 서버 혼잡/일시 장애. 재시도하면 대개 풀린다.
const TRANSIENT_STATUS = [429, 500, 502, 503, 504];
// 총 3회 시도. 서비스 워커가 유휴 상태로 종료되지 않도록 대기 시간은 짧게 유지한다.
const RETRY_DELAYS_MS = [1200, 3500];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "transformSelectionMenu",
    title: "쉬운 글로 변환 (선택 영역)",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "transformSelectionMenu" && tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, {
      action: "transformFromContextMenu",
      text: info.selectionText
    });
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
    return `${text}\\n\\n(안내: 응답이 길이 제한에 걸려 도중에 끊겼습니다.)`;
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
    ? `\\n\\n이 API Key로 사용 가능한 모델:\\n${usable.slice(0, 15).join('\\n')}`
    : '';
  throw new Error(
    `사용 가능한 모델을 찾지 못했습니다.\\n시도한 모델: ${order.join(', ')}\\n마지막 응답: ${lastNotFound || '알 수 없음'}${hint}`
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
});""",

    "popup.html": """<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      width: 310px;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f9fafb;
      margin: 0;
      color: #111827;
    }
    h3 {
      margin-top: 0;
      margin-bottom: 12px;
      font-size: 16px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section {
      margin-bottom: 12px;
    }
    label {
      font-size: 12px;
      font-weight: bold;
      color: #374151;
      display: block;
      margin-bottom: 4px;
    }
    input[type="password"] {
      width: 100%;
      padding: 8px 10px;
      box-sizing: border-box;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 12px;
      outline: none;
    }
    input[type="password"]:focus {
      border-color: #2563eb;
    }
    button {
      width: 100%;
      padding: 10px;
      margin-top: 6px;
      cursor: pointer;
      border-radius: 6px;
      border: none;
      font-weight: bold;
      font-size: 13px;
      transition: background-color 0.2s;
    }
    .btn-primary {
      background: #2563eb;
      color: white;
    }
    .btn-primary:hover {
      background: #1d4ed8;
    }
    .btn-secondary {
      background: #e5e7eb;
      color: #1f2937;
    }
    .btn-secondary:hover {
      background: #d1d5db;
    }
    .info-box {
      font-size: 11px;
      color: #6b7280;
      background: #f3f4f6;
      padding: 8px 10px;
      border-radius: 6px;
      margin-top: 8px;
      line-height: 1.4;
    }
    #status {
      font-size: 12px;
      color: #2563eb;
      margin-top: 8px;
      text-align: center;
      font-weight: 600;
      word-break: keep-all;
    }
  </style>
</head>
<body>
  <h3>접근성 AI 리더 v2.2</h3>
  
  <div class="section">
    <label for="apiKey">Gemini API Key</label>
    <input type="password" id="apiKey" placeholder="AIzaSy... 키를 입력하세요">
    <button id="saveKeyBtn" class="btn-secondary">키 저장하기</button>
  </div>

  <div class="section">
    <button id="transformBtn" class="btn-primary">쉬운 글로 변환 (선택/전체)</button>
  </div>

  <div class="info-box">
    - 글 드래그 시 뜨는 버튼 또는 우클릭 메뉴로 변환 가능합니다.<br>
    - 모달 열림 상태 단축키: Ctrl+A (전체 재생), Ctrl+S (정지)
  </div>

  <div id="status"></div>

  <script src="popup.js"></script>
</body>
</html>""",

    "popup.js": """document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get('geminiApiKey');
  if (data.geminiApiKey) {
    document.getElementById('apiKey').value = data.geminiApiKey;
    showStatus('API Key가 준비되었습니다.');
  }
});

document.getElementById('saveKeyBtn').addEventListener('click', async () => {
  const key = document.getElementById('apiKey').value.trim();
  if (!key) {
    showStatus('API Key를 입력해주세요.');
    return;
  }
  await chrome.storage.local.set({ geminiApiKey: key });
  showStatus('API Key가 저장되었습니다.');
});

document.getElementById('transformBtn').addEventListener('click', async () => {
  const keyInput = document.getElementById('apiKey').value.trim();
  if (!keyInput) {
    alert('Gemini API Key를 먼저 입력하고 저장해주세요.');
    return;
  }

  showStatus('웹페이지 글 읽는 중...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.tabs.sendMessage(tab.id, { action: "triggerTransform" });
  window.close();
});

function showStatus(msg) {
  document.getElementById('status').innerText = msg;
}""",

    "content.js": """(function () {
  if (window.__accReaderInjected) return;
  window.__accReaderInjected = true;

  let currentUtterance = null;
  let clickToReadEnabled = true;
  let ttsSeq = 0;
  let ttsWatchdog = null;
  let requestSeq = 0;

  const style = document.createElement('style');
  style.id = 'acc-style';
  style.innerHTML = `
    #acc-reader-overlay {
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      background-color: rgba(0, 0, 0, 0.75);
      z-index: 2147483647;
      display: none;
      justify-content: center; align-items: center;
      backdrop-filter: blur(4px);
      box-sizing: border-box;
    }

    #acc-reader-modal {
      background: #ffffff;
      width: 85%; max-width: 820px; max-height: 85vh;
      padding: 32px; border-radius: 16px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
      overflow-y: auto; position: relative;
      font-family: -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo", sans-serif;
      box-sizing: border-box;
    }

    #acc-reader-header {
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 2px solid #f3f4f6; padding-bottom: 14px; margin-bottom: 16px;
    }

    #acc-reader-modal-title {
      margin: 0; font-size: 1.35rem; color: #111827; font-weight: 700;
    }

    #acc-reader-badge {
      font-size: 0.8rem; background: #eff6ff; color: #1d4ed8;
      padding: 4px 8px; border-radius: 6px; font-weight: 600; margin-left: 8px;
    }

    #acc-tts-toolbar {
      display: flex; align-items: center; gap: 8px;
      background: #f8fafc; border: 1px solid #e2e8f0;
      padding: 10px 14px; border-radius: 10px; margin-bottom: 20px;
    }

    .acc-tts-btn {
      background: #ffffff; border: 1px solid #cbd5e1;
      padding: 6px 12px; border-radius: 6px;
      font-size: 0.88rem; font-weight: 600; cursor: pointer;
      color: #334155; display: flex; align-items: center; gap: 4px;
      transition: all 0.15s ease;
    }

    .acc-tts-btn:hover { background: #f1f5f9; color: #0f172a; }
    .acc-tts-btn.active { background: #2563eb; color: #ffffff; border-color: #2563eb; }

    #acc-reader-content-area {
      font-size: 1.3rem; line-height: 1.95; color: #1f2937;
      word-break: keep-all;
    }

    .acc-read-block {
      padding: 3px 6px;
      border-radius: 4px;
      margin-bottom: 4px;
      min-height: 1.2em;
      transition: background-color 0.15s ease;
      white-space: pre-wrap;
    }

    .acc-read-block.clickable {
      cursor: pointer;
    }

    .acc-read-block.clickable:hover {
      background-color: #e0f2fe;
    }

    #acc-truncate-notice {
      background: #fffbeb;
      border: 1px solid #fde68a;
      color: #92400e;
      font-size: 0.95rem;
      padding: 10px 14px;
      border-radius: 8px;
      margin-bottom: 16px;
      line-height: 1.5;
    }

    #acc-reader-close-btn {
      position: absolute; top: 20px; right: 24px;
      background: #f3f4f6; border: none;
      width: 36px; height: 36px; border-radius: 50%;
      font-size: 1.2rem; cursor: pointer; color: #4b5563;
      display: flex; align-items: center; justify-content: center;
    }

    #acc-reader-close-btn:hover { background: #e5e7eb; color: #111827; }

    #acc-float-btn {
      position: absolute;
      z-index: 2147483646;
      display: none;
      background: #2563eb;
      color: #ffffff;
      border: none;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: bold;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
      transition: transform 0.15s ease, background-color 0.15s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Pretendard", sans-serif;
    }

    #acc-float-btn:hover {
      background: #1d4ed8;
      transform: translateY(-2px);
    }

    .acc-spinner {
      width: 42px;
      height: 42px;
      border: 4px solid #e5e7eb;
      border-top: 4px solid #2563eb;
      border-radius: 50%;
      animation: acc-spin 1s linear infinite;
      margin: 0 auto;
    }

    @keyframes acc-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const overlayDiv = document.createElement('div');
  overlayDiv.id = 'acc-reader-overlay';
  overlayDiv.innerHTML = `
    <div id="acc-reader-modal">
      <button id="acc-reader-close-btn" title="닫기">✕</button>
      <div id="acc-reader-header">
        <h3 id="acc-reader-modal-title">접근성 AI 리더 <span id="acc-reader-badge">전체 본문</span></h3>
      </div>
      
      <div id="acc-tts-toolbar">
        <span style="font-weight: bold; font-size: 0.88rem; color: #475569; margin-right: 4px;">음성 읽기:</span>
        <button id="acc-tts-play" class="acc-tts-btn">전체 재생 (Ctrl+A)</button>
        <button id="acc-tts-toggle-click" class="acc-tts-btn active">클릭 읽기: ON</button>
        <button id="acc-tts-stop" class="acc-tts-btn">정지 (Ctrl+S)</button>
      </div>

      <div id="acc-reader-content-area"></div>
    </div>
  `;
  document.body.appendChild(overlayDiv);

  const floatBtn = document.createElement('button');
  floatBtn.id = 'acc-float-btn';
  floatBtn.innerText = '쉬운 글로 변환';
  document.body.appendChild(floatBtn);

  function stopTTS() {
    ttsSeq++;
    if (ttsWatchdog) {
      clearInterval(ttsWatchdog);
      ttsWatchdog = null;
    }
    currentUtterance = null;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  // 크롬은 긴 텍스트를 한 번에 넘기면 약 15초 뒤 무음으로 멈춘다.
  // 문장 단위로 잘라 순차 재생하면 이 제한에 걸리지 않는다.
  function splitIntoChunks(text) {
    const MAX_CHUNK = 180;
    const chunks = [];

    text.split('\\n').forEach(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return;

      trimmedLine.split(/(?<=[.!?…])\\s+/).forEach(sentence => {
        let rest = sentence.trim();
        if (!rest) return;

        // 문장 하나가 지나치게 길면 쉼표나 공백에서 한 번 더 나눈다.
        while (rest.length > MAX_CHUNK) {
          let cut = rest.lastIndexOf(',', MAX_CHUNK);
          if (cut < MAX_CHUNK * 0.4) cut = rest.lastIndexOf(' ', MAX_CHUNK);
          if (cut < MAX_CHUNK * 0.4) cut = MAX_CHUNK;
          chunks.push(rest.slice(0, cut + 1).trim());
          rest = rest.slice(cut + 1).trim();
        }
        if (rest) chunks.push(rest);
      });
    });

    return chunks;
  }

  function playTTS(textToRead) {
    if (!('speechSynthesis' in window)) {
      alert('이 브라우저는 음성 합성(TTS) 기능을 지원하지 않습니다.');
      return;
    }

    stopTTS();
    if (!textToRead || !textToRead.trim()) return;

    const cleanText = textToRead.replace(/[#*`_~]/g, '');
    const chunks = splitIntoChunks(cleanText);
    if (!chunks.length) return;

    // stopTTS()가 올린 값을 기준으로 삼는다. 이후 정지되면 세대가 어긋나 체인이 멈춘다.
    const mySeq = ttsSeq;
    let idx = 0;

    // 크롬이 재생 도중 스스로 일시정지 상태에 빠지는 경우가 있어 주기적으로 깨운다.
    ttsWatchdog = setInterval(() => {
      if (mySeq !== ttsSeq) return;
      if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }, 5000);

    const speakNext = () => {
      if (mySeq !== ttsSeq) return;
      if (idx >= chunks.length) {
        stopTTS();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[idx++]);
      utterance.lang = 'ko-KR';
      utterance.rate = 0.95;
      utterance.onend = speakNext;
      utterance.onerror = () => {
        if (mySeq !== ttsSeq) return;
        stopTTS();
      };

      currentUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    };

    speakNext();
  }

  function playAllText() {
    const allBlocks = Array.from(document.querySelectorAll('.acc-read-block'));
    const fullText = allBlocks.map(b => b.innerText).join('\\n');
    if (fullText.trim()) {
      playTTS(fullText);
    }
  }

  function updateClickToReadStyles() {
    const blocks = document.querySelectorAll('.acc-read-block');
    const toggleBtn = document.getElementById('acc-tts-toggle-click');
    if (clickToReadEnabled) {
      if (toggleBtn) {
        toggleBtn.innerText = '클릭 읽기: ON';
        toggleBtn.classList.add('active');
      }
      blocks.forEach(b => b.classList.add('clickable'));
    } else {
      if (toggleBtn) {
        toggleBtn.innerText = '클릭 읽기: OFF';
        toggleBtn.classList.remove('active');
      }
      blocks.forEach(b => b.classList.remove('clickable'));
    }
  }

  function showLoadingOverlay(isSelection) {
    stopTTS();
    const overlay = document.getElementById('acc-reader-overlay');
    const badge = document.getElementById('acc-reader-badge');
    const contentArea = document.getElementById('acc-reader-content-area');
    const toolbar = document.getElementById('acc-tts-toolbar');

    badge.innerText = isSelection ? '선택 분석 중' : '전체 분석 중';
    if (toolbar) toolbar.style.display = 'none';

    contentArea.innerHTML = `
      <div style="text-align: center; padding: 48px 20px;">
        <div class="acc-spinner"></div>
        <p style="margin-top: 20px; font-size: 1.15rem; color: #1e293b; font-weight: 700;">
          AI가 글을 쉬운 말로 분석 중입니다
        </p>
        <p style="font-size: 0.9rem; color: #64748b; margin-top: 8px;">
          잠시만 기다려 주세요. 오른쪽 상단 ✕ 버튼을 누르면 취소됩니다.
        </p>
      </div>
    `;
    overlay.style.display = 'flex';
  }

  function renderOverlayContent(rawText, isSelection, truncatedFrom) {
    stopTTS();
    const overlay = document.getElementById('acc-reader-overlay');
    const badge = document.getElementById('acc-reader-badge');
    const contentArea = document.getElementById('acc-reader-content-area');
    const toolbar = document.getElementById('acc-tts-toolbar');

    if (toolbar) toolbar.style.display = 'flex';
    badge.innerText = isSelection ? '선택 문단' : '전체 본문';
    contentArea.innerHTML = '';

    if (truncatedFrom) {
      const notice = document.createElement('div');
      notice.id = 'acc-truncate-notice';
      notice.innerText = `원문이 길어 앞부분 ${truncatedFrom.used}자만 변환했습니다. (전체 ${truncatedFrom.total}자)`;
      contentArea.appendChild(notice);
    }

    const lines = rawText.split('\\n');
    lines.forEach((line, idx) => {
      const block = document.createElement('div');
      block.className = 'acc-read-block';
      block.dataset.index = idx;
      block.innerText = line.length === 0 ? ' ' : line;
      contentArea.appendChild(block);
    });

    updateClickToReadStyles();
    overlay.style.display = 'flex';
  }

  document.getElementById('acc-tts-play').addEventListener('click', playAllText);

  document.getElementById('acc-tts-toggle-click').addEventListener('click', () => {
    clickToReadEnabled = !clickToReadEnabled;
    updateClickToReadStyles();
  });

  document.getElementById('acc-tts-stop').addEventListener('click', stopTTS);

  document.getElementById('acc-reader-content-area').addEventListener('click', (e) => {
    if (!clickToReadEnabled) return;
    const targetBlock = e.target.closest('.acc-read-block');
    if (!targetBlock) return;

    const targetIdx = parseInt(targetBlock.dataset.index, 10);
    const allBlocks = Array.from(document.querySelectorAll('.acc-read-block'));
    const textParts = allBlocks.slice(targetIdx).map(b => b.innerText);
    const textToRead = textParts.join('\\n');
    
    playTTS(textToRead);
  });

  function closeModal() {
    // 진행 중인 요청의 결과가 뒤늦게 도착해 모달을 되살리지 못하게 한다.
    requestSeq++;
    stopTTS();
    document.getElementById('acc-reader-overlay').style.display = 'none';
  }

  document.getElementById('acc-reader-close-btn').addEventListener('click', closeModal);

  window.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('acc-reader-overlay');
    const isOverlayVisible = overlay && overlay.style.display === 'flex';

    if (!isOverlayVisible) return;

    if (e.key === 'Escape') {
      closeModal();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      playAllText();
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      stopTTS();
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (floatBtn.contains(e.target) || document.getElementById('acc-reader-overlay')?.contains(e.target)) {
      return;
    }
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    if (selectedText.length > 3) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      floatBtn.style.top = `${window.scrollY + rect.bottom + 8}px`;
      floatBtn.style.left = `${window.scrollX + Math.max(10, rect.left)}px`;
      floatBtn.style.display = 'block';
      floatBtn.dataset.selectedText = selectedText;
    } else {
      floatBtn.style.display = 'none';
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!floatBtn.contains(e.target)) {
      floatBtn.style.display = 'none';
    }
  });

  floatBtn.addEventListener('click', () => {
    const text = floatBtn.dataset.selectedText;
    floatBtn.style.display = 'none';
    if (text) {
      runGeminiTransform(text, true);
    }
  });

  // API 호출은 background에서 수행한다. 콘텐트 스크립트의 fetch는
  // 페이지의 CSP(connect-src)를 따르기 때문에 엄격한 사이트에서 차단된다.
  async function runGeminiTransform(textToTransform, isSelection) {
    const mySeq = ++requestSeq;
    showLoadingOverlay(isSelection);

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        action: 'callGemini',
        text: textToTransform
      });
    } catch (err) {
      if (mySeq !== requestSeq) return;
      closeModal();
      console.error(err);
      alert('확장 프로그램 백그라운드와 통신하지 못했습니다. chrome://extensions 에서 확장 프로그램을 새로고침한 뒤 다시 시도해 주세요.');
      return;
    }

    // 로딩 중 모달을 닫았거나 새 요청이 시작되었으면 이 결과는 버린다.
    if (mySeq !== requestSeq) return;

    if (!result || !result.ok) {
      closeModal();
      alert((result && result.error) || 'AI 변환 처리 중 오류가 발생했습니다.');
      return;
    }

    renderOverlayContent(result.text, isSelection, result.truncatedFrom);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "transformFromContextMenu") {
      if (request.text) {
        runGeminiTransform(request.text, true);
      }
    }

    if (request.action === "triggerTransform") {
      const selectedText = window.getSelection().toString().trim();
      if (selectedText.length > 5) {
        runGeminiTransform(selectedText, true);
      } else {
        const target = document.querySelector('article, main, .content, #content') || document.body;
        runGeminiTransform(target.innerText.trim(), false);
      }
    }
    return true;
  });
})();"""
}

for filename, content in files.items():
    with open(filename, "w", encoding="utf-8") as f:
        f.write(content.strip())
    print(f"[OK] v2.2 {filename} write complete")

print("\n[DONE] All files written successfully.")