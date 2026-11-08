// 체육관 대관 — 요금·가능 시간·상태 전이·DB 제약 일치·알림 스위치를 실제로 실행해 검증한다.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/rental/gym-rental-rules.ts");
const service = await loadTsModule("src/lib/rental/gym-rental-service.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const read = (p) => readFileSync(p, "utf8");
const MIGRATION = read("prisma/migrations/20261107120000_add_gym_rental_request/migration.sql");

test("요금: 2시간·12명·냉난방 = 이용료 92,000 + 보증금 20,000 = 112,000", () => {
  const fee = rules.calculateRentalFee({ durationMinutes: 120, headcount: 12, useAircon: true });
  assert.equal(fee.baseFee, 70_000);
  assert.equal(fee.airconFee, 10_000);
  assert.equal(fee.extraPeopleFee, 12_000);
  assert.equal(fee.usageFee, 92_000);
  assert.equal(fee.deposit, 20_000);
  assert.equal(fee.total, 112_000);
});

test("요금: 1시간·10명·냉난방 없음 = 40,000 + 보증금, 10명까지는 추가 없음", () => {
  const fee = rules.calculateRentalFee({ durationMinutes: 60, headcount: 10, useAircon: false });
  assert.equal(fee.usageFee, 40_000);
  assert.equal(fee.total, 60_000);
  assert.equal(rules.calculateRentalFee({ durationMinutes: 180, headcount: 11, useAircon: false }).usageFee, 40_000 + 60_000 + 9_000);
});

test("요금: 범위 밖 시간·인원은 거절", () => {
  assert.throws(() => rules.calculateRentalFee({ durationMinutes: 0, headcount: 5, useAircon: false }));
  assert.throws(() => rules.calculateRentalFee({ durationMinutes: 30, headcount: 5, useAircon: false })); // 1시간 미만
  assert.throws(() => rules.calculateRentalFee({ durationMinutes: 70, headcount: 5, useAircon: false })); // 30분 단위 아님
  assert.throws(() => rules.calculateRentalFee({ durationMinutes: rules.RENTAL_MAX_MINUTES + 30, headcount: 5, useAircon: false }));
  assert.throws(() => rules.calculateRentalFee({ durationMinutes: 60, headcount: 0, useAircon: false }));
  assert.throws(() => rules.calculateRentalFee({ durationMinutes: 60, headcount: rules.RENTAL_MAX_HEADCOUNT + 1, useAircon: false }));
});

const MON = "2026-11-09"; // 월요일
const CLASSES = [
  { dayOfWeek: "Mon", startTime: "16:00", endTime: "16:55" },
  { dayOfWeek: "Mon", startTime: "19:20", endTime: "20:35" },
  { dayOfWeek: "Tue", startTime: "09:00", endTime: "12:00" }, // 다른 요일 — 월요일 칸에 영향 없음
];

// 시작 후보(분) → 사유. 분 단위로 찾는다.
const reasonAt = (day, hm) => day.starts.find((o) => o.minute === rules.hmToMinutes(hm))?.reason;
const maxAt = (day, hm) => day.starts.find((o) => o.minute === rules.hmToMinutes(hm))?.maxMinutes;

test("가능 시간: 그 요일 수업과 겹치는 시작만 막고, 끝나는 시각과 시작 시각이 같으면 안 겹친다", () => {
  assert.equal(kst.kstDow(MON), 1);
  const day = rules.buildRentalDay({ date: MON, classes: CLASSES, busy: [], nowMs: kst.kstAt("2026-11-01", "00:00") });
  assert.equal(day.starts[0].label, "09:00"); // 평일 09시부터
  assert.equal(day.starts.at(-1).label, "21:00"); // 22시까지 최소 1시간 → 마지막 시작 21:00
  assert.equal(reasonAt(day, "09:00"), "OPEN"); // 화요일 수업은 무관
  assert.equal(reasonAt(day, "15:00"), "OPEN"); // 15:00~16:00 은 16:00 수업 직전까지
  assert.equal(maxAt(day, "15:00"), 60);
  assert.equal(reasonAt(day, "15:10"), "CLASS"); // 1시간이 16:00 수업과 겹침
  assert.equal(reasonAt(day, "16:50"), "CLASS");
  assert.equal(reasonAt(day, "17:00"), "OPEN"); // 16:55 종료 → 17:00 시작 가능(16:55 는 10분 단위가 아님)
  assert.equal(reasonAt(day, "19:00"), "CLASS");
  assert.equal(reasonAt(day, "20:30"), "CLASS"); // 20:35 종료
  assert.equal(reasonAt(day, "20:40"), "OPEN"); // 끝나고 바로
  assert.equal(maxAt(day, "20:40"), 60); // 20:40~21:40, 22:00 넘김(1시간 30분)은 불가
});

test("가능 시간: 지난 시각·승인된 대관·특강 회차는 막힌다", () => {
  const day = rules.buildRentalDay({
    date: MON,
    classes: CLASSES,
    busy: [{ startMinute: 10 * 60 + 30, endMinute: 11 * 60 }], // 특강 10:30~11:00
    bookedBusy: [{ startMinute: 13 * 60, endMinute: 15 * 60 }], // 승인 대관 13~15시
    nowMs: kst.kstAt(MON, "09:30"),
  });
  assert.equal(reasonAt(day, "09:00"), "PAST");
  assert.equal(reasonAt(day, "09:30"), "PAST"); // 지금 이 순간 = 이미 시작
  assert.equal(reasonAt(day, "09:40"), "CLASS"); // 09:40~10:40 이 특강과 겹침
  assert.equal(reasonAt(day, "10:00"), "CLASS");
  assert.equal(reasonAt(day, "11:00"), "OPEN");
  assert.equal(reasonAt(day, "13:00"), "BOOKED");
  assert.equal(reasonAt(day, "14:00"), "BOOKED");
  assert.equal(maxAt(day, "11:00"), 120); // 11~13시 → 13시 막힘
  assert.equal(rules.isRentalRangeAvailable(day, 660, 120), true);
  assert.equal(rules.isRentalRangeAvailable(day, 660, 150), false);
  assert.equal(rules.isRentalRangeAvailable(day, 960, 60), false); // 16시 수업
  assert.ok(day.blocks.some((b) => b.reason === "BOOKED" && b.startMinute === 780));
});

test("KST 시각: 분 → 절대 시각이 한국 시간 기준(UTC 서버에서도 같은 값)", () => {
  assert.equal(new Date(rules.rentalInstantMs(MON, 9 * 60)).toISOString(), "2026-11-09T00:00:00.000Z");
  assert.equal(new Date(rules.rentalInstantMs(MON, 22 * 60)).toISOString(), "2026-11-09T13:00:00.000Z");
  assert.equal(new Date(rules.rentalInstantMs(MON, 20 * 60 + 40)).toISOString(), "2026-11-09T11:40:00.000Z");
  assert.equal(new Date(rules.rentalInstantMs("2026-12-31", 24 * 60)).toISOString(), "2026-12-31T15:00:00.000Z");
});

test("신청 가능 날짜: 오늘부터 정해진 날 수까지만", () => {
  assert.equal(rules.isBookableDate("2026-11-07", "2026-11-07"), true);
  assert.equal(rules.isBookableDate("2026-11-06", "2026-11-07"), false);
  assert.equal(rules.isBookableDate(kst.addDaysKst("2026-11-07", rules.RENTAL_BOOKING_DAYS), "2026-11-07"), true);
  assert.equal(rules.isBookableDate(kst.addDaysKst("2026-11-07", rules.RENTAL_BOOKING_DAYS + 1), "2026-11-07"), false);
  assert.equal(rules.isBookableDate("2026-02-30", "2026-01-01"), false);
});

test("DB 제약과 코드 상태 목록이 같은 집합이다(EXCLUDE·CHECK)", () => {
  const exclude = /EXCLUDE USING gist[\s\S]*?WHERE \(status IN \(([^)]*)\)\)/.exec(MIGRATION);
  assert.ok(exclude, "EXCLUDE 제약이 있어야 한다");
  const holding = exclude[1].match(/'([A-Z_]+)'/g).map((s) => s.slice(1, -1)).sort();
  assert.deepEqual(holding, [...rules.RENTAL_HOLDING_STATUSES].sort());
  const check = /status IN \(('REQUESTED'[^)]*)\)/.exec(MIGRATION);
  const all = check[1].match(/'([A-Z_]+)'/g).map((s) => s.slice(1, -1)).sort();
  assert.deepEqual(all, [...rules.RENTAL_STATUSES].sort());
  // RLS·권한 회수
  assert.match(MIGRATION, /ALTER TABLE "GymRentalRequest" ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /REVOKE ALL ON "GymRentalRequest" FROM %I/);
  // 신청자 문자 규칙은 꺼진 채로 만든다
  for (const trigger of ["RENTAL_RECEIVED_APPLICANT", "RENTAL_APPROVED_APPLICANT", "RENTAL_CONFIRMED_APPLICANT"]) {
    assert.match(MIGRATION, new RegExp(`'${trigger}'[^\\n]*'EXTERNAL', 'PARENT', false`), trigger);
  }
});

