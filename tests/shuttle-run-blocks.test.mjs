import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// 2026-11-09 원장 점검(2차): «등원·하원 섹션별 묶음이 없어져 구분이 안 된다 · 끌어서 옮기는 게 안 보인다 ·
// 관리자 수정 화면 공간 낭비 · PC 에선 지도가 블록 옆에».
// → 운행표를 «수업시간 × 방향» 블록으로 묶고(기사님·관리자 공통), 관리자 편집 카드는 한 줄, 끌기는 떠다니는 카드·삽입선,
//   PC 관리자 화면 오른쪽에 고른 묶음의 노선 지도.

const require = createRequire(import.meta.url);
const transpile = (src) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const load = async (file, req = require) => {
  const mod = { exports: {} };
  new Function("require", "module", "exports", transpile(await readFile(file, "utf8")))(req, mod, mod.exports);
  return mod.exports;
};
const blocks = await load("src/lib/shuttle/runBlocks.ts");
const links = await load("src/lib/maps/coordinate-links.ts");
const RunBoard = (await load("src/components/shuttle/run/RunBoard.tsx", (id) => {
  if (id.endsWith(".module.css")) return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : String(k)) });
  if (id === "@/lib/maps/coordinate-links") return links;
  if (id === "@/lib/shuttle/runBlocks") return blocks;
  return require(id);
})).default;

const row = (groupKey, i, o = {}) => ({
  key: `${groupKey}:${i}`, kind: "REGULAR", direction: groupKey.includes("alight") ? "DROPOFF" : "PICKUP", groupKey,
  groupLabel: `🕒 ${groupKey.match(/\d\d:\d\d~\d\d:\d\d/)[0]} 수업`, label: `정류장${i}`, subLabel: null, time: `15:${10 + i}`, minutes: 910 + i, seq: i,
  lat: 37.6, lng: 127.1, isHub: false, isTerminal: false, pending: false, warn: false,
  riders: [{ key: `R:${groupKey}${i}`, checkId: `${groupKey}${i}`, kind: "REGULAR", name: `학생${i}` }], ...o,
});

test("묶음 나누기: 순서는 그대로, 이어지는 같은 묶음만 한 블록 · 끊겼다 이어지면 «이어서»", () => {
  const rows = [row("R:16:00~17:00:board", 0), row("R:16:00~17:00:board", 1), row("R:16:00~17:00:alight", 2), row("R:16:00~17:00:board", 3)];
  const out = blocks.groupRunBlocks(rows);
  assert.deepEqual(out.map((b) => [b.label, b.continued, b.rows.map((r) => r.key)]), [
    ["16:00~17:00 수업 · 등원", false, ["R:16:00~17:00:board:0", "R:16:00~17:00:board:1"]],
    ["16:00~17:00 수업 · 하원", false, ["R:16:00~17:00:alight:2"]],
    ["16:00~17:00 수업 · 등원", true, ["R:16:00~17:00:board:3"]],
  ]);
  // 블록을 이어 붙이면 원래 목록과 같다(기사님 운행 순서 보존).
  assert.deepEqual(out.flatMap((b) => b.rows), rows);
  assert.equal(new Set(out.map((b) => b.key)).size, out.length, "React key 는 겹치지 않는다");
});

test("묶음 머리 글자: 그림문자를 떼고 방향을 붙인다(이미 있으면 그대로) · 특강은 «특강 · 방향 · 차량»", () => {
  assert.equal(blocks.runBlockLabel({ kind: "REGULAR", direction: "PICKUP", groupLabel: "🕒 17:00 수업" }), "17:00 수업 · 등원");
  assert.equal(blocks.runBlockLabel({ kind: "REGULAR", direction: "DROPOFF", groupLabel: "🕒 17:00 수업 · 하원" }), "17:00 수업 · 하원");
  assert.equal(blocks.runBlockLabel({ kind: "REGULAR", direction: "DROPOFF", groupLabel: null }), "정규 · 하원");
  assert.equal(blocks.runBlockLabel({ kind: "SEASONAL", direction: "PICKUP", groupLabel: "🚐 1호차 · 1회차" }), "특강 · 등원 · 1호차 · 1회차");
  assert.equal(blocks.runBlockLabel({ kind: "SEASONAL", direction: "DROPOFF", groupLabel: null }), "특강 · 하원");
});

