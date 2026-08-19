const domainsEl = document.getElementById('domains');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');

async function load() {
  const { extraDomains } = await chrome.storage.sync.get({ extraDomains: [] });
  domainsEl.value = extraDomains.join('\n');
}

document.getElementById('save').addEventListener('click', async () => {
  const list = domainsEl.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  await chrome.storage.sync.set({ extraDomains: list });
  statusEl.textContent = 'Сохранено';
  setTimeout(() => (statusEl.textContent = ''), 1500);
});

async function loadStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/workspace\.vk\.ru/.test(tab.url || '')) {
      statsEl.textContent = 'Открой app.workspace.vk.ru, чтобы увидеть статистику блокировок.';
      return;
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.__vkAdsBlocker ? window.__vkAdsBlocker.stats() : null),
    });
    if (!result) {
      statsEl.textContent = 'Скрипт ещё не инициализирован на странице.';
      return;
    }
    statsEl.innerHTML =
      `Скрыто блоков: <b>${result.blocked}</b><br>` +
      `Замечено хостов у iframe: ${result.seenHosts.length ? result.seenHosts.join(', ') : '—'}`;
  } catch (e) {
    statsEl.textContent = 'Не удалось получить статистику: ' + e.message;
  }
}

load();
loadStats();
