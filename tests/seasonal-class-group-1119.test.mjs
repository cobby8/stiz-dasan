import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as seasonalTypes from "../src/components/seasonal/types.ts";
import * as publicErrorText from "../src/components/ui/public-error-text.ts";
import * as seatLevelModule from "../src/lib/seats/seatLevel.ts";
import * as periodPricingModule from "../src/lib/seasonal/period-pricing.ts";
import * as attendanceRuleModule from "../src/lib/seasonal/attendance-rule.ts";
import * as applicationPlanModule from "../src/lib/seasonal/application-plan.ts";
import * as kstModule from "../src/lib/datetime/kst.ts";
import * as referralSourcesModule from "../src/lib/enrollment/referralSources.ts";
import * as groups from "../src/lib/seasonal/offering-groups.ts";
import { parseApplicationInput, assertWeekdayCountMatchesFrequency } from "../src/lib/seasonal/contracts.ts";

// 2026-11-19 원장 지시 «특강반은 주2회·주3회 같은 횟수 이름이 들어가는 게 아니라 횟수는 신청 학생이 선택하는 옵션.
//   반 이름은 "초등 고학년"처럼 하나로 통일»을 고정한다.
//   1) 반 카드 = 교시 하나(같은 운영 반 묶음) · 가격표 2) 신청 순서 반 → 기간 → 주 몇 회 → 요일(정확히 N개)
//   3) 서버 요일 수 = 횟수 검사 4) 이름에서 횟수를 빼도 코드 «-N»으로 인식 5) 공개 프로그램 목록·챗봇에서 특강 제외

const read = (file) => readFileSync(file, "utf8");
const require = createRequire(import.meta.url);
const openTime = new Date("2026-07-10T12:00:00+09:00").getTime();

// ── 운영 DB 2027-winter-1 반 9개 — 2026-11-19 읽기 전용 SELECT 로 뽑은 값 그대로 ──
//   (회차: 초등 두 반 1/4~1/29 월~금 20회, 중등부 1/11~1/29 월~금 15회. 기간표는 초등 반만 4주·3주)
const FOUR_CLOSE = "2027-01-01T09:00:00.000Z"; // KST 1/1(금) 18:00
const THREE_CLOSE = "2027-01-08T09:00:00.000Z"; // KST 1/8(금) 18:00
const LINK = { EH: "89d4ce3e-c6a3-476c-a56a-3266bbeb4674", EL: "871bcd10-485b-42a9-b47a-57177afe977c", MID: "f366f8b4-944b-4ea0-bef0-0b3dacd52254" };
const GRADE = { EH: "초4~6", EL: "초1~4 (예비 초5는 고학년·저학년 모두 선택 가능)", MID: "예비 중1~중3" };
const BASE = { EH: "초등 고학년", EL: "초등 저학년", MID: "중등부" };
// 시작 시각(UTC 시·분) — KST 09:30 / 11:00 / 12:30, 수업 80분
const START = { EH: [0, 30], EL: [2, 0], MID: [3, 30] };
const FREQ = [
  // [횟수, 이름 꼬리, 반 가격(신입·재원), 셔틀비, 4주(신입·재원), 3주(신입·재원)]
  [2, "주2회", [180000, 150000], 10000, [240000, 200000], [180000, 150000]],
  [3, "주3회", [243000, 198000], 15000, [324000, 264000], [243000, 198000]],
  [5, "매일(주5회)", [360000, 300000], 20000, [480000, 400000], [360000, 300000]],
];

/** 평일 회차 — 날짜는 UTC 달력으로만 센다(시간대 개입 없음) */
function weekdaySessions(code, firstDay, lastDay) {
  const [hour, minute] = START[code];
  const sessions = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    const dow = new Date(Date.UTC(2027, 0, day)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const startsAt = new Date(Date.UTC(2027, 0, day, hour, minute));
    sessions.push({ startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 80 * 60000).toISOString() });
  }
  return sessions;
}

