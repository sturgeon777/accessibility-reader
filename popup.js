document.addEventListener('DOMContentLoaded', async () => {
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

// 확장 프로그램을 다시 불러온 뒤 새로고침하지 않은 탭에는 콘텐트 스크립트가 없다.
// 그 상태로 메시지를 보내면 받는 쪽이 없어 조용히 실패하므로, 직접 주입한 뒤 다시 시도한다.
async function sendTrigger(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "triggerTransform" });
    return true;
  } catch (err) {
    return false;
  }
}

document.getElementById('transformBtn').addEventListener('click', async () => {
  const keyInput = document.getElementById('apiKey').value.trim();
  if (!keyInput) {
    alert('Gemini API Key를 먼저 입력하고 저장해주세요.');
    return;
  }

  showStatus('웹페이지 글 읽는 중...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    showStatus('현재 탭을 찾지 못했습니다.');
    return;
  }

  const url = tab.url || '';
  if (!/^(https?|file):/.test(url)) {
    showStatus('이 페이지에서는 사용할 수 없습니다. 일반 웹페이지에서 시도해 주세요.');
    return;
  }

  if (await sendTrigger(tab.id)) {
    window.close();
    return;
  }

  showStatus('페이지에 연결하는 중...');
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    showStatus('이 페이지에는 접근할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.');
    return;
  }

  if (await sendTrigger(tab.id)) {
    window.close();
  } else {
    showStatus('페이지를 새로고침한 뒤 다시 시도해 주세요.');
  }
});

function showStatus(msg) {
  document.getElementById('status').innerText = msg;
}