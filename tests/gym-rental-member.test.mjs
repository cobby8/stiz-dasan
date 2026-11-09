// 체육관 대관 2026-11-08 원장 승인표 — 재원생 무료·일요일 전 시간·환불 계좌·개인정보 동의·승인/거절 문자(알림톡 틀)·
// 실제 정규 수업 시간표로 «막혀야 할 시간이 열리거나, 열려야 할 시간이 막히지 않는지» 를 실제로 실행해 검증한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/rental/gym-rental-rules.ts");
const service = await loadTsModule("src/lib/rental/gym-rental-service.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const read = (p) => readFileSync(p, "utf8");

// ── 요금: 재원생 무료 ─────────────────────────────────────────────────────
test("요금: 재원생 2시간·10명·냉난방 없음 = 0원(보증금도 0)", () => {
  const fee = rules.calculateRentalFee({ durationMinutes: 120, headcount: 10, useAircon: false, memberFree: true });
  assert.equal(fee.baseFee, 70_000);
  assert.equal(fee.freeDiscount, 70_000);
  assert.equal(fee.usageFee, 0);
  assert.equal(fee.deposit, 0);
  assert.equal(fee.total, 0);
  assert.equal(fee.memberFree, true);
});

test("요금: 재원생 3시간·12명·냉난방 = 30,000 + 15,000 + 18,000 = 63,000, 보증금 0", () => {
  const fee = rules.calculateRentalFee({ durationMinutes: 180, headcount: 12, useAircon: true, memberFree: true });
  assert.equal(fee.baseFee - fee.freeDiscount, 30_000);
  assert.equal(fee.airconFee, 15_000);
  assert.equal(fee.extraPeopleFee, 18_000);
  assert.equal(fee.usageFee, 63_000);
  assert.equal(fee.deposit, 0);
  assert.equal(fee.total, 63_000);
});

test("요금: 재원생 1시간·1시간30분은 시간 요금 전부 무료, 일반 신청은 그대로(무료 0·보증금 20,000)", () => {
  assert.equal(rules.calculateRentalFee({ durationMinutes: 60, headcount: 5, useAircon: false, memberFree: true }).total, 0);
  assert.equal(rules.calculateRentalFee({ durationMinutes: 90, headcount: 5, useAircon: false, memberFree: true }).total, 0);
  assert.equal(rules.calculateRentalFee({ durationMinutes: 150, headcount: 5, useAircon: false, memberFree: true }).total, 15_000);
  const normal = rules.calculateRentalFee({ durationMinutes: 90, headcount: 10, useAircon: false });
  assert.deepEqual([normal.freeDiscount, normal.usageFee, normal.deposit, normal.total], [0, 55_000, 20_000, 75_000]);
  assert.equal(rules.RENTAL_FEE.memberFreeCap, 70_000);
});

// ── 실제 정규 수업 시간표(운영, 2026-11-08 기준) ─────────────────────────
const REAL = {
  Mon: ["16:00-16:55", "17:00-17:55", "18:00-19:15", "19:20-20:35"],
  Tue: ["15:00-15:55", "16:00-16:55", "17:00-17:55", "18:00-19:15", "19:20-20:35", "20:40-21:55"],
  Wed: ["15:00-15:55", "16:00-16:55", "17:00-17:55", "18:00-19:15", "19:20-20:55"],
  Thu: ["15:00-15:55", "16:00-16:55", "17:00-17:55", "18:00-19:15", "19:20-20:35", "20:40-21:55", "20:50-21:50"],
  Fri: ["15:00-15:55", "16:00-16:55", "17:00-17:55", "18:00-19:15", "19:20-20:35"],
  Sat: ["09:40-10:45", "10:50-11:55", "12:00-13:05", "13:10-14:15", "17:10-18:25"],
  Sun: ["17:00-19:25"], // 일요일은 무시 대상(스포라운드 수업)
};
const CLASSES = Object.entries(REAL).flatMap(([dayOfWeek, list]) =>
  list.map((range) => ({ dayOfWeek, startTime: range.split("-")[0], endTime: range.split("-")[1] })));
// 2026-11-16(월) ~ 11-22(일) — 테스트 «지금»은 그 전 주
const WEEK = { Mon: "2026-11-16", Tue: "2026-11-17", Wed: "2026-11-18", Thu: "2026-11-19", Fri: "2026-11-20", Sat: "2026-11-21", Sun: "2026-11-22" };
const NOW = kst.kstAt("2026-11-08", "12:00");
const toMin = (hm) => rules.hmToMinutes(hm);
const OPEN = { Mon: 540, Tue: 540, Wed: 540, Thu: 540, Fri: 540, Sat: 600, Sun: 600 };
// 2026-11-09 원장 규칙 — 평일 마감 22:10 · 주말 22:00 (수업과 겹치는 시간은 그대로 막는다)
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const CLOSE = { Mon: 1330, Tue: 1330, Wed: 1330, Thu: 1330, Fri: 1330, Sat: 1320, Sun: 1320 };
/** 원장 규칙으로 직접 계산한 «그날 막히는 수업 구간» — 일요일 없음, 나머지는 수업 그대로 */
function blockingClasses(code) {
  if (code === "Sun") return [];
  return REAL[code].map((r) => r.split("-").map(toMin))
    .filter(([s, e]) => e > s);
}

/** 열린 시작 시각을 «09:00~15:00, 20:40~21:00» 처럼 이어진 구간으로 묶는다(10분 간격) */
function openRanges(day) {
  const open = day.starts.filter((s) => s.available).map((s) => s.minute);
  const ranges = [];
  for (const m of open) {
    const last = ranges.at(-1);
    if (last && m - last[1] === 10) last[1] = m;
    else ranges.push([m, m]);
  }
  return ranges.map(([a, b]) => (a === b ? rules.minuteLabel(a) : `${rules.minuteLabel(a)}~${rules.minuteLabel(b)}`)).join(", ");
}

test("실제 시간표: 요일마다 수업과 겹치는 [시작, 시작+60)은 하나도 열리지 않고, 안 겹치면 열린다 · 최대 시간이 다음 수업을 넘지 않는다", () => {
  for (const [code, date] of Object.entries(WEEK)) {
    assert.equal(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][kst.kstDow(date)], code, date);
    const day = rules.buildRentalDay({ date, classes: CLASSES, busy: [], nowMs: NOW });
    const classes = blockingClasses(code);
    assert.equal(day.closeMinute, CLOSE[code], code);
    assert.equal(day.openMinute, OPEN[code], code);
    assert.equal(day.starts[0].minute, OPEN[code], code);
    assert.equal(day.starts.at(-1).minute, CLOSE[code] - 60, code); // 마지막 시작 평일 21:10(22:10 마감) · 주말 21:00(22:00 마감)
    for (const option of day.starts) {
      const end = option.minute + 60;
      const clash = classes.some(([s, e]) => option.minute < e && s < end);
      assert.equal(option.available, !clash, `${code} ${option.label}`);
      if (option.available) {
        // 이어 쓸 수 있는 최대 시간이 다음 수업 시작·마감(평일 22:10 · 주말 22:00)을 넘지 않는다
        const nextClass = Math.min(CLOSE[code], ...classes.map(([s]) => s).filter((s) => s >= end));
        assert.ok(option.minute + option.maxMinutes <= nextClass, `${code} ${option.label} max ${option.maxMinutes}`);
        // 그리고 30분 단위로 그 한계까지 최대로 준다(덜 막지 않는다)
        assert.ok(option.minute + option.maxMinutes + 30 > Math.min(nextClass, option.minute + rules.RENTAL_MAX_MINUTES), `${code} ${option.label} 덜 열림`);
        assert.equal(rules.isRentalRangeAvailable(day, option.minute, option.maxMinutes), true);
        assert.equal(rules.isRentalRangeAvailable(day, option.minute, option.maxMinutes + 30), false);
      } else {
        assert.equal(rules.isRentalRangeAvailable(day, option.minute, 60), false);
      }
    }
  }
});

