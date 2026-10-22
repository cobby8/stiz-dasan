import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import * as kst from "../src/lib/datetime/kst.ts";

const require = createRequire(import.meta.url);
function compile(file, dependencies) {
  const code = ts.transpileModule(readFileSync(`src/app/apply/trial/${file}.ts${file.endsWith("Form") ? "x" : ""}`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", "window", code)((id) => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id), exports, { scrollTo() {} });
  return exports;
}
const schedule = compile("trialScheduleSelection", { "@/lib/datetime/kst": kst });
const now = Date.parse("2026-10-22T00:00:00+09:00");
const slots = [
  { slotKey: "Mon-4", dayLabel: "월", available: 5 },
  { slotKey: "Sat-2", dayLabel: "토", available: 4 },
  { slotKey: "Sat-3", dayLabel: "토", available: 0 },
];

function harness(t, { initialStep = 1, form = {}, availableSlots = slots, existing = null, lookupError = false } = {}) {
  t.mock.method(Date, "now", () => now);
  const initialForm = {
    trialDate: "2026-10-24", trialDay: "토", trialPeriod: "2",
    childName: "합성 학생", childGender: "남", childSchool: "합성 학교", childGrade: "초3",
    parentPhone: "010-0000-1111", source: "OTHER", trialFeeNoticeAgreed: true, honeypot: "", ...form,
  };
  const states = [initialStep, initialForm];
  let index = 0;
  const submissions = [];
  const pending = [];
  const scrolls = [];
  const errorRef = { current: null };
  let effectDeps;
  let effects = [];
  const Component = compile("TrialApplicationForm", {
    "react": { ...React,
      useState(initial) { const key = index++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key], (next) => { states[key] = typeof next === "function" ? next(states[key]) : next; }]; },
      useTransition: () => [false, (callback) => pending.push(callback())],
      useRef: () => errorRef,
      useEffect(callback, deps) { if (!effectDeps || deps.some((value, index) => !Object.is(value, effectDeps[index]))) effects.push(callback); effectDeps = deps; },
    },
    "@/lib/datetime/kst": kst,
    "./trialScheduleSelection": schedule,
    "@/components/ui/FontFreeIcon": { default: () => null },
    "@/components/MetaPixel": { trackMetaEvent() {} },
    "next/link": { default: ({ children }) => React.createElement("span", null, children) },
    "@/app/actions/public": {
      findExistingTrialApplicationForEdit: async () => { if (lookupError) throw new Error("fixture failure"); return existing; },
      submitTrialApplication: async (payload) => { submissions.push(payload); return { mode: "created" }; },
    },
  }).default;
  function elements() {
    index = 0;
    effects = [];
    errorRef.current = null;
    const found = [];
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      if (typeof node.type === "function") return visit(node.type(node.props));
      if (node.props?.role === "alert" && node.props.ref) node.props.ref.current = { scrollIntoView(options) { scrolls.push(options); } };
      found.push(node);
      visit(node.props?.children);
    };
    visit(Component({ availableSlots, contactPhone: "", initialSource: "OTHER" }));
    effects.forEach((callback) => callback());
    return found;
  }
  const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : node?.props ? text(node.props.children) : "";
  return {
    states, submissions, scrolls,
    date() { return elements().find((node) => node.type === "input" && node.props.type === "date"); },
    button(label) { return elements().find((node) => node.type === "button" && text(node).includes(label)); },
    text() { return elements().map(text).join(" "); },
    async settle() { await Promise.all(pending); },
  };
}

test("날짜·요일·실제교시·마감·과거 날짜를 같은 기준으로 검증한다", () => {
  const valid = { trialDate: "2026-10-24", trialDay: "토", trialPeriod: "2" };
  assert.equal(schedule.trialScheduleError(valid, slots, now), "");
  assert.match(schedule.trialScheduleError({ ...valid, trialDate: "2020-01-01" }, slots, now), /오늘 이후/);
  assert.match(schedule.trialScheduleError({ ...valid, trialDay: "월" }, slots, now), /날짜와 요일/);
  assert.match(schedule.trialScheduleError({ ...valid, trialPeriod: "4" }, slots, now), /현재 시간표/);
  assert.match(schedule.trialScheduleError({ ...valid, trialPeriod: "3" }, slots, now), /마감/);
  assert.match(schedule.trialScheduleError({ ...valid, trialDate: "2026-02-30" }, slots, now), /올바른/);
  assert.match(schedule.trialScheduleError(valid, [], now), /시간표 정보를 확인/);
  assert.match(schedule.trialScheduleError({ ...valid, trialDate: "2026-10-25", trialDay: "일" }, slots, now), /등록된 수업이 없습니다/);
});

test("실제 날짜 입력은 한국요일을 자동 선택하고 다른 요일의 교시는 해제한다", (t) => {
  const ui = harness(t);
  assert.equal(ui.date().props.min, "2026-10-22");
  ui.date().props.onChange({ target: { value: "2026-10-26" } });
  assert.equal(ui.states[1].trialDay, "월");
  assert.equal(ui.states[1].trialPeriod, "");
  assert.equal(ui.states[1].childName, "합성 학생");
  assert.ok(ui.button("4교시"));
  assert.equal(ui.button("2교시"), undefined);
});

