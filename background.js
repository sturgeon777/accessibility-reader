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