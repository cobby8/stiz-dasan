// 관리자 목록 공통 규칙(2026-10-30 목록 개편 1단계) — 신청·상담 화면부터 적용, 다음 화면도 같은 부품을 쓴다.
// 지키는 약속: ① 한 줄 행·말줄임 금지 ② 글자 왼쪽/숫자·날짜 오른쪽 ③ 행 클릭 → 오른쪽 패널(모바일 시트)
//             ④ 상태별 건수 칩이 상태 필터와 같은 값 공유 ⑤ «목록 | 상태별» 전환을 브라우저에 기억
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const globalsCss = read("../src/app/globals.css");
const adminModal = read("../src/components/admin/AdminModal.tsx");
const panel = read("../src/components/admin/list/ListDetailPanel.tsx");
const chips = read("../src/components/admin/list/StatusCountChips.tsx");
const toggle = read("../src/components/admin/list/ListViewToggle.tsx");
const applyClient = read("../src/app/admin/apply/ApplyAdminClient.tsx");
const applyModals = read("../src/app/admin/apply/ApplyAdminModals.tsx");
const trialClient = read("../src/app/admin/trial/TrialCrmClient.tsx");

// 함수 본문만 잘라 본다(다른 화면 부분의 문자열에 걸리지 않게)
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 함수가 있어야 합니다`);
  const next = source.indexOf("\n    function ", start + 10);
  return source.slice(start, next > 0 ? next : undefined);
}

test("공통 목록 표는 글자 왼쪽·숫자 오른쪽(tabular-nums)·내용 폭 규칙을 opt-in 클래스로 건다", () => {
  assert.match(globalsCss, /table\.admin-list-table \{\s*table-layout: auto;/);
  assert.match(globalsCss, /table\.admin-list-table td \{\s*text-align: left !important;\s*white-space: nowrap;/);
  assert.match(globalsCss, /\.admin-cell-num \{\s*text-align: right !important;\s*font-variant-numeric: tabular-nums;/);
});

test("상세 패널은 공통 모달의 포커스·Esc·바깥 클릭 처리를 그대로 쓰고 배치만 바꾼다", () => {
  assert.match(panel, /<AdminModal[\s\S]*layout="side"/);
  assert.match(adminModal, /layout\?: "center" \| "side"/);
  assert.match(adminModal, /md:w-\[420px\]/);
  assert.match(adminModal, /rounded-t-2xl/);
});

test("상태 칩은 누르면 그 상태, 다시 누르면 전체로 돌아가고 44px 터치 영역을 지킨다", () => {
  assert.match(chips, /onSelect\(active \? allValue : item\.value\)/);
  assert.match(chips, /aria-pressed=\{active\}/);
  assert.match(chips, /min-h-11/);
  assert.match(chips, /tabular-nums/);
});

test("보기 전환은 aria-pressed 2칸 버튼이고 선택을 localStorage 에 기억한다", () => {
  assert.match(toggle, /aria-pressed=\{selected\}/);
  assert.match(toggle, /min-h-11/);
  assert.match(toggle, /window\.localStorage\.getItem\(storageKey\)/);
  assert.match(toggle, /window\.localStorage\.setItem\(storageKey, next\)/);
});

test("수강신청·체험 목록은 공통 부품을 쓰고 칩은 기존 상태 필터(filter)와 같은 값을 공유한다", () => {
  for (const source of [applyClient, trialClient]) {
    assert.match(source, /<table className="admin-list-table/);
    assert.match(source, /<StatusCountChips[\s\S]*?selected=\{filter\}[\s\S]*?onSelect=\{setFilter\}/);
    assert.match(source, /<ListViewToggle/);
    assert.match(source, /useRememberedListView\(/);
    assert.match(source, /scope="rowgroup"/);
  }
  // 상세는 패널로 연다(내용·기능은 기존 상세 모달 그대로)
  assert.match(applyModals, /<ListDetailPanel onClose=\{onClose\} titleId="application-detail-title"/);
  assert.match(trialClient, /<ListDetailPanel onClose=\{onClose\} titleId="trial-detail-modal-title"/);
});

test("목록 행은 한 줄이고 말줄임(truncate)을 쓰지 않는다 — 긴 값은 짧은 표기, 전체는 상세 패널", () => {
  const applyRow = functionBody(applyClient, "renderApplicationRow");
  const trialRow = functionBody(trialClient, "renderTrialRow");
  for (const row of [applyRow, trialRow]) {
    assert.doesNotMatch(row, /truncate|text-ellipsis/);
  }
  // 셔틀은 주소 대신 «이용/미이용», 희망 수업은 «화4» 같은 짧은 표기
  assert.match(applyRow, /app\.shuttleNeeded \? "이용" : "미이용"/);
  assert.match(applyRow, /formatPreferredSlotsShort\(/);
  // 날짜 칸은 오른쪽 정렬
  assert.match(applyRow, /admin-cell-num[^"]*">\{formatDate\(app\.createdAt\)\}/);
  assert.match(trialRow, /admin-cell-num/);
});

// 목록 개편 2단계(원생 관리) — 1단계 부품·규칙을 그대로 쓴다
const studentsClient = read("../src/app/admin/students/StudentManagementClient.tsx");

test("원생 관리: 공통 표 규칙·상태 칩(filterStatus 공유, 다시 누르면 기본값 ACTIVE)·보기 전환(기존 기억 키)", () => {
  assert.match(studentsClient, /<table className="admin-list-table/);
  assert.match(studentsClient, /<StatusCountChips[\s\S]*?selected=\{filterStatus\}[\s\S]*?onSelect=\{applyStatusFilter\}[\s\S]*?allValue=\{DEFAULT_STATUS_FILTER\}/);
  assert.match(studentsClient, /const DEFAULT_STATUS_FILTER = "ACTIVE"/);
  // 필터 초기화도 같은 기본값으로 돌아간다
  assert.match(studentsClient, /setFilterStatus\(DEFAULT_STATUS_FILTER\)/);
  assert.match(studentsClient, /<ListViewToggle/);
  assert.match(studentsClient, /useRememberedListView\(STUDENT_VIEW_STORAGE_KEY/);
  assert.match(studentsClient, /STUDENT_VIEW_STORAGE_KEY = "admin-students-view-mode"/);
});

test("원생 관리: 행 클릭은 상세 패널, 이름 링크·⚡ 는 전파 차단, 행 키보드는 안쪽 버튼을 가로채지 않는다", () => {
  assert.match(studentsClient, /<ListDetailPanel onClose=\{\(\) => setDetailStudentId\(null\)\} titleId="student-detail-panel-title"/);
  assert.match(studentsClient, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(studentsClient, /admin-cell-center px-2 py-1\.5" onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(studentsClient, /href=\{`\/admin\/students\/\$\{s\.id\}`\}[\s\S]*?onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  // 패널 안에서도 상세 페이지로 갈 수 있다
  assert.match(studentsClient, /상세 페이지 열기/);
  // 활성인데 반이 없으면 «반 없음» 으로 분명히
  assert.match(studentsClient, /status === "ACTIVE"\) \{[\s\S]*?반 없음/);
  // 목록·반별 행 어디에도 말줄임을 쓰지 않는다
  assert.doesNotMatch(studentsClient, /\btruncate\b|text-ellipsis/);
});

// 목록 개편 3단계(청구·수납) — 같은 부품·규칙. 조회·저장·금액 계산은 그대로, 보이는 모양만
const financeClient = read("../src/app/admin/finance/FinanceClient.tsx");

test("청구·수납: 공통 표 규칙(금액·날짜 오른쪽)·상태 칩(paymentStatusFilter 공유, 다시 누르면 전체)·상태별 묶음·행 클릭 패널", () => {
  assert.match(financeClient, /<table className="admin-list-table/);
  // 금액·납부기한은 오른쪽 + 자릿수 폭 고정
  assert.match(financeClient, /admin-cell-num[^"]*">\{formatAmount\(p\.amount\)\}/);
  assert.match(financeClient, /admin-cell-num[^"]*">\{toDateStr\(p\.dueDate\)\}/);
  // 칩은 필터 select 와 같은 값, 다시 누르면 ""(필터 초기화와 같은 값)
  assert.match(financeClient, /<StatusCountChips[\s\S]*?selected=\{paymentStatusFilter\}[\s\S]*?onSelect=\{applyPaymentStatusFilter\}[\s\S]*?allValue=""/);
  assert.match(financeClient, /setPaymentStatusFilter\(""\)/);
  // 실제 저장되는 취소 값은 CANCELED(옛 select 의 CANCELLED 는 아무것도 못 찾았다)
  assert.match(financeClient, /<option value="CANCELED">/);
  assert.doesNotMatch(financeClient, /"CANCELLED"/);
  // 보기 전환 «목록 | 상태별», 상태별 머리줄은 건수 + 금액 합계
  assert.match(financeClient, /<ListViewToggle/);
  assert.match(financeClient, /useRememberedListView\(FINANCE_VIEW_STORAGE_KEY/);
  assert.match(financeClient, /scope="rowgroup"[\s\S]*?건 · 합계/);
  // 행 클릭 패널, 행 키보드는 안쪽 체크박스·⚡ 를 가로채지 않는다, 패널 작업은 행 ⚡ 와 같은 목록
  assert.match(financeClient, /<ListDetailPanel onClose=\{\(\) => setDetailPaymentId\(null\)\} titleId="payment-detail-panel-title"/);
  assert.match(financeClient, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(financeClient, /admin-cell-center px-2 py-1\.5" onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(financeClient, /const detailActions = buildRowActions\(d\)/);
  // 목록 행에 말줄임 없음
  const row = financeClient.slice(financeClient.indexOf("function renderPaymentRow("), financeClient.indexOf("const paymentColumnCount"));
  assert.ok(row.length > 100, "renderPaymentRow 가 있어야 합니다");
  assert.doesNotMatch(row, /\btruncate\b|text-ellipsis|line-clamp/);
});