test("실제 시간표: 요일별 «열린 시작 구간» (원장 보고용 표와 같다)", () => {
  const table = Object.fromEntries(Object.entries(WEEK).map(([code, date]) =>
    [code, openRanges(rules.buildRentalDay({ date, classes: CLASSES, busy: [], nowMs: NOW }))]));
  assert.deepEqual(table, {
    // 평일 저녁: 20:40 부터 수업과 상관없이 열리고 마지막 시작 21:10(22:10 마감)
    Mon: "09:00~15:00, 20:40~21:10",
    Tue: "09:00~14:00", // 성인반 20:40~21:55 → 21:55 이후 1시간은 22:10 을 넘는다
    Wed: "09:00~14:00, 21:00~21:10", // 20:55 수업 종료 뒤 21:00·21:10 시작(22:10 마감)
    Thu: "09:00~14:00", // 성인반·슈팅 21:55 종료 → 저녁 대관 불가
    Fri: "09:00~14:00, 20:40~21:10",
    Sat: "14:20~16:10, 18:30~21:00",
    Sun: "10:00~21:00",
  });
});

test("일요일: 수업·특강 회차는 무시하고 10:00~21:00 시작 전부 가능, 승인된 대관(BOOKED)만 막는다", () => {
  const sun = WEEK.Sun;
  const all = rules.buildRentalDay({ date: sun, classes: CLASSES, busy: [{ startMinute: 600, endMinute: 1320 }], nowMs: NOW });
  assert.ok(all.starts.every((s) => s.available), "특강 회차가 있어도 일요일은 전부 열린다");
  assert.equal(all.starts.length, (21 - 10) * 6 + 1);
  assert.deepEqual(all.blocks, []);
  assert.equal(all.starts[0].maxMinutes, 360);
  // 승인된 대관 18:00~19:00 은 일요일에도 막힌다
  const booked = rules.buildRentalDay({ date: sun, classes: CLASSES, busy: [], bookedBusy: [{ startMinute: 1080, endMinute: 1140 }], nowMs: NOW });
  const at = (hm) => booked.starts.find((s) => s.minute === toMin(hm));
  assert.equal(at("17:10").reason, "BOOKED");
  assert.equal(at("18:50").reason, "BOOKED");
  assert.equal(at("19:00").available, true);
  assert.equal(at("17:00").maxMinutes, 60);
  // 일요일 09:50 은 영업 전
  assert.equal(rules.isRentalRangeAvailable(booked, 590, 60), false);
  // 토요일은 여전히 수업으로 막힌다(일요일만 예외)
  const sat = rules.buildRentalDay({ date: WEEK.Sat, classes: CLASSES, busy: [], nowMs: NOW });
  assert.equal(sat.starts.find((s) => s.minute === toMin("10:00")).reason, "CLASS");
});

test("지난 시각은 막힌다 — 일요일도 마찬가지", () => {
  const day = rules.buildRentalDay({ date: WEEK.Sun, classes: CLASSES, busy: [], nowMs: kst.kstAt(WEEK.Sun, "15:05") });
  assert.equal(day.starts.find((s) => s.minute === toMin("15:00")).reason, "PAST");
  assert.equal(day.starts.find((s) => s.minute === toMin("15:10")).available, true);
});

