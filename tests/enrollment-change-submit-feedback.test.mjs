import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as seatLevelModule from "../src/lib/seats/seatLevel.ts";

// 2026-11-09 원장 신고: 학부모 «⋯» → 수강 변경 신청 → 휴원 → «신청하기»가 «제대로 동작 안 함».
// 재현한 원인 두 가지:
//  1) 결과 문구(오류·접수 완료)가 화면 맨 위/맨 아래에 있어, 휴대폰에서 아래로 내려 버튼을 누른 사람에게 안 보였다.
//     (아이폰 날짜 고르기는 min 을 무시해 휴원 시작일 이전 복귀일을 고를 수 있고, 그 거절 문구가 화면 밖에 떴다)
//  2) 접수 성공 직후 router.refresh 가 끝나기 전에 «신청하기»가 다시 살아나, 한 번 더 누르면 «이미 검토 중» 오류가 됐다.
// 실제 React 렌더러 없이 컴포넌트 함수를 직접 불러 요소 트리를 보고, 버튼 onClick 을 눌러 본다.

const nodeRequire = createRequire(import.meta.url);
const realReact = nodeRequire("react");

const load = (path, mocks = {}) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : nodeRequire(name);
  module._compile(compiled, absolute);
  return module.exports;
};

const rules = load("src/lib/enrollment/changeRequestRules.ts");
const changeStatus = load("src/lib/enrollment/parentChangeStatus.ts");

// 상태 이름 = useState 호출 순서. 순서가 바뀌면 아래 길이 검사가 먼저 깨진다.
const STATE_NAMES = ["childIdx", "kind", "toClassId", "effectiveFrom", "resumeOn", "reason", "error", "done", "uncertainSource", "submittedFor", "localPending", "canceledId", "resumeFrom", "pauseFrom", "additionalPauseIds"];

function harness() {
  let state = {};
  let calls = 0;
  const transitions = [];
  const refreshes = { count: 0 };
  const fakeReact = {
    ...realReact,
    useState(initial) {
      const name = STATE_NAMES[calls++];
      if (!(name in state)) state[name] = initial;
      return [state[name], (value) => { state[name] = typeof value === "function" ? value(state[name]) : value; }];
    },
    useRef: (value) => ({ current: value }),
    useMemo: (factory) => factory(),
    useTransition: () => [false, (fn) => { transitions.push(fn()); }],
  };
  const Client = load("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx", {
    react: fakeReact,
    "next/navigation": { useRouter: () => ({ refresh() { refreshes.count++; } }) },
    "@/lib/enrollment/changeRequestRules": rules,
    "@/lib/enrollment/parentChangeStatus": changeStatus,
    "@/lib/seats/seatLevel": seatLevelModule,
    "@/components/parent/InlineConfirm": { __esModule: true, default: function InlineConfirm() { return null; } },
    "@/lib/mypage/requestPreset": { presetIndex: () => 0, presetFirst: (list) => [...list] }, "@/components/parent/customerMessage": { customerMessage: (raw, fallback) => (typeof raw === "string" && raw) || fallback },
  }).default;
  const render = (initial) => {
    calls = 0;
    const tree = Client({ initial });
    assert.equal(calls, STATE_NAMES.length, "useState 개수가 바뀌었다 — STATE_NAMES 순서를 맞출 것");
    return tree;
  };
  return { render, state, transitions, refreshes, set: (patch) => Object.assign(state, patch) };
}

const initial = (pending = null) => ({
  effectiveFrom: "2026-12-01", minEffectiveFrom: "2026-11-10", maxEffectiveFrom: "2027-02-09", classes: [],
  children: [{ studentId: "student-a", studentName: "합성", enrollmentId: "enrollment-a", currentClassId: "class-a", currentClassName: "합성 반", currentProgramName: "합성", pending }],
});

/** 요소 트리를 펼쳐 [요소, 문서 순서] 목록으로 만든다 */
function flatten(node, out = []) {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const item of node) flatten(item, out); return out; }
  if (typeof node !== "object") { out.push({ text: String(node) }); return out; }
  out.push({ el: node });
  flatten(node.props?.children, out);
  return out;
}
const textOf = (node) => flatten(node).filter((x) => x.text).map((x) => x.text).join("");
const findButton = (list, label) => list.find((x) => x.el?.type === "button" && textOf(x.el.props.children).includes(label))?.el;
const indexOf = (list, pred) => list.findIndex(pred);