/** 공개 응답(service.ts publicOffering) 모양의 반 9개. renamed=true 면 반 이름을 «초등 고학년»으로 바꾼 뒤의 모습 */
function winterOfferings({ renamed = false } = {}) {
  const rows = [];
  let order = 10;
  for (const code of ["EH", "EL", "MID"]) {
    for (const [frequency, tail, [newPrice, existingPrice], shuttleFee, four, three] of FREQ) {
      const periods = code === "MID" ? [] : [
        { label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", price: four[0], newApplicantPrice: four[0], existingApplicantPrice: four[1], shuttleFee: null, displayOrder: 0, applicationClosesAt: FOUR_CLOSE, closed: false, closesLabel: "1/1(금) 18:00" },
        { label: "3주", startDate: "2027-01-11", endDate: "2027-01-29", price: three[0], newApplicantPrice: three[0], existingApplicantPrice: three[1], shuttleFee: null, displayOrder: 1, applicationClosesAt: THREE_CLOSE, closed: false, closesLabel: "1/8(금) 18:00" },
      ];
      rows.push({
        id: `${code}-${frequency}`, code: `WINTER1-${code}-${frequency}`, linkedClassId: LINK[code],
        name: renamed ? BASE[code] : `${BASE[code]} ${tail}`, displayOrder: order,
        targetGrade: GRADE[code], capacity: 12, seatLevel: "AVAILABLE",
        price: newPrice, newApplicantPrice: newPrice, existingApplicantPrice: existingPrice,
        shuttleAvailable: true, shuttleFee, waitlistEnabled: true,
        sessionDates: code === "MID" ? weekdaySessions(code, 11, 29) : weekdaySessions(code, 4, 29),
        periods,
      });
      order += 10;
    }
  }
  return rows;
}

function winterProgram(options) {
  return seasonalTypes.normalizeProgram({
    id: "winter-1", slug: "2027-winter-1", title: "2027 겨울방학 특강 1차", status: "PUBLISHED",
    applicationOpensAt: "2026-07-01T00:00:00+09:00", applicationClosesAt: "2026-07-26T23:59:59+09:00",
    startsAt: "2027-01-04T00:00:00+09:00", endsAt: "2027-01-29T23:59:59+09:00",
    dateSelect: { enabled: true, perSessionNewPrice: null, perSessionExistingPrice: null, minSessionCount: 1 },
    offerings: winterOfferings(options),
  }, openTime);
}

/** 화면 컴포넌트를 서버 렌더(useState 는 states 순서대로 미리 채운 값). seasonal-public-display 와 같은 방식 */
function render(name, program, states) {
  const initialStates = states ?? (name === "SeasonalDetailClient" ? [program, false] : ["ready", program]);
  let stateIndex = 0;
  const source = ts.transpileModule(read(`src/components/seasonal/${name}.tsx`), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", source)((id) => {
    if (id === "react") return {
      ...React, useEffect() {}, useMemo: (factory) => factory(), useRef: (value) => ({ current: value }),
      useState: (initial) => [stateIndex < initialStates.length ? initialStates[stateIndex++] : (stateIndex++, typeof initial === "function" ? initial() : initial), () => {}],
    };
    if (id === "next/link" || id === "@/components/common/ReturnLink" || id === "@/components/common/ReplaceLink") {
      return { default: ({ children, ...props }) => React.createElement("a", props, children) };
    }
    if (id === "./types") return { ...seasonalTypes, seasonalDisplayState: (value) => seasonalTypes.seasonalDisplayState(value, openTime) };
    if (id === "@/components/maps/LocationPickerModal") return { default: () => null };
    if (id === "@/components/ui/public-error-text") return publicErrorText;
    if (id === "@/lib/seats/seatLevel") return seatLevelModule;
    if (id === "@/lib/seasonal/contracts") return { SHUTTLE_LOCATION_CONSENT_VERSION: "fixture" };
    if (id === "@/lib/seasonal/period-pricing") return periodPricingModule;
    if (id === "@/lib/seasonal/attendance-rule") return attendanceRuleModule;
    if (id === "@/lib/seasonal/application-plan") return applicationPlanModule;
    if (id === "@/lib/datetime/kst") return kstModule;
    if (id === "@/lib/enrollment/referralSources") return referralSourcesModule;
    if (id === "@/components/public-floating") return {
      PublicBottomBar: ({ className, children }) => React.createElement("div", { className }, children),
      usePublicOverlayOpen() {},
    };
    return require(id);
  }, exports);
  return renderToStaticMarkup(React.createElement(exports.default, { slug: program.slug }));
}