test("실제 다음 단계는 과거 날짜와 날짜·요일 모순을 통과시키지 않는다", async (t) => {
  for (const form of [{ trialDate: "2020-01-01" }, { trialDay: "월", trialPeriod: "4" }]) {
    const ui = harness(t, { form });
    await ui.button("다음").props.onClick();
    assert.equal(ui.states[0], 1);
    assert.match(ui.states[2], /오늘 이후|날짜와 요일/);
    assert.equal(ui.submissions.length, 0);
  }
});

test("기존 신청의 잘못된 일정은 값을 보존한 채 일정 단계로 돌려보낸다", async (t) => {
  const ui = harness(t, { initialStep: 2, existing: { id: "existing-fixture", trialDate: "2020-01-01", trialDay: "수", trialPeriod: "4", childName: "불러온 합성 학생" } });
  await ui.button("다음").props.onClick();
  assert.equal(ui.states[0], 1);
  assert.equal(ui.states[1].trialDate, "2020-01-01");
  assert.equal(ui.states[1].childName, "불러온 합성 학생");
  assert.equal(ui.states[1].parentPhone, "010-0000-1111");
  assert.match(ui.states[2], /오늘 이후/);
  assert.equal(ui.submissions.length, 0);
});

test("최종 제출 전에도 날짜를 재검사하며 입력과 동의를 보존한다", async (t) => {
  const ui = harness(t, { initialStep: 3, form: { trialDate: "2020-01-01" } });
  await ui.button("신청").props.onClick();
  await ui.settle();
  assert.equal(ui.states[0], 1);
  assert.match(ui.states[2], /오늘 이후/);
  assert.equal(ui.states[1].childName, "합성 학생");
  assert.equal(ui.states[1].trialFeeNoticeAgreed, true);
  assert.equal(ui.submissions.length, 0);
  assert.match(ui.text(), /오늘 이후/);
  assert.equal(ui.scrolls.length, 1, "최종 제출에서 복귀한 오류도 렌더 후 노출한다");
});

test("시간표가 없을 때 임의 교시를 만들지 않고 조회 실패 때 입력을 보존한다", async (t) => {
  const empty = harness(t, { availableSlots: [] });
  assert.equal(empty.button("1교시"), undefined);
  assert.equal(empty.button("8교시"), undefined);
  assert.match(empty.text(), /시간표 정보를 확인할 수 없습니다/);
  const failing = harness(t, { initialStep: 2, lookupError: true });
  await failing.button("다음").props.onClick();
  assert.equal(failing.states[0], 2);
  assert.equal(failing.states[1].childName, "합성 학생");
  assert.match(failing.states[2], /기존 신청 정보를 확인하지 못했습니다/);
});

test("불일치한 기존 신청을 교정하면 기존 ID와 원래 제출 항목으로 수정할 수 있다", async (t) => {
  const ui = harness(t, { initialStep: 2, existing: { id: "existing-fixture", trialDate: "2026-10-24", trialDay: "월", trialPeriod: "4" } });
  await ui.button("다음").props.onClick();
  assert.equal(ui.states[0], 1);
  assert.match(ui.states[2], /날짜와 요일/);
  ui.button("토").props.onClick();
  assert.equal(ui.states[1].trialPeriod, "");
  ui.button("2교시").props.onClick();
  await ui.button("다음").props.onClick();
  assert.equal(ui.states[0], 2);
  await ui.button("다음").props.onClick();
  assert.equal(ui.states[0], 3);
  ui.button("신청").props.onClick();
  await ui.settle();
  assert.equal(ui.submissions.length, 1);
  assert.deepEqual(ui.submissions[0], {
    existingId: "existing-fixture", trialDate: "2026-10-24", trialDay: "토", trialPeriod: "2", preferredSlotKey: "Sat-2",
    childName: "합성 학생", childGrade: "초3", childGender: "남", childSchool: "합성 학교", parentPhone: "010-0000-1111",
    source: "OTHER", trialFeeNoticeAgreed: true, honeypot: "",
  });
});

test("기존 일정 복귀·동일 오류 재시도·통신 오류는 렌더 후 오류를 다시 노출한다", async (t) => {
  const loaded = harness(t, { initialStep: 2, existing: { id: "existing-fixture", trialDate: "2020-01-01", trialDay: "수", trialPeriod: "4" } });
  await loaded.button("다음").props.onClick();
  assert.equal(loaded.scrolls.length, 0, "오류 DOM이 렌더되기 전에는 위치를 측정하지 않는다");
  assert.match(loaded.text(), /오늘 이후/);
  assert.deepEqual(loaded.scrolls.at(-1), { block: "center", behavior: "auto" });
  const previousCount = loaded.scrolls.length;
  await loaded.button("다음").props.onClick();
  loaded.text();
  assert.equal(loaded.scrolls.length, previousCount + 1, "같은 메시지라도 재시도하면 다시 보여준다");
  assert.equal(loaded.states[1].childName, "합성 학생");

  const failing = harness(t, { initialStep: 2, lookupError: true });
  await failing.button("다음").props.onClick();
  failing.text();
  assert.equal(failing.states[0], 2);
  assert.equal(failing.scrolls.length, 1);
  assert.equal(failing.states[1].trialDate, "2026-10-24");
});
