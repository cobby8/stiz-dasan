import http from 'node:http';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export const PREVIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self'; worker-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'self'; object-src 'none'";
export const LOCAL_DRIVER_TOKEN = '00000000000000000000000000abcdef01';

export function allowPreviewRequest({ method, pathname, actionId, actions = {} }) {
  if (/^\/(?:api\/(?:cron|auth|ops|payments|kakao|push)|auth|login|logout)(?:\/|$)/i.test(pathname)) return false;
  if (/^\/(?:sw(?:-[\w-]+)?\.js|service-worker\.js|manifest(?:-[\w-]+)?\.json)$/.test(pathname)) return false;
  if (/^\/api\//.test(pathname) && /(?:send|dispatch-message|reconcile|sync|publish|backup|delete|confirm|cancel|location-session)/i.test(pathname)) return false;
  if (['GET', 'HEAD'].includes(method)) {
    if (pathname.startsWith('/api/')) return /^\/api\/admin\/(?:billing-workbench|apply(?:\/(?:source-stats|settings))?|students(?:\/import-summary|\/[^/]+\/activity)?|student-options|driver-requests|regular\/dispatch\/saved|seasonal\/dispatch\/saved)$/.test(pathname) || pathname === '/api/staff/shuttle';
    return pathname === '/' || /^\/(?:admin|staff|mypage|driver|_next)(?:\/|$)/.test(pathname) || /^\/[\w/-]+\.(?:png|svg|ico|jpg|jpeg|webp|woff2?|ttf|css)$/.test(pathname) || ['/programs', '/intro', '/gallery', '/notices', '/terms', '/privacy', '/faq', '/opengraph-image'].includes(pathname);
  }
  return method === 'POST' && /^\/staff\/sessions\/[^/]+$/.test(pathname) && ['loadStaffSessionMonthlyFees', 'loadStaffAttendanceBilling'].includes(actions[actionId]);
}

export function allowPreviewRedirect(location, origin) {
  try { return new URL(location, origin).origin === origin; } catch { return false; }
}

const localClickGuard = `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(a){try{var u=new URL(a.getAttribute('href'),location.href);if(u.origin!==location.origin){e.preventDefault();e.stopImmediatePropagation();}}catch(x){e.preventDefault();}}},true);</script>`;

export function createPreviewProxy({ upstreamPort, accounts, actions = {}, gate, onBlocked = () => {}, onError = () => {} }) {
  const entries = { admin: '/admin', teacher: '/staff', parent: '/mypage', driver: `/driver/${LOCAL_DRIVER_TOKEN}` };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = String(req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost', '['].includes(host)) { res.writeHead(403); return res.end(); }
    if (url.pathname.startsWith('/__entry/')) {
      const role = url.pathname.slice('/__entry/'.length);
      if (req.method !== 'GET' || !Object.hasOwn(entries, role) || (role !== 'driver' && !accounts[role])) { res.writeHead(404); return res.end(); }
      res.writeHead(302, { 'Set-Cookie': `qa-role=${role}; Path=/; HttpOnly; SameSite=Strict`, Location: entries[role], 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!allowPreviewRequest({ method: req.method, pathname: url.pathname, actionId: req.headers['next-action'], actions })) {
      onBlocked(); res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: '미리보기에서는 저장·발송·결제를 실행하지 않습니다.' }));
    }
    const headers = { ...req.headers };
    headers['accept-encoding'] = 'identity';
    if (gate) headers['x-stiz-preview-gate'] = gate;
    if (!/\bqa-role=/.test(headers.cookie || '')) headers.cookie = `${headers.cookie ? headers.cookie + '; ' : ''}qa-role=admin`;
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers, 'content-security-policy': PREVIEW_CSP, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()' };
      const location = responseHeaders.location;
      const origin = `http://${req.headers.host}`;
      if (location && !allowPreviewRedirect(location, origin)) { onBlocked(); res.writeHead(403); response.resume(); return res.end('외부 이동을 차단했습니다.'); }
      delete responseHeaders['content-length'];
      res.writeHead(response.statusCode, responseHeaders);
      if (String(response.headers['content-type']).includes('text/html')) {
        let prefix = '', inserted = false;
        const decoder = new StringDecoder('utf8');
        const guard = new Transform({ transform(chunk, _encoding, done) {
          const text = decoder.write(chunk);
          if (inserted) { this.push(text); return done(); }
          prefix += text;
          if (prefix.includes('</head>')) { this.push(prefix.replace('</head>', localClickGuard + '</head>')); prefix = ''; inserted = true; }
          done();
        }, flush(done) { const last = decoder.end(); if (inserted) this.push(last); else if (prefix || last) this.push(prefix + last); done(); } });
        response.pipe(guard).pipe(res);
      } else response.pipe(res);
    });
    upstream.on('error', () => { onError(); if (!res.headersSent) res.writeHead(503); res.end('미리보기를 준비하고 있습니다.'); });
    req.pipe(upstream);
  });
}
