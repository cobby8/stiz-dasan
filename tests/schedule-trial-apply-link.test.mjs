import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-14 원장 점검표: «시간표 화면에서 각 수업 카드에 신청 버튼을 만들고 체험수업 신청으로 연결».
// 카드의 «체험 신청» → /apply/trial?day=<요일 열쇠>&slot=<교시> → 폼이 그 요일·교시를 초기값으로 쓴다.

const { initialTrialScheduleFromQuery, trialScheduleForDate, trialScheduleError } =
    await loadTsModule("src/app/apply/trial/trialScheduleSelection.ts");

const slots = [
    { slotKey: "Mon-4", dayOfWeek: "Mon", dayLabel: "월", seatLevel: "AVAILABLE" },
    { slotKey: "Sat-2", dayOfWeek: "Sat", dayLabel: "토", seatLevel: "TIGHT" },
    { slotKey: "Sat-3", dayOfWeek: "Sat", dayLabel: "토", seatLevel: "FULL" },
];

test("주소의 요일·교시가 지금 시간표에 있고 마감이 아니면 초기값으로 쓴다", () => {
    assert.deepEqual(initialTrialScheduleFromQuery("Mon", "4", slots), { trialDay: "월", trialPeriod: "4" });
    assert.deepEqual(initialTrialScheduleFromQuery("Sat", "2", slots), { trialDay: "토", trialPeriod: "2" });
});

test("없는 수업·마감 수업·빈 값·이상한 값은 무시한다(초기값 없음)", () => {
    assert.equal(initialTrialScheduleFromQuery("Sat", "3", slots), null, "마감 수업");
    assert.equal(initialTrialScheduleFromQuery("Tue", "4", slots), null, "없는 요일");
    assert.equal(initialTrialScheduleFromQuery("Mon", "9", slots), null, "없는 교시");
    assert.equal(initialTrialScheduleFromQuery(undefined, "4", slots), null);
    assert.equal(initialTrialScheduleFromQuery("Mon", undefined, slots), null);
    assert.equal(initialTrialScheduleFromQuery("<script>", "4", slots), null);
    assert.equal(initialTrialScheduleFromQuery("Mon", "4", []), null, "시간표를 못 읽은 경우");
});

test("초기값 뒤에 같은 요일 날짜를 고르면 교시가 유지되고, 다른 요일이면 비워진다", () => {
    const initial = { trialDate: "", ...initialTrialScheduleFromQuery("Mon", "4", slots) };
    // 2026-11-16 은 월요일, 2026-11-21 은 토요일
    assert.deepEqual(trialScheduleForDate(initial, "2026-11-16", slots), { trialDate: "2026-11-16", trialDay: "월", trialPeriod: "4" });
    assert.deepEqual(trialScheduleForDate(initial, "2026-11-21", slots), { trialDate: "2026-11-21", trialDay: "토", trialPeriod: "" });
});

test("초기값만으로는 검증을 통과하지 못한다 — 날짜를 골라야 한다(검증 기준 그대로)", () => {
    const initial = { trialDate: "", ...initialTrialScheduleFromQuery("Mon", "4", slots) };
    assert.equal(trialScheduleError(initial, slots, Date.parse("2026-11-14T03:00:00Z")), "체험수업 희망일을 선택해주세요.");
});

test("시간표 카드 보기: 수업 카드마다 «체험 신청» 테두리 버튼, 마감이면 버튼 없음, 표 보기에는 없음", () => {
    const source = readFileSync("src/app/schedule/ScheduleClient.tsx", "utf8");
    assert.match(source, /\{slot\.seatLevel !== "FULL" && \(\s*<a\s+href=\{trialApplyHref\(slot\)\}/);
    assert.match(source, /className="public-btn-secondary ml-auto shrink-0 text-sm"\s*>\s*체험 신청\s*<\/a>/);
    assert.match(source, /return `\/apply\/trial\?day=\$\{encodeURIComponent\(slot\.dayKey\)\}&slot=\$\{encodeURIComponent\(period\)\}`;/);
    // 카드마다 반복되므로 꽉 찬 주 버튼은 쓰지 않는다
    assert.doesNotMatch(source, /public-btn-primary[^"]*"\s*>\s*체험 신청/);
    // 정원·등록 인원 숫자를 새로 내보이지 않는다(공개 슬롯 타입에 없다)
    assert.doesNotMatch(source, /slot\.(enrolled|capacity)\b/);
    assert.doesNotMatch(readFileSync("src/components/ScheduleTableView.tsx", "utf8"), /체험 신청|apply\/trial/);
});

test("체험 신청 화면이 주소의 day·slot 을 읽어 폼 초기값으로 넘긴다", () => {
    const page = readFileSync("src/app/apply/trial/page.tsx", "utf8");
    assert.match(page, /initialTrialScheduleFromQuery\(params\.day, params\.slot, slots\)/);
    assert.match(page, /initialSchedule=\{initialSchedule\}/);
    const form = readFileSync("src/app/apply/trial/TrialApplicationForm.tsx", "utf8");
    assert.match(form, /trialDay: initialSchedule\?\.trialDay \?\? ""/);
    assert.match(form, /trialPeriod: initialSchedule\?\.trialPeriod \?\? ""/);
});