/**
 * 신청 화면 상태(useState 순서): 0 state · 1 program · 2 selectedIds · 3 selectedWeekdayKeys · 4 applicantType · 5 form ·
 *   6 shuttle · 7 locationPicker · 8 locationConsent · 9 submitState · 10 message · 11 result · 12 selectionMode ·
 *   13 selectedDateKeys · 14 selectedPeriodKey · 15 selectedFrequency · 16 dateLimitNotice · 17 weekdayNotice
 */
function applyStates(program, { ids = [], weekdays = [], applicantType = "", periodKey = "", frequency = null, mode = "WEEKDAY" } = {}) {
  return ["ready", program, ids, weekdays, applicantType, undefined, {}, null, false, "idle", "", null, mode, [], periodKey, frequency, "", ""]
    .map((value, index) => index === 5 ? { childName: "", childBirthDate: "", childGender: "", childGrade: "", childSchool: "", childPhone: "", parentName: "", parentPhone: "", parentRelation: "보호자", address: "", memo: "", referralSource: "", agreedTerms: false, agreedPrivacy: false } : value);
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// ── 1. 반 이름·횟수 규칙 ─────────────────────────────────────────────

test("반 이름에서 횟수 빼기: 주2회·주 3회·매일(주5회) 모두 «초등 고학년»(예전엔 «매일( )»이 남았다)", () => {
  for (const title of ["초등 고학년 주2회", "초등 고학년 주 3회", "초등 고학년 매일(주5회)", "초등 고학년", "초등 고학년 (주3회)"]) {
    assert.equal(groups.offeringBaseTitle(title), "초등 고학년", title);
  }
  assert.equal(groups.offeringBaseTitle("주2회"), "주2회", "다 지워지면 원래 이름");
  assert.equal(applicationPlanModule.stripWeeklyFrequency("초등 고학년 매일(주5회)"), "초등 고학년", "날짜 선택 제목도 같은 규칙");
  assert.equal(applicationPlanModule.itemTitleSnapshot("초등 고학년 매일(주5회)", { mode: "DATE", dateCount: 8, periodLabel: "4주" }), "초등 고학년 날짜 선택 8회 (4주)");
});

test("횟수 인식: 이름에서 «주N회»를 빼도 코드 끝 «-N»으로 안다 — 운영 DB 2027 코드 18개·2026 여름 코드 6개", () => {
  for (const season of ["WINTER1", "WINTER2"]) {
    for (const code of ["EH", "EL", "MID"]) {
      for (const frequency of [2, 3, 5]) {
        assert.equal(periodPricingModule.offeringWeeklyFrequency({ title: BASE[code], code: `${season}-${code}-${frequency}` }), frequency);
      }
    }
  }
  for (const [code, frequency] of [["SUMMER-EH-2", 2], ["SUMMER-EH-3", 3], ["SUMMER-EH-5", 5], ["SUMMER-EL-2", 2], ["SUMMER-EL-5", 5], ["SUMMER-MID-2", 2]]) {
    assert.equal(periodPricingModule.offeringWeeklyFrequency({ title: "초등 고학년 주 2회".replace("2", String(frequency)), code }), frequency);
  }
  assert.equal(periodPricingModule.offeringWeeklyFrequency({ title: "슈팅", code: "SHOOT" }), null, "이름·코드 둘 다 없으면 null");
});

test("횟수 붙은 이름: 이미 «주N회»가 있으면 그대로(기존 시즌 글자 불변), 뺐으면 코드 횟수를 붙인다", () => {
  assert.equal(groups.offeringTitleWithFrequency({ title: "초등 고학년 주 2회", code: "SUMMER-EH-2" }), "초등 고학년 주 2회");
  assert.equal(groups.offeringTitleWithFrequency({ title: "초등 고학년 매일(주5회)", code: "WINTER1-EH-5" }), "초등 고학년 매일(주5회)");
  assert.equal(groups.offeringTitleWithFrequency({ title: "초등 고학년", code: "WINTER1-EH-2" }), "초등 고학년 주2회");
  assert.equal(groups.offeringTitleWithFrequency({ title: "초등 고학년", code: "WINTER1-EH-5" }), "초등 고학년 매일(주5회)");
  assert.equal(groups.offeringTitleWithFrequency({ title: "슈팅", code: null }), "슈팅");
  assert.equal(groups.offeringGroupLabel({ title: "초등 고학년", code: "WINTER1-EH-3" }), "초등 고학년 · 주3회");
});

test("묶음: 같은 연결 반은 한 묶음 · 횟수 오름차순 · 횟수 미설정은 맨 뒤+경고 · 연결 반 없으면 혼자", () => {
  const rows = [
    { id: "a5", linkedClassId: "L", code: "X-5", name: "고학년 매일(주5회)" },
    { id: "a2", linkedClassId: "L", code: "X-2", name: "고학년 주2회" },
    { id: "solo", linkedClassId: null, code: "SOLO", name: "슈팅" },
    { id: "a?", linkedClassId: "L", code: "X", name: "고학년 특별" },
  ];
  const result = groups.groupOfferingsByClass(rows, (row) => row.name);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, "고학년");
  assert.deepEqual(result[0].options.map((option) => option.label), ["주2회", "매일(주5회)", "고학년 특별"]);
  assert.equal(result[0].missingFrequency, true);
  assert.equal(result[1].key, "solo");
  assert.equal(result[1].missingFrequency, false, "반 하나뿐인 옛 반은 경고하지 않는다(요일 수로 신청)");
});