// ── 상태 전이 ─────────────────────────────────────────────────────────────
test("상태: 입금 0원 승인은 바로 확정(PAID), 보증금 0원 건은 «보증금 환불» 버튼이 없다", () => {
  assert.equal(rules.rentalTransitionTarget("approve", { totalAmount: 0 }), "PAID");
  assert.equal(rules.rentalTransitionTarget("approve", { totalAmount: 63_000 }), "APPROVED");
  assert.equal(rules.rentalTransitionTarget("confirmPayment", { totalAmount: 0 }), "PAID");
  assert.deepEqual(rules.allowedRentalActions("COMPLETED", { deposit: 0 }), []);
  assert.deepEqual(rules.allowedRentalActions("COMPLETED", { deposit: 20_000 }), ["refund"]);
  assert.deepEqual(rules.allowedRentalActions("COMPLETED"), ["refund"]); // 행을 안 넘기면 예전 그대로
  assert.deepEqual(rules.allowedRentalActions("PAID", { deposit: 0 }).sort(), ["cancel", "complete"]);
  // 시간을 차지하는 상태 목록(EXCLUDE 제약과 같은 집합)은 바뀌지 않았다
  assert.deepEqual([...rules.RENTAL_HOLDING_STATUSES].sort(), ["APPROVED", "COMPLETED", "PAID", "REFUNDED"]);
});

const ID = "00000000-0000-4000-8000-000000000001";
function fakeTx({ status = "REQUESTED", totalAmount = 112_000, deposit = 20_000, startMinute = 600, endMinute = 720 } = {}) {
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes("FOR UPDATE")) return [{ id: values[0], status, rentalDate: WEEK.Mon, deposit, startMinute, endMinute, totalAmount }];
      if (sql.includes(`FROM "GymRentalRequest" o`)) return [];
      if (sql.includes(`FROM "Class"`)) return CLASSES;
      if (sql.includes(`"SpecialProgramSessionDate"`)) return [];
      if (sql.includes(`AS "startsAt"`)) return [];
      if (sql.startsWith(`UPDATE "GymRentalRequest"`)) return [{ id: values[0], status: values[1] }];
      throw new Error(`예상 못 한 SQL: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe(sql, ...values) { calls.push({ sql, values }); return 1; },
  };
}
const updateOf = (tx) => tx.calls.find((c) => c.sql.startsWith(`UPDATE "GymRentalRequest"`));

test("서버 승인: 입금 0원이면 PAID + 입금 확인 시각도 찍는다 / 금액 있으면 APPROVED", async () => {
  const free = fakeTx({ totalAmount: 0, deposit: 0 });
  const r = await service.transitionRentalInTx(free, ID, "approve", "admin", { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.request.status, "PAID");
  assert.match(updateOf(free).sql, /"paidAt" = now\(\)/);
  const paid = fakeTx({ totalAmount: 63_000, deposit: 0 });
  assert.equal((await service.transitionRentalInTx(paid, ID, "approve", "admin", { nowMs: NOW })).request.status, "APPROVED");
  assert.doesNotMatch(updateOf(paid).sql, /"paidAt" = now\(\)/);
});

test("서버 거절: 사유 필수, 사유는 rejectReason 에 저장 / 보증금 0원 건의 환불 단계는 거절", async () => {
  assert.equal((await service.transitionRentalInTx(fakeTx(), ID, "reject", "a", {})).ok, false);
  assert.equal((await service.transitionRentalInTx(fakeTx(), ID, "reject", "a", { rejectReason: "   " })).ok, false);
  const tx = fakeTx();
  assert.equal((await service.transitionRentalInTx(tx, ID, "reject", "a", { rejectReason: " 그 시간에  학원 일정이 있어요 " })).ok, true);
  assert.equal(updateOf(tx).values[8], "그 시간에 학원 일정이 있어요");
  assert.equal(updateOf(tx).values[1], "REJECTED");
  const noDeposit = fakeTx({ status: "COMPLETED", deposit: 0, totalAmount: 0 });
  assert.equal((await service.transitionRentalInTx(noDeposit, ID, "refund", "a", {})).ok, false);
  assert.equal(updateOf(noDeposit), undefined);
});

// ── 신청(가짜 DB) — 재원생 무료(로그인 계정)·환불 계좌·개인정보 동의 ────────
// 재원생 무료 = 로그인한 학부모 계정의 «내 자녀»(childAccessSql 범위) 중 재원 학생일 때만(원장 2026-11-08)
const LEGACY_ACCESS = `s."parentId" = $1`; // childAccessSql("s", "$1") — 연결 표가 꺼진 환경
const FAMILY_ACCESS = `(s."parentId" = $1 OR EXISTS (SELECT 1 FROM "ParentStudentAccess" child_access WHERE child_access."studentId" = s.id AND child_access."userId" = $1 AND child_access.status = 'ACTIVE'))`;
const PARENT = { appUserId: "parent-1", role: "PARENT", accessSql: FAMILY_ACCESS };

function fakeDb({ students = [{ id: "student-1", name: "김철수" }] } = {}) {
  const db = {
    inserted: null,
    memberQuery: null,
    async $queryRawUnsafe(sql, ...values) {
      if (sql.includes(`FROM "Class"`) && !sql.includes(`FROM "Student" s`)) return CLASSES;
      if (sql.includes(`"SpecialProgramSessionDate"`)) return [];
      if (sql.includes(`AS "startsAt"`)) return [];
      if (sql.includes("COUNT(*) FILTER")) return [{ phone10: 0, phoneDay: 0, ip10: 0, ipDay: 0, all10: 0 }];
      if (sql.includes(`"applicantPhone" = $1 AND "rentalDate"`)) return [];
      if (sql.includes(`FROM "Student" s`)) {
        db.memberQuery = { sql, values };
        return values[0] === PARENT.appUserId ? students : [];
      }
      if (sql.includes(`INSERT INTO "GymRentalRequest"`)) {
        db.inserted = values;
        return [{ id: ID, rentalDate: values[0], startMinute: values[14], endMinute: values[15], usageFee: values[10], deposit: values[11], totalAmount: values[12], memberFree: values[16], status: "REQUESTED" }];
      }
      throw new Error(`예상 못 한 SQL: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe() { return 1; },
  };
  return db;
}
const BASE = {
  rentalDate: WEEK.Mon, startMinute: 600, durationMinutes: 120, headcount: 10, useAircon: false,
  applicantName: "김보호", applicantPhone: "010-1234-5678", purpose: "가족 농구", agreedRules: true, agreedPrivacy: true,
};
const REFUND = { refundBank: "카카오뱅크", refundAccount: "3333-01-1234567", refundHolder: " 김보호 " };
const apply = (db, input, viewer = null) => service.createRentalRequest(db, input, NOW, null, viewer);

