// 구글 시트 원장 은퇴(Phase 2 — 시트 «읽기» 화면 정리) 검증 — developer 작성(2026-10-06).
// 2026-11-18 결정표(sheet-switch «완전히 지운다»): «숨김 + 되돌리기 스위치»였던 시트 동기화·연동 화면·시트 점검을 코드째 지웠다.
// 과거(9월까지) 시트 이력 «조회»는 유지한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (p) => readFileSync(p, 'utf8');
// 서버 페이지가 시트 스위치를 더 이상 읽거나 넘기지 않는지
const noSwitch = (src) => !/isSheetSyncRetired|sheetRetirement|sheetRetired/.test(src);

// ── 1. 시간표 시트 동기화 ──────────────────────────────────────────────
test('시간표 관리: «구글시트 연동관리» 창·시트 주소 안내·지금 동기화가 지워졌다(수업 칸 편집은 그대로)', () => {
  assert.ok(noSwitch(read('src/app/admin/schedule/page.tsx')));
  const src = read('src/app/admin/schedule/ScheduleAdminClient.tsx');
  assert.ok(noSwitch(src));
  assert.doesNotMatch(src, /sync-schedule|showSheetModal|googleSheetsScheduleUrl|구글시트 연동|hasSheetUrl/);
  const modals = read('src/app/admin/schedule/ScheduleAdminModals.tsx');
  assert.doesNotMatch(modals, /showSheetModal|구글시트 연동관리|지금 동기화|onSyncSheet/);
  // DB 시간표(ScheduleSlot) 칸 편집은 남는다
  assert.match(src, /onSaveSheetSlot=\{save\}/);
  assert.match(modals, /onSaveSheetSlot: \(slot: SheetClassSlot\) => void;/);
  // 시트 주소는 더 이상 저장하지 않는다(컬럼은 DB 에 남김)
  const admin = read('src/app/actions/admin.ts');
  const allowed = admin.slice(admin.indexOf('const ALLOWED_SETTINGS_COLUMNS'), admin.indexOf('];', admin.indexOf('const ALLOWED_SETTINGS_COLUMNS')));
  assert.doesNotMatch(allowed, /'googleSheetsScheduleUrl'/);
});

// 백업 버튼 묶음은 실제로 렌더해서 확인한다(가짜 react — fetch 는 부르지 않는다)
function renderBackupButtons(props) {
  const code = ts.transpileModule(read('src/app/admin/AdminBackupButtons.tsx'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const deps = {
    react: { useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }) },
    'react/jsx-runtime': { jsx: (type, p) => ({ type, props: p }), jsxs: (type, p) => ({ type, props: p }) },
  };
  const exports = {};
  vm.compileFunction(code, ['require', 'exports'])((id) => deps[id], exports);
  const text = (n) => Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' ? n : n?.props ? text(n.props.children) : '';
  return text(props === undefined ? exports.default() : exports.default(props));
}

test('관리자 시스템 도구: 「시트 동기화」는 지워졌고 백업·복원 버튼은 그대로', () => {
  const html = renderBackupButtons();
  assert.doesNotMatch(html, /시트 동기화/);
  assert.match(html, /설정 백업 다운로드/, '백업·복원 버튼은 그대로');
  assert.ok(noSwitch(read('src/app/admin/layout.tsx')));
  assert.ok(noSwitch(read('src/app/admin/AdminShellClient.tsx')));
  assert.match(read('src/app/admin/AdminShellClient.tsx'), /<LazyBackupButtons \/>/);
  assert.doesNotMatch(read('src/app/admin/AdminBackupButtons.tsx'), /sync-schedule/);
});

// 2026-11-18: 죽은 크론(옛 코드 정리 B)에 이어 관리자 수동 동기화(/api/admin/sync-schedule)·syncSheetSlots 도 지웠다.
test('시트 시간표 동기화 경로(크론·관리자 수동·공유 로직·일회성 스크립트)는 모두 지워졌다', () => {
  for (const path of ['src/app/api/cron/sync-schedule/route.ts', 'src/app/api/admin/sync-schedule/route.ts', 'src/lib/syncSheetSlots.ts', 'scripts/sync-classes.mjs']) {
    assert.equal(existsSync(path), false, path);
  }
  // 구글 시트 CSV 읽기·파싱 함수도 지웠다(타입·상수만 남김)
  const schedule = read('src/lib/googleSheetsSchedule.ts');
  assert.doesNotMatch(schedule, /fetchSheetSchedule|parseSheetCSV/);
  // 시간표 대체 경로는 구글시트 사본(SheetSlotCache)으로 넘어가지 않는다
  for (const path of ['src/app/schedule/page.tsx', 'src/app/simulator/page.tsx', 'src/app/api/admin/schedule/route.ts', 'src/lib/adminReadPayloads.ts', 'src/lib/queries.ts']) {
    assert.doesNotMatch(read(path), /getSheetSlotCache/, path);
  }
  for (const path of ['src/app/api/chat/route.ts', 'src/lib/siteOpsBot.ts']) {
    assert.doesNotMatch(read(path), /FROM "SheetSlotCache"/, path);
  }
});

