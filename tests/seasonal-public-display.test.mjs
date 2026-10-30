import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as seasonalTypes from "../src/components/seasonal/types.ts";
import * as publicErrorText from "../src/components/ui/public-error-text.ts";
import { extractPrograms, formatSeasonalDate, formatSeasonalPeriod, normalizeProgram, seasonalApplicationStatusLabel, seasonalDisplayState, statusLabel } from "../src/components/seasonal/types.ts";

const at = (value) => new Date(value).getTime();
const season = {
  id: "fixture-season", slug: "fixture", title: "합성 특강", status: "PUBLISHED",
  applicationOpensAt: "2026-07-01T00:00:00+09:00", applicationClosesAt: "2026-07-26T23:59:59+09:00",
  startsAt: "2026-07-27T00:00:00+09:00", endsAt: "2026-08-19T23:59:59+09:00",
  offerings: [{ id: "available", capacity: 10, remaining: 3, waitlistEnabled: false }],
};

const require = createRequire(import.meta.url);
const openTime = at("2026-07-10T12:00:00+09:00");

function renderPublicPage(name, program) {
  const initialStates = name === "SeasonalListClient" ? [[program], "ready"]
    : name === "SeasonalDetailClient" ? [program, false] : ["ready", program];
  let stateIndex = 0;
  const source = ts.transpileModule(readFileSync(`src/components/seasonal/${name}.tsx`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", source)((id) => {
    if (id === "react") return {
      ...React, useEffect() {}, useMemo: (factory) => factory(), useRef: (value) => ({ current: value }),
      useState: (initial) => [stateIndex < initialStates.length ? initialStates[stateIndex++] : typeof initial === "function" ? initial() : initial, () => {}],
    };
    if (id === "next/link") return { default: ({ children, ...props }) => React.createElement("a", props, children) };
    if (id === "./types") return { ...seasonalTypes, seasonalDisplayState: (value) => seasonalDisplayState(value, openTime) };
    if (id === "@/components/maps/LocationPickerModal") return { default: () => null };
    if (id === "@/components/ui/public-error-text") return publicErrorText;
    if (id === "@/lib/seasonal/contracts") return { SHUTTLE_LOCATION_CONSENT_VERSION: "fixture" };
    // 하단 고정 바 감싸개(플로팅 버튼 위치용)는 모양만 같은 div 로 바꿔 렌더한다.
    if (id === "@/components/public-floating") return {
      PublicBottomBar: ({ className, children }) => React.createElement("div", { className }, children),
      usePublicOverlayOpen() {},
    };
    return require(id);
  }, exports);
  return renderToStaticMarkup(React.createElement(exports.default, { slug: program.slug }));
}

test("모집 기간 안에도 빈 수업·전 수업 마감을 구분하고 대기·잔여석이 있을 때만 신청을 연다", () => {
  const cases = [
    [[], "수업 안내 예정", false],
    [[{ id: "full", capacity: 10, remaining: 0, waitlistEnabled: false }], "전 수업 마감", false],
    [[{ id: "waiting", capacity: 10, remaining: 0, waitlistEnabled: true }], "신청 가능", true],
    [[{ id: "available", capacity: 10, remaining: 1, waitlistEnabled: false }], "신청 가능", true],
  ];
  for (const [offerings, label, canApply] of cases) {
    const program = normalizeProgram({ ...season, offerings }, openTime);
    const display = seasonalDisplayState(program, openTime);
    assert.equal(display.status, "OPEN");
    assert.equal(display.label, label);
    assert.equal(display.canApply, canApply);
    assert.equal(display.showSeats, canApply);
    if (!canApply) assert.equal(display.actionLabel, "특강 내용 보기");
  }
});

test("빈 수업·전 수업 마감의 목록·상세·직접 신청 화면은 신청 유도 없이 같은 상태를 표시한다", () => {
  for (const [offerings, label, message] of [
    [[], "수업 안내 예정", "신청 가능한 수업을 준비하고 있습니다."],
    [[{ id: "full", capacity: 10, remaining: 0, waitlistEnabled: false }], "전 수업 마감", "모든 수업이 마감되어 신청할 수 없습니다."],
  ]) {
    const program = normalizeProgram({ ...season, offerings }, openTime);
    for (const name of ["SeasonalListClient", "SeasonalDetailClient", "SeasonalApplyClient"]) {
      const html = renderPublicPage(name, program);
      assert.ok(html.includes(label), name);
      assert.ok(html.includes(message), name);
      assert.doesNotMatch(html, /신청 가능<|수업을 선택하세요|신청 화면에서 여러 수업|자세히 보고 신청하기|전체 잔여석|href="[^"]*\/apply"|<form/);
    }
  }
});

