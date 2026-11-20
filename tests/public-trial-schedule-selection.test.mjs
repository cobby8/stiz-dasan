import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";
import * as kst from "../src/lib/datetime/kst.ts";
import * as publicErrorText from "../src/components/ui/public-error-text.ts";
import * as seatLevel from "../src/lib/seats/seatLevel.ts";
import { loadTsModule } from "./_ts-module.mjs";

// 체험 셔틀 요청 규칙(2026-11-19) — 신청서가 쓰는 검사를 실제 모듈로 돌린다
const trialShuttleRequest = await loadTsModule("src/lib/trial/trialShuttleRequest.ts");

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
  // 공개 응답은 남은 자리 숫자 대신 3단계만(2026-11-13 f9)
  { slotKey: "Mon-4", dayLabel: "월", seatLevel: "AVAILABLE" },
  { slotKey: "Sat-2", dayLabel: "토", seatLevel: "AVAILABLE" },
  { slotKey: "Sat-3", dayLabel: "토", seatLevel: "FULL" },
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
    "@/components/ui/public-error-text": publicErrorText,
    "@/lib/seats/seatLevel": seatLevel,
    "./trialScheduleSelection": schedule,
    // 체험 안내(위치·준비물·확정 조건) 표시 부품 — 일정 검증과 무관해 빈 부품으로(2026-11-10 체험비 온라인 결제)
    "./TrialVisitGuide": { default: () => null },
    "@/components/ui/FontFreeIcon": { default: () => null },
    // 셔틀 입력 부품(지도 창 포함)은 일정 검증과 무관해 빈 부품으로 — 검사 규칙은 실제 모듈
    "@/components/trial/TrialShuttleRequestFields": { default: () => null },
    "@/lib/trial/trialShuttleRequest": trialShuttleRequest,
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

// 훅 순서: 0=step 1=form 2=error … 10=shuttle 11=shuttleErrors (새 상태는 맨 뒤)
const SHUTTLE_STATE = 10;
const SHUTTLE_ERRORS_STATE = 11;
const shuttlePlace = { name: "합성아파트 후문", address: "경기 남양주시 합성로 49", latitude: 37.61, longitude: 127.15 };

test("셔틀 «필요»인데 위치나 위치명이 비면 2단계에서 못 넘어가고 그 칸 안내가 생긴다", async (t) => {
  const noLocation = harness(t, { initialStep: 2 });
  noLocation.states[SHUTTLE_STATE] = { needed: true, direction: "BOTH", pickup: null, dropoffDifferent: false, dropoff: null };
  await noLocation.button("다음").props.onClick();
  assert.equal(noLocation.states[0], 2);
  assert.match(noLocation.states[SHUTTLE_ERRORS_STATE].pickupLocation, /지도에서/);
  assert.equal(noLocation.submissions.length, 0);

  const noName = harness(t, { initialStep: 2 });
  noName.states[SHUTTLE_STATE] = { needed: true, direction: "PICKUP", pickup: { ...shuttlePlace, name: " " }, dropoffDifferent: false, dropoff: null };
  await noName.button("다음").props.onClick();
  assert.equal(noName.states[0], 2);
  assert.match(noName.states[SHUTTLE_ERRORS_STATE].pickupName, /타는 곳 이름/);

  // 마지막 제출 직전에도 다시 본다 — 문제가 있으면 셔틀 칸이 있는 2단계로
  const atSubmit = harness(t, { initialStep: 3 });
  atSubmit.states[SHUTTLE_STATE] = { needed: true, direction: "BOTH", pickup: null, dropoffDifferent: false, dropoff: null };
  atSubmit.button("신청").props.onClick();
  await atSubmit.settle();
  assert.equal(atSubmit.states[0], 2);
  assert.equal(atSubmit.submissions.length, 0);
});

test("셔틀 «필요 없음»(기본)은 예전 전송 모양 그대로, «필요»는 요청을 함께 보낸다", async (t) => {
  const none = harness(t, { initialStep: 2 });
  await none.button("다음").props.onClick();
  assert.equal(none.states[0], 3);
  assert.deepEqual(none.states[SHUTTLE_STATE], { needed: false, direction: "BOTH", pickup: null, dropoffDifferent: false, dropoff: null });
  none.button("신청").props.onClick();
  await none.settle();
  assert.equal("shuttle" in none.submissions[0], false);

  const needed = harness(t, { initialStep: 2 });
  const request = { needed: true, direction: "DROPOFF", pickup: shuttlePlace, dropoffDifferent: false, dropoff: null };
  needed.states[SHUTTLE_STATE] = request;
  await needed.button("다음").props.onClick();
  assert.equal(needed.states[0], 3);
  assert.deepEqual(needed.states[SHUTTLE_ERRORS_STATE], {});
  needed.button("신청").props.onClick();
  await needed.settle();
  assert.deepEqual(needed.submissions[0].shuttle, request);
});