const ROWS = [row("R:16:00~17:00:board", 0), row("R:16:00~17:00:board", 1), row("R:17:00~18:00:board", 2)];
const render = (props) => renderToStaticMarkup(React.createElement(RunBoard, {
  rows: ROWS, dragKey: null, onDragKeyChange() {}, onDropOn() {}, onMove() {}, displayTime: (r) => r.time, onTimeChange() {},
  renderRider: (r, rider) => React.createElement("span", { key: rider.checkId }, rider.name), ...props,
}));

test("관리자 편집: 블록 머리(누르면 지도) + 한 줄 카드(넓은 2칸 격자 아님) + 시각 칸 폭 확보", () => {
  const html = render({ mode: "admin", editing: true, selectedGroupKey: "R:17:00~18:00:board", onSelectBlock() {} });
  assert.equal((html.match(/<section /g) ?? []).length, 2);
  assert.match(html, /aria-pressed="false"[^>]*>[\s\S]*?16:00~17:00 수업 · 등원[\s\S]*?정류장 2곳 · 학생 2명 · 15:10~15:11/);
  assert.match(html, /aria-pressed="true"[\s\S]*?지도에 표시 중/);
  // 한 줄 카드 — 기사님 카드 틀(styles.stop = PC 에서 2칸 격자)·넓은 시각 칸을 쓰지 않는다.
  const cards = html.match(/<li [^>]*data-run-key[^>]*>/g) ?? [];
  assert.equal(cards.length, 3);
  for (const li of cards) { assert.match(li, /lg:flex-nowrap/); assert.doesNotMatch(li, /academy-driver-stop|rounded-2xl border p-3/); }
  assert.match(html, /type="time"[^>]*class="h-11 w-\[8\.75rem\] shrink-0[^"]*tabular-nums/);
  // 끌기 범위 = 같은 묶음(카드에 묶음 키를 달아 손가락 위치와 비교한다).
  assert.equal((html.match(/data-run-group="R:16:00~17:00:board"/g) ?? []).length, 2);
  // 손잡이 touch-action 은 인라인으로(테마의 button{touch-action:manipulation} 이 클래스를 이긴다).
  assert.equal((html.match(/style="touch-action:none"/g) ?? []).length, 3);
  // 끌기 전에는 떠다니는 카드·삽입선이 없다.
  assert.doesNotMatch(html, /shadow-2xl|data-drop-line/);
});

test("관리자 보기 모드·기사님 화면: 블록 머리는 있고 카드 틀은 예전 그대로", () => {
  const view = render({ mode: "admin", editing: false, onSelectBlock() {} });
  assert.match(view, /<li draggable="false" class="[^"]*academy-driver-stop rounded-2xl border p-3/);
  const driver = render({ mode: "driver", editing: false });
  assert.match(driver, /<h3 [^>]*>[\s\S]*?17:00~18:00 수업 · 등원/);
  assert.doesNotMatch(driver, /<button[^>]*aria-pressed/);
});