test("잔여석 또는 대기 신청이 가능한 수업은 상세 신청 버튼과 직접 신청서를 유지한다", () => {
  for (const offering of [
    { id: "seat", capacity: 10, remaining: 1, waitlistEnabled: false },
    { id: "waiting", capacity: 10, remaining: 0, waitlistEnabled: true },
  ]) {
    const program = normalizeProgram({ ...season, offerings: [offering] }, openTime);
    assert.match(renderPublicPage("SeasonalListClient", program), /자세히 보고 신청하기/);
    const detail = renderPublicPage("SeasonalDetailClient", program);
    assert.match(detail, /수업을 선택하세요/);
    assert.match(detail, /href="\/seasonal\/fixture\/apply"/);
    assert.match(renderPublicPage("SeasonalApplyClient", program), /<form/);
  }
});

test("공개 ISO 날짜와 Date 객체를 한국 시간의 읽기 쉬운 날짜로 표시한다", () => {
  assert.equal(formatSeasonalDate("2026-07-26T15:00:00.000Z"), "2026년 7월 27일");
  assert.equal(formatSeasonalDate(new Date("2026-08-19T14:59:59Z"), true), "2026년 8월 19일 23:59");
  assert.equal(formatSeasonalDate("2026-07-27"), "2026년 7월 27일");
  assert.equal(formatSeasonalDate("2026-07-27T09:30:00", true), "2026년 7월 27일 09:30");
  assert.equal(formatSeasonalPeriod(season.startsAt, season.endsAt), "2026년 7월 27일 ~ 2026년 8월 19일");
  assert.equal(formatSeasonalPeriod("2026-07-27", "2026-07-27"), "2026년 7월 27일");
});

test("누락·잘못된 날짜는 코드 원문이나 Invalid Date 대신 안내를 표시한다", () => {
  for (const value of [undefined, null, "", "1", "2026", "NOT_A_DATE", "2026-02-30", "2026-02-30T00:00:00Z", new Date(NaN)]) assert.equal(formatSeasonalDate(value), "일정 안내 예정");
  assert.equal(formatSeasonalPeriod(undefined, undefined), "일정 안내 예정");
  assert.equal(formatSeasonalPeriod("2026-07-27", undefined), "2026년 7월 27일부터 · 종료일 안내 예정");
  assert.equal(formatSeasonalPeriod(undefined, "2026-08-19"), "2026년 8월 19일까지 · 시작일 안내 예정");
});

test("모집 예정·모집 중·접수 마감·운영 종료의 경계와 좌석 노출을 함께 판정한다", () => {
  const cases = [
    ["2026-06-30T23:59:59+09:00", "UPCOMING", false],
    ["2026-07-01T00:00:00+09:00", "OPEN", true],
    ["2026-07-26T23:59:59+09:00", "OPEN", true],
    ["2026-07-27T00:00:00+09:00", "CLOSED", false],
    ["2026-08-19T23:59:59+09:00", "CLOSED", false],
    ["2026-08-20T00:00:00+09:00", "ENDED", false],
  ];
  for (const [time, status, showSeats] of cases) {
    const normalized = normalizeProgram(season, at(time));
    const display = seasonalDisplayState(normalized, at(time));
    assert.equal(display.status, status, time);
    assert.equal(display.showSeats, showSeats, time);
    assert.equal(display.canApply, showSeats, time);
    if (!showSeats) assert.equal(display.actionLabel, "특강 내용 보기");
  }
});

test("서버의 종료·마감·취소를 날짜 계산으로 다시 모집 중으로 열지 않는다", () => {
  for (const status of ["CLOSED", "ENDED", "CANCELLED", "ARCHIVED", "DRAFT", "INTERNAL_VALUE"]) {
    const program = normalizeProgram({ ...season, status }, at("2026-07-10T12:00:00+09:00"));
    const display = seasonalDisplayState(program, at("2026-07-10T12:00:00+09:00"));
    assert.equal(display.canApply, false, status);
    assert.equal(display.showSeats, false, status);
    assert.doesNotMatch(display.label, /[A-Z_]{3}/);
  }
  const closed = normalizeProgram({ ...season, isAccepting: false }, at("2026-07-10T12:00:00+09:00"));
  assert.equal(closed.status, "CLOSED");
});

