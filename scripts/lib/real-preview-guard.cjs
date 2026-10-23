// 개발 미리보기 전용: 앱 프로세스가 운영 서비스나 다른 DB에 접속하지 못하게 합니다.
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

function isAllowedDestination(host, port, ports) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase()) && ports.includes(Number(port));
}

function installPreviewGuard({ ports, auditFile }) {
  const record = () => { if (auditFile) fs.appendFileSync(auditFile, 'OUTBOUND_BLOCKED\n'); };
  const blocked = () => { record(); throw new Error('개발 미리보기에서 외부 연결을 차단했습니다.'); };
  const allowedUrl = input => {
    try { const u = new URL(typeof input === 'string' ? input : input.url || input.href); return isAllowedDestination(u.hostname, u.port || (u.protocol === 'https:' ? 443 : 80), ports); } catch { return false; }
  };
  const originalFetch = global.fetch;
  global.fetch = (input, ...args) => allowedUrl(input) ? originalFetch(input, ...args) : Promise.reject((() => { record(); return new Error('개발 미리보기에서 외부 연결을 차단했습니다.'); })());
  for (const transport of [http, https]) for (const key of ['request', 'get']) {
    const original = transport[key];
    transport[key] = function(input, ...args) {
      const valid = typeof input === 'object' && !(input instanceof URL)
        ? isAllowedDestination(input.hostname || input.host || 'localhost', input.port || (transport === https ? 443 : 80), ports)
        : allowedUrl(input);
      if (!valid) return blocked();
      return original.call(this, input, ...args);
    };
  }
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function(...args) {
    let first = args[0]; if (Array.isArray(first)) first = first[0];
    const options = typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    // Node 자체의 작업자 통신 파이프는 네트워크 목적지가 아닙니다.
    if (options?.path && /^\\\\[.?]\\pipe\\/.test(options.path)) return originalConnect.apply(this, args);
    if (!options || !isAllowedDestination(options.host || 'localhost', options.port, ports)) return blocked();
    return originalConnect.apply(this, args);
  };
}

module.exports = { isAllowedDestination, installPreviewGuard };
if (process.env.STIZ_REAL_PREVIEW_PORTS) {
  const ports = process.env.STIZ_REAL_PREVIEW_PORTS.split(',').map(Number);
  const db = new URL(process.env.DATABASE_URL);
  if (!isAllowedDestination(db.hostname, db.port, ports) || !ports.every(p => Number.isInteger(p) && p > 1024)) throw new Error('개발 미리보기 연결 범위가 맞지 않습니다.');
  installPreviewGuard({ ports, auditFile: process.env.STIZ_REAL_PREVIEW_AUDIT });
}