// ── 2. 재무 「시트 원장 기준 수납 점검」 ───────────────────────────────
test('재무: 「시트 점검」 버튼·점검 패널·API 가 지워졌다', () => {
  assert.ok(noSwitch(read('src/app/admin/finance/page.tsx')));
  const src = read('src/app/admin/finance/FinanceClient.tsx');
  assert.ok(noSwitch(src));
  assert.doesNotMatch(src, /loadSheetPreview|sheetPreview|sheet-reconcile|시트 원장 기준 수납 점검/);
  assert.equal(existsSync('src/app/api/admin/finance/sheet-reconcile/route.ts'), false);
});

// ── 3. 학생 관리 시트 정합성 점검·재연결 ───────────────────────────────
test('학생 관리: 시트 점검 도구는 화면에서 없앴고(2026-10-29), 점검 API 도 이관 도구와 함께 삭제(2026-11-13 원장 지시)', () => {
  const src = read('src/app/admin/students/StudentManagementClient.tsx');
  assert.doesNotMatch(src, /sheetRetired|showImportTools|ImportSummaryMetric|원생 자료 점검/);
  assert.doesNotMatch(read('src/app/admin/students/page.tsx'), /sheetRetired=/);
  for (const api of ['reconcile', 'relink', 'current-roster']) {
    assert.ok(!existsSync(`src/app/api/admin/import-students/${api}/route.ts`), `${api} API 삭제`);
  }
});

// 2026-11-18 옛 코드 정리 B: 부르는 곳이 없던 «이관 요약 조회»(adminReadPayloads)는 지웠다.
// 학생 상세 월별 이력은 queries.ts 가 같은 표를 직접 읽으므로 그대로 살아 있다.
test('과거 시트 이력 표시는 유지: 학생 목록 월 상태·학생 상세 월별 이력이 살아 있다', () => {
  const queries = read('src/lib/queries.ts');
  assert.match(queries, /function buildStudentMonthlyHistory\(/);
  assert.match(queries, /monthlyHistory: buildStudentMonthlyHistory\(monthlyHistoryRows\)/);
  assert.match(queries, /FROM "StudentSheetImportBatch" b/);
});

// ── 4. 학생 가져오기 화면 ──────────────────────────────────────────────
// 2026-11-13 원장 «이번에 완전히 다 옮기고 제거»: 운영 시트는 11-05 에 9월분까지 끝까지 가져왔고(2,458줄)
// 10월부터 시트를 쓰지 않아 화면·API 를 지웠다. 가져온 자료는 DB 에 그대로 있다(위 «과거 시트 이력 표시는 유지»).
test('수강생 이관 화면은 삭제됐다', () => {
  assert.ok(!existsSync('src/app/admin/import/page.tsx'));
  assert.ok(!existsSync('src/app/api/admin/import-students/route.ts'));
});

// ── 5. 쓰지 않는 코드 삭제 ─────────────────────────────────────────────
test('호출처 0 이던 시트 함수 3개는 지워져 있다', () => {
  // 2026-11-18: 남겨 둔 파서까지 부르는 곳이 없어 uniformOrders.ts 파일째 지웠다.
  assert.ok(!existsSync('src/lib/uniformOrders.ts'));
  const admin = read('src/app/actions/admin.ts');
  assert.doesNotMatch(admin, /export async function syncScheduleToClasses\b/);
  assert.doesNotMatch(admin, /export async function getClassSyncPreview\b/);
});

// ── 6. 서버 getDay() 정리 ──────────────────────────────────────────────
test('출석 반 목록의 요일은 kstDow 로 구한다(서버 시간대 무관)', () => {
  const queries = read('src/lib/queries.ts');
  assert.match(queries, /return ATTENDANCE_DAY_KEYS\[kstDow\(date\)\];/);
  assert.doesNotMatch(queries, /T12:00:00\+09:00`\)\.getDay\(\)/);
});