// ── 2. 운영 DB 값으로 공개 상세·신청 화면 렌더 ─────────────────────────

for (const renamed of [false, true]) {
  const label = renamed ? "이름을 «초등 고학년»으로 바꾼 뒤" : "지금 이름(주N회 포함)";
  test(`운영 DB 2027-winter-1 반 9개 → 카드 3개·가격표 (${label})`, () => {
    const program = winterProgram({ renamed });
    const classGroups = seasonalTypes.programClassGroups(program);
    assert.deepEqual(classGroups.map((group) => group.title), ["초등 고학년", "초등 저학년", "중등부"]);
    assert.deepEqual(classGroups.map((group) => group.options.map((option) => option.label).join("·")), ["주2회·주3회·매일(주5회)", "주2회·주3회·매일(주5회)", "주2회·주3회·매일(주5회)"]);
    // 회차는 묶음 안에서 한 줄로(같은 날·같은 시각)
    assert.deepEqual(classGroups.map((group) => group.sessionDates.length), [20, 20, 15]);
    // 가격표: 초등 = 횟수 3 × 기간 2, 중등 = 기간 없이 횟수 3
    const rowText = (group) => group.priceRows.map((row) => `${row.frequencyLabel}|${row.periodLabel ?? "-"}|${row.newPrice}|${row.existingPrice}`);
    assert.deepEqual(rowText(classGroups[0]), [
      "주2회|4주|240000|200000", "주2회|3주|180000|150000",
      "주3회|4주|324000|264000", "주3회|3주|243000|198000",
      "매일(주5회)|4주|480000|400000", "매일(주5회)|3주|360000|300000",
    ]);
    assert.deepEqual(rowText(classGroups[2]), ["주2회|-|180000|150000", "주3회|-|243000|198000", "매일(주5회)|-|360000|300000"]);

    const detail = render("SeasonalDetailClient", program);
    assert.equal((detail.match(/<article/g) ?? []).length, 3, "상세 카드 3개");
    for (const title of ["초등 고학년", "초등 저학년", "중등부"]) assert.match(detail, new RegExp(`<h3[^>]*>${title}</h3>`));
    assert.doesNotMatch(detail, /<h3[^>]*>[^<]*주\d회/, "카드 제목에 횟수가 없다");
    const detailText = text(detail);
    assert.match(detailText, /횟수 주2회 · 주3회 · 매일\(주5회\)/);
    assert.match(detailText, /횟수 기간 신입생 재원생 주2회 4주 240,000원 200,000원 3주 180,000원 150,000원 주3회 4주 324,000원 264,000원/);
    assert.match(detailText, /매일\(주5회\) 360,000원 300,000원/, "중등부는 기간 없이 반 가격");
    assert.match(detailText, /전체 수업 일정 · 20회/);
    assert.doesNotMatch(detail, /\d+\s*명|남은 자리 \d/, "인원 숫자는 보이지 않는다");

    const apply = render("SeasonalApplyClient", program, applyStates(program));
    assert.equal((apply.match(/<article/g) ?? []).length, 3, "신청 카드 3개");
    assert.match(text(apply), /신청할 반을 선택한 뒤 주 몇 회 다닐지, 참여할 요일을 차례로 골라주세요\./);
    // 고르기 전 카드 수강료 = 표에서 가장 낮은 금액(재원생 3주·중등 재원생 150,000원)부터
    assert.match(text(apply), /자리 여유 수강료 150,000원부터/);
    assert.doesNotMatch(apply, /주 몇 회 \*/, "반을 고르기 전에는 횟수 칸이 없다");
  });
}