test("상태 전이: 승인 → 입금 확인 → 사용 완료 → 환불, 거절은 승인 전만", () => {
  assert.deepEqual(rules.allowedRentalActions("REQUESTED").sort(), ["approve", "reject"]);
  assert.deepEqual(rules.allowedRentalActions("APPROVED").sort(), ["cancel", "confirmPayment"]);
  assert.deepEqual(rules.allowedRentalActions("PAID").sort(), ["cancel", "complete"]);
  assert.deepEqual(rules.allowedRentalActions("COMPLETED"), ["refund"]);
  for (const done of ["REFUNDED", "REJECTED", "CANCELLED"]) assert.deepEqual(rules.allowedRentalActions(done), []);
  for (const s of rules.RENTAL_STATUSES) assert.ok(rules.RENTAL_STATUS_LABEL[s], s);
});

const SAMPLE = {
  applicantName: "김대관", applicantPhone: "01012345678", rentalDate: MON, startHour: 10, endHour: 12, startMinute: 600, endMinute: 720,
  headcount: 12, useAircon: true, usageFee: 92_000, deposit: 20_000, totalAmount: 112_000, purpose: "동호회 연습",
};

test("문자 문구: 계좌는 승인 문자에만, 원장 알림·접수 문자에는 없다", () => {
  const account = "하나은행 55491019425407 (예금주 권혜미)";
  const approved = rules.buildRentalApprovedApplicantSms(SAMPLE, account);
  assert.match(approved, /55491019425407/);
  assert.match(approved, /112,000원/);
  assert.doesNotMatch(rules.buildRentalReceivedApplicantSms(SAMPLE), /55491019425407/);
  assert.doesNotMatch(rules.buildRentalAdminAlert(SAMPLE), /55491019425407/);
  assert.match(rules.buildRentalAdminAlert(SAMPLE), /2026년 11월 9일\(월\) 10:00~12:00 \(2시간\)/);
  assert.match(rules.buildRentalConfirmedApplicantSms(SAMPLE), /실내운동화/);
  assert.match(rules.buildRentalConfirmedApplicantSms(SAMPLE), /주민센터 주차장/);
});

