(function () {
  const ACC_IDS = ['acc-style', 'acc-reader-overlay', 'acc-float-btn'];

  function removeAccNodes() {
    ACC_IDS.forEach(id => {
      const stale = document.getElementById(id);
      if (stale) stale.remove();
    });
  }

  // 확장 프로그램을 다시 불러오면 이전 콘텐트 스크립트가 페이지에 남는다.
  // 새로 주입될 때 이전 흔적을 먼저 걷어내야 UI와 리스너가 중복되지 않는다.
  if (typeof window.__accReaderCleanup === 'function') {
    try {
      window.__accReaderCleanup();
    } catch (err) {
      // 이전 컨텍스트가 이미 무효화된 경우. 아래에서 DOM만 정리한다.
    }
  }
  removeAccNodes();
  window.__accReaderInjected = true;

  // 이 인스턴스가 페이지에 붙인 리스너를 한 번에 떼어내기 위한 신호
  const listenerScope = new AbortController();
  const scoped = { signal: listenerScope.signal };

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

  // 다음 주입 때 이 인스턴스를 깨끗이 걷어낼 수 있도록 등록해 둔다.
  window.__accReaderCleanup = () => {
    listenerScope.abort();
    stopTTS();
    removeAccNodes();
  };

  // 크롬은 긴 텍스트를 한 번에 넘기면 약 15초 뒤 무음으로 멈춘다.
  // 문장 단위로 잘라 순차 재생하면 이 제한에 걸리지 않는다.
  function splitIntoChunks(text) {
    const MAX_CHUNK = 180;
    const chunks = [];

    text.split('\n').forEach(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return;

      trimmedLine.split(/(?<=[.!?…])\s+/).forEach(sentence => {
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
  }, scoped);

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
  }, scoped);

  document.addEventListener('mousedown', (e) => {
    if (!floatBtn.contains(e.target)) {
      floatBtn.style.display = 'none';
    }
  }, scoped);

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
})();