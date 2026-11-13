import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// 2026-11-09 원장 점검: «정류장 수정만 있고 시간 수정 없음. 수정 누르고 드래그앤드랍으로 이동하도록».
// → 관리자 운행표 = 평소엔 보기만, 화면 위 [수정] 하나로 편집 모드(시각 칸·손잡이 끌기·▲▼·정류장 수정·×).
// 카드 틀(RunBoard)을 실제로 그려 본다. 기사님 모드(driver)는 이번 변경과 무관해야 한다.

const require = createRequire(import.meta.url);
const transpile = (src) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

// CSS 모듈은 클래스 이름 그대로, 지도 링크 모듈은 실제 파일을 변환해 붙인다.
const links = { exports: {} };
new Function("require", "module", "exports", transpile(await readFile("src/lib/maps/coordinate-links.ts", "utf8")))(require, links, links.exports);
// 묶음 나누기(순수 모듈)도 실제 파일을 변환해 붙인다.
const blocksMod = { exports: {} };
new Function("require", "module", "exports", transpile(await readFile("src/lib/shuttle/runBlocks.ts", "utf8")))(require, blocksMod, blocksMod.exports);
const fakeRequire = (id) => {
  if (id.endsWith(".module.css")) return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : String(k)) });
  if (id === "@/lib/maps/coordinate-links") return links.exports;
  if (id === "@/lib/shuttle/runBlocks") return blocksMod.exports;
  return require(id);
};
const loaded = { exports: {} };
new Function("require", "module", "exports", transpile(await readFile("src/components/shuttle/run/RunBoard.tsx", "utf8")))(fakeRequire, loaded, loaded.exports);
const RunBoard = loaded.exports.default;

const ROWS = [
  { key: "R:16:30:a:0", kind: "REGULAR", direction: "PICKUP", groupKey: "g1", groupLabel: "🕒 16:30 수업 · 등원", label: "A아파트 정문", subLabel: null,
    time: "16:10", minutes: 970, seq: 0, lat: 37.6, lng: 127.1, isHub: false, isTerminal: false, pending: false, warn: false,
    riders: [{ checkId: "row-1", key: "R:row-1", name: "김가나", grade: "초3" }] },
  { key: "R:16:30:b:1", kind: "REGULAR", direction: "PICKUP", groupKey: "g1", groupLabel: "🕒 16:30 수업 · 등원", label: "B초등학교 후문", subLabel: null,
    time: null, minutes: null, seq: 1, lat: null, lng: null, isHub: false, isTerminal: false, pending: false, warn: false,
    riders: [{ checkId: "row-2", key: "R:row-2", name: "이다라", grade: null }] },
];
const render = (props) => renderToStaticMarkup(React.createElement(RunBoard, {
  rows: ROWS, dragKey: null, onDragKeyChange() {}, onDropOn() {}, onMove() {}, displayTime: (r) => r.time, onTimeChange() {},
  renderRider: (row, rider) => React.createElement("div", { key: rider.checkId }, rider.name), ...props,
}));

test("관리자 보기 모드: 시각·번호만 보이고 편집 손잡이·시각 칸은 없다", () => {
  const html = render({ mode: "admin", editing: false });
  assert.match(html, /16:10/);
  assert.match(html, /시간 미정/);
  assert.doesNotMatch(html, /type="time"|drag_indicator|순서 위로|data-run-key/);
  // 길안내는 기사님 화면에만
  assert.doesNotMatch(html, /길안내/);
});

test("관리자 편집 모드: 카드마다 시각 칸 + 끌기 손잡이 + ▲▼, 카드 자체는 스크롤을 막지 않는다", () => {
  const html = render({ mode: "admin", editing: true });
  assert.equal((html.match(/type="time"/g) ?? []).length, 2);
  assert.match(html, /aria-label="A아파트 정문 정차 시간"/);
  assert.equal((html.match(/drag_indicator/g) ?? []).length, 2);
  // 리뷰 반영: 손잡이는 탭 순서에서 빼고(▲▼ 가 키보드 대안) 이름표로 안내
  assert.match(html, /tabindex="-1" aria-label="A아파트 정문 끌어서 순서 옮기기 · ▲▼ 버튼으로도 옮길 수 있어요"/);
  assert.match(html, /aria-label="B초등학교 후문 순서 아래로"/);
  assert.equal((html.match(/data-run-key=/g) ?? []).length, 2);
  // 손잡이만 touch-none(카드 위에서는 화면 스크롤 가능), 기본 끌기(draggable)는 쓰지 않는다
  assert.doesNotMatch(html, /draggable="true"/);
  assert.doesNotMatch(html, /<li[^>]*touch-none/);
});