test("신청: 로그인 학부모의 연결 재원생이면 2시간 0원·보증금 0·환불 계좌 없이 저장, 학생 id·신청 계정 저장", async () => {
  const db = fakeDb();
  const r = await apply(db, { ...BASE, memberFree: true, memberStudentId: "student-1", ...REFUND }, PARENT);
  assert.equal(r.ok, true);
  const v = db.inserted;
  assert.deepEqual([v[10], v[11], v[12]], [0, 0, 0]);
  assert.equal(v[16], true); // memberFree
  assert.equal(v[17], "student-1"); // memberStudentId
  assert.deepEqual([v[18], v[19], v[20]], [null, null, null]); // 보증금 0 → 환불 계좌 저장 안 함
  assert.equal(v[21], "parent-1"); // applicantUserId
  // 학생 범위 = 마이페이지 «내 자녀»(childAccessSql 조각 그대로) + 재원(병합 제외·ACTIVE·끝난 반 제외)
  const sql = db.memberQuery.sql;
  assert.ok(sql.includes(FAMILY_ACCESS), "childAccessSql 조각을 그대로 쓴다(가족 연결 포함)");
  assert.match(sql, /"mergedIntoStudentId" IS NULL/);
  assert.match(sql, /e\.status = 'ACTIVE'/);
  // 2026-11-09 원장 기준: 승인(ACTIVE)일부터 재원생 — 개시일 전이어도 무료 대관 대상
  assert.doesNotMatch(sql, /startsOn/);
  assert.match(sql, /c\.name NOT LIKE '\[%'/);
  assert.doesNotMatch(sql, /phone|regexp_replace/i, "이름·번호 대조는 쓰지 않는다");
  assert.deepEqual(db.memberQuery.values, ["parent-1"]);
});

test("신청: 비로그인·직원 계정·연결 안 된 학생·학생 미선택이면 재원생 무료 거절", async () => {
  const cases = [
    [null, "student-1", service.RENTAL_MEMBER_LOGIN_MESSAGE],
    [{ ...PARENT, role: "ADMIN" }, "student-1", service.RENTAL_MEMBER_LOGIN_MESSAGE], // 직원 계정은 무료 적용 안 됨
    [{ ...PARENT, role: "INSTRUCTOR" }, "student-1", service.RENTAL_MEMBER_LOGIN_MESSAGE],
    [PARENT, "student-other", service.RENTAL_MEMBER_STUDENT_MESSAGE], // 이 계정의 연결 학생이 아님
    [{ ...PARENT, appUserId: "parent-2" }, "student-1", service.RENTAL_MEMBER_STUDENT_MESSAGE], // 다른 학부모
    [{ ...PARENT, accessSql: "" }, "student-1", service.RENTAL_MEMBER_STUDENT_MESSAGE], // 학부모 인증 미완료(범위 없음)
  ];
  for (const [viewer, studentId, message] of cases) {
    const db = fakeDb();
    const r = await apply(db, { ...BASE, memberFree: true, memberStudentId: studentId }, viewer);
    assert.equal(r.ok, false, JSON.stringify(viewer));
    assert.equal(r.message, message, JSON.stringify(viewer));
    assert.equal(db.inserted, null);
  }
  const noPick = await apply(fakeDb(), { ...BASE, memberFree: true, memberStudentId: "" }, PARENT);
  assert.equal(noPick.ok, false);
  // 직원 계정·범위 없는 계정은 학생 조회 자체를 하지 않는다
  const staff = fakeDb();
  await apply(staff, { ...BASE, memberFree: true, memberStudentId: "student-1" }, { ...PARENT, role: "ADMIN" });
  assert.equal(staff.memberQuery, null);
  // 연결 표가 꺼진 환경(옛 parentId 조건)도 같은 함수로 동작한다
  assert.equal((await apply(fakeDb(), { ...BASE, memberFree: true, memberStudentId: "student-1" }, { ...PARENT, accessSql: LEGACY_ACCESS })).ok, true);
});

test("신청: 재원생 3시간·12명·냉난방 = 63,000원(보증금 0) 서버 재계산, 학생 여럿이면 고른 학생으로", async () => {
  const db = fakeDb({ students: [{ id: "student-1", name: "김철수" }, { id: "student-2", name: "김영희" }] });
  const r = await apply(db, { ...BASE, durationMinutes: 180, headcount: 12, useAircon: true, memberFree: true, memberStudentId: "student-2" }, PARENT);
  assert.equal(r.ok, true);
  assert.deepEqual([db.inserted[10], db.inserted[11], db.inserted[12]], [63_000, 0, 63_000]);
  assert.equal(db.inserted[17], "student-2");
});

