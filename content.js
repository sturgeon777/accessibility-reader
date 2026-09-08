(function () {
  if (window.__accReaderInjected) return;
  window.__accReaderInjected = true;

  let currentUtterance = null;
  let clickToReadEnabled = true;

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
  document.head.appendChild(style);

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
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  function playTTS(textToRead) {
    if (!('speechSynthesis' in window)) {
      alert('이 브라우저는 음성 합성(TTS) 기능을 지원하지 않습니다.');
      return;
    }

    stopTTS();
    if (!textToRead || !textToRead.trim()) return;

    const cleanText = textToRead.replace(/[#*`_~]/g, '');
    currentUtterance = new SpeechSynthesisUtterance(cleanText);
    currentUtterance.lang = 'ko-KR';
    currentUtterance.rate = 0.95;

    currentUtterance.onend = () => stopTTS();
    currentUtterance.onerror = () => stopTTS();

    window.speechSynthesis.speak(currentUtterance);
  }

  function playAllText() {
    const allBlocks = Array.from(document.querySelectorAll('.acc-read-block'));
    const fullText = allBlocks.map(b => b.innerText).join('\n');
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

  function renderOverlayContent(rawText, isSelection) {
    stopTTS();
    const overlay = document.getElementById('acc-reader-overlay');
    const badge = document.getElementById('acc-reader-badge');
    const contentArea = document.getElementById('acc-reader-content-area');
    const toolbar = document.getElementById('acc-tts-toolbar');

    if (toolbar) toolbar.style.display = 'flex';
    badge.innerText = isSelection ? '선택 문단' : '전체 본문';
    contentArea.innerHTML = '';

    const lines = rawText.split('\n');
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
    const textToRead = textParts.join('\n');
    
    playTTS(textToRead);
  });

  function closeModal() {
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

  async function runGeminiTransform(textToTransform, isSelection) {
    const storageData = await chrome.storage.local.get('geminiApiKey');
    const apiKey = storageData.geminiApiKey;
    if (!apiKey) {
      alert('Gemini API Key가 설정되지 않았습니다. 확장 프로그램 팝업 창에서 API Key를 입력 후 저장해 주세요.');
      return;
    }

    showLoadingOverlay(isSelection);

    try {
      const prompt = `당신은 웹 접근성 보조 전문 AI입니다. 아래 제공된 [원문]을 분석하여 다음 3가지 항목으로 구성된 쉬운 언어 보고서를 작성해 주세요.

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
${textToTransform.slice(0, 3500)}`;

      const apiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      const resJson = await apiRes.json();

      if (resJson.error) {
        closeModal();
        alert(`API 오류: ${resJson.error.message}`);
        return;
      }

      const aiResponse = resJson.candidates[0].content.parts[0].text;
      renderOverlayContent(aiResponse, isSelection);

    } catch (err) {
      closeModal();
      console.error(err);
      alert('AI 변환 처리 중 오류가 발생했습니다.');
    }
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
})();