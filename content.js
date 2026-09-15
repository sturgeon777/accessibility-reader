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
  let loadingHintTimer = null;
  let glossary = new Map();

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

    .acc-term {
      color: #1d4ed8;
      border-bottom: 2px dotted #2563eb;
      cursor: pointer;
      padding: 0 1px;
    }

    .acc-term:hover { background-color: #dbeafe; }

    #acc-term-popover {
      position: absolute;
      z-index: 10;
      max-width: 320px;
      background: #1e293b;
      color: #f8fafc;
      font-size: 0.95rem;
      line-height: 1.55;
      padding: 10px 14px;
      border-radius: 8px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
      word-break: keep-all;
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

    #acc-model-tag {
      font-size: 0.72rem; color: #64748b; font-weight: 500;
      margin-left: 8px; letter-spacing: 0.01em;
    }

    #acc-model-notice {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e40af;
      font-size: 0.92rem;
      padding: 9px 14px;
      border-radius: 8px;
      margin-bottom: 14px;
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
        <h3 id="acc-reader-modal-title">접근성 AI 리더 <span id="acc-reader-badge">전체 본문</span><span id="acc-model-tag"></span></h3>
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
    const fullText = allBlocks.map(b => b.dataset.text || b.innerText).join('\n');
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

  // AI 응답의 '어려운 용어 사전' 부분에서 단어와 뜻을 뽑아낸다.
  // 형식: '• 단어: 쉬운 뜻풀이'
  function parseGlossary(lines) {
    const map = new Map();
    lines.forEach(raw => {
      const line = raw.trim();
      if (!line) return;
      const body = line.replace(/^[•·*-]+/, '').trim();
      const sep = body.search(/[:：]/);
      if (sep < 1) return;
      const word = body.slice(0, sep).trim();
      const meaning = body.slice(sep + 1).trim();
      if (word.length >= 2 && word.length <= 20 && meaning) map.set(word, meaning);
    });
    return map;
  }

  // 본문에서 사전에 있는 단어를 찾아 누를 수 있게 감싼다.
  // innerHTML 대신 노드를 직접 만들어 붙인다. AI 응답을 그대로 HTML로
  // 해석하면 안 되기 때문이다.
  function appendWithTerms(block, text, terms) {
    let buffer = '';
    const flush = () => {
      if (buffer) {
        block.appendChild(document.createTextNode(buffer));
        buffer = '';
      }
    };

    let i = 0;
    while (i < text.length) {
      const hit = terms.find(word => text.startsWith(word, i));
      if (hit) {
        flush();
        const span = document.createElement('span');
        span.className = 'acc-term';
        span.textContent = hit;
        span.dataset.term = hit;
        block.appendChild(span);
        i += hit.length;
      } else {
        buffer += text[i];
        i += 1;
      }
    }
    flush();
  }

  function hideTermPopover() {
    const old = document.getElementById('acc-term-popover');
    if (old) old.remove();
  }

  function showTermPopover(termEl) {
    hideTermPopover();
    const meaning = glossary.get(termEl.dataset.term);
    if (!meaning) return;

    const modal = document.getElementById('acc-reader-modal');
    const pop = document.createElement('div');
    pop.id = 'acc-term-popover';
    pop.innerText = `${termEl.dataset.term}: ${meaning}`;
    modal.appendChild(pop);

    const mr = modal.getBoundingClientRect();
    const er = termEl.getBoundingClientRect();
    pop.style.left = `${Math.max(8, er.left - mr.left)}px`;
    pop.style.top = `${er.bottom - mr.top + modal.scrollTop + 6}px`;
  }

  function showLoadingOverlay(isSelection) {
    stopTTS();
    const overlay = document.getElementById('acc-reader-overlay');
    const badge = document.getElementById('acc-reader-badge');
    const contentArea = document.getElementById('acc-reader-content-area');
    const toolbar = document.getElementById('acc-tts-toolbar');

    badge.innerText = isSelection ? '선택 분석 중' : '전체 분석 중';
    const modelTag = document.getElementById('acc-model-tag');
    if (modelTag) modelTag.innerText = '';
    if (toolbar) toolbar.style.display = 'none';

    contentArea.innerHTML = `
      <div style="text-align: center; padding: 48px 20px;">
        <div class="acc-spinner"></div>
        <p style="margin-top: 20px; font-size: 1.15rem; color: #1e293b; font-weight: 700;">
          AI가 글을 쉬운 말로 분석 중입니다
        </p>
        <p id="acc-loading-sub" style="font-size: 0.9rem; color: #64748b; margin-top: 8px;">
          잠시만 기다려 주세요. 오른쪽 상단 ✕ 버튼을 누르면 취소됩니다.
        </p>
      </div>
    `;
    overlay.style.display = 'flex';

    // 좋은 모델은 긴 글을 다시 쓰는 데 1분이 넘기도 한다. 멈춘 것으로 오해하지 않게 알린다.
    clearTimeout(loadingHintTimer);
    loadingHintTimer = setTimeout(() => {
      const sub = document.getElementById('acc-loading-sub');
      if (sub) sub.innerText = '긴 글은 쉽게 다시 쓰는 데 1~2분까지 걸릴 수 있습니다. 오른쪽 상단 ✕ 버튼을 누르면 취소됩니다.';
    }, 15000);
  }

  function renderOverlayContent(rawText, isSelection, truncatedFrom, modelInfo) {
    stopTTS();
    const overlay = document.getElementById('acc-reader-overlay');
    const badge = document.getElementById('acc-reader-badge');
    const contentArea = document.getElementById('acc-reader-content-area');
    const toolbar = document.getElementById('acc-tts-toolbar');

    hideTermPopover();
    clearTimeout(loadingHintTimer);
    if (toolbar) toolbar.style.display = 'flex';
    badge.innerText = isSelection ? '선택 문단' : '전체 본문';
    contentArea.innerHTML = '';

    const modelTag = document.getElementById('acc-model-tag');
    if (modelTag) {
      const parts = modelInfo ? [modelInfo.model, modelInfo.promptLabel] : [];
      modelTag.innerText = parts.filter(Boolean).join(' · ');
    }

    // 기본 모델이 아닌 모델이 답한 경우, 조용히 바뀌지 않도록 이유와 함께 알린다.
    if (modelInfo && modelInfo.notice) {
      const switched = document.createElement('div');
      switched.id = 'acc-model-notice';
      switched.innerText = modelInfo.notice;
      contentArea.appendChild(switched);
    }

    if (truncatedFrom) {
      const notice = document.createElement('div');
      notice.id = 'acc-truncate-notice';
      notice.innerText = `원문이 길어 앞부분 ${truncatedFrom.used}자만 변환했습니다. (전체 ${truncatedFrom.total}자)`;
      contentArea.appendChild(notice);
    }

    const lines = rawText.split('\n');

    // '어려운 용어 사전'이 시작되는 줄. 그 아래는 사전 자체이므로 용어 표시를 하지 않는다.
    let glossaryStart = lines.findIndex(l => l.includes('용어 사전'));
    if (glossaryStart < 0) glossaryStart = lines.length;

    glossary = parseGlossary(lines.slice(glossaryStart + 1));
    // 긴 단어를 먼저 찾아야 짧은 단어에 가려지지 않는다.
    const terms = [...glossary.keys()].sort((a, b) => b.length - a.length);

    lines.forEach((line, idx) => {
      const block = document.createElement('div');
      block.className = 'acc-read-block';
      block.dataset.index = idx;
      // 음성으로 읽을 원문. 화면에는 뜻풀이가 끼어들 수 있으므로 따로 보관한다.
      block.dataset.text = line;

      if (line.length === 0) {
        block.innerText = ' ';
      } else if (idx < glossaryStart && terms.length) {
        appendWithTerms(block, line, terms);
      } else {
        block.innerText = line;
      }
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
    const termEl = e.target.closest('.acc-term');
    if (termEl) {
      // 뜻만 띄우고 음성 재생으로 넘어가지 않게 막는다.
      e.stopPropagation();
      showTermPopover(termEl);
      return;
    }
    hideTermPopover();

    if (!clickToReadEnabled) return;
    const targetBlock = e.target.closest('.acc-read-block');
    if (!targetBlock) return;

    const targetIdx = parseInt(targetBlock.dataset.index, 10);
    const allBlocks = Array.from(document.querySelectorAll('.acc-read-block'));
    const textParts = allBlocks.slice(targetIdx).map(b => b.dataset.text || b.innerText);
    const textToRead = textParts.join('\n');
    
    playTTS(textToRead);
  });

  function closeModal() {
    hideTermPopover();
    clearTimeout(loadingHintTimer);
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

    renderOverlayContent(result.text, isSelection, result.truncatedFrom, {
      model: result.model,
      switchedForLoad: result.switchedForLoad,
      notice: result.notice,
      promptLabel: result.promptLabel
    });
  }

  // 붙여넣기 페이지(reader.html)에서 변환을 시작하는 입구.
  // 일반 웹페이지에서는 콘텐트 스크립트가 격리된 공간에서 돌기 때문에
  // 페이지의 스크립트가 이 함수에 접근할 수 없다.
  window.__accReaderTransform = (text) => runGeminiTransform(text, true);

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