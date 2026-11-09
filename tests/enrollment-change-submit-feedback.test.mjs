import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

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

// 상태 이름 = useState 호출 순서. 순서가 바뀌면 아래 길이 검사가 먼저 깨진다.
const STATE_NAMES = ["childIdx", "kind", "toClassId", "effectiveFrom", "resumeOn", "reason", "error", "done", "uncertainSource", "submittedFor"];

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
    "@/components/parent/InlineConfirm": { __esModule: true, default: function InlineConfirm() { return null; } },
    "@/components/parent/customerMessage": { customerMessage: (raw, fallback) => (typeof raw === "string" && raw) || fallback },
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
