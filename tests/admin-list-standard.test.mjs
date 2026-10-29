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