test("같은 자녀가 다니는 여러 반을 고르면 공통 휴원일과 함께 한 요청으로 보낸다", async () => {
  const h = harness();
  h.set({ kind: "PAUSE" });
  const data = initial();
  const primary = { ...data.children[0], enrollmentStatus: "ACTIVE", minPauseFrom: "2026-11-11" };
  const additional = { ...primary, enrollmentId: "enrollment-b", currentClassId: "class-b", currentClassName: "수요일 반", minPauseFrom: "2026-11-12" };
  const sibling = { ...additional, enrollmentId: "enrollment-sibling", studentId: "student-b", currentClassName: "형제 반" };
  const paused = { ...additional, enrollmentId: "enrollment-paused", currentClassId: "class-c", enrollmentStatus: "PAUSED" };
  const children = [primary, additional, sibling, paused];
  const available = { ...data, canGroupPause: true, children };
  const checks = (tree) => flatten(tree).filter((x) => x.el?.type === "input" && x.el.props.type === "checkbox");
  assert.equal(checks(h.render({ ...data, children })).length, 0, "DB 변경 전에는 기존 단일 반 신청");
  const choices = checks(h.render(available));
  assert.equal(choices.length, 1);
  choices[0].el.props.onChange({ target: { checked: true } });
  const list = flatten(h.render(available));
  const date = list.find((x) => x.el?.props?.id === "pause-from").el;
  assert.equal(date.props.min, "2026-11-12");
  assert.equal(date.props.value, "2026-11-12");
  const sent = [];
  globalThis.fetch = async (_url, request) => {
    sent.push(JSON.parse(request.body));
    return { status: 200, ok: true, json: async () => ({ ok: true, id: "request-a", kind: "PAUSE", effectiveFrom: "2026-11-12" }) };
  };
  findButton(list, "신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].enrollmentIds, ["enrollment-a", "enrollment-b"]);
  assert.equal(sent[0].effectiveFrom, "2026-11-12");
});

test("휴원 신청 오류 문구는 «신청하기» 버튼 바로 위에 보인다(맨 위에 두면 휴대폰에서 안 보인다)", () => {
  const h = harness();
  h.set({ kind: "PAUSE", error: "복귀 예정일은 휴원 시작일보다 뒤여야 합니다." });
  const list = flatten(h.render(initial()));
  const alertAt = indexOf(list, (x) => x.el?.props?.role === "alert");
  const reasonAt = indexOf(list, (x) => x.el?.type === "textarea");
  const buttonAt = indexOf(list, (x) => x.el?.type === "button" && textOf(x.el.props.children).includes("신청하기"));
  assert.ok(alertAt > reasonAt && alertAt < buttonAt, `오류(${alertAt})가 사유 칸(${reasonAt})과 버튼(${buttonAt}) 사이에 있어야 한다`);
});

test("아이폰처럼 휴원 시작일 이전 복귀일을 고르면 보내지 않고 언제부터인지 알려 준다", async () => {
  const h = harness();
  h.set({ kind: "PAUSE", resumeOn: "2026-11-20" });
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { status: 200, ok: true, json: async () => ({ ok: true }) }; };
  findButton(flatten(h.render(initial())), "신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.equal(fetched, 0);
  assert.match(h.state.error, /2026-12-01부터.*2026-12-02 이후/);
});

test("접수 성공 뒤 새 내역이 오기 전까지 «신청하기»를 다시 누를 수 없다(두 번째 누름 = «이미 검토 중» 오류였다)", async () => {
  const h = harness();
  h.set({ kind: "PAUSE" });
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { status: 200, ok: true, json: async () => ({ ok: true, effectiveFrom: "2026-12-01", waitlisted: false }) }; };
  findButton(flatten(h.render(initial())), "신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].kind, "PAUSE");
  assert.equal(h.refreshes.count, 1);

  // router.refresh 가 아직 안 끝난 상태 = 서버 내역(pending)이 아직 비어 있다
  const list = flatten(h.render(initial(null)));
  const locked = findButton(list, "접수됨");
  assert.ok(locked, "접수 완료 표시 버튼이 있어야 한다");
  assert.equal(locked.props.disabled, true);
  assert.equal(findButton(list, "신청하기"), undefined);
  assert.ok(list.some((x) => x.el?.props?.role === "status" && textOf(x.el.props.children).includes("접수되었습니다")));

  // 새 내역이 오면 검토 중 상자로 바뀌고, 접수 문구는 그 상자 안에 남는다
  const after = flatten(h.render(initial({ id: "request-a", kind: "PAUSE", toClassName: null, effectiveFrom: "2026-12-01", resumeOn: null, waitlisted: false })));
  assert.ok(after.some((x) => x.text?.includes("검토 중")));
  assert.ok(after.some((x) => x.el?.props?.role === "status"));
});

test("신청을 취소하면 잠금이 풀려 다시 신청할 수 있다", async () => {
  const h = harness();
  h.set({ kind: "PAUSE", submittedFor: "enrollment-a" });
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) });
  const tree = flatten(h.render(initial({ id: "request-a", kind: "PAUSE", toClassName: null, effectiveFrom: "2026-12-01", resumeOn: null, waitlisted: false })));
  const confirm = tree.find((x) => x.el?.type?.name === "InlineConfirm");
  confirm.el.props.onConfirm();
  await Promise.all(h.transitions);
  assert.equal(h.state.submittedFor, null);
  const button = findButton(flatten(h.render(initial(null))), "신청하기");
  assert.equal(button.props.disabled, false);
});

