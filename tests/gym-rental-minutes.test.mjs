// 체육관 대관 — 시작 10분 단위·이용 30분 단위·주말 10시·달력(2026-11-08 원장 지시)을 실제로 실행해 검증한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/rental/gym-rental-rules.ts");
const service = await loadTsModule("src/lib/rental/gym-rental-service.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const kakao = await loadTsModule("src/lib/kakao-rental-reply.ts");
const read = (p) => readFileSync(p, "utf8");

const MON = "2026-11-09"; // 월요일
const SAT = "2026-11-14"; // 토요일
const SUN = "2026-11-15"; // 일요일
const NOW = kst.kstAt("2026-11-07", "12:00");
// 월요일 수업이 20:40 에 끝난다
const CLASSES = [
  { dayOfWeek: "Mon", startTime: "19:20", endTime: "20:40" },
  { dayOfWeek: "Sat", startTime: "13:00", endTime: "14:30" },
];
const at = (day, hm) => day.starts.find((o) => o.minute === rules.hmToMinutes(hm));

// ── 요금 ─────────────────────────────────────────────────────────────────
test("요금: 정수 시간이면 기존(시간 단위) 금액과 정확히 같다 — 1~6시간 × 인원 × 냉난방", () => {
  for (let h = 1; h <= 6; h += 1) {
    for (const headcount of [1, 10, 11, 15, 30]) {
      for (const useAircon of [false, true]) {
        const extra = Math.max(0, headcount - 10);
        const old = 40_000 + 30_000 * (h - 1) + (useAircon ? 5_000 * h : 0) + extra * 3_000 * h; // 2026-11-07 공식
        const fee = rules.calculateRentalFee({ durationMinutes: h * 60, headcount, useAircon });
        assert.equal(fee.usageFee, old, `${h}시간 ${headcount}명 냉난방=${useAircon}`);
        assert.equal(fee.total, old + 20_000);
      }
    }
  }
});

test("요금: 30분 단위 — 첫 1시간 40,000 + 30분마다 15,000, 냉난방 30분 2,500, 초과 1인·30분 1,500", () => {
  assert.equal(rules.calculateRentalFee({ durationMinutes: 90, headcount: 10, useAircon: false }).usageFee, 55_000);
  const fee = rules.calculateRentalFee({ durationMinutes: 90, headcount: 12, useAircon: true });
  assert.equal(fee.baseFee, 55_000);
  assert.equal(fee.airconFee, 7_500);
  assert.equal(fee.extraPeopleFee, 9_000);
  assert.equal(fee.total, 71_500 + 20_000);
  assert.equal(rules.calculateRentalFee({ durationMinutes: 150, headcount: 1, useAircon: false }).usageFee, 40_000 + 15_000 * 3);
  // 원장 확정 상수(30분 단가가 기준, 시간당 값은 ×2)
  assert.deepEqual(
    [rules.RENTAL_FEE.firstHour, rules.RENTAL_FEE.extraHalfHour, rules.RENTAL_FEE.airconPerHalfHour, rules.RENTAL_FEE.extraPersonPerHalfHour, rules.RENTAL_FEE.deposit],
    [40_000, 15_000, 2_500, 1_500, 20_000],
  );
  assert.equal(rules.RENTAL_FEE.extraHour, 30_000);
  // 최소 1시간, 30분 단위, 최대 6시간
  for (const bad of [0, 30, 45, 61, 75, 390]) assert.throws(() => rules.calculateRentalFee({ durationMinutes: bad, headcount: 5, useAircon: false }), String(bad));
  assert.doesNotThrow(() => rules.calculateRentalFee({ durationMinutes: 360, headcount: 5, useAircon: false }));
});

// ── 가능 시간 ────────────────────────────────────────────────────────────
test("시작은 10분 단위, 평일 09:00 · 주말(토·일) 10:00 부터, 마지막 시작 21:00", () => {
  const mon = rules.buildRentalDay({ date: MON, classes: [], busy: [], nowMs: NOW });
  assert.equal(mon.openMinute, 540);
  assert.equal(mon.closeMinute, 1320);
  assert.equal(mon.starts[0].label, "09:00");
  assert.equal(mon.starts[1].label, "09:10");
  assert.ok(mon.starts.every((o) => o.minute % 10 === 0));
  assert.equal(mon.starts.at(-1).label, "21:00");
  for (const date of [SAT, SUN]) {
    const day = rules.buildRentalDay({ date, classes: [], busy: [], nowMs: NOW });
    assert.equal(day.openMinute, 600, date);
    assert.equal(day.starts[0].label, "10:00", date);
    assert.equal(at(day, "09:50"), undefined, date);
  }
});

test("수업이 20:40 에 끝나면 20:40 부터 시작 가능, 그 전 시작은 수업과 겹쳐 막힌다", () => {
  const day = rules.buildRentalDay({ date: MON, classes: CLASSES, busy: [], nowMs: NOW });
  assert.equal(at(day, "20:30").reason, "CLASS");
  assert.equal(at(day, "20:40").available, true);
  assert.equal(at(day, "20:40").maxMinutes, 60); // 21:40 → 22:10 은 22:00 넘김
  assert.equal(rules.isRentalRangeAvailable(day, 1240, 60), true);
  assert.equal(rules.isRentalRangeAvailable(day, 1240, 90), false); // 22:00 넘김
  assert.equal(at(day, "18:20").maxMinutes, 60); // 18:20~19:20 딱 맞게
  assert.equal(rules.isRentalRangeAvailable(day, 1100, 90), false); // 18:20~19:50 수업과 겹침
  assert.equal(rules.isRentalRangeAvailable(day, 1245, 60), false); // 10분 단위 아님
  assert.equal(rules.isRentalRangeAvailable(day, 1240, 45), false); // 30분 단위 아님
});

test("주말: 수업 시간은 빼고 10:00~22:00, 이용은 30분 단위로 이어서", () => {
  const day = rules.buildRentalDay({ date: SAT, classes: CLASSES, busy: [], nowMs: NOW });
  assert.equal(at(day, "10:00").maxMinutes, 180); // 10:00~13:00
  assert.equal(at(day, "12:10").reason, "CLASS");
  assert.equal(at(day, "14:30").available, true);
  assert.equal(at(day, "14:30").maxMinutes, 360);
  assert.equal(rules.isRentalRangeAvailable(day, 540, 60), false); // 주말 09:00 거절
  assert.equal(rules.isRentalRangeAvailable(day, 600, 180), true);
  assert.equal(rules.isRentalRangeAvailable(day, 600, 210), false);
  assert.deepEqual(day.blocks.map((b) => [b.startMinute, b.endMinute, b.reason]), [[780, 870, "CLASS"]]);
});

// ── 표시 ─────────────────────────────────────────────────────────────────
test("표시 함수 하나: «20:40~22:10 (1시간 30분)» — 문자·슬랙·앱 알림·관리자 화면이 같이 쓴다", () => {
  assert.equal(rules.formatRentalTime(1240, 1330), "20:40~22:10 (1시간 30분)");
  assert.equal(rules.formatRentalTime(600, 720), "10:00~12:00 (2시간)");
  assert.equal(rules.rentalTimeText({ startHour: 10, endHour: 12 }), "10:00~12:00 (2시간)"); // 분 없는 옛 행
  assert.equal(rules.rentalTimeText({ startHour: 20, endHour: 22, startMinute: 1240, endMinute: 1300 }), "20:40~21:40 (1시간)");
  const alert = rules.buildRentalAdminAlert({
    applicantName: "김대관", applicantPhone: "01012345678", rentalDate: MON, startHour: 20, endHour: 22,
    startMinute: 1240, endMinute: 1300, headcount: 8, useAircon: false, usageFee: 40_000, deposit: 20_000, totalAmount: 60_000,
  });
  assert.match(alert, /2026년 11월 9일\(월\) 20:40~21:40 \(1시간\)/);
  assert.deepEqual(rules.rentalHourColumns(1240, 1330), { startHour: 20, endHour: 23 });
  assert.deepEqual(rules.rentalHourColumns(600, 720), { startHour: 10, endHour: 12 });
  // 다른 화면이 옛 정시 표시를 쓰지 않는다
  assert.match(read("src/lib/rental/gym-rental-notify.ts"), /rentalTimeText\(request\)/);
  const admin = read("src/app/admin/rental/RentalAdminClient.tsx");
  assert.doesNotMatch(admin, /rentalTimeLabel|startHour/);
  assert.match(admin, /rentalTimeText\(row\)/);
  assert.match(read("src/app/rental/RentalClient.tsx"), /formatRentalTime\(receipt\.startMinute, receipt\.endMinute\)/);
  // 카카오 카드·안내 문자에도 30분 단가
  const { KAKAO_RENTAL_TEXT } = kakao;
  assert.match(KAKAO_RENTAL_TEXT, /30분마다 15,000원/);
  assert.ok([...KAKAO_RENTAL_TEXT].length <= 400);
});

// ── 날짜(KST) ────────────────────────────────────────────────────────────
test("자정 경계·요일: KST 00:05 는 서버(UTC)가 전날 15:05 여도 오늘, 요일은 Date.UTC 기준", () => {
  const justAfterMidnight = Date.parse("2026-11-08T15:05:00.000Z"); // KST 11-09 00:05
  assert.equal(kst.todayKst(justAfterMidnight), MON);
  assert.equal(kst.kstDow(MON), 1);
  assert.equal(kst.kstDow(SAT), 6);
  assert.equal(kst.kstDow(SUN), 0);
  assert.equal(kst.kstDow("2027-01-01"), 5); // 금요일 — 연말 넘김
  assert.equal(kst.kstDow("2028-02-29"), 2); // 윤년 화요일
  assert.equal(rules.rentalOpenMinute("2028-02-29"), 540);
  assert.equal(rules.rentalOpenMinute("2027-01-02"), 600); // 토요일
  // 오늘 이미 지난 시작은 막힌다(KST 20:45 → 20:40 시작 불가, 20:50 가능)
  const day = rules.buildRentalDay({ date: MON, classes: [], busy: [], nowMs: kst.kstAt(MON, "20:45") });
  assert.equal(at(day, "20:40").reason, "PAST");
  assert.equal(at(day, "20:50").available, true);
});

test("달력: 오늘~60일만 고를 수 있고, 일요일 시작 빈칸·월말·연말 이동이 맞다", () => {
  const today = "2026-11-08";
  const nov = rules.buildRentalCalendar("2026-11", today);
  assert.equal(nov[0].date, "2026-11-01"); // 11/1 은 일요일 → 빈칸 없음
  assert.equal(nov.length, 30);
  assert.equal(nov.find((c) => c.date === "2026-11-07").bookable, false); // 어제
  assert.equal(nov.find((c) => c.date === today).bookable, true);
  assert.equal(nov.find((c) => c.date === today).isToday, true);
  const jan = rules.buildRentalCalendar("2027-01", today);
  assert.equal(jan.filter((c) => c === null).length, 5); // 2027-01-01 금요일
  assert.equal(jan.find((c) => c?.date === "2027-01-07").bookable, true); // 60일째
  assert.equal(jan.find((c) => c?.date === "2027-01-08").bookable, false); // 61일째
  assert.equal(rules.buildRentalCalendar("2028-02", today).filter(Boolean).length, 29); // 윤년
  assert.equal(rules.shiftYm("2026-12", 1), "2027-01");
  assert.equal(rules.shiftYm("2027-01", -1), "2026-12");
});

// ── 서버(가짜 DB) ────────────────────────────────────────────────────────
function fakeDb({ classes = CLASSES, rentals = [] } = {}) {
  const db = {
    inserted: null,
    async $queryRawUnsafe(sql, ...values) {
      if (sql.includes(`FROM "Class"`)) return classes;
      if (sql.includes(`"SpecialProgramSessionDate"`)) return [];
      if (sql.includes(`AS "startsAt"`)) return rentals;
      if (sql.includes("COUNT(*) FILTER")) return [{ phone10: 0, phoneDay: 0, ip10: 0, ipDay: 0, all10: 0 }];
      if (sql.includes(`"applicantPhone" = $1 AND "rentalDate"`)) return [];
      if (sql.includes(`INSERT INTO "GymRentalRequest"`)) {
        db.inserted = values;
        return [{ id: "00000000-0000-4000-8000-000000000001", rentalDate: values[0], startHour: values[1], endHour: values[2],
          startMinute: values[14], endMinute: values[15], usageFee: values[10], deposit: values[11], totalAmount: values[12], status: "REQUESTED" }];
      }
      throw new Error(`예상 못 한 SQL: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe() { return 1; },
  };
  return db;
}
const BASE = {
  rentalDate: MON, headcount: 8, useAircon: false, applicantName: "김대관", applicantPhone: "010-1234-5678", purpose: "연습", agreedRules: true,
  // 2026-11-08 필수 추가 — 개인정보 동의 + 보증금 환불 계좌
  agreedPrivacy: true, refundBank: "하나은행", refundAccount: "12345678901", refundHolder: "김대관",
};
const apply = (db, extra) => service.createRentalRequest(db, { ...BASE, ...extra }, NOW);

test("신청: 수업 20:40 종료 직후 20:40 시작 1시간 저장 — 분·정시 컬럼·절대 시각(KST)", async () => {
  const db = fakeDb();
  const r = await apply(db, { startMinute: 1240, durationMinutes: 60 });
  assert.equal(r.ok, true);
  const v = db.inserted;
  assert.deepEqual([v[1], v[2]], [20, 22]); // startHour 내림·endHour 올림
  assert.equal(v[3], "2026-11-09T11:40:00.000Z"); // 20:40 KST
  assert.equal(v[4], "2026-11-09T12:40:00.000Z"); // 21:40 KST
  assert.deepEqual([v[14], v[15]], [1240, 1300]);
  assert.equal(v[10], 40_000);
});

test("신청: 30분 단위 이용(1시간 30분) 저장, 요금은 서버가 다시 계산", async () => {
  const db = fakeDb();
  const r = await apply(db, { startMinute: 600, durationMinutes: 90, usageFee: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual([db.inserted[14], db.inserted[15]], [600, 690]);
  assert.equal(db.inserted[10], 55_000);
  assert.equal(db.inserted[12], 75_000);
});

test("신청 거절: 10분 단위 아님·30분 단위 아님·1시간 미만·22시 넘김·수업 겹침·주말 10시 전·승인 대관 겹침", async () => {
  const cases = [
    [{ startMinute: 1245, durationMinutes: 60 }, "10분 단위 아님"],
    [{ startMinute: 600, durationMinutes: 75 }, "30분 단위 아님"],
    [{ startMinute: 600, durationMinutes: 30 }, "1시간 미만"],
    [{ startMinute: 600, durationMinutes: 390 }, "6시간 초과"],
    [{ startMinute: 1240, durationMinutes: 90 }, "22:00 넘김"],
    [{ startMinute: 1260, durationMinutes: 90 }, "22:00 넘김(21시)"],
    [{ startMinute: 1140, durationMinutes: 60 }, "수업 19:20 과 겹침"],
    [{ startMinute: 500, durationMinutes: 60 }, "평일 09시 전"],
    [{ rentalDate: SAT, startMinute: 540, durationMinutes: 60 }, "주말 09:00"],
    [{ rentalDate: SUN, startMinute: 590, durationMinutes: 60 }, "주말 09:50"],
    [{ startMinute: "abc", durationMinutes: 60 }, "숫자 아님"],
  ];
  for (const [extra, label] of cases) {
    const db = fakeDb();
    const r = await apply(db, extra);
    assert.equal(r.ok, false, label);
    assert.equal(db.inserted, null, label);
  }
  // 승인된 대관 21:00~22:00 과 겹침
  const booked = fakeDb({ rentals: [{ startsAt: "2026-11-09T12:00:00.000Z", endsAt: "2026-11-09T13:00:00.000Z" }] });
  assert.equal((await apply(booked, { startMinute: 1240, durationMinutes: 60 })).ok, false);
  // 주말 10:00 은 된다
  assert.equal((await apply(fakeDb(), { rentalDate: SUN, startMinute: 600, durationMinutes: 60 })).ok, true);
});

test("신청: 옛 화면(정시·시간)이 보낸 값도 분으로 바꿔 같은 검사를 거친다", async () => {
  const db = fakeDb();
  assert.equal((await apply(db, { startHour: 10, hours: 2 })).ok, true);
  assert.deepEqual([db.inserted[14], db.inserted[15]], [600, 720]);
  assert.equal((await apply(fakeDb(), { rentalDate: SAT, startHour: 9, hours: 1 })).ok, false); // 주말 9시
});

// ── 마이그레이션·스키마 일치 ─────────────────────────────────────────────
test("마이그레이션: 분 컬럼 추가(IF NOT EXISTS)·기존 행 채우기·되돌림 SQL, schema.prisma 와 일치", () => {
  const sql = read("prisma/migrations/20261108210000_gym_rental_minutes/migration.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "startMinute" INTEGER/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "endMinute" INTEGER/);
  assert.match(sql, /SET "startMinute" = "startHour" \* 60,\s+"endMinute" = "endHour" \* 60/);
  assert.match(sql, /되돌림 SQL:[\s\S]*DROP COLUMN IF EXISTS "startMinute"/);
  assert.match(sql, /"startHour" = "startMinute" \/ 60 AND "endHour" = \("endMinute" \+ 59\) \/ 60/);
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model GymRentalRequest"), schema.indexOf("}", schema.indexOf("model GymRentalRequest")));
  assert.match(model, /startMinute\s+Int\?/);
  assert.match(model, /endMinute\s+Int\?/);
  // DB 의 정수 나눗셈 규칙과 코드의 내림·올림이 같다
  for (const [s, e] of [[540, 600], [1240, 1300], [1240, 1330], [600, 960]]) {
    const cols = rules.rentalHourColumns(s, e);
    assert.equal(cols.startHour, Math.trunc(s / 60));
    assert.equal(cols.endHour, Math.trunc((e + 59) / 60));
    assert.ok(cols.endHour > cols.startHour);
  }
});
