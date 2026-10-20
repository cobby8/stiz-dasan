import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function load(relative) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, { exports, Intl, Date });
  return exports;
}
const { publicScheduleNotice, publicScheduleSlots } = load('../src/app/schedule/publicSchedulePresentation.ts');
const { publicSeasonalDate, isPastSeasonalProgram } = load('../src/components/seasonal/publicPresentation.ts');

test('공개 준비물·휴강 안내는 원문 그대로 유지한다', () => {
  for (const note of ['준비물: 운동복과 실내화', '휴강 안내: 다음 주 상담 문의', '체험 가능 · 모집 중']) assert.equal(publicScheduleNotice(note), note);
});

test('운영 메모와 분류하지 못한 메모는 공개하지 않고 원문을 바꾸지 않는다', () => {
  const note = '[2026-09-10 운영자확정] 토7 월수강료120,000원. 공통주말Program기본110,000원 적용대상아님. 셔틀없음.';
  assert.equal(publicScheduleNotice(note), null);
  assert.equal(publicScheduleNotice('담당자 개별 확인 필요'), null);
  assert.equal(publicScheduleNotice('관리자 확인: 체험 가능'), null);
  assert.equal(publicScheduleNotice(null), null);
  assert.equal(note.includes('120,000원'), true);
});

test('특강 ISO 시각과 날짜를 한국 날짜로 표시하고 비정상 입력을 숨긴다', () => {
  assert.equal(publicSeasonalDate('2026-10-19T15:00:00.000Z'), '2026. 10. 20.');
  assert.equal(publicSeasonalDate('2026-10-20'), '2026. 10. 20.');
  assert.equal(publicSeasonalDate(undefined), '');
  assert.equal(publicSeasonalDate('bad date'), '일정 확인 중');
});

test('종료 특강 분류는 날짜 전용 자료의 한국 시간 마지막 순간까지 보장한다', () => {
  const program = { status: 'OPEN', operationEnd: '2026-10-20' };
  assert.equal(isPastSeasonalProgram(program, Date.parse('2026-10-20T14:59:59Z')), false);
  assert.equal(isPastSeasonalProgram(program, Date.parse('2026-10-20T15:00:00Z')), true);
  assert.equal(isPastSeasonalProgram({ status: 'ENDED' }, 0), true);
  assert.equal(isPastSeasonalProgram({ status: 'UPCOMING' }, 0), false);
});

test('신청 허브는 직접 신청 두 경로와 유니폼 보조 입구를 보존한다', () => {
  const source = fs.readFileSync(new URL('../src/app/apply/ApplyPageClient.tsx', import.meta.url), 'utf8');
  for (const href of ['/apply/trial', '/apply/enroll', '/apply/uniform', '/terms']) assert.ok(source.includes(`href="${href}"`));
  for (const anchor of ['trial', 'enroll', 'uniform', 'faq']) assert.ok(source.includes(`id="${anchor}"`));
  assert.ok(source.includes('trialContentHtml'));
  assert.ok(source.includes('enrollContentHtml'));
  assert.ok(!fs.readFileSync(new URL('../src/app/apply/page.tsx', import.meta.url), 'utf8').includes('<ProcessSteps'));
});

test('공개 전달 자료 정제는 원본 메모·금액·시각을 변경하지 않는다', () => {
  const slots = [{ slotKey: 'Sat7', note: '[운영자확정] 토7 월수강료120,000원', amount: 120000, startTime: '16:00' }];
  const projected = publicScheduleSlots(slots);
  assert.equal(projected[0].note, null);
  assert.equal(projected[0].amount, 120000);
  assert.equal(projected[0].startTime, '16:00');
  assert.equal(slots[0].note, '[운영자확정] 토7 월수강료120,000원');
});

for (const route of ['schedule', 'simulator']) test(`${route} 실제 공개 페이지의 클라이언트 직렬화 자료에 운영 메모가 없다`, async () => {
  const sourceSlots = [
    { slotKey: 'Sat7', programId: 'program-1', note: '[2026-09-10 운영자확정] 토7 월수강료120,000원. 공통주말Program기본110,000원 적용대상아님.' },
    { slotKey: 'Sat8', programId: 'program-1', note: '준비물: 운동복과 실내화' },
  ];
  const code = ts.transpileModule(fs.readFileSync(new URL(`../src/app/${route}/page.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const require = createRequire(import.meta.url);
  new Function('require', 'exports', code)((id) => {
    if (id === '@/lib/queries') return { getAcademySettings: async () => ({ contactPhone: 'masked' }), getPrograms: async () => [{ id: 'program-1', name: '시험 수업' }], getClassSlotOverrides: async () => [], getCustomClassSlots: async () => [], getSheetSlotCache: async () => [] };
    if (id === '@/lib/scheduleSlotPayload') return { getScheduleSlotAdminData: async () => ({ slots: sourceSlots, overrides: [], customSlots: [] }) };
    if (id === '@/lib/mergeSlots') return { buildMergedSlots: (slots) => slots };
    if (id === '@/lib/publicMetadata') return { buildPublicMetadata: (value) => value };
    if (id.endsWith('/publicSchedulePresentation')) return { publicScheduleSlots };
    if (id === './ScheduleClient' || id === './SimulatorClient') return { default: (props) => React.createElement('script', { type: 'application/json', dangerouslySetInnerHTML: { __html: JSON.stringify(props) } }) };
    if (id === '@/components/PublicPageLayout') return { default: ({ children }) => children };
    if (id.startsWith('@/components/')) return { default: () => null };
    return require(id);
  }, exports);
  const html = renderToStaticMarkup(await exports.default());
  assert.ok(html.includes('준비물: 운동복과 실내화'));
  for (const secret of ['운영자확정', '적용대상아님', '120,000원', '공통주말Program']) assert.ok(!html.includes(secret));
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match);
  const props = JSON.parse(match[1]);
  assert.equal(props.allSlots[0].note, null);
  assert.equal(props.allSlots[1].note, '준비물: 운동복과 실내화');
  assert.ok(sourceSlots[0].note.includes('운영자확정'));
});
