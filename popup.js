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
}