import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePreviewCalendar } from '../scripts/lib/real-preview-calendar.mjs';

const address = 'https://calendar.google.com/calendar/ical/preview/public/basic.ics';
const client = (url) => ({ async query(sql) { assert.match(sql, /^SELECT /); return { rows: [{ url }] }; } });
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:private-id@example.invalid\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261013\r\nSUMMARY:10월 3주차\r\nDESCRIPTION:private-description\r\nLOCATION:private-address\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

test('공식 달력 주소가 없으면 외부 연결 없이 DB 일정만 사용한다', async () => {
  const result = await capturePreviewCalendar(client(null), { fetchImpl() { throw Error('외부 호출 금지'); } });
  assert.deepEqual(result, { kind: 'DB', events: [] });
});

test('공통 일정 파서로 읽고 공개 수업일·제목만 복사한다', async () => {
  const result = await capturePreviewCalendar(client(address), {
    now: new Date('2026-10-20T00:00:00Z'),
    async fetchImpl(url, options) { assert.equal(url, address); assert.equal(options.redirect, 'manual'); return new Response(ics); },
  });
  assert.equal(result.kind, 'DB_AND_ICS');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, '10월 3주차');
  assert.equal(result.events[0].date.getTime(), Date.UTC(2026, 9, 12));
  const data = JSON.stringify(result);
  for (const value of [address, 'private-id', 'private-description', 'private-address']) assert.ok(!data.includes(value));
});

test('잘못된 주소·외부 리다이렉트·조회 실패는 빈 일정으로 바꾸지 않는다', async () => {
  for (const url of ['http://calendar.google.com/calendar/ical/preview/basic.ics', 'https://example.invalid/basic.ics']) {
    await assert.rejects(capturePreviewCalendar(client(url)), /허용한 공식 일정/);
  }
  await assert.rejects(capturePreviewCalendar(client(address), { async fetchImpl() { return new Response(null, { status: 302 }); } }), /공식 일정/);
  await assert.rejects(capturePreviewCalendar(client(address), { async fetchImpl() { return new Response(null, { status: 503 }); } }), /공식 일정/);
});