test("신청 순서: 반 고른 뒤 «주 몇 회»(그 교시에 있는 횟수만) → 횟수 전에는 요일을 못 누른다", () => {
  const program = winterProgram({ renamed: true });
  const html = render("SeasonalApplyClient", program, applyStates(program, { ids: ["EH-2"] }));
  const plain = text(html);
  assert.match(plain, /주 몇 회 \* 고른 횟수만큼 참여 요일을 고릅니다\. 횟수에 따라 수강료가 정해집니다\. 주2회 주3회 매일\(주5회\)/);
  assert.match(plain, /참여 요일 \* 먼저 주 몇 회인지 골라 주세요\./);
  assert.match(plain, /미완료: 수강 기간 · 주 몇 회/);
  // 요일 버튼은 모두 잠김(월~금은 횟수 전이라, 토·일은 수업이 없어서)
  const weekdayButtons = html.match(/<button[^>]*aria-pressed="false"[^>]*>(월|화|수|목|금)<\/button>/g) ?? [];
  assert.equal(weekdayButtons.length, 5);
  for (const button of weekdayButtons) assert.match(button, /disabled=""/);
});

test("주2회 + 요일 2개 + 4주 → «초등 고학년 · 주2회» 240,000원 · 요일 수가 모자라면 «참여 요일 3개»", () => {
  const program = winterProgram({ renamed: true });
  const done = text(render("SeasonalApplyClient", program, applyStates(program, { ids: ["EH-2"], weekdays: ["MON", "WED"], periodKey: "2027-01-04|2027-01-29", frequency: 2, applicantType: "NEW" })));
  assert.match(done, /주2회는 요일 2개를 골라 주세요\. \(2\/2\)/);
  assert.match(done, /초등 고학년 · 주2회 4주 · 월·수 · 총 8회/);
  assert.match(done, /수강료 240,000원/);
  assert.doesNotMatch(done, /미완료:[^가-힣]*(주 몇 회|참여 요일)/);

  const short = text(render("SeasonalApplyClient", program, applyStates(program, { ids: ["EH-2"], weekdays: ["MON", "WED"], periodKey: "2027-01-04|2027-01-29", frequency: 3, applicantType: "EXISTING" })));
  assert.match(short, /주3회는 요일 3개를 골라 주세요\. \(2\/3\)/);
  assert.match(short, /미완료: 참여 요일 3개/);
  assert.match(short, /초등 고학년 · 주3회/);
});