// ── 2026-11-09 원장 점검: «접수 후 복귀 신청도 떠야 해. 휴원 신청 취소도 필요하고» ─────────────
const confirmOf = (list) => list.find((x) => x.el?.type?.name === "InlineConfirm")?.el;
const allText = (list) => list.filter((x) => x.text).map((x) => x.text).join("");
const pauseChild = (over = {}) => ({
  effectiveFrom: "2026-12-01", minEffectiveFrom: "2026-11-10", maxEffectiveFrom: "2027-02-09",
  minResumeFrom: "2026-11-09", maxResumeFrom: "2027-02-09", classes: [],
  children: [{ studentId: "student-a", studentName: "합성", enrollmentId: "enrollment-a", currentClassId: "class-a", currentClassName: "합성 반", currentProgramName: "합성", enrollmentStatus: "PAUSED", scheduled: null, pending: null, ...over }],
});

test("검토 중인 휴원 신청에는 «휴원 신청 취소» 버튼이 그 상자 안에 바로 있다", () => {
  const h = harness();
  const list = flatten(h.render(initial({ id: "request-a", kind: "PAUSE", toClassName: null, effectiveFrom: "2026-12-01", resumeOn: null, waitlisted: false })));
  const confirm = confirmOf(list);
  assert.ok(confirm, "취소 확인 부품이 있어야 한다");
  assert.equal(confirm.props.label, "휴원 신청 취소");
  assert.equal(findButton(list, "신청하기"), undefined);
});

test("서버가 신청 id 를 돌려주면 새로고침을 기다리지 않고 바로 «검토 중 + 휴원 신청 취소»로 바뀐다", async () => {
  const h = harness();
  h.set({ kind: "PAUSE" });
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, id: "request-new", kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn: null, toClassName: null, waitlisted: false }) });
  findButton(flatten(h.render(initial())), "신청하기").props.onClick();
  await Promise.all(h.transitions);
  // 서버 내역은 아직 비어 있다(새로고침 전)
  const list = flatten(h.render(initial(null)));
  assert.match(allText(list), /검토 중/);
  assert.equal(findButton(list, "신청하기"), undefined);
  assert.equal(findButton(list, "접수됨"), undefined, "취소 버튼이 바로 있으니 «불러오는 중» 잠금은 필요 없다");
  const confirm = confirmOf(list);
  assert.equal(confirm.props.label, "휴원 신청 취소");
  assert.ok(list.some((x) => x.el?.props?.role === "status" && textOf(x.el.props.children).includes("접수되었습니다")));

  // 그 자리에서 바로 취소 → 같은 id 로 취소 요청, 늦게 온 서버 내역(같은 id)도 다시 보이지 않는다
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { status: 200, ok: true, json: async () => ({ ok: true }) }; };
  confirm.props.onConfirm();
  await Promise.all(h.transitions);
  assert.deepEqual(bodies[0], { action: "cancel", id: "request-new" });
  const stale = flatten(h.render(initial({ id: "request-new", kind: "PAUSE", toClassName: null, effectiveFrom: "2026-12-01", resumeOn: null, waitlisted: false })));
  assert.equal(confirmOf(stale), undefined);
  assert.equal(findButton(stale, "신청하기").props.disabled, false);
});

test("휴원 중인 반에는 «복귀 신청»이 보이고 RESUME·복귀 희망일로 보낸다", async () => {
  const h = harness();
  const first = flatten(h.render(pauseChild()));
  assert.match(allText(first), /휴원 중인 반/);
  const button = findButton(first, "복귀 신청하기");
  assert.ok(button);
  assert.equal(button.props.disabled, true, "날짜를 고르기 전에는 누를 수 없다");
  // 반 변경·휴원·퇴원 칩은 보이지 않는다
  assert.equal(findButton(first, "반·요일 변경"), undefined);

  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { status: 200, ok: true, json: async () => ({ ok: true, id: "request-r", kind: "RESUME", effectiveFrom: "2026-11-20", resumeOn: null, toClassName: null, waitlisted: false }) }; };
  h.set({ resumeFrom: "2026-11-20" });
  findButton(flatten(h.render(pauseChild())), "복귀 신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].kind, "RESUME");
  assert.equal(bodies[0].effectiveFrom, "2026-11-20");
  assert.equal(bodies[0].enrollmentId, "enrollment-a");
  const after = flatten(h.render(pauseChild()));
  assert.equal(confirmOf(after).props.label, "복귀 신청 취소");
  assert.match(allText(after), /복귀 · 2026-11-20부터/);
});

