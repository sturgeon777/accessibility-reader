// 붙여넣기 전용 페이지.
// 크롬에 내장된 PDF 뷰어 안에서는 콘텐트 스크립트가 돌지 않으므로, 논문 PDF의
// 글은 복사해서 이 페이지에 붙여넣어 변환한다. 화면 표시와 음성 읽기, 용어 뜻보기는
// 같은 페이지에 불러온 content.js를 그대로 쓴다.

const LIMIT = 8000;
const source = document.getElementById('source');
const count = document.getElementById('count');

function updateCount() {
  const length = source.value.trim().length;
  count.innerText = `${length} / ${LIMIT}자`;
  count.classList.toggle('over', length > LIMIT);
}

function convert() {
  const text = source.value.trim();
  if (!text) {
    source.focus();
    return;
  }
  if (typeof window.__accReaderTransform !== 'function') {
    alert('변환 기능을 불러오지 못했습니다. 확장 프로그램을 새로고침한 뒤 다시 열어 주세요.');
    return;
  }
  window.__accReaderTransform(text);
}

source.addEventListener('input', updateCount);
document.getElementById('convert').addEventListener('click', convert);
source.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    convert();
  }
});

// 팝업에서 붙여넣고 넘어온 경우, 저장해 둔 글을 꺼내 바로 변환한다.
(async () => {
  const store = chrome.storage.session || chrome.storage.local;
  const { pendingPasteText } = await store.get('pendingPasteText');
  if (!pendingPasteText) {
    source.focus();
    return;
  }
  // 새로고침할 때마다 다시 변환되지 않도록 꺼낸 즉시 지운다.
  await store.remove('pendingPasteText');
  source.value = pendingPasteText;
  updateCount();
  convert();
})();
