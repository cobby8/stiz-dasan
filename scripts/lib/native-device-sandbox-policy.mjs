import { isIP } from 'node:net';

export const SANDBOX_PORT = 8453;
export const ROLE_PATHS = Object.freeze(['/store-app', '/__entry/admin', '/__entry/teacher', '/__entry/parent', '/__entry/driver', '/admin', '/staff', '/staff/sessions/sandbox-session', '/mypage', '/mypage/enrollment-change', '/driver/sandbox-only', '/__sandbox/media']);
export const BODY_LIMIT = 8 * 1024 * 1024;
export function privateIpv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function sandboxOrigin(host = 'localhost', port = SANDBOX_PORT) {
  if (host !== 'localhost' && host !== '127.0.0.1' && !privateIpv4(host)) throw new Error('로컬 또는 명시한 사설 IPv4만 허용합니다.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('시험 포트 범위가 아닙니다.');
  return `https://${host}:${port}`;
}
export function requestTarget(rawUrl, host, origins) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048 || !rawUrl.startsWith('/') || rawUrl.startsWith('//') || /[\\\x00-\x20\x7f]/.test(rawUrl)) return null;
  if (!origins.includes(`https://${host}`)) return null;
  try {
    const decoded = decodeURIComponent(rawUrl.split('?')[0]);
    if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('%') || decoded.includes('//')) return null;
    const parsed = new URL(rawUrl, `https://${host}`);
    if (parsed.origin !== `https://${host}`) return null;
    return parsed;
  } catch { return null; }
}
export function sameOriginWrite(headers, origin) {
  return headers.origin === origin && !['cross-site', 'same-site'].includes(headers['sec-fetch-site']) && !headers['x-forwarded-host'] && !headers['x-forwarded-proto'];
}
export const SANDBOX_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), bluetooth=()',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-STIZ-Sandbox': 'synthetic-only',
});

// 서버가 운영 요청을 중계하는 경로는 없다. 알려진 합성 조회와 첨부 시험만 허용한다.
export function routeDecision(method, pathname) {
  if (method === 'GET' && ROLE_PATHS.includes(pathname)) return 'page';
  if (method === 'GET' && ['/bundle.js', '/screen.css', '/guard.js', '/stiz-logo.png', '/material.woff2', '/material.ttf'].includes(pathname)) return 'asset';
  if (method === 'GET' && ['/__sandbox/health', '/__sandbox/counters', '/api/admin/dashboard', '/api/admin/dashboard/system', '/api/account/child-links', '/api/staff/sessions/sandbox-session/photos'].includes(pathname)) return 'synthetic-read';
  if (method === 'POST' && ['/__sandbox/upload', '/api/staff/sessions/sandbox-session/photos'].includes(pathname)) return 'synthetic-upload';
  return 'deny';
}

export const browserGuard = `(() => {
  'use strict';
  const allowedPages = new Set(${JSON.stringify(ROLE_PATHS)});
  const same = value => { try { const u = new URL(value, location.href); return u.origin === location.origin && !u.username && !u.password; } catch { return false; } };
  const deny = () => { document.getElementById('sandbox-status').textContent = '격리 시험: 외부 이동·운영 저장·발송·결제는 차단됩니다.'; };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => { const value = typeof input === 'string' || input instanceof URL ? input : input.url; if (!same(value)) return Promise.reject(new Error('SANDBOX_EXTERNAL_BLOCKED')); return originalFetch(input, init); };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { if (!same(url)) throw new Error('SANDBOX_EXTERNAL_BLOCKED'); return originalOpen.call(this, method, url, ...rest); };
  window.open = () => { deny(); return null; };
  if (navigator.sendBeacon) navigator.sendBeacon = () => false;
  if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { throw new Error('SANDBOX_SERVICE_WORKER_BLOCKED'); };
  document.addEventListener('click', event => { const anchor = event.target.closest?.('a'); if (!anchor) return; const u = new URL(anchor.href, location.href); if (!same(u) || !allowedPages.has(u.pathname) || u.search) { event.preventDefault(); event.stopImmediatePropagation(); deny(); } }, true);
  document.addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); deny(); }, true);
})();`;
