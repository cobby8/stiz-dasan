import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as period from "../src/app/annual/annualPeriod.ts";

const require = createRequire(import.meta.url);
// TSX/TS 파일을 CommonJS 로 바꿔 실행한다. 화면이 부르는 같은 폴더 모듈과 KST 도구는 실제 코드를 그대로 쓴다.
const loaded = new Map();
function load(file, now) {
    const key = `${file}|${now}`;
    if (loaded.has(key)) return loaded.get(key);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const exports = {};
    loaded.set(key, exports);
    new Function("require", "exports", code)((id) => {
        if (id === "next/navigation") return { useRouter: () => ({ refresh() {} }) };
        if (id === "./EventDetailPanel") return { default: () => null };
        if (id === "./annual-months.css") return {};
        if (id === "@/lib/classSchedule") return { DAY_NAMES: ["일", "월", "화", "수", "목", "금", "토"], CLOSED_RE: /학원\s*휴무|휴무일|휴강/ };
        if (id === "./annualPeriod") return { ...period, getKoreanAnnualPeriod: () => period.getKoreanAnnualPeriod(new Date(now)) };
        if (id === "@/lib/datetime/kst") {
            const kst = load("src/lib/datetime/kst.ts", now);
            return { ...kst, todayKst: () => kst.todayKst(new Date(now).getTime()) };
        }
        if (id === "./AnnualCalendarView") return load("src/app/annual/AnnualCalendarView.tsx", now);
        if (id === "./annualCalendar") return load("src/app/annual/annualCalendar.ts", now);
        if (id === "./AnnualEventsClient") return {};
        return require(id);
    }, exports);
    return exports;
}

function render(events = [], schedules = {}, now = "2026-10-22T01:00:00Z", defaultView = "list") {
    const exports = load("src/app/annual/AnnualEventsClient.tsx", now);
    return renderToStaticMarkup(React.createElement(exports.default, {
        allEvents: events, yearlySchedules: schedules, classDays: [1, 2, 3, 4, 5, 6], defaultView,
    }));
}
const event = (id, date, extra = {}) => ({ id, title: id, date, category: "일반", isAllDay: true, source: "db", ...extra });

test("첫 화면은 12개 월 선택과 현재 월 일정 한 패널만 보여준다", () => {
    const html = render([
        event("지난1월행사", "2026-01-05T00:00:00Z"),
        event("이번10월행사", "2026-10-25T00:00:00Z"),
        event("다음11월행사", "2026-11-05T00:00:00Z"),
    ]);
    assert.equal((html.match(/role="tab"/g) || []).length, 12);
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
    assert.match(html, /role="tabpanel" aria-labelledby="annual-month-9"/);
    assert.match(html, /이번10월행사/);
    assert.doesNotMatch(html, /지난1월행사|다음11월행사/);
});

test("현재 월 행사 0건이어도 그달을 표시하고 공식 수업일자 열기를 보존한다", () => {
    const html = render([event("9월에만있는행사", "2026-09-10T00:00:00Z")], {
        2026: { 9: { 1: ["2026-09-28T00:00:00Z"] } },
    });
    assert.match(html, /2026년 10월에 등록된 행사가 없습니다/);
    assert.match(html, /수업일자 확인/);
    assert.doesNotMatch(html, /9월에만있는행사/);
});

test("공식 수강월은 실제 날짜가 전월이어도 해당 월에 남긴다", () => {
    const html = render([event("10월개강확정행사", "2026-09-28T00:00:00Z", {
        academicYear: 2026, academicMonth: 9,
    })]);
    assert.match(html, /10월개강확정행사/);
    assert.match(html, /9월 28일/);
    assert.match(html, /role="tabpanel" aria-labelledby="annual-month-9"/);
});

test("한국의 새해 첫날은 1월을 열고 일정 없는 달도 선택 가능하게 둔다", () => {
    const html = render([], {}, "2026-12-31T15:00:00Z");
    assert.match(html, /2027년 1월에 등록된 행사가 없습니다/);
    assert.match(html, /role="tabpanel" aria-labelledby="annual-month-0"/);
    assert.equal((html.match(/role="tab"/g) || []).length, 12);
});

// ── 달력형(기본 보기, 2026-11-06 원장 결정) ──

test("기본 보기는 달력형이고 달력·목록 전환 버튼을 함께 보여 준다", () => {
    const exports = load("src/app/annual/AnnualEventsClient.tsx", "2026-11-06T01:00:00Z");
    const html = renderToStaticMarkup(React.createElement(exports.default, { allEvents: [], yearlySchedules: {}, classDays: [] }));
    assert.match(html, /role="group" aria-label="2026년 11월 달력"/);
    assert.match(html, /aria-pressed="true"[^>]*>.*?달력/s);
    assert.match(html, /목록/);
    assert.doesNotMatch(html, /등록된 행사가 없습니다/); // 목록형 빈 안내는 달력형에서 나오지 않는다
});

test("달력형은 실제 날짜 칸에 일정을 놓고 여러 날 휴무를 기간 내내 칠한다(서버 화면엔 오늘을 박지 않는다)", () => {
    const html = render([
        event("학원 휴무 (추석)", "2026-11-04T00:00:00Z", { endDate: "2026-11-05T00:00:00Z", category: "방학" }),
        event("12월 개강", "2026-11-30T00:00:00Z", { academicYear: 2026, academicMonth: 11 }),
        event("다음달행사", "2026-12-15T00:00:00Z"),
    ], {}, "2026-11-04T01:00:00Z", "calendar");
    // 11/4·11/5 두 칸 모두 휴무 표시 + «휴무» 글자
    assert.match(html, /aria-label="11월 4일 수요일, 일정 1개, 학원 휴무"/);
    assert.match(html, /aria-label="11월 5일 목요일, 일정 1개, 학원 휴무"/);
    assert.equal((html.match(/annual-calendar-short is-closed"><span class="annual-calendar-dot [^"]+"><\/span>휴무/g) || []).length, 2);
    // 수강월 일정은 짧은 이름 «개강» 으로 보인다
    assert.match(html, /<\/span>개강<\/span>/);
    // 수강월이 12월이어도 달력은 실제 날짜(11/30) 칸에 둔다
    assert.match(html, /aria-label="11월 30일 월요일, 일정 1개"/);
    assert.doesNotMatch(html, /다음달행사/);
    // 5분 캐시된 서버 화면에 어제 날짜가 박히지 않게 «오늘» 표시·자동 선택은 브라우저에서만 한다
    assert.doesNotMatch(html, /, 오늘"|is-today/);
    assert.match(html, /날짜를 누르면 그날 일정을 볼 수 있습니다/);
});
