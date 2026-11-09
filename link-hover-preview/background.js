// Many sites send X-Frame-Options or CSP frame-ancestors, which stops them
// loading inside the preview iframe. When the user turns on "allowBlocked",
// the content script asks for a session rule that strips those headers, scoped
// to the previewed domain, sub_frame requests only, and the requesting tab only.

const ALLOW_DEFAULT = { allowBlocked: false };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'allow-frame' || !sender.tab) return;
  allowFrameFor(msg.url, sender.tab.id)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});

async function allowFrameFor(url, tabId) {
  const { allowBlocked } = await chrome.storage.sync.get(ALLOW_DEFAULT);
  if (!allowBlocked) return;
  const hostname = new URL(url).hostname;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' }
          ]
        },
        condition: {
          requestDomains: [hostname],
          resourceTypes: ['sub_frame'],
          tabIds: [tabId]
        }
      }
    ]
  });
}

async function clearAllRules() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.length) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map((r) => r.id)
    });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.allowBlocked && !changes.allowBlocked.newValue) {
    clearAllRules();
  }
});