test("끌기 배선(3차 실시간 재배치): 끄는 카드가 따라오고 다른 카드가 밀림 · 놓을 때 한 번만 순서 변경 · 취소는 그대로", async () => {
  const board = await readFile("src/components/shuttle/run/RunBoard.tsx", "utf8");
  // 삽입선·따로 떠다니는 카드(ghost)는 없앴다 — 카드 자체가 transform 으로 움직인다.
  assert.doesNotMatch(board, /data-drop-line|ghostRef/);
  assert.match(board, /cards\[from\]\.style\.transform = `translateY\(\$\{top - tops\[from\]\}px\) scale\(1\.02\)`;/);
  // 지나간 카드만 한 칸(끄는 카드 높이 + 틈)씩 밀린다.
  assert.match(board, /const shift = from < target && i > from && i <= target \? -s\.step : target < from && i >= target && i < from \? s\.step : 0;/);
  // 끄는 중에는 순서를 바꾸지 않는다 — onDropOn 은 finishDrag 의 안착 뒤 flushSync 안에서 단 한 번.
  assert.equal((board.match(/onDropOn\(/g) ?? []).length, 1);
  assert.match(board, /flushSync\(\(\) => \{[\s\S]{0,200}latest\.current\.onDropOn\(targetRow\);\s*latest\.current\.onDragKeyChange\(null\);/);
  // 취소(Esc·pointercancel)는 원래 자리로(target = from) — 순서 그대로.
  assert.match(board, /const target = commit \? s\.target : from;/);
  assert.match(board, /if \(e\.key === "Escape"\) finishDrag\(false\);/);
  assert.equal((board.match(/onPointerCancel=\{\(event\) => endPointer\(event, false\)\}/g) ?? []).length, 2);
  assert.match(board, /prefers-reduced-motion: reduce/);
  assert.match(board, /reduce \? "none" : `transform \$\{SHIFT_MS\}ms \$\{EASE\}`/);
  // 리뷰 반영: 못 옮길 때는 위치를 기억하지 않고, 기억값은 한 프레임 뒤 버린다 · 왼쪽 버튼만 끌기
  assert.match(board, /if \(same\[same\.findIndex\(\(r\) => r\.key === row\.key\) \+ dir\]\) rememberPositions\(\);/);
  assert.match(board, /requestAnimationFrame\(\(\) => \{ if \(flipFrom\.current === map\) flipFrom\.current = null; \}\);/);
  assert.match(board, /if \(event\.button !== 0 \|\| session\.current \|\| pending\.current \|\| !cardEl\) return;/);
  // 리뷰 반영(3차 권장 4건)
  // (1) 끌기 범위 = 누른 카드가 든 블록(section) 안 — «(이어서)» 블록 사이에 다른 묶음이 끼어도 블록 간 거리를 한 칸으로 재지 않는다.
  assert.match(board, /const scope = cardEl\.closest\("section"\) \?\? listRef\.current;/);
  // (2) 포인터 붙잡기가 풀리면 취소(카드 줄·손잡이 둘 다) · 언마운트 때 안착 타이머 지우고 «끄는 중» 표시 해제
  assert.equal((board.match(/onLostPointerCapture=\{\(event\) => endPointer\(event, false\)\}/g) ?? []).length, 2);
  assert.match(board, /if \(settleTimer\.current != null\) window\.clearTimeout\(settleTimer\.current\);/);
  assert.match(board, /session\.current\.detach\(\);\s*session\.current = null;\s*latest\.current\.onDragKeyChange\(null\);/);
  // (3) 끌기를 시작한 포인터만 — 움직임·떼기·취소 모두 ownPointer 로 거른다
  assert.match(board, /return id != null && id === event\.pointerId;/);
  assert.match(board, /function moveDrag\(event: PointerEvent<HTMLElement>\) \{\s*if \(!ownPointer\(event\)\) return;/);
  assert.match(board, /function endPointer\(event: PointerEvent<HTMLElement>, commit: boolean\) \{\s*if \(!ownPointer\(event\)\) return;/);
  // (4) LIFT_PX(5px) 움직여야 들어 올린다 — 그 전에 떼면 그냥 탭(아무것도 안 바뀜)
  assert.match(board, /const LIFT_PX = 5;/);
  assert.match(board, /if \(Math\.abs\(event\.clientY - p\.startClientY\) < LIFT_PX\) return;\s*liftDrag\(p, event\.clientY\);/);
  assert.match(board, /if \(pending\.current\) \{ pending\.current = null; return; \}/);
  // 순서 덮어쓰기·저장은 여전히 바깥(관리자 화면)의 일 — 카드 틀은 저장 API 를 모른다.
  assert.doesNotMatch(board, /\/api\//);
});

test("관리자 PC 지도: 기존 카카오 지도 부품 재사용 · 넓은 화면에서만 만들고 sticky · 블록 머리로 고른다", async () => {
  const editor = await readFile("src/app/admin/shuttle/regular-dispatch/RegularRunEditor.tsx", "utf8");
  assert.match(editor, /import \{ RouteMapCanvas, type RouteMapStop \} from "@\/components\/seasonal\/DispatchRouteMap";/);
  assert.match(editor, /window\.matchMedia\("\(min-width: 1024px\)"\)/);
  assert.match(editor, /<aside aria-label="노선 지도" className="hidden lg:sticky lg:top-\[4\.5rem\] lg:block">/);
  assert.match(editor, /\{wide\s*\? <RouteMapCanvas start=\{null\} end=\{null\} stops=\{mapStops\}/);
  assert.match(editor, /selectedGroupKey=\{wide \? mapGroupKey : null\}[\s\S]{0,120}onSelectBlock=\{wide \? setPickedGroup : undefined\}/);
  // 리뷰 반영: 지도는 좌표·이름·순번 문자열이 바뀔 때만 다시 그린다(시각 입력 때 확대·위치 초기화 방지)
  assert.match(editor, /const mapStops = useMemo\(\(\) => mapStopsNow, \[mapStopsKey\]\);/);
  // 리뷰 반영: 편집 칩 «반 이동»도 44px
  assert.doesNotMatch(editor, /min-h-9/);
  // 마커 번호 = 카드 순번(stopRows 순서 + 1)
  assert.match(editor, /\.map\(\(r, i\) => \(\{ row: r, badge: String\(i \+ 1\) \}\)\)/);
});
