const AppCurrency = {
  USD: { code: 'USD', symbol: '$', rate: 1.0 },
  EUR: { code: 'EUR', symbol: '\u20AC', rate: 0.92 },
  GBP: { code: 'GBP', symbol: '\u00A3', rate: 0.78 },
  JPY: { code: 'JPY', symbol: '\u00A5', rate: 157.20 },
  CAD: { code: 'CAD', symbol: 'CA$', rate: 1.37 },
  AUD: { code: 'AUD', symbol: 'A$', rate: 1.51 },
};

function getCurrency() {
  const code = localStorage.getItem('monet_currency') || 'USD';
  return AppCurrency[code] || AppCurrency.USD;
}

function setCurrency(code) {
  if (AppCurrency[code]) {
    localStorage.setItem('monet_currency', code);
  }
}

function convert(usdValue) {
  const cur = getCurrency();
  return usdValue * cur.rate;
}

function formatCurrency(usdValue, decimals = 2) {
  const cur = getCurrency();
  const converted = convert(usdValue);
  if (cur.code === 'JPY') {
    decimals = 0;
  }
  return cur.symbol + converted.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatChange(pct) {
  if (pct == null || isNaN(pct)) return '-';
  const sign = pct >= 0 ? '+' : '';
  return sign + pct.toFixed(2) + '%';
}

function formatLargeNumber(num) {
  if (num == null || isNaN(num)) return '-';
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

function formatLargeCurrency(usdValue, decimals) {
  const cur = getCurrency();
  const converted = convert(usdValue);
  let val = converted;
  let suffix = '';
  if (Math.abs(val) >= 1e12) { val /= 1e12; suffix = 'T'; }
  else if (Math.abs(val) >= 1e9) { val /= 1e9; suffix = 'B'; }
  else if (Math.abs(val) >= 1e6) { val /= 1e6; suffix = 'M'; }
  else if (Math.abs(val) >= 1e3) { val /= 1e3; suffix = 'K'; }
  const d = decimals != null ? decimals : (cur.code === 'JPY' ? 0 : 2);
  return cur.symbol + val.toFixed(d) + suffix;
}
