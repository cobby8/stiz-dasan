// 구글 시트 원장 은퇴(Phase 2 — 시트 «읽기» 화면 정리) 검증 — developer 작성(2026-10-06).
// 원칙: 기능을 지우지 않고 «숨김». 같은 스위치(isSheetSyncRetired)로 은퇴면 숨기고, "0" 이면 옛 화면 그대로.
// 과거(9월까지) 시트 이력 «조회»는 유지한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (p) => readFileSync(p, 'utf8');
// 서버 페이지가 스위치를 process.env 로 판정해 sheetRetired 를 넘기는지
const passesSwitch = (src) =>
  /import \{ isSheetSyncRetired \} from "@\/lib\/operations-sync\/sheetRetirement"/.test(src) &&
  /sheetRetired=\{isSheetSyncRetired\(process\.env\)\}/.test(src);

// ── 1. 시간표 시트 동기화 ──────────────────────────────────────────────
test('시간표 관리: 페이지가 스위치를 넘기고, 「구글시트 연동」 버튼·시트 안내가 은퇴면 숨는다', () => {
  assert.ok(passesSwitch(read('src/app/admin/schedule/page.tsx')));
  const src = read('src/app/admin/schedule/ScheduleAdminClient.tsx');
  assert.match(src, /sheetRetired = false,/, '기본값 false = 스위치를 안 넘기면 옛 화면');
  // 모달을 여는 버튼이 !sheetRetired 안에 있어야 「지금 동기화」에 닿을 길이 없다
  assert.match(src, /\{!sheetRetired && \(\s*<button\s+onClick=\{\(\) => \{ setSheetUrlInput\(sheetUrl \|\| ""\); setShowSheetModal\(true\); \}\}/);
  assert.match(src, /adminViewMode === "edit" && !sheetRetired && !hasSheetUrl && !isDbScheduleSource/);
  assert.match(src, /adminViewMode === "edit" && !sheetRetired && hasSheetUrl && slots\.length === 0/);
  // 동기화 기능 자체는 지우지 않았다(되돌리기용)
  assert.match(src, /fetch\("\/api\/admin\/sync-schedule", \{ method: "POST" \}\)/);
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

test('관리자 시스템 도구: 은퇴면 「시트 동기화」가 없고, 스위치 "0"(false) 이면 그대로 보인다', () => {
  const retired = renderBackupButtons({ sheetRetired: true });
  assert.doesNotMatch(retired, /시트 동기화/);
  assert.match(retired, /설정 백업 다운로드/, '백업·복원 버튼은 그대로');
  assert.match(renderBackupButtons({ sheetRetired: false }), /시트 동기화/);
  assert.match(renderBackupButtons(), /시트 동기화/, 'props 없이 불러도 옛 화면');
  // layout → AdminShellClient → AdminBackupButtons 로 스위치가 이어지는지
  assert.ok(passesSwitch(read('src/app/admin/layout.tsx')));
  assert.match(read('src/app/admin/AdminShellClient.tsx'), /<LazyBackupButtons sheetRetired=\{sheetRetired\} \/>/);
});

test('죽은 크론 /api/cron/sync-schedule: 지우지 않고, 은퇴면 시트를 읽기 전에 410 을 돌려준다', () => {
  const src = read('src/app/api/cron/sync-schedule/route.ts');
  const guard = src.indexOf('if (isSheetSyncRetired(process.env))');
  assert.ok(guard > 0);
  assert.ok(guard < src.indexOf('await syncSheetSlots()'), '410 판정이 시트 읽기보다 먼저');
  assert.ok(src.indexOf('Unauthorized') < guard, '인증 검사는 그대로 먼저');
  assert.match(src, /status: 410/);
});

// ── 2. 재무 「시트 원장 기준 수납 점검」 ───────────────────────────────
test('재무: 은퇴면 「시트 점검」 버튼과 점검 패널을 숨기고, API 는 남겨 둔다', () => {
  assert.ok(passesSwitch(read('src/app/admin/finance/page.tsx')));
  const src = read('src/app/admin/finance/FinanceClient.tsx');
  assert.match(src, /sheetRetired = false,/);
  assert.match(src, /\{!sheetRetired && \(\s*<button\s+type="button"\s+onClick=\{loadSheetPreview\}/);
  assert.match(src, /\{!sheetRetired && \(sheetError \|\| sheetPreview\) && \(/);
  assert.ok(existsSync('src/app/api/admin/finance/sheet-reconcile/route.ts'));
});

// ── 3. 학생 관리 시트 정합성 점검·재연결 ───────────────────────────────
test('학생 관리: 은퇴면 「점검 도구」(최신 원생목록·차이 점검·미연결 점검)를 숨기고 이관 요약 숫자는 남긴다', () => {
  assert.ok(passesSwitch(read('src/app/admin/students/page.tsx')));
  const src = read('src/app/admin/students/StudentManagementClient.tsx');
  assert.match(src, /sheetRetired = false,/);
  assert.match(src, /\{!sheetRetired && \(\s*<button\s+type="button"\s+onClick=\{\(\) => setShowImportTools/);
  assert.match(src, /\{!sheetRetired && showImportTools && \(/);
  // 과거 시트 이관 요약 숫자(조회)는 조건 없이 그대로
  assert.match(src, /<ImportSummaryMetric label="최신 원생" value=\{sheetImportSummary\.uniqueStudents\} \/>/);
  for (const api of ['reconcile', 'relink', 'current-roster']) {
    assert.ok(existsSync(`src/app/api/admin/import-students/${api}/route.ts`), `${api} API 유지`);
  }
});

test('과거 시트 이력 표시는 유지: 학생 목록 월 상태·학생 상세 월별 이력·이관 요약 조회가 살아 있다', () => {
  const queries = read('src/lib/queries.ts');
  assert.match(queries, /function buildStudentMonthlyHistory\(/);
  assert.match(queries, /monthlyHistory: buildStudentMonthlyHistory\(monthlyHistoryRows\)/);
  assert.match(read('src/lib/adminReadPayloads.ts'), /FROM "StudentSheetImportBatch" b/);
});

// ── 4. 학생 가져오기 화면 ──────────────────────────────────────────────
test('수강생 이관 화면: 은퇴면 "과거 자료 조회용" 안내만 붙이고 기능은 그대로', () => {
  const src = read('src/app/admin/import/page.tsx');
  assert.match(src, /const sheetRetired = isSheetSyncRetired\(process\.env\);/);
  assert.match(src, /\{sheetRetired && \(/);
  assert.match(src, /시트 원장 종료\(2026-10\) — 과거 자료 조회용/);
  assert.match(src, /<ImportClient defaultSheetUrl=/, '가져오기 기능은 숨기지 않는다');
});

// ── 5. 쓰지 않는 코드 삭제 ─────────────────────────────────────────────
test('호출처 0 이던 시트 함수 3개는 지워져 있다', () => {
  assert.doesNotMatch(read('src/lib/uniformOrders.ts'), /readUniformOrderSheet\s*\(|from "googleapis"/);
  const admin = read('src/app/actions/admin.ts');
  assert.doesNotMatch(admin, /export async function syncScheduleToClasses\b/);
  assert.doesNotMatch(admin, /export async function getClassSyncPreview\b/);
  // 파서는 남긴다(분류 규칙 테스트 uniform-orders.test.mjs 가 사용)
  assert.match(read('src/lib/uniformOrders.ts'), /export function parseUniformOrderRows\(/);
});

// ── 6. 서버 getDay() 정리 ──────────────────────────────────────────────
test('출석 반 목록의 요일은 kstDow 로 구한다(서버 시간대 무관)', () => {
  const queries = read('src/lib/queries.ts');
  assert.match(queries, /return ATTENDANCE_DAY_KEYS\[kstDow\(date\)\];/);
  assert.doesNotMatch(queries, /T12:00:00\+09:00`\)\.getDay\(\)/);
});