test("휴대폰 번호 정리: 숫자만, 010 형식만", () => {
  assert.equal(rules.normalizeRentalPhone("010-1234-5678"), "01012345678");
  assert.equal(rules.normalizeRentalPhone("02-123-4567"), "");
  assert.equal(rules.normalizeRentalPhone("abc"), "");
  assert.equal(rules.formatRentalPhone("01012345678"), "010-1234-5678");
});

// ── 가짜 DB 로 서비스 실행 ─────────────────────────────────────────────────
function fakeDb({ rentals = [], counts = { phone10: 0, phoneDay: 0, all10: 0 }, existing = [] } = {}) {
  const calls = [];
  const db = {
    calls,
    inserted: null,
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes(`FROM "Class"`)) return CLASSES;
      if (sql.includes(`"SpecialProgramSessionDate"`)) return [];
      if (sql.includes(`AS "startsAt"`)) return rentals;
      if (sql.includes("COUNT(*) FILTER")) return [counts];
      if (sql.startsWith(`SELECT id, "rentalDate"`) && sql.includes(`"applicantPhone" = $1 AND "rentalDate"`)) return existing;
      if (sql.includes(`INSERT INTO "GymRentalRequest"`)) {
        db.inserted = values;
        return [{ id: "00000000-0000-4000-8000-000000000001", rentalDate: values[0], startHour: values[1], endHour: values[2],
          headcount: values[5], useAircon: values[6], applicantName: values[7], applicantPhone: values[8], purpose: values[9],
          usageFee: values[10], deposit: values[11], totalAmount: values[12], startMinute: values[14], endMinute: values[15], status: "REQUESTED" }];
      }
      throw new Error(`예상 못 한 SQL: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe() { return 1; },
  };
  return db;
}

const NOW = kst.kstAt("2026-11-07", "12:00");
const GOOD = {
  rentalDate: MON, startMinute: 600, durationMinutes: 120, headcount: 12, useAircon: true,
  applicantName: " 김대관 ", applicantPhone: "010-1234-5678", purpose: "동호회 연습", agreedRules: true,
  usageFee: 1, totalAmount: 1, // 화면이 보낸 금액은 무시돼야 한다
};

test("신청: 금액은 서버가 다시 계산하고, KST 기준 절대 시각을 저장한다", async () => {
  const db = fakeDb();
  const result = await service.createRentalRequest(db, GOOD, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  const v = db.inserted;
  assert.equal(v[3], "2026-11-09T01:00:00.000Z"); // 10시 KST
  assert.equal(v[4], "2026-11-09T03:00:00.000Z"); // 12시 KST
  assert.equal(v[7], "김대관");
  assert.equal(v[8], "01012345678");
  assert.deepEqual([v[10], v[11], v[12]], [92_000, 20_000, 112_000]);
});

test("신청: 수업 시간·승인된 대관과 겹치면 거절, 동의·목적 없으면 거절", async () => {
  assert.equal((await service.createRentalRequest(fakeDb(), { ...GOOD, startMinute: 960, durationMinutes: 60 }, NOW)).ok, false);
  const booked = fakeDb({ rentals: [{ startsAt: "2026-11-09T02:00:00.000Z", endsAt: "2026-11-09T03:00:00.000Z" }] }); // 11~12시
  assert.equal((await service.createRentalRequest(booked, GOOD, NOW)).ok, false);
  assert.equal((await service.createRentalRequest(fakeDb(), { ...GOOD, agreedRules: false }, NOW)).ok, false);
  assert.equal((await service.createRentalRequest(fakeDb(), { ...GOOD, purpose: "  " }, NOW)).ok, false);
  assert.equal((await service.createRentalRequest(fakeDb(), { ...GOOD, applicantPhone: "123" }, NOW)).ok, false);
  assert.equal((await service.createRentalRequest(fakeDb(), { ...GOOD, rentalDate: "2026-11-06" }, NOW)).ok, false);
});

const IP = "a".repeat(64);

test("신청: 한도 확인 전에 신청 전체를 잠그고, 접속 주소 지문을 저장한다", async () => {
  const db = fakeDb();
  db.$executeRawUnsafe = async (sql, ...values) => { db.calls.push({ sql, values }); return 1; };
  assert.equal((await service.createRentalRequest(db, GOOD, NOW, IP)).ok, true);
  const lockAt = db.calls.findIndex((c) => c.sql.includes("pg_advisory_xact_lock") && c.values[0] === "gym-rental:apply");
  const countAt = db.calls.findIndex((c) => c.sql.includes("COUNT(*) FILTER"));
  assert.ok(lockAt >= 0 && lockAt < countAt, "잠금이 한도 확인보다 먼저");
  assert.equal(db.calls[countAt].values[1], IP);
  assert.equal(db.inserted[13], IP);
  // 형식이 틀린 지문은 저장하지 않는다
  const odd = fakeDb();
  await service.createRentalRequest(odd, GOOD, NOW, "1.2.3.4");
  assert.equal(odd.inserted[13], null);
});

test("신청: 같은 접속 주소 10분 5건·하루 15건이면 막는다", async () => {
  for (const counts of [{ ip10: 5, ipDay: 5 }, { ip10: 0, ipDay: 15 }]) {
    const db = fakeDb({ counts: { phone10: 0, phoneDay: 0, all10: 0, ...counts } });
    assert.equal((await service.createRentalRequest(db, GOOD, NOW, IP)).ok, false);
    assert.equal(db.inserted, null);
  }
  assert.equal(service.RENTAL_RATE_LIMIT.perIp10Min, 5);
  assert.equal(service.RENTAL_RATE_LIMIT.perIpDay, 15);
});

test("가능 시간: 끝난 반([종료])과 ACTIVE 수강생 없는 반은 조회에서 뺀다", async () => {
  const db = fakeDb();
  await service.loadRentalDay(db, MON, NOW);
  const sql = db.calls.find((c) => c.sql.includes(`FROM "Class"`)).sql;
  assert.match(sql, /c\.name NOT LIKE '\[%'/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM "Enrollment" e WHERE e\."classId" = c\.id AND e\.status = 'ACTIVE'\)/);
});

test("신청: 같은 연락처 반복은 막고, 같은 시간 재신청은 새로 만들지 않는다", async () => {
  const limited = fakeDb({ counts: { phone10: service.RENTAL_RATE_LIMIT.perPhone10Min, phoneDay: 0, all10: 0 } });
  const r = await service.createRentalRequest(limited, GOOD, NOW);
  assert.equal(r.ok, false);
  assert.equal(limited.inserted, null);
  const dup = fakeDb({ existing: [{ id: "x", status: "REQUESTED" }] });
  const d = await service.createRentalRequest(dup, GOOD, NOW);
  assert.equal(d.ok, true);
  assert.equal(d.duplicate, true);
  assert.equal(dup.inserted, null);
});

function fakeTx({ status = "REQUESTED", clash = false, startHour = 10, endHour = 12, sessions = [] } = {}) {
  const startMinute = startHour * 60;
  const endMinute = endHour * 60;
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes("FOR UPDATE")) return [{ id: values[0], status, rentalDate: MON, deposit: 20_000, startMinute, endMinute, totalAmount: 112_000 }];
      if (sql.includes(`FROM "GymRentalRequest" o`)) return clash ? [{ id: "other" }] : [];
      // 승인 때 다시 보는 가능 시간(정규 반·특강·승인 대관)
      if (sql.includes(`FROM "Class"`)) return CLASSES;
      if (sql.includes(`"SpecialProgramSessionDate"`)) return sessions;
      if (sql.includes(`AS "startsAt"`)) return [];
      if (sql.startsWith(`UPDATE "GymRentalRequest"`)) return [{ id: values[0], status: values[1] }];
      throw new Error(`예상 못 한 SQL: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe(sql, ...values) { calls.push({ sql, values }); return 1; },
  };
}
const ID = "00000000-0000-4000-8000-000000000001";