test("마지막에 받은 OPEN 응답도 기간이 지나면 종료 상태로 표시한다", () => {
  const program = normalizeProgram({ ...season, status: "OPEN" }, at("2026-07-10T12:00:00+09:00"));
  const display = seasonalDisplayState(program, at("2026-10-22T12:00:00+09:00"));
  assert.equal(display.label, "운영 종료");
  assert.equal(display.message, "운영이 종료된 특강입니다.");
  assert.equal(display.canApply, false);
  assert.equal(display.showSeats, false);
});

test("Date 객체 응답과 여러 목록을 정규화해도 순번을 현재 시각으로 오해하지 않는다", (t) => {
  t.mock.method(Date, "now", () => at("2026-10-22T12:00:00+09:00"));
  const dateProgram = normalizeProgram({ ...season, applicationOpensAt: new Date(season.applicationOpensAt), startsAt: new Date(season.startsAt) }, at("2026-07-10T12:00:00+09:00"));
  assert.equal(dateProgram.applicationStart, "2026-06-30T15:00:00.000Z");
  assert.equal(dateProgram.operationStart, "2026-07-26T15:00:00.000Z");
  const rows = extractPrograms({ programs: [season, { ...season, id: "second" }] });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "ENDED"));
});

test("모집 상태여도 손상된 일정은 좌석과 신청 가능으로 안내하지 않는다", () => {
  for (const field of ["applicationOpensAt", "applicationClosesAt", "startsAt", "endsAt"]) {
    const program = normalizeProgram({ ...season, status: "OPEN", [field]: "INTERNAL_BAD_DATE" }, at("2026-07-10T12:00:00+09:00"));
    const display = seasonalDisplayState(program, at("2026-07-10T12:00:00+09:00"));
    assert.equal(display.label, "안내 확인 중", field);
    assert.equal(display.canApply, false, field);
    assert.equal(display.showSeats, false, field);
  }
});

test("날짜만 있는 마감·운영 종료일은 한국 시간 당일 끝까지 유지한다", () => {
  const row = { ...season, applicationClosesAt: "2026-07-26", endsAt: "2026-08-19" };
  assert.equal(normalizeProgram(row, at("2026-07-26T23:59:59.999+09:00")).status, "OPEN");
  assert.equal(normalizeProgram(row, at("2026-07-27T00:00:00+09:00")).status, "CLOSED");
  assert.equal(normalizeProgram(row, at("2026-08-19T23:59:59.999+09:00")).status, "CLOSED");
  assert.equal(normalizeProgram(row, at("2026-08-20T00:00:00+09:00")).status, "ENDED");
});

test("수용인원만 있고 접수 자료가 없으면 잔여석을 임의로 채우지 않는다", () => {
  const classes = normalizeProgram({ ...season, offerings: [
    { id: "unknown", capacity: 15 },
    { id: "remaining", capacity: 15, remainingCapacity: 4 },
    { id: "enrolled", capacity: 15, enrolled: 12 },
  ] }).classes;
  assert.equal(classes[0].remaining, null);
  assert.equal(classes[1].remaining, 4);
  assert.equal(classes[2].remaining, 3);
});

test("알 수 없는 신청 결과 상태도 내부 코드 대신 안전한 한글 안내를 쓴다", () => {
  assert.equal(seasonalApplicationStatusLabel("WAITLISTED"), "대기 접수");
  assert.equal(seasonalApplicationStatusLabel("CANCELLED"), "취소");
  assert.equal(seasonalApplicationStatusLabel("INTERNAL_DATABASE_ERROR"), "접수 상태 확인 중");
  assert.equal(seasonalApplicationStatusLabel("constructor"), "접수 상태 확인 중");
  assert.equal(statusLabel("UNKNOWN"), "안내 확인 중");
  assert.equal(statusLabel("toString"), "안내 확인 중");
});

test("해외 기기 시간대에서도 같은 한국 날짜·요일·수업 시각을 표시한다", () => {
  const script = `import {formatSeasonalDate,normalizeProgram} from './src/components/seasonal/types.ts'; const p=normalizeProgram({status:'OPEN',offerings:[{id:'one',capacity:10,remaining:3,sessionDates:[{startsAt:'2026-07-26T15:30:00Z',endsAt:'2026-07-26T16:30:00Z'}]}]});console.log(JSON.stringify({date:formatSeasonalDate('2026-07-26T15:00:00Z'),day:p.classes[0].dayLabel,time:p.classes[0].startTime}));`;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ: "America/Los_Angeles" }, stdio: ["ignore", "pipe", "ignore"] });
  assert.deepEqual(JSON.parse(result), { date: "2026년 7월 27일", day: "월", time: "00:30" });
});