test("복귀 희망일이 범위를 벗어나면(아이폰 min 무시) 보내지 않고 범위를 알려 준다", async () => {
  for (const day of ["2026-11-08", "2027-02-10"]) {
    const h = harness();
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; return { status: 200, ok: true, json: async () => ({ ok: true }) }; };
    h.set({ resumeFrom: day });
    findButton(flatten(h.render(pauseChild())), "복귀 신청하기").props.onClick();
    await Promise.all(h.transitions);
    assert.equal(fetched, 0, day);
    assert.match(h.state.error, /2026-11-09부터 2027-02-09 사이/);
  }
});

test("승인됐지만 시작 전인 휴원은 «휴원 예정»과 학원 연락 안내를 보여 준다", () => {
  const h = harness();
  const data = initial(null);
  data.children[0].scheduled = { kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn: "2027-01-05" };
  const text = allText(flatten(h.render(data)));
  assert.match(text, /휴원 예정 · 2026-12-01부터/);
  assert.match(text, /학원에 연락/);
  assert.match(text, /2027-01-05 복귀 예정/);
  // 휴원 중 반에 복귀가 이미 승인돼 기다리는 중이면 복귀 신청 양식은 숨긴다(중복 방지)
  const h2 = harness();
  const waiting = flatten(h2.render(pauseChild({ scheduled: { kind: "RESUME", effectiveFrom: "2026-11-20", resumeOn: null } })));
  assert.equal(findButton(waiting, "복귀 신청하기"), undefined);
  assert.match(allText(waiting), /복귀 예정 · 2026-11-20부터/);
});

// ── 2026-11-10 원장 재점검: 김루빈(한 학생·월/수 두 반·둘 다 다니는 중) 휴원 → «복귀 버튼 안 보여» ─────────
// 운영 데이터 모양 그대로: 같은 학생이 반 2개로 두 줄 나온다. 두 번째 반(수요일)을 골라 휴원을 보낸다.
const twoClasses = (pendingB = null) => ({
  effectiveFrom: "2026-12-01", minEffectiveFrom: "2026-11-11", maxEffectiveFrom: "2027-02-10",
  minResumeFrom: "2026-11-10", maxResumeFrom: "2027-02-10", classes: [],
  children: [
    { studentId: "student-r", studentName: "합성", enrollmentId: "enrollment-mon", currentClassId: "class-mon", currentClassName: "월요일 4교시", currentProgramName: "합성", enrollmentStatus: "ACTIVE", scheduled: null, pending: null },
    { studentId: "student-r", studentName: "합성", enrollmentId: "enrollment-wed", currentClassId: "class-wed", currentClassName: "수요일 4교시", currentProgramName: "합성", enrollmentStatus: "ACTIVE", scheduled: null, pending: pendingB },
  ],
});

test("한 학생이 두 반이면 고른 반(두 번째)으로 휴원을 보내고, 접수 뒤엔 «휴원 신청 취소»만 — 복귀는 휴원이 시작돼야 생긴다", async () => {
  const h = harness();
  h.set({ childIdx: 1, kind: "PAUSE" });
  const before = flatten(h.render(twoClasses()));
  assert.ok(before.some((x) => x.el?.type === "select"), "반이 둘이면 반 고르기가 보여야 한다");
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { status: 200, ok: true, json: async () => ({ ok: true, id: "request-w", kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn: null, toClassName: null, waitlisted: false }) }; };
  findButton(before, "신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.equal(bodies.length, 1);
  assert.deepEqual({ enrollmentId: bodies[0].enrollmentId, kind: bodies[0].kind }, { enrollmentId: "enrollment-wed", kind: "PAUSE" });

  const after = flatten(h.render(twoClasses()));
  assert.equal(confirmOf(after).props.label, "휴원 신청 취소");
  assert.equal(findButton(after, "복귀 신청하기"), undefined, "검토 중(아직 다니는 중)인 반에는 복귀 신청이 없다 — 설계");

  // 다른 반(월요일)으로 바꾸면 그 반은 아무 신청이 없어 다시 신청할 수 있다(잠금이 반마다 따로)
  h.set({ childIdx: 0 });
  const other = flatten(h.render(twoClasses()));
  assert.equal(findButton(other, "신청하기").props.disabled, false);
});
