import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

const require = createRequire(import.meta.url);

/** 저장된 달력 주소는 메모리 안에서만 사용하고 공개 일정 필드만 반환한다. */
export async function capturePreviewCalendar(source, { now = new Date(), fetchImpl = fetch } = {}) {
  const { rows } = await source.query(`SELECT to_jsonb(s)->>'googleCalendarIcsUrl' AS url FROM "public"."AcademySettings" s LIMIT 1`);
  const url = rows[0]?.url;
  if (!url) return { events: [], kind: 'DB' };
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('공식 일정 주소를 확인하지 못했습니다.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'calendar.google.com' || !parsed.pathname.startsWith('/calendar/ical/') || !parsed.pathname.endsWith('.ics') || parsed.username || parsed.password) throw new Error('미리보기에서 허용한 공식 일정 주소가 아닙니다.');
  const sourceText = await readFile(new URL('../../src/lib/googleCalendar.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(sourceText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const loaded = {};
  let failed = false;
  const safeFetch = async (address) => {
    if (address !== url) throw new Error('허용하지 않은 일정 연결입니다.');
    const response = await fetchImpl(address, { redirect: 'manual', signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4 * 1024 * 1024) throw new Error('공식 일정을 읽지 못했습니다.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('공식 일정 응답이 없습니다.');
    const chunks = []; let length = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('공식 일정 응답이 너무 큽니다.'); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    return new Response(Buffer.concat(chunks), { status: 200 });
  };
  new Function('require', 'exports', 'process', 'fetch', 'console', code)((id) => {
    if (id !== 'node-ical') throw new Error('일정 미리보기에서 허용하지 않은 모듈입니다.');
    return require(id);
  }, loaded, { env: {} }, safeFetch, { error() { failed = true; }, warn() {}, log() {} });
  let events;
  try { events = await loaded.fetchGoogleCalendarEvents(url, { strict: true, fresh: true }); }
  catch { throw new Error('공식 일정 조회에 실패해 미리보기를 중단했습니다.'); }
  if (failed || !Array.isArray(events) || !events.length) throw new Error('공식 일정의 수업 근거를 확인하지 못했습니다.');
  const year = new Date(now).getUTCFullYear();
  return { kind: 'DB_AND_ICS', events: events.filter(e => e.date.getUTCFullYear() >= year - 1 && e.date.getUTCFullYear() <= year + 1).map(e => ({
    id: randomUUID(), title: String(e.title), date: e.date, endDate: e.endDate ?? null, category: e.category ?? '일반', createdAt: new Date(now), updatedAt: new Date(now),
  })) };
}
