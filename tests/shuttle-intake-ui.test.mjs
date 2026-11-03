import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const FILE = "src/components/shuttle/intake/ShuttleIntakeClient.tsx";
const item = (id = "app-1") => ({
 applicationId: id, studentId: "student-1", studentName: "합성 학생", grade: "초3", requestedStartOn: "2026-11-09", requestedTime: "16:40", fingerprint: "fingerprint-current",
 classes: ["Mon", "Wed"].map(dayOfWeek => ({ id: dayOfWeek, name: "합성 수업", dayOfWeek, startTime: "17:00", endTime: "17:55" })),
 locations: [{ kind: "PICKUP", name: "합성 정류장", address: "합성 위치", latitude: 37, longitude: 127 }],
 progress: { status: "ROSTER_PENDING", label: "배차 대기", detail: "명단 반영이 필요합니다.", rosterHref: "/admin/shuttle/regular?month=2026-11&studentId=student-1", dispatchHref: "/admin/shuttle/regular-dispatch?month=2026-11&studentId=student-1" },
 review: { id: "review-1", driverUserId: "driver-1", driverName: "합성 기사", status: "PENDING", note: null, proposals: [], requestedAt: "2026-11-03", reviewedAt: null },
});
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(mode, items = [item()]) {
 const scopes = new Map(), requests = [], effects = []; let current = null, cursor = 0, getData = { serviceMonth: "2026-11", items, page: 1, hasMore: false, drivers: [{ id: "driver-1", name: "합성 기사" }] }, failure = null, postHandler = null, getHandler = null;
 const state = () => { assert.ok(current); return scopes.get(current); };
 const react = {
  useState(initial) { const s = state(), i = cursor++; if (!(i in s.values)) s.values[i] = typeof initial === "function" ? initial() : initial; return [s.values[i], value => { s.values[i] = typeof value === "function" ? value(s.values[i]) : value; }]; },
  useRef(initial) { const s = state(), i = cursor++; if (!(i in s.values)) s.values[i] = { current: initial }; return s.values[i]; },
  useCallback(fn) { cursor++; return fn; },
  useEffect(fn, deps) { const s = state(), i = cursor++; const old = s.effects[i]; if (!old || deps.some((value, at) => value !== old.deps[at])) { old?.cleanup?.(); const record = { deps, cleanup: null }; s.effects[i] = record; effects.push(() => { record.cleanup = fn(); }); } },
 };
 const exported = {};
 const code = ts.transpileModule(readFileSync(FILE, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 vm.runInNewContext(code, { exports: exported, require(name) { if (name === "react") return react; if (name === "react/jsx-runtime") return jsx; if (name === "next/link") return { default: props => jsx.jsx("a", props) }; throw new Error(`Unexpected import: ${name}`); }, AbortController, Error, fetch: async (url, options = {}) => {
  requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
  if (options.method === "POST" && postHandler) return postHandler(url, options);
  if (!options.method && getHandler) return getHandler(url, options);
  if (failure && (failure.method === (options.method ?? "GET"))) return { ok: false, json: async () => ({ error: failure.message }) };
  return { ok: true, json: async () => options.method === "POST" ? { ok: true } : structuredClone(getData) };
 } });
 function expand(node) {
  if (Array.isArray(node)) return node.map((child, index) => { const expanded = expand(child); return React.isValidElement(expanded) ? React.cloneElement(expanded, { key: expanded.key ?? index }) : expanded; });
  if (!React.isValidElement(node)) return node;
  if (typeof node.type === "function") {
   const previous = current, previousCursor = cursor;
   current = `${node.type.name}:${node.key ?? "root"}`; cursor = 0;
   if (!scopes.has(current)) scopes.set(current, { values: [], effects: [] });
   const result = node.type(node.props); current = previous; cursor = previousCursor; return expand(result);
  }
  return React.cloneElement(node, node.props, expand(node.props.children));
 }
 const render = () => expand(jsx.jsx(exported.default, { mode, initialMonth: "2026-11" }));
 function all(node, predicate, found = []) { if (Array.isArray(node)) node.forEach(n => all(n, predicate, found)); else if (React.isValidElement(node)) { if (predicate(node)) found.push(node); all(node.props.children, predicate, found); } return found; }
 const text = node => Array.isArray(node) ? node.map(text).join("") : React.isValidElement(node) ? node.props["aria-hidden"] ? "" : text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
 async function settle() { for (let i = 0; i < 3; i++) { render(); effects.splice(0).forEach(run => run()); await tick(); } }
 function control(label, index = 0) { const labels = all(render(), n => n.type === "label" && text(n).startsWith(label)); assert.ok(labels[index], `라벨 없음 ${label}`); return all(labels[index], n => ["input", "select", "textarea"].includes(n.type))[0]; }
 async function change(label, value, index = 0) { control(label, index).props.onChange({ target: { value } }); await settle(); }
 async function click(label, index = 0) { const button = all(render(), n => n.type === "button" && text(n) === label)[index]; assert.ok(button, `버튼 없음 ${label}`); assert.ok(!button.props.disabled, `비활성 버튼 ${label}`); button.props.onClick(); await settle(); }
 return { render, settle, requests, control, change, click, all, text, html: () => renderToStaticMarkup(render()), setFailure: value => { failure = value; }, setData: value => { getData = value; }, data: () => structuredClone(getData), setPost: value => { postHandler = value; }, setGet: value => { getHandler = value; } };
}

test("처리함을 열면 조회만 하며 배차·알림 또는 검토 요청을 자동 저장하지 않는다", async () => {
 const f = harness("admin"); await f.settle();
 assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.method, undefined);
 assert.equal(f.requests[0].url, "/api/admin/shuttle/intake?month=2026-11&page=1");
 assert.match(f.html(), /합성 학생/); assert.match(f.html(), /2026-11-09/); assert.match(f.html(), /배차 대기/);
 assert.doesNotMatch(f.html(), /문자 발송|확정 저장/);
});
test("관리자가 명시 요청하면 선택 월·담당 기사·현재 신청 지문만 보낸다", async () => {
 const f = harness("admin"); await f.settle(); await f.click("다시 검토 요청");
 const writes = f.requests.filter(r => r.options.method === "POST"); assert.equal(writes.length, 1);
 assert.deepEqual(writes[0].body, { applicationId: "app-1", serviceMonth: "2026-11", driverUserId: "driver-1", expectedFingerprint: "fingerprint-current" });
 assert.match(f.html(), /실제 배차와 알림은 변경하지 않았습니다/);
});
test("기사 추가 확인 의견은 별도 제출하며 실패해도 입력 내용과 결과 선택을 보존한다", async () => {
 const f = harness("driver"); await f.settle(); await f.change("검토 결과", "NEEDS_CONFIRMATION"); await f.change("검토 의견", "정문 승차 가능 여부 확인 필요");
 f.setFailure({ method: "POST", message: "연결하지 못했습니다." }); await f.click("검토 의견 전달");
 assert.equal(f.control("검토 의견").props.value, "정문 승차 가능 여부 확인 필요"); assert.equal(f.control("검토 결과").props.value, "NEEDS_CONFIRMATION"); assert.match(f.html(), /연결하지 못했습니다/);
 assert.deepEqual(f.requests.find(r => r.body)?.body, { reviewId: "review-1", expectedFingerprint: "fingerprint-current", result: "NEEDS_CONFIRMATION", note: "정문 승차 가능 여부 확인 필요", proposals: [] });
 assert.doesNotMatch(f.html(), /href="\/admin\//);
});
test("요일별 등하원 시각을 빠뜨리면 제출하지 않으며 완성 후 네 항목을 보낸다", async () => {
 const f = harness("driver"); await f.settle(); await f.change("검토 의견", "기존 노선에서 검토한 합성 제안"); await f.click("검토 의견 전달"); assert.equal(f.requests.filter(r => r.body).length, 0);
 for (const day of ["월", "수"]) for (const direction of ["등원", "하원"]) await f.change(`${day} ${direction} 가능 시각`, direction === "등원" ? "16:40" : "18:20");
 await f.click("검토 의견 전달"); const body = f.requests.find(r => r.body).body; assert.equal(body.proposals.length, 4); assert.deepEqual(body.proposals.map(p => p.dayOfWeek), ["Mon", "Mon", "Wed", "Wed"]);
 assert.match(f.html(), /배차 확정은 학원에서 진행/);
});
test("이전 검토가 오래되면 기사 위치와 입력·제출 경로를 숨긴다", async () => {
 const stale = item(); stale.review.status = "STALE"; const f = harness("driver", [stale]); await f.settle();
 assert.match(f.html(), /신청 변경·재검토 필요/); assert.doesNotMatch(f.html(), /합성 정류장|type="time"|검토 의견 전달/);
});
test("새 조회에서 신청이 바뀌면 기존 입력을 보존하되 새 지문으로 자동 제출하지 않는다", async () => {
 const f = harness("driver"); await f.settle(); await f.change("검토 의견", "작성 중인 합성 의견");
 const changed = f.data(); changed.items[0].fingerprint = "fingerprint-new"; f.setData(changed); await f.click("새로 확인");
 assert.equal(f.control("검토 의견").props.value, "작성 중인 합성 의견"); assert.ok(f.all(f.render(), n => n.type === "fieldset")[0].props.disabled);
 await f.click("변경 내용 확인 후 새로 작성"); assert.equal(f.control("검토 의견").props.value, ""); assert.equal(f.requests.filter(r => r.body).length, 0);
});
test("조회 실패를 신청 없음으로 표시하지 않으며 작성 중 내용은 그대로 남긴다", async () => {
 const f = harness("driver"); await f.settle(); await f.change("검토 의견", "보존할 의견"); f.setFailure({ method: "GET", message: "목록을 읽지 못했습니다." }); await f.click("새로 확인");
 assert.match(f.html(), /목록을 읽지 못했습니다/); assert.doesNotMatch(f.html(), /배정된 검토 요청이 없습니다/); assert.equal(f.control("검토 의견").props.value, "보존할 의견");
});
test("여러 학생 요청 중 하나만 완료돼도 남은 저장이 끝날 때까지 월 전환을 막는다", async () => {
 const f = harness("admin", [item("app-1"), item("app-2")]); await f.settle();
 const pending = []; f.setPost(() => new Promise(resolve => pending.push(resolve)));
 await f.click("다시 검토 요청", 0); await f.click("다시 검토 요청", 0);
 assert.equal(pending.length, 2); assert.ok(f.control("적용 월").props.disabled);
 pending[0]({ ok: true, json: async () => ({ ok: true }) }); await f.settle(); assert.ok(f.control("적용 월").props.disabled);
 pending[1]({ ok: true, json: async () => ({ ok: true }) }); await f.settle(); assert.equal(f.control("적용 월").props.disabled, false);
});
test("다음 페이지를 펼쳐도 기존 입력을 유지하고 중복 학생을 한 번만 표시한다", async () => {
 const f = harness("driver"); const first = f.data(); first.hasMore = true; f.setData(first); await f.settle(); await f.change("검토 의견", "첫 학생 작성 중");
 f.setGet(async url => ({ ok: true, json: async () => ({ ...first, page: Number(new URL(url, "http://local").searchParams.get("page")), hasMore: false, items: [item("app-1"), item("app-2")] }) }));
 await f.click("신청 더 보기");
 assert.equal(f.all(f.render(), n => n.type === "article").length, 2); assert.equal(f.control("검토 의견", 0).props.value, "첫 학생 작성 중"); assert.match(f.html(), /확인 2명/); assert.doesNotMatch(f.html(), /신청 더 보기/);
 assert.equal(f.requests.at(-1).url, "/api/staff/shuttle/intake?month=2026-11&page=2");
});
test("추가 페이지 오류는 이미 쓴 메모를 보존하고 같은 페이지를 재시도한다", async () => {
 const f = harness("driver"); const first = f.data(); first.hasMore = true; f.setData(first); await f.settle(); await f.change("검토 의견", "전송 안 한 의견");
 f.setFailure({ method: "GET", message: "다음 페이지 연결 실패" }); await f.click("신청 더 보기");
 assert.equal(f.control("검토 의견").props.value, "전송 안 한 의견"); assert.match(f.html(), /다음 페이지 연결 실패/);
 f.setFailure(null); f.setGet(async () => ({ ok: true, json: async () => ({ ...first, items: [item("app-2")], page: 2, hasMore: false }) })); await f.click("신청 더 보기");
 assert.equal(f.all(f.render(), n => n.type === "article").length, 2); assert.equal(f.control("검토 의견").props.value, "전송 안 한 의견");
 assert.equal(f.requests.filter(r => r.url.endsWith("page=2")).length, 2);
});
test("새로 확인은 펼친 두 페이지를 다시 읽고 두 번째 학생의 입력도 보존한다", async () => {
 const f = harness("driver"); const first = f.data(); first.hasMore = true; f.setData(first); await f.settle();
 f.setGet(async url => { const page = Number(new URL(url, "http://local").searchParams.get("page")); return { ok: true, json: async () => ({ ...first, items: [item(`app-${page}`)], page, hasMore: page === 1 }) }; });
 await f.click("신청 더 보기"); await f.change("검토 의견", "둘째 학생 보존", 1); const before = f.requests.length; await f.click("새로 확인");
 assert.deepEqual(f.requests.slice(before).map(r => r.url.slice(-6)), ["page=1", "page=2"]); assert.equal(f.control("검토 의견", 1).props.value, "둘째 학생 보존");
});
test("다음 페이지 조회 중 월을 바꾸면 늦은 이전 월 응답을 섞지 않는다", async () => {
 const f = harness("driver"); const first = f.data(); first.hasMore = true; f.setData(first); await f.settle(); let finish;
 f.setGet(async url => url.includes("2026-11") ? new Promise(resolve => { finish = resolve; }) : { ok: true, json: async () => ({ ...first, serviceMonth: "2026-12", items: [], page: 1, hasMore: false }) });
 await f.click("신청 더 보기"); await f.change("적용 월", "2026-12");
 finish({ ok: true, json: async () => ({ ...first, items: [item("old-month")], page: 2, hasMore: false }) }); await f.settle();
 assert.equal(f.control("적용 월").props.value, "2026-12"); assert.doesNotMatch(f.html(), /합성 학생|다음 신청 확인 중/); assert.match(f.html(), /배정된 검토 요청이 없습니다/);
});
test("한 페이지의 대상이 모두 보류돼도 다음 페이지가 있으면 신청 없음으로 단정하지 않는다", async () => {
 const f = harness("admin", []); const first = f.data(); first.hasMore = true; f.setData(first); await f.settle(); assert.match(f.html(), /다음 신청 목록을 확인/); assert.match(f.html(), /신청 더 보기/); assert.doesNotMatch(f.html(), /신규 셔틀 신청이 없습니다/);
});
test("새 화면은 계정 권한 검사를 거치며 공용 토큰 화면을 수정하지 않고 메뉴에서 연결한다", () => {
 const admin = readFileSync("src/app/admin/shuttle/intake/page.tsx", "utf8"), driver = readFileSync("src/app/staff/shuttle/intake/page.tsx", "utf8");
 assert.match(admin, /await requireAdmin\(\)/); assert.match(driver, /await requireStaff\(\)/); assert.match(driver, /shuttleScope\(staff.roles\) === "NONE"/);
 assert.match(readFileSync("src/app/admin/shuttle/ShuttleSectionTabs.tsx", "utf8"), /\/admin\/shuttle\/intake/); assert.match(readFileSync("src/app/staff/shuttle/page.tsx", "utf8"), /\/staff\/shuttle\/intake/);
 const source = readFileSync(FILE, "utf8"); assert.match(source, /min-h-11/); assert.match(source, /text-base/); assert.match(source, /type="time"/); assert.doesNotMatch(source, /\/api\/driver\/request|\/api\/admin\/regular\/dispatch|regular-notice/);
});