test("매일(주5회)은 월~금 자동 선택 — 요일을 따로 고르지 않는다", () => {
  const program = winterProgram({ renamed: true });
  const html = text(render("SeasonalApplyClient", program, applyStates(program, { ids: ["EH-2"], periodKey: "2027-01-11|2027-01-29", frequency: 5, applicantType: "EXISTING" })));
  assert.match(html, /매일\(주5회\)은 월·화·수·목·금 모든 요일에 다닙니다\./);
  assert.match(html, /초등 고학년 · 매일\(주5회\) 3주 · 월·화·수·목·금 · 총 15회/);
  assert.match(html, /수강료 300,000원/);
});

test("신청 화면은 요일 모드에도 weeklyFrequency 를 실어 보낸다(횟수 반이 있는 교시만)", () => {
  const apply = read("src/components/seasonal/SeasonalApplyClient.tsx");
  assert.match(apply, /\.\.\.\(asksFrequency && weeklyFrequency !== null \? \{ weeklyFrequency \} : \{\}\)/);
  assert.match(apply, /const asksFrequency = isDateMode \|\| usesFrequencyChoice;/);
  assert.match(apply, /\{groups\.map\(\(group\) => \{/);
  assert.doesNotMatch(apply, /\{offerings\.map\(\(item\) => \{/, "반 9개를 카드로 다 펼치지 않는다");
});

// ── 3. 서버 입력 검사: 요일 수 = 횟수 ──────────────────────────────────

const baseInput = {
  idempotencyKey: "k-1", applicantType: "NEW",
  child: { name: "학생", birthDate: "2016-03-01" }, parent: { name: "보호자", phone: "01012345678" },
  agreedTerms: true, agreedPrivacy: true, items: [{ offeringId: "EH-2" }],
};

test("서버 검사: 요일 모드 weeklyFrequency=2 + 요일 2개 통과, 요일 3개면 400 WEEKDAY_COUNT_MISMATCH «주2회는 요일 2개를 골라 주세요»", () => {
  const ok = parseApplicationInput({ ...baseInput, selectedWeekdays: ["MON", "WED"], weeklyFrequency: 2 });
  assert.equal(ok.selectionMode, "WEEKDAY");
  assert.equal(ok.weeklyFrequency, 2);
  assert.throws(() => parseApplicationInput({ ...baseInput, selectedWeekdays: ["MON", "WED", "FRI"], weeklyFrequency: 2 }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "WEEKDAY_COUNT_MISMATCH");
    assert.equal(error.message, "주2회는 요일 2개를 골라 주세요.");
    return true;
  });
  assert.throws(() => parseApplicationInput({ ...baseInput, selectedWeekdays: ["MON"], weeklyFrequency: 9 }), (error) => error.code === "FREQUENCY_REQUIRED");
});

test("서버 검사 호환: 옛 화면·회원 앱(weeklyFrequency 없음)은 지금처럼 요일 수로 정한다", () => {
  const legacy = parseApplicationInput({ ...baseInput, selectedWeekdays: ["MON", "WED", "FRI"] });
  assert.equal("weeklyFrequency" in legacy, false);
  assert.doesNotThrow(() => assertWeekdayCountMatchesFrequency(3, undefined));
  assert.doesNotThrow(() => assertWeekdayCountMatchesFrequency(3, null));
  assert.doesNotThrow(() => assertWeekdayCountMatchesFrequency(3, ""));
  // 날짜 모드는 예전과 같다(weeklyFrequency 필수, 날짜 수 검사는 서비스의 assertDateCount)
  const date = parseApplicationInput({ ...baseInput, selectionMode: "DATE", selectedDates: ["2027-01-04"], weeklyFrequency: 2 });
  assert.equal(date.weeklyFrequency, 2);
});

test("서비스: 요일 모드도 같은 검사 + 보낸 횟수로 반을 고르고, 제목 스냅샷에 횟수를 붙인다", () => {
  const service = read("src/lib/seasonal/service.ts");
  assert.match(service, /if \(!isDateMode\) assertWeekdayCountMatchesFrequency\(selectedWeekdays\.length, request\.weeklyFrequency\);/);
  assert.match(service, /const frequency = isDateMode \|\| request\.weeklyFrequency != null \? Number\(request\.weeklyFrequency\) : selectedWeekdays\.length;/);
  assert.match(service, /titleSnapshot: itemTitleSnapshot\(offeringTitleWithFrequency\(assignment\.offering\), \{/);
  assert.match(service, /return offeringWeeklyFrequency\(offering\);/);
  const route = read("src/app/api/admin/seasonal/route.ts");
  assert.equal((route.match(/titleSnapshot: offeringTitleWithFrequency\(offering\)/g) ?? []).length, 2, "관리자 재배정·수동 추가도 같은 제목 규칙");
  assert.match(route, /offeringTitle: items\.map\(\(item\) => offeringTitleWithFrequency\(item\.offering\)\)/);
  assert.doesNotMatch(route, /match\(\/주\\s\*\(\\d\+\)\\s\*회\|-\(\\d\)/, "횟수 정규식 사본이 남지 않는다");
});

// ── 4. 관리자 화면 ─────────────────────────────────────────────────────

test("관리자 시즌 화면: 교시 한 줄 아래 횟수별 가격 행 + 행마다 «편집» + 횟수 미설정 경고, 신청 상세 «초등 고학년 · 주2회»", () => {
  const admin = read("src/app/admin/seasonal/SeasonalAdminClient.tsx");
  assert.match(admin, /label: frequency \? weeklyFrequencyLabel\(frequency\) : offering\.name/);
  assert.match(admin, /onClick=\{\(\) => onEditClass\(target\)\} aria-label=\{`\$\{group\.name\} \$\{rule\.label\} 편집`\}/);
  assert.match(admin, /missingFrequency: sortedOfferings\.length > 1 && sortedOfferings\.some/);
  assert.match(admin, /횟수 미설정: /);
  assert.match(admin, /\{classDisplayName\(item\.className\)\}/);
  assert.match(admin, /return offeringBaseTitle\(name\);/);
});

// ── 5. 공개 프로그램 목록·챗봇에서 특강 제외 ─────────────────────────

test("공개 시간표·시뮬레이터 프로그램 목록과 상담 챗봇은 특강 전용·숨긴 프로그램을 뺀다", () => {
  assert.match(read("src/app/schedule/page.tsx"), /programs=\{\(programs as any\[\]\)\.filter\(\(p\) => !p\.seasonalOnly\)/);
  assert.match(read("src/app/simulator/page.tsx"), /const programList = \(programs as any\[\]\)\.filter\(\(p\) => !p\.seasonalOnly\)/);
  const chat = read("src/app/api/chat/route.ts");
  assert.match(chat, /WHERE p\."deletedAt" IS NULL\s+AND NOT \(EXISTS \(SELECT 1 FROM "Class" c WHERE c\."programId" = p\.id AND c\."dayOfWeek" = 'Seasonal'\)/);
  assert.match(chat, /WHERE c\."dayOfWeek" NOT IN \('Seasonal', 'Archived'\)/);
});