test("신청: 일반 신청은 환불 계좌 3칸 필수(은행 목록·숫자 10~16자리·예금주), 계좌는 숫자만 저장", async () => {
  for (const bad of [
    {},
    { ...REFUND, refundBank: "없는은행" },
    { ...REFUND, refundAccount: "12345" },
    { ...REFUND, refundAccount: "12345678901234567" },
    { ...REFUND, refundHolder: "  " },
  ]) {
    const db = fakeDb();
    const r = await apply(db, { ...BASE, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(db.inserted, null);
  }
  const db = fakeDb();
  assert.equal((await apply(db, { ...BASE, ...REFUND })).ok, true);
  assert.deepEqual([db.inserted[18], db.inserted[19], db.inserted[20]], ["카카오뱅크", "3333011234567", "김보호"]);
  assert.equal(db.inserted[16], false);
  assert.equal(db.inserted[21], null); // 비로그인 신청
  assert.deepEqual([db.inserted[11], db.inserted[12]], [20_000, 90_000]);
  // 로그인 학부모가 무료 체크 없이 학생 id 만 보내도 무료가 되지 않는다(신청 계정은 남는다)
  const sneaky = fakeDb();
  await apply(sneaky, { ...BASE, ...REFUND, memberStudentId: "student-1" }, PARENT);
  assert.equal(sneaky.inserted[12], 90_000);
  assert.equal(sneaky.memberQuery, null);
  assert.equal(sneaky.inserted[21], "parent-1");
});

test("신청: 개인정보 수집·이용 동의 없으면 거절(재원생도)", async () => {
  const r = await apply(fakeDb(), { ...BASE, ...REFUND, agreedPrivacy: false });
  assert.equal(r.ok, false);
  assert.match(r.message, /개인정보/);
  assert.equal((await apply(fakeDb(), { ...BASE, agreedPrivacy: undefined, memberFree: true, memberStudentId: "student-1" }, PARENT)).ok, false);
});

test("연결 학생 목록: 학부모만·childAccessSql 조각만 받는다(그 밖의 글자는 빈 목록)", async () => {
  assert.deepEqual(await service.listRentalMemberStudents(fakeDb(), null), []);
  assert.deepEqual(await service.listRentalMemberStudents(fakeDb(), { ...PARENT, role: "DRIVER" }), []);
  assert.deepEqual(await service.listRentalMemberStudents(fakeDb(), { ...PARENT, accessSql: "1=1" }), []);
  assert.deepEqual(await service.listRentalMemberStudents(fakeDb(), PARENT), [{ id: "student-1", name: "김철수" }]);
  // 서버 액션은 childAccessSql·getVerifiedParentState(학부모 화면과 같은 기준)를 재사용하고, 역할 PARENT 만 넘긴다
  const actions = read("src/app/actions/rental.ts");
  assert.match(actions, /accessSql: await childAccessSql\("s", "\$1"\)/);
  assert.match(actions, /if \(!account \|\| account\.role !== "PARENT"\) return null;/);
  assert.match(actions, /const state = await getVerifiedParentState\(\);/);
  assert.match(actions, /createRentalRequest\(tx, input, Date\.now\(\), ipHash, viewer\)/);
  // 이름·번호 맞히기 경로와 실패 기록 표는 없다
  const svc = read("src/lib/rental/gym-rental-service.ts");
  assert.doesNotMatch(svc, /findActiveMemberStudent|GymRentalMemberCheckFail|memberStudentName\?: unknown/);
});

test("입력 정리: 계좌번호 숫자만·은행 목록·송금 복사 글자(예금주 제외)", () => {
  assert.equal(rules.normalizeRefundAccount("110-123-456789"), "110123456789");
  assert.equal(rules.normalizeRefundAccount("123"), "");
  assert.ok(rules.RENTAL_REFUND_BANKS.includes("하나은행"));
  assert.equal(rules.rentalBankCopyText("하나은행 55491019425407 (예금주 권혜미)"), "하나은행 55491019425407");
  assert.equal(rules.rentalBankCopyText("하나은행 55491019425407 예금주 권혜미"), "하나은행 55491019425407");
  assert.equal(rules.rentalBankCopyText("하나은행 55491019425407"), "하나은행 55491019425407");
});

// ── 문자 = 알림톡 틀 ─────────────────────────────────────────────────────
const ACCOUNT = "하나은행 55491019425407 (예금주 권혜미)";
const ROW = {
  applicantName: "김대관", applicantPhone: "01012345678", rentalDate: "2026-11-16", startHour: 20, endHour: 22,
  startMinute: 1240, endMinute: 1300, headcount: 8, useAircon: false, usageFee: 40_000, deposit: 20_000, totalAmount: 60_000,
};

test("문자 틀: 승인(일반) 본문이 원장 승인본과 글자까지 같다", () => {
  const m = rules.buildRentalApplicantMessage("approved", ROW, ACCOUNT);
  assert.equal(m.templateKey, "approved");
  assert.equal(m.body, [
    "[스티즈농구교실] 체육관 대관이 승인되었습니다.",
    "2026년 11월 16일(월) 20:40~21:40 (1시간) · 8명",
    "입금 60,000원(이용료 40,000원 + 보증금 20,000원)",
    "하나은행 55491019425407 (예금주 권혜미)",
    "입금자명은 신청자 이름으로 해 주세요. 입금 확인 후 확정 문자를 드려요.",
    "[이용 수칙]",
    "· 실내운동화 필수",
    "· 신청한 시간·인원 지키기",
    "· 사용 후 정리정돈, 냉난방 끄고 퇴실",
    "· 주차는 인근 주민센터 주차장 이용",
    "· 수칙을 지키지 않으면 보증금이 차감될 수 있어요",
  ].join("\n"));
});

test("문자 틀: 재원생 0원 = 무료 확정 문구(계좌·보증금 줄 없음), 재원생 유료 = 남은 항목 요약 + 보증금 없음", () => {
  const free = rules.buildRentalApplicantMessage("approved", { ...ROW, memberFree: true, usageFee: 0, deposit: 0, totalAmount: 0 }, ACCOUNT);
  assert.equal(free.templateKey, "approvedMemberFree");
  assert.equal(free.body, [
    "[스티즈농구교실] 재원생 무료 체육관 대관이 확정되었습니다.",
    "2026년 11월 16일(월) 20:40~21:40 (1시간) · 8명",
    "이용료 무료(재원생 2시간 무료)",
    "[이용 수칙]",
    "· 실내운동화 필수",
    "· 신청한 시간·인원 지키기",
    "· 사용 후 정리정돈, 냉난방 끄고 퇴실",
    "· 주차는 인근 주민센터 주차장 이용",
  ].join("\n"));
  assert.doesNotMatch(free.body, /55491019425407|보증금/);
  const pay = rules.buildRentalApplicantMessage("approved", {
    ...ROW, startHour: 10, endHour: 13, startMinute: 600, endMinute: 780, headcount: 12, useAircon: true,
    memberFree: true, usageFee: 63_000, deposit: 0, totalAmount: 63_000,
  }, ACCOUNT);
  assert.equal(pay.templateKey, "approvedMemberPay");
  assert.match(pay.body, /^\[스티즈농구교실\] 재원생 체육관 대관이 승인되었습니다\.\n/);
  assert.match(pay.body, /\n입금 63,000원\(2시간 초과 30,000원 \+ 냉난방 15,000원 \+ 인원 추가 18,000원, 보증금 없음\)\n하나은행 55491019425407/);
  assert.match(pay.body, /입금 확인 후 확정 문자를 드려요\./);
  assert.doesNotMatch(pay.body, /보증금이 차감/);
});

test("문자 틀: 거절(사유)·확정(보증금 0원이면 환불 문장 제외)", () => {
  const rejected = rules.buildRentalApplicantMessage("rejected", { ...ROW, rejectReason: "그 시간에 학원 일정이 있어요" }, ACCOUNT);
  assert.equal(rejected.body, [
    "[스티즈농구교실] 죄송합니다. 신청하신 체육관 대관이 어렵습니다.",
    "2026년 11월 16일(월) 20:40~21:40 (1시간)",
    "사유: 그 시간에 학원 일정이 있어요",
    "다른 시간으로 다시 신청해 주세요. www.stiz-dasan.kr/rental",
  ].join("\n"));
  const confirmed = rules.buildRentalApplicantMessage("confirmed", { ...ROW, useAircon: true }, ACCOUNT);
  assert.equal(confirmed.templateKey, "confirmed");
  assert.match(confirmed.body, /· 8명 · 냉난방\n/);
  assert.match(confirmed.body, /보증금을 환불해 드립니다\.$/);
  const noDeposit = rules.buildRentalApplicantMessage("confirmed", { ...ROW, memberFree: true, deposit: 0 }, ACCOUNT);
  assert.equal(noDeposit.templateKey, "confirmedNoDeposit");
  assert.doesNotMatch(noDeposit.body, /보증금/);
  // 옛 이름 함수도 같은 틀을 쓴다
  assert.equal(rules.buildRentalConfirmedApplicantSms(ROW), rules.buildRentalApplicantMessage("confirmed", ROW, "-").body);
});

test("알림톡: 틀에 변수 맵을 넣은 결과 == 문자 본문(틀마다), 변수는 그 틀에 쓰인 것만", () => {
  const cases = [
    ["approved", ROW],
    ["approved", { ...ROW, memberFree: true, usageFee: 0, deposit: 0, totalAmount: 0 }],
    ["approved", { ...ROW, memberFree: true, endMinute: 1240 + 150, usageFee: 15_000, deposit: 0, totalAmount: 15_000, startMinute: 1110, endHour: 21, startHour: 18 }],
    ["rejected", { ...ROW, rejectReason: "신청 인원이 너무 많아요" }],
    ["confirmed", ROW],
    ["confirmed", { ...ROW, deposit: 0 }],
  ];
  const seen = new Set();
  for (const [kind, row] of cases) {
    const m = rules.buildRentalApplicantMessage(kind, row, ACCOUNT);
    seen.add(m.templateKey);
    const template = rules.RENTAL_APPLICANT_TEMPLATES[m.templateKey];
    assert.equal(rules.fillRentalTemplate(template, m.variables), m.body, m.templateKey);
    const used = [...new Set(template.match(/#\{[^}]+\}/g))].sort();
    assert.deepEqual(Object.keys(m.variables).sort(), used, m.templateKey);
    // 알림톡 변수 값이 비어 있지 않다(빈 변수는 발송 실패)
    for (const value of Object.values(m.variables)) assert.ok(String(value).length > 0, m.templateKey);
  }
  assert.deepEqual([...seen].sort(), Object.keys(rules.RENTAL_APPLICANT_TEMPLATES).sort());
  assert.throws(() => rules.fillRentalTemplate("#{없음}", {}));
});

test("알림톡 문서: 등록 문구가 코드 틀과 글자까지 같다(템플릿 5종 + 선택 1종)", () => {
  const doc = read("docs/kakao-alimtalk-rental-templates.md");
  for (const [key, template] of Object.entries(rules.RENTAL_APPLICANT_TEMPLATES)) {
    assert.ok(doc.includes("```\n" + template + "\n```"), `문서에 ${key} 본문이 그대로 있어야 한다`);
  }
  for (const env of ["RENTAL_ALIMTALK_APPROVED", "RENTAL_ALIMTALK_APPROVED_MEMBER_FREE", "RENTAL_ALIMTALK_APPROVED_MEMBER_PAY", "RENTAL_ALIMTALK_REJECTED", "RENTAL_ALIMTALK_CONFIRMED"]) {
    assert.ok(doc.includes(env), env);
  }
  assert.match(doc, /https:\/\/www\.stiz-dasan\.kr\/rental/);
});

test("연결: 알림톡 env 매핑·거절 트리거·문자 결과 기록·알림톡 경로(sendTrackedSms → sendMessageDetailed)", () => {
  const notify = read("src/lib/rental/gym-rental-notify.ts");
  for (const [key, env] of [
    ["approved", "RENTAL_ALIMTALK_APPROVED"], ["approvedMemberFree", "RENTAL_ALIMTALK_APPROVED_MEMBER_FREE"],
    ["approvedMemberPay", "RENTAL_ALIMTALK_APPROVED_MEMBER_PAY"], ["rejected", "RENTAL_ALIMTALK_REJECTED"], ["confirmed", "RENTAL_ALIMTALK_CONFIRMED"],
  ]) assert.match(notify, new RegExp(`${key}: "${env}"`));
  assert.match(notify, /rejected: "RENTAL_REJECTED_APPLICANT"/);
  assert.match(notify, /alimtalk,\n/);
  const notification = read("src/lib/notification.ts");
  assert.match(notification, /alimtalk: input\.alimtalk\?\.templateId\?\.trim\(\) \? input\.alimtalk : undefined/);
  const actions = read("src/app/actions/rental.ts");
  assert.match(actions, /saveRentalSmsStatus\(prisma, r\.id, `\$\{sms\}:\$\{kind\}`\)/);
  // 접수 문자는 계속 전용 스위치(꺼짐) — 바꾸지 않는다
  assert.match(notify, /process\.env\.RENTAL_APPLICANT_RECEIVED_SMS_ENABLED === "1"/);
});

// ── 마이그레이션·스키마 ──────────────────────────────────────────────────
test("마이그레이션: 새 컬럼 전부 IF NOT EXISTS + nullable/기본값, 거절 규칙은 꺼진 채 등록, schema.prisma 와 일치", () => {
  const sql = read("prisma/migrations/20261108230000_gym_rental_member_refund/migration.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "memberFree" BOOLEAN NOT NULL DEFAULT false/);
  for (const col of ["memberStudentId", "refundBank", "refundAccount", "refundHolder", "rejectReason", "applicantSmsStatus", "applicantUserId"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS "${col}" TEXT;`), col);
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "privacyAgreedAt" TIMESTAMPTZ\(6\);/);
  assert.match(sql, /'RENTAL_REJECTED_APPLICANT'[^\n]*'EXTERNAL', 'PARENT', false/);
  assert.match(sql, /ON CONFLICT \(trigger\) DO NOTHING/);
  assert.match(sql, /되돌림 SQL:[\s\S]*DROP COLUMN IF EXISTS "memberFree"/);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM "GymRentalRequest"|GymRentalMemberCheckFail/);
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model GymRentalRequest"), schema.indexOf("}", schema.indexOf("model GymRentalRequest")));
  assert.match(model, /memberFree\s+Boolean\s+@default\(false\)/);
  for (const col of ["memberStudentId", "refundBank", "refundAccount", "refundHolder", "rejectReason", "applicantSmsStatus", "applicantUserId"]) {
    assert.match(model, new RegExp(`${col}\\s+String\\?`), col);
  }
  assert.match(model, /privacyAgreedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/);
});

test("화면: 시간 고르기는 버튼 하나 + 시트, 시작칩 나열·30분 단가 문구 제거, 요금표는 1시간 단위", () => {
  const client = read("src/app/rental/RentalClient.tsx");
  const sheet = read("src/app/rental/RentalTimeSheet.tsx");
  assert.match(client, /"시간 고르기"/);
  assert.match(client, /<RentalTimeSheet/);
  assert.doesNotMatch(client, /groupByHour|durationChoices/);
  assert.doesNotMatch(client, /30분당|PerHalfHour/);
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, /aria-modal="true"/);
  assert.match(sheet, /event\.key === "Escape"/);
  assert.match(sheet, /document\.body\.style\.overflow = "hidden"/);
  assert.match(sheet, /이 시간으로/);
  // 막힘 규칙을 화면에서 새로 만들지 않는다 — 서버가 준 available/maxMinutes 만 읽는다
  assert.doesNotMatch(sheet, /hmToMinutes|dayOfWeek|buildRentalDay\(/);
  const page = read("src/app/rental/page.tsx");
  assert.match(page, /"이후 1시간마다"/);
  assert.doesNotMatch(page, /30분당|30분마다|PerHalfHour/);
  // 개인정보 동의 문구(수집 항목·목적·보유 기간·거부 시 불이익)
  for (const word of ["수집 항목", "목적", "보유 기간", "동의하지 않으면"]) assert.match(client, new RegExp(word));
  // 입금 0원 안내
  assert.match(client, /입금할 금액이 없어요\. 원장님 승인 문자를 기다려 주세요/);
  assert.match(client, /"금액 복사"/);
});

test("시트 보조 함수: 가능한 시만, 이용 시간은 1시간~최대로 맞춘다", async () => {
  const day = rules.buildRentalDay({ date: WEEK.Tue, classes: CLASSES, busy: [], nowMs: NOW });
  // RentalTimeSheet 는 React 의존이라 같은 계산을 규칙 결과로 확인한다
  const hours = [...new Set(day.starts.filter((s) => s.available).map((s) => Math.floor(s.minute / 60)))];
  assert.deepEqual(hours, [9, 10, 11, 12, 13, 14]); // 화요일: 15시 수업 전까지(저녁은 성인반 21:55 까지라 불가)
  const mon = rules.buildRentalDay({ date: WEEK.Mon, classes: CLASSES, busy: [], nowMs: NOW });
  const evening = mon.starts.filter((s) => s.available && s.minute >= 20 * 60).map((s) => [s.label, s.maxMinutes]);
  assert.deepEqual(evening, [["20:40", 90], ["20:50", 60], ["21:00", 60], ["21:10", 60]]); // 월요일 20:35 수업 뒤 — 22:10 마감까지 30분 단위
  const at1400 = day.starts.find((s) => s.minute === 14 * 60);
  assert.equal(at1400.maxMinutes, 60);
});

// ── 검수 반영(G-2·G-3·아이콘·동의 문구) + 로그인 기반 화면 ───────────────
test("관리자: 환불 계좌는 확정·사용 완료·환불 완료·취소 단계에서만, 보증금 0원 사용 완료는 끝난 것으로 정렬, 재원생 승인 안내", () => {
  const actions = read("src/app/actions/rental.ts");
  assert.match(actions, /REFUND_ACCOUNT_VISIBLE: readonly RentalStatus\[\] = \["PAID", "COMPLETED", "REFUNDED", "CANCELLED"\]/);
  const svc = read("src/lib/rental/gym-rental-service.ts");
  assert.match(svc, /WHEN status = 'COMPLETED' AND deposit > 0 THEN 3 ELSE 4 END/);
  assert.match(svc, /OR \(status = 'COMPLETED' AND deposit = 0\) THEN NULL/);
  assert.match(svc, /AS "applicantUserName"/);
  const admin = read("src/app/admin/rental/RentalAdminClient.tsx");
  assert.match(admin, /재원생 무료 · 로그인 계정: \{confirmRow\.applicantUserName \|\| "확인 필요"\}로 신청/);
  // 아이콘은 같은 파일의 다른 아이콘과 같은 방식(material-symbols-outlined + aria-hidden, 크기 클래스 없음)
  assert.match(admin, /<span className="material-symbols-outlined" aria-hidden="true">content_copy<\/span>/);
  // 공개 신청서: 재원생 무료면 «보증금 차감» 문장을 빼고 보인다
  const client = read("src/app/rental/RentalClient.tsx");
  assert.match(client, /memberFree \? "를 지키겠습니다\." : "를 지키지 않으면 보증금이 차감될 수 있습니다\."/);
});

test("공개 화면: 페이지는 정적(ISR) 그대로, 로그인 여부는 서버 액션으로 묻고, 비로그인이면 맨 위 로그인 유도(/rental 로 복귀)", () => {
  const page = read("src/app/rental/page.tsx");
  assert.match(page, /export const revalidate = 3600;/);
  assert.doesNotMatch(page, /cookies\(|headers\(|requireAuth|getVerifiedParentState/);
  const client = read("src/app/rental/RentalClient.tsx");
  assert.match(client, /getRentalMemberContext\(\)/);
  assert.match(client, /재원생 가족이면 로그인하고 신청하면 2시간 무료/);
  assert.match(client, /href="\/login\?redirect=%2Frental"/);
  // 로그인 유도는 날짜(첫 입력)보다 위
  assert.ok(client.indexOf("재원생 가족이면 로그인하고") < client.indexOf("{/* 1. 날짜"));
  // 연결 재원생이 있을 때만 체크칸, 학생 이름 입력칸은 없다
  assert.match(client, /\{memberStudents\.length > 0 && \(/);
  assert.doesNotMatch(client, /studentName|학원에 등록된 학생 이름/);
  assert.match(client, /memberStudentId: memberFree \? memberStudentId : ""/);
});

test("신청 완료: 맨 위로 튀지 않고 접수증으로 스크롤, 계좌·금액 복사가 접수증 맨 위(원장 지시 2026-11-08)", () => {
  const client = read("src/app/rental/RentalClient.tsx");
  // 예전 원인 — 접수 직후 window.scrollTo(맨 위)로 히어로·요금 안내가 보이고 접수증은 아래로 밀렸다
  assert.doesNotMatch(client, /window\.scrollTo\(\{ top: 0/);
  assert.match(client, /receiptRef\.current\?\.scrollIntoView\(\{ behavior: reduceMotion \? "auto" : "smooth", block: "start" \}\)/);
  assert.match(client, /prefers-reduced-motion: reduce/);
  assert.match(client, /receiptTitleRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(client, /ref=\{receiptTitleRef\} tabIndex=\{-1\}/);
  assert.match(client, /ref=\{receiptRef\} className="public-card scroll-mt-24/);
  // 입금 계좌·복사 버튼이 접수 번호보다 위
  const receiptStart = client.indexOf("ref={receiptRef}");
  assert.ok(client.indexOf('"계좌 복사"', receiptStart) < client.indexOf("접수 번호", receiptStart));
  assert.ok(client.indexOf('"금액 복사"', receiptStart) < client.indexOf("접수 번호", receiptStart));
  // 복사값은 그대로 — 계좌는 서버가 만든 bankCopyText, 금액은 숫자만
  assert.match(client, /copyText\("account", receipt\.bankCopyText\)/);
  assert.match(client, /copyText\("amount", String\(receipt\.totalAmount\)\)/);
});
