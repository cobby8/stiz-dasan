import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const cal = await loadTsModule("src/app/annual/annualCalendar.ts");

test("달력 칸은 일요일부터 시작하고 앞뒤 달 날짜로 빈칸을 채운다", () => {
    const weeks = cal.buildMonthGrid(2026, 10); // 2026년 11월: 1일이 일요일, 30일
    assert.equal(weeks.length, 5);
    assert.deepEqual(weeks[0][0], { ymd: "2026-11-01", day: 1, inMonth: true, dow: 0 });
    assert.equal(weeks[4][1].ymd, "2026-11-30");
    assert.equal(weeks[4][2].inMonth, false); // 12/1
    const feb = cal.buildMonthGrid(2026, 1); // 2026년 2월: 1일 일요일, 28일 → 딱 4주
    assert.equal(feb.length, 4);
    const leap = cal.buildMonthGrid(2028, 1); // 윤년 2월 29일
    assert.ok(leap.flat().some((c) => c.ymd === "2028-02-29" && c.inMonth));
});

test("연말을 넘는 칸도 날짜가 맞다", () => {
    const dec = cal.buildMonthGrid(2026, 11); // 2026년 12월: 1일 화요일
    assert.equal(dec[0][0].ymd, "2026-11-29");
    const last = dec[dec.length - 1];
    assert.equal(last[6].ymd, "2027-01-02");
    assert.equal(last[6].inMonth, false);
});

test("여러 날 일정은 기간 안의 보이는 날마다 들어가고, 시각 있는 일정은 KST 날짜로 들어간다", () => {
    const weeks = cal.buildMonthGrid(2026, 7); // 2026년 8월
    const map = cal.eventsByDay([
        { id: "vac", title: "여름휴가", date: "2026-08-01T00:00:00.000Z", endDate: "2026-08-08T00:00:00.000Z" },
        // 8/9 KST 01:00 — UTC 로는 8/8. 달력은 KST 날짜(9일)에 둔다
        { id: "late", title: "새벽 일정", date: "2026-08-08T16:00:00.000Z" },
        { id: "over", title: "달 넘는 일정", date: "2026-07-30T00:00:00.000Z", endDate: "2026-08-02T00:00:00.000Z" },
    ], weeks);
    for (const d of ["01", "02", "05", "08"]) assert.ok(map.get(`2026-08-${d}`).some((e) => e.id === "vac"), d);
    assert.equal(map.get("2026-08-09")?.map((e) => e.id).join(), "late");
    assert.ok(map.get("2026-07-30").some((e) => e.id === "over")); // 앞 달 칸(보이는 날)에도 들어간다
    assert.ok(!map.get("2026-08-03")?.some((e) => e.id === "over"));
});

test("끝이 시작보다 앞선 일정은 시작일에만, 자정에 끝나는 시간 일정은 다음 날로 번지지 않는다", () => {
    const weeks = cal.buildMonthGrid(2026, 10);
    const map = cal.eventsByDay([
        { id: "bad", title: "잘못된 기간", date: "2026-11-10T00:00:00.000Z", endDate: "2026-11-08T00:00:00.000Z" },
        // KST 11/12 22:00 ~ 11/13 00:00
        { id: "night", title: "밤 일정", date: "2026-11-12T13:00:00.000Z", endDate: "2026-11-12T15:00:00.000Z", isAllDay: false },
    ], weeks);
    assert.equal(map.get("2026-11-10")?.map((e) => e.id).join(), "bad");
    assert.ok(!map.get("2026-11-08"));
    assert.equal(map.get("2026-11-12")?.map((e) => e.id).join(), "night");
    assert.ok(!map.get("2026-11-13"));
});

test("휴대폰 칸 짧은 이름: 개강·종강·휴무 등 실제 제목에서 두 글자로", () => {
    const L = (t, c) => cal.shortEventLabel(t, c);
    assert.equal(L("11월 개강"), "개강");
    assert.equal(L("12월 종강"), "종강");
    assert.equal(L("겨울방학특강 1차 개강"), "개강");
    assert.equal(L("여름방학특강 종료"), "종강");
    assert.equal(L("방학특강 모집 개시"), "모집"); // «개시» 가 있어도 모집이 먼저
    assert.equal(L("학원 휴무 (추석 연휴)"), "휴무");
    assert.equal(L("학원휴무"), "휴무");
    assert.equal(L("농구교실 휴무"), "휴무");
    assert.equal(L("여름휴가"), "휴무");
    assert.equal(L("[다산2호점 대관] 댄스스포츠"), "대관");
    assert.equal(L("하남시장기 U12"), "대회");
    assert.equal(L("성인반 교류전"), "대회");
    assert.equal(L("대체육관 수업"), "수업");
    assert.equal(L("새봄중 스포츠클럽"), "클럽");
    assert.equal(L("이병하 신혼여행", "특별행사"), "행사");
    assert.equal(L("알 수 없는 일정"), "일정");
    for (const t of ["11월 개강", "학원 휴무 (5월 연휴)", "[다산1호점 대관] 댄스스포츠"]) assert.ok(L(t).length <= 2, t);
});