test("가장자리 자동 스크롤: 손가락이 멈춰도 rAF 루프로 계속, 끌기 끝·화면 떠나면 정지", async () => {
  const board = await readFile("src/components/shuttle/run/RunBoard.tsx", "utf8");
  assert.match(board, /scrollFrame\.current = requestAnimationFrame\(autoScrollStep\)/);
  // 2026-11-09 3차(실시간 재배치): 놓기·취소(finishDrag) 첫머리에서 바로 정지 + 창 감시(Esc·스크롤) 해제.
  assert.match(board, /s\.settling = true;\s*stopAutoScroll\(\);\s*s\.detach\(\);/);
  // 화면을 떠나면 스크롤 루프·안착 타이머·창 감시 정지
  assert.match(board, /useEffect\(\(\) => \(\) => \{\s*stopAutoScroll\(\);\s*if \(settleTimer\.current != null\) window\.clearTimeout\(settleTimer\.current\);/);
  assert.match(board, /if \(session\.current\) \{\s*session\.current\.detach\(\);/);
  // 스크롤로 카드 위치가 바뀌면 그 프레임에 끄는 카드·밀린 카드를 다시 맞춘다
  assert.match(board, /window\.scrollBy\(0, dy\);\s*updateDrag\(\);/);
});

test("기사님 모드: 보기 화면은 그대로, 편집 때 카드 전체 끌기(실시간 재배치 · 손잡이 없음 · 넓은 시각 칸)", () => {
  const view = render({ mode: "driver", editing: false });
  // 2026-11-09 2차: 기사님 화면에도 묶음 머리(글자만, 버튼 아님)가 붙는다 — 카드 안 마크업·탑승 버튼은 그대로.
  assert.match(view, /<h3[^>]*>[\s\S]*16:30 수업 · 등원[\s\S]*정류장 2곳 · 학생 2명 · 16:10<\/span><\/h3>/);
  assert.doesNotMatch(view, /aria-pressed|지도 보기|data-drop-line/);
  assert.match(view, /길안내/);
  assert.doesNotMatch(view, /drag_indicator|data-run-key/);
  const edit = render({ mode: "driver", editing: true });
  // 2026-11-09 3차: 브라우저 기본 끌기(draggable) 대신 관리자와 같은 포인터 끌기 — 묶음 계산용 data-run-key/group 이 붙는다.
  assert.doesNotMatch(edit, /draggable="true"/);
  assert.match(edit, /<li[^>]*touch-none cursor-grab/);
  assert.equal((edit.match(/<li[^>]*data-run-key="[^"]+" data-run-group="g1"[^>]*style="touch-action:none"/g) ?? []).length, 2);
  assert.match(edit, /col-span-3 mt-2 h-12 w-full/);
  assert.doesNotMatch(edit, /drag_indicator/);
});

test("관리자 묶음 편집(2026-11-10): 머리마다 작은 연필 · 고른 묶음만 편집 카드 · 그 머리 줄에 [취소][저장]·아래 적용 범위", () => {
  const TWO = [...ROWS, { ...ROWS[0], key: "R:17:a:0", groupKey: "g2", groupLabel: "🕒 17:00~18:00 수업", label: "C마을", time: "16:40", minutes: 1000, seq: 2,
    riders: [{ checkId: "row-3", key: "R:row-3", name: "박마바", grade: null }] }];
  const base = { rows: TWO, mode: "admin", onEditBlock() {}, renderEditActions: () => React.createElement("button", { type: "button" }, "저장"),
    renderEditBar: () => React.createElement("div", { "data-edit-bar": "" }, "적용 범위") };
  // 보기 = 묶음마다 연필(이름표 «16:30 등원 묶음 수정»), 원 36px 시각·누르는 자리 44px · 편집 카드·[저장] 없음
  const view = render({ ...base, editing: false, editingGroupKey: null });
  assert.equal((view.match(/묶음 수정"/g) ?? []).length, 2);
  assert.match(view, /aria-label="16:30 등원 묶음 수정"/);
  assert.match(view, /aria-label="17:00 등원 묶음 수정"/);
  // 2026-11-13 UI 통일(원장 «아이콘 빼고 글자로»): 연필 아이콘 원 → 글자 «수정» 작은 보조 버튼(PC 36px · 터치 44px). 이름표는 위 단언 그대로.
  assert.match(view, /<button type="button" aria-label="16:30 등원 묶음 수정"[^>]*class="academy-button-secondary academy-button-sm shrink-0">수정<\/button>/);
  assert.doesNotMatch(view, />edit<\/span>/);
  assert.doesNotMatch(view, /drag_indicator|type="time"|data-edit-bar|>저장</);
  // g1 편집 = g1 카드 2장만 손잡이·시각 칸, g1 머리에는 연필 대신 [저장]·아래 줄, g2 는 연필 그대로
  const edit = render({ ...base, editing: true, editingGroupKey: "g1" });
  assert.equal((edit.match(/drag_indicator/g) ?? []).length, 2);
  assert.equal((edit.match(/type="time"/g) ?? []).length, 2);
  assert.equal((edit.match(/data-run-group="g2"/g) ?? []).length, 0);
  assert.equal((edit.match(/묶음 수정"/g) ?? []).length, 1);
  assert.match(edit, /aria-label="17:00 등원 묶음 수정"/);
  assert.equal((edit.match(/>저장</g) ?? []).length, 1);
  assert.equal((edit.match(/data-edit-bar/g) ?? []).length, 1);
  // 편집 중 머리는 관리자 머리 아래에 붙어 따라온다
  assert.match(edit, /class="sticky top-14 z-10[^"]*"/);
  // 기사님 화면(연필·묶음 편집 props 없음)에는 연필이 없다
  assert.doesNotMatch(render({ rows: TWO, mode: "driver", editing: true }), /묶음 수정/);
});

test("관리자 화면 배선: 묶음 연필 → 그 묶음만 편집 모드, 정류장 수정·×·학생 창은 편집 묶음에서만, 창 열기 전 순서 먼저 저장", async () => {
  const editor = await readFile("src/app/admin/shuttle/regular-dispatch/RegularRunEditor.tsx", "utf8");
  // 화면 위 [수정] 버튼 없음(옛 «↕ 순서·시간 수정»도 없음) — 묶음 머리 연필(onEditBlock)로 들어간다
  assert.doesNotMatch(editor, /onClick=\{startEditing\}|>edit<\/span>수정/);
  assert.doesNotMatch(editor, /↕ 순서·시간 수정|기사님 화면과 같음/);
  assert.match(editor, /editingGroupKey=\{editingGroup\}\s*onEditBlock=\{startEditing\}\s*renderEditActions=\{renderEditActions\}\s*renderEditBar=\{renderEditBar\}/);
  // 다른 묶음으로 옮길 때 저장 안 한 변경이 있으면 확인
  assert.match(editor, /if \(orderDirty && !window\.confirm\("저장하지 않은 순서·시각 수정이 있습니다\. 버리고 이 묶음을 수정할까요\?"\)\) return;/);
  assert.doesNotMatch(editor, /sticky top-0/);
  // 적용 범위 옆에 어느 달 명단에 반영되는지 짧게
  assert.match(editor, /formatRosterMonths\(\[serviceMonth, \.\.\.laterMonths\]\)\} 명단에 반영/);
  // 2026-11-13 UI 통일: 임의 크기 text-[12px] → text-xs(같은 12px), 보조 설명은 굵기 없음.
  assert.match(editor, /<span className="text-xs font-normal">\{scopeHint\}<\/span>/);
  // 보기 묶음에는 편집 버튼이 없다
  assert.match(editor, /\{rowEditing && row\.kind === "REGULAR" && row\.riders\.length > 0 && \(/);
  // 2026-11-09 2차: 편집 모드 학생 = 한 줄 카드 안 칩(이름 → 셔틀 정보 창 · × → 빼기). 보기 모드 학생 줄엔 둘 다 없다.
  const riderFn = editor.slice(editor.indexOf("function renderRider("), editor.indexOf("  return (\n    <div className=\"mx-auto max-w-6xl"));
  const [chip, viewRider] = riderFn.split(/\n    \}\n    return \(/);
  assert.ok(viewRider, "편집 칩(if (editingGroup === row.groupKey) { … })과 보기 줄이 나뉘어 있어야 한다");
  assert.match(chip, /if \(editingGroup === row\.groupKey\) \{\s*return \(\s*<span key=/);
  assert.match(chip, /openDialog\(\{ kind: "student", rowId: rider\.checkId \}\)[\s\S]*openDialog\(\{ kind: "remove", rowId: rider\.checkId \}\)/);
  assert.doesNotMatch(viewRider, /kind: "remove"|kind: "student"/);
  // 바꾼 순서·시각이 있으면 창을 열기 전에 먼저 저장(편집 모드 유지)
  assert.match(editor, /if \(!window\.confirm\("바꾼 순서·시각을 먼저 저장할까요\?"\)\) return;\s*if \(await saveOrder\(true\)\) open\(\);/);
  // 저장 안 한 변경이 없으면 이동 확인을 띄우지 않는다
  assert.match(editor, /function confirmLeave\(\) \{ return !orderDirty \|\|/);
});
