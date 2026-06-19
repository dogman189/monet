const NAV_TABS = [
  { id: 'terminal',    label: 'Terminal',       href: 'index.html' },
  { id: 'trade',       label: 'Trade',          href: 'trade.html' },
  { id: 'prices',      label: 'Crypto Prices',  href: 'crypto-prices.html' },
  { id: 'model',       label: 'Model',          href: 'model.html' },
  { id: 'report',      label: 'Report',         href: 'report.html' },
  { id: 'settings',    label: 'Settings',       href: 'settings.html' },
];

const TAB_STORAGE_KEY = 'monet_visible_tabs';

function getDefaultTabVisibility() {
  const map = {};
  NAV_TABS.forEach(t => { map[t.id] = true; });
  return map;
}

function getTabVisibility() {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      NAV_TABS.forEach(t => { if (parsed[t.id] === undefined) parsed[t.id] = true; });
      return parsed;
    }
  } catch (e) {}
  return getDefaultTabVisibility();
}

function setTabVisibility(id, visible) {
  const vis = getTabVisibility();
  vis[id] = visible;
  localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(vis));
}

function isTabVisible(id) {
  return getTabVisibility()[id] !== false;
}

function renderNav(currentPageId) {
  const container = document.getElementById('nav-links');
  if (!container) return;
  container.innerHTML = '';
  NAV_TABS.forEach(tab => {
    if (!isTabVisible(tab.id)) return;
    const a = document.createElement('a');
    a.href = tab.href;
    a.className = 'nav-link' + (tab.id === currentPageId ? ' active' : '');
    a.textContent = tab.label;
    container.appendChild(a);
  });
}