test("승인: 그날 잠금 후 겹치는 승인 대관이 있으면 거절, 없으면 APPROVED", async () => {
  const tx = fakeTx();
  const ok = await service.transitionRentalInTx(tx, ID, "approve", "admin", { nowMs: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.request.status, "APPROVED");
  assert.ok(tx.calls.some((c) => c.sql.includes("pg_advisory_xact_lock") && c.values[0] === `gym-rental:${MON}`));
  const clash = await service.transitionRentalInTx(fakeTx({ clash: true }), ID, "approve", "admin", { nowMs: NOW });
  assert.equal(clash.ok, false);
});

test("승인: 신청 뒤 생긴 수업·특강과 겹치거나 이미 지난 시간이면 거절(UPDATE 없음)", async () => {
  // 16시 칸은 월요일 정규 수업
  const classTx = fakeTx({ startHour: 15, endHour: 17 });
  assert.equal((await service.transitionRentalInTx(classTx, ID, "approve", "a", { nowMs: NOW })).ok, false);
  assert.ok(!classTx.calls.some((c) => c.sql.startsWith(`UPDATE "GymRentalRequest"`)));
  // 신청 뒤 11~12시 특강 회차가 생김
  const seasonTx = fakeTx({ sessions: [{ startsAt: "2026-11-09T02:00:00.000Z", endsAt: "2026-11-09T03:00:00.000Z" }] });
  assert.equal((await service.transitionRentalInTx(seasonTx, ID, "approve", "a", { nowMs: NOW })).ok, false);
  // 이용 시각이 이미 지남
  assert.equal((await service.transitionRentalInTx(fakeTx(), ID, "approve", "a", { nowMs: kst.kstAt(MON, "10:30") })).ok, false);
});

test("확정 뒤 취소: 돌려준 금액(0~입금액) 필수, 메모에 금액 기록 / 입금 전 취소는 금액 없이", async () => {
  for (const bad of [undefined, "", -1, 112_001, 1.5]) {
    assert.equal((await service.transitionRentalInTx(fakeTx({ status: "PAID" }), ID, "cancel", "a", { cancelRefund: bad })).ok, false, String(bad));
  }
  const paid = fakeTx({ status: "PAID" });
  assert.equal((await service.transitionRentalInTx(paid, ID, "cancel", "a", { cancelRefund: 0, memo: "고객 사정" })).ok, true);
  const update = paid.calls.find((c) => c.sql.startsWith(`UPDATE "GymRentalRequest"`));
  assert.equal(update.values[7], 0);
  assert.equal(update.values[4], "환불 0원 · 고객 사정");
  const approved = fakeTx({ status: "APPROVED" });
  assert.equal((await service.transitionRentalInTx(approved, ID, "cancel", "a")).ok, true);
  assert.equal(approved.calls.find((c) => c.sql.startsWith(`UPDATE "GymRentalRequest"`)).values[7], null);
});

test("상태 전이: 맞지 않는 상태·잘못된 환불 금액은 거절", async () => {
  assert.equal((await service.transitionRentalInTx(fakeTx({ status: "PAID" }), ID, "approve", "a")).ok, false);
  assert.equal((await service.transitionRentalInTx(fakeTx({ status: "COMPLETED" }), ID, "refund", "a", { depositRefunded: 25_000 })).ok, false);
  const refund = fakeTx({ status: "COMPLETED" });
  assert.equal((await service.transitionRentalInTx(refund, ID, "refund", "a", { depositRefunded: 15_000 })).ok, true);
  const update = refund.calls.find((c) => c.sql.startsWith(`UPDATE "GymRentalRequest"`));
  assert.equal(update.values[3], 15_000);
  assert.equal((await service.transitionRentalInTx(fakeTx(), "not-a-uuid", "approve", "a")).ok, false);
  assert.equal((await service.transitionRentalInTx(fakeTx(), ID, "explode", "a")).ok, false);
  assert.equal(service.isRentalOverlapViolation({ code: "23P01" }), true);
  assert.equal(service.isRentalOverlapViolation(new Error("other")), false);
});

// ── 연결(메뉴·권한·스위치) ─────────────────────────────────────────────────
test("관리자 메뉴 «요청·신청함»에서 체육관 대관 화면에 도달할 수 있다", () => {
  const shell = read("src/app/admin/AdminShellClient.tsx");
  const requests = shell.slice(shell.indexOf('label: "요청·신청함"'), shell.indexOf('label: "수업 운영"'));
  assert.match(requests, /\["\/admin\/rental", "체육관 대관", "🏟️"\]/);
  assert.match(shell, /"🏟️": "stadium"/);
});

// 손님 브라우저 번들에 들어가는 파일 = 클라이언트 컴포넌트에서 import 를 따라간 모듈 전부.
// "use server" 파일은 번들에 «호출 손잡이»만 들어가고 본문(그 파일이 import 하는 것)은 서버에 남으므로 거기서 멈춘다.
function clientBundleFiles(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = read(file);
    if (file !== entry && /^\s*["']use server["']/.test(code)) continue;
    for (const [, spec] of code.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g)) {
      if (!spec || !(spec.startsWith("@/") || spec.startsWith("."))) continue;
      const base = spec.startsWith("@/") ? `src/${spec.slice(2)}` : join(dirname(file), spec).replace(/\\/g, "/");
      const hit = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((p) => existsSync(p) && !p.endsWith("/"));
      if (hit) stack.push(hit);
    }
  }
  return [...seen];
}

test("공개 신청 화면의 브라우저 번들 경로에 입금 계좌가 없다(계좌는 서버 전용 모듈에만)", () => {
  // 카드사 심사 승인(2026-11-07) 뒤 원장 지시로 공개 메뉴에 노출한다.
  assert.match(read("src/components/PublicHeader.tsx"), /\{ href: "\/rental", label: "체육관 대관" \}/);
  const files = clientBundleFiles("src/app/rental/RentalClient.tsx");
  assert.ok(files.includes("src/lib/rental/gym-rental-rules.ts"), "규칙 모듈은 번들에 들어간다(그래서 계좌를 두면 안 된다)");
  assert.ok(files.includes("src/app/actions/rental.ts"), "서버 액션 파일까지는 따라간다");
  for (const file of files) {
    assert.doesNotMatch(read(file), /55491019425407|권혜미/, file);
    assert.ok(!file.endsWith("gym-rental-notify.ts"), "서버 전용 알림 모듈이 번들 경로에 있으면 안 된다");
  }
  // 계좌는 서버 전용 모듈 한 곳 + 그 모듈은 server-only 로 잠김
  const notify = read("src/lib/rental/gym-rental-notify.ts");
  assert.match(notify, /^import "server-only";/m);
  assert.match(notify, /DEFAULT_RENTAL_BANK_ACCOUNT = "하나은행 55491019425407 \(예금주 권혜미\)"/);
  assert.match(notify, /process\.env\.RENTAL_BANK_ACCOUNT/);
  assert.match(read("src/app/rental/RentalClient.tsx"), /publicErrorText\(/);
});

test("관리자 액션은 requireAdmin, 신청자 문자는 스위치(RENTAL_APPLICANT_SMS_ENABLED) 뒤에", () => {
  const actions = read("src/app/actions/rental.ts");
  for (const fn of ["getAdminRentalRequests", "updateRentalStatus"]) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 300), /await requireAdmin\(\)/, fn);
  }
  const notify = read("src/lib/rental/gym-rental-notify.ts");
  assert.match(notify, /process\.env\.RENTAL_APPLICANT_SMS_ENABLED === "1"/);
  // 접수 문자는 남의 번호로도 보낼 수 있어 전용 스위치 없이는 절대 안 나간다
  assert.match(notify, /process\.env\.RENTAL_APPLICANT_RECEIVED_SMS_ENABLED === "1"/);
  const applicantFn = notify.slice(notify.indexOf("export async function sendRentalApplicantSms"));
  assert.match(applicantFn.slice(0, 400), /if \(kind === "received" \? !isRentalReceivedSmsEnabled\(\) : !isRentalApplicantSmsEnabled\(\)\) return;/);
  // 원장 알림 문자는 10분 창 키로 장부 중복을 걸러 한 통으로 묶는다(슬랙은 건별)
  assert.match(notify, /eventId: smsEventId/);
  assert.match(notify, /if \(admin\.phone && sendSms\)/);
  assert.equal(rules.rentalAdminSmsWindowKey(kst.kstAt(MON, "10:01")), rules.rentalAdminSmsWindowKey(kst.kstAt(MON, "10:09")));
  assert.notEqual(rules.rentalAdminSmsWindowKey(kst.kstAt(MON, "10:09")), rules.rentalAdminSmsWindowKey(kst.kstAt(MON, "10:11")));
  assert.match(rules.buildRentalAdminAlert(SAMPLE, 3), /승인 대기 3건/);
  // 공개 신청은 한도 확인·저장을 한 트랜잭션에서, IP 는 x-forwarded-for 첫 값의 지문으로
  assert.match(actions, /prisma\.\$transaction\(\(tx\) => createRentalRequest\(tx, input, Date\.now\(\), ipHash\)\)/);
  assert.match(actions, /get\("x-forwarded-for"\) \?\? ""\)\.split\(","\)\[0\]/);
  // 원장 알림은 관리자 역할 계정만
  assert.match(notify, /role IN \('ADMIN','VICE_ADMIN'\)/);
});
