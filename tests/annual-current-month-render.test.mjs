import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as period from "../src/app/annual/annualPeriod.ts";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync("src/app/annual/AnnualEventsClient.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function render(events = [], schedules = {}, now = "2026-10-22T01:00:00Z") {
    const exports = {};
    new Function("require", "exports", source)((id) => {
        if (id === "next/navigation") return { useRouter: () => ({ refresh() {} }) };
        if (id === "./EventDetailPanel") return { default: () => null };
        if (id === "./annual-months.css") return {};
        if (id === "@/lib/classSchedule") return { DAY_NAMES: ["일", "월", "화", "수", "목", "금", "토"] };
        if (id === "./annualPeriod") return { ...period, getKoreanAnnualPeriod: () => period.getKoreanAnnualPeriod(new Date(now)) };
        return require(id);
    }, exports);
    return renderToStaticMarkup(React.createElement(exports.default, {
        allEvents: events, yearlySchedules: schedules, classDays: [1, 2, 3, 4, 5, 6],
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
