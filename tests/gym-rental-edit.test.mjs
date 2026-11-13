// 관리자 «내용 수정»(editRentalInTx) — 가짜 DB 로 실제 실행해 본다(2026-11-13 신청자 전화로 1시간 → 2시간 변경 요청).
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const service = await loadTsModule("src/lib/rental/gym-rental-service.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");

const MON = "2026-11-09"; // 월요일 — 16:00 정규 수업이 있다
const NOW = kst.kstAt("2026-11-07", "12:00");
const ID = "00000000-0000-4000-8000-000000000001";
const CLASSES = [{ dayOfWeek: "Mon", startTime: "16:00", endTime: "16:55" }];

/** 지금 저장된 신청 한 건(10:00~11:00 · 6명 · 60,000원) */
function current(over = {}) {
  return {
    id: ID, rentalDate: MON, startHour: 10, endHour: 11, startMinute: 600, endMinute: 660, headcount: 6, useAircon: false,
    usageFee: 40_000, deposit: 20_000, totalAmount: 60_000, status: "REQUESTED", memberFree: false, adminMemo: null, ...over,
  };
}

function fakeTx({ row = current(), rentals = [] } = {}) {
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes("FOR UPDATE")) return row ? [row] : [];
      if (sql.includes(`FROM "Class"`)) return CLASSES;
      if (sql.includes(`"SpecialProgramSessionDate"`)) return [];
      if (sql.includes(`AS "startsAt"`)) return rentals;
      if (sql.startsWith(`UPDATE "GymRentalRequest"`)) return [{ ...row, id: values[0], rentalDate: values[1], usageFee: values[10], deposit: values[11], totalAmount: values[12] }];
      throw new Error(`예상 못 한 SQL: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe(sql, ...values) { calls.push({ sql, values }); return 1; },
  };
}
const updateOf = (tx) => tx.calls.find((c) => c.sql.startsWith(`UPDATE "GymRentalRequest"`));
const edit = (over) => ({ rentalDate: MON, startMinute: 600, durationMinutes: 120, headcount: 6, useAircon: false, ...over });

test("1시간 → 2시간: 금액을 서버가 다시 계산(이용료 70,000 + 보증금 20,000)하고 메모에 전후를 남긴다", async () => {
  const tx = fakeTx();
  const result = await service.editRentalInTx(tx, ID, edit(), "admin", NOW);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const update = updateOf(tx);
  assert.deepEqual(update.values.slice(1, 6), [MON, 10, 12, 600, 720]); // 날짜·정시 칸·분
  assert.deepEqual(update.values.slice(10, 13), [70_000, 20_000, 90_000]);
  assert.match(update.values[14], /10:00~11:00 .* 60,000원 → .*10:00~12:00 .* 90,000원/);
  assert.equal(update.values[15], "REQUESTED"); // 그 사이 상태가 바뀌었으면 UPDATE 0건
  // 그날 승인과 같은 줄에 서고, 가능 시간은 «자기 자신»을 빼고 본다
  assert.ok(tx.calls.some((c) => c.sql.includes("pg_advisory_xact_lock") && c.values[0] === `gym-rental:${MON}`));
  assert.equal(tx.calls.find((c) => c.sql.includes(`AS "startsAt"`)).values[2], ID);
});

test("정규 수업·다른 승인 대관과 겹치면 저장하지 않는다", async () => {
  const classTx = fakeTx();
  assert.equal((await service.editRentalInTx(classTx, ID, edit({ startMinute: 900 }), "a", NOW)).ok, false); // 15:00~17:00 ↔ 16:00 수업
  assert.equal(updateOf(classTx), undefined);
  const otherTx = fakeTx({ rentals: [{ startsAt: "2026-11-09T02:00:00.000Z", endsAt: "2026-11-09T03:00:00.000Z" }] }); // 11~12시 다른 대관
  assert.equal((await service.editRentalInTx(otherTx, ID, edit(), "a", NOW)).ok, false);
  assert.equal(updateOf(otherTx), undefined);
});

test("돈을 받은 뒤(확정·완료)는 고칠 수 없고, 잘못된 값·지난 날짜는 거절", async () => {
  for (const status of ["PAID", "COMPLETED", "REJECTED", "CANCELLED"]) {
    const tx = fakeTx({ row: current({ status }) });
    assert.equal((await service.editRentalInTx(tx, ID, edit(), "a", NOW)).ok, false, status);
    assert.equal(updateOf(tx), undefined, status);
  }
  for (const bad of [{ startMinute: 605 }, { durationMinutes: 45 }, { durationMinutes: 420 }, { headcount: 0 }, { rentalDate: "2026-11-06" }, { rentalDate: "11/09" }]) {
    assert.equal((await service.editRentalInTx(fakeTx(), ID, edit(bad), "a", NOW)).ok, false, JSON.stringify(bad));
  }
  assert.equal((await service.editRentalInTx(fakeTx(), "not-a-uuid", edit(), "a", NOW)).ok, false);
  assert.equal((await service.editRentalInTx(fakeTx({ row: null }), ID, edit(), "a", NOW)).ok, false);
});

test("바뀐 게 없으면 저장하지 않고, 입금 대기 건도 고칠 수 있으며 재원생 무료는 보증금 0원을 유지한다", async () => {
  const same = fakeTx();
  const unchanged = await service.editRentalInTx(same, ID, edit({ durationMinutes: 60 }), "a", NOW);
  assert.equal(unchanged.ok && unchanged.changed, false);
  assert.equal(updateOf(same), undefined);

  const approved = fakeTx({ row: current({ status: "APPROVED" }) });
  assert.equal((await service.editRentalInTx(approved, ID, edit(), "a", NOW)).ok, true);
  assert.equal(updateOf(approved).values[15], "APPROVED");

  // 입금 대기(재원생 3시간·30,000원)를 2시간(0원)으로 줄이면 막는다
  const zero = fakeTx({ row: current({ status: "APPROVED", memberFree: true, usageFee: 30_000, deposit: 0, totalAmount: 30_000, endMinute: 780, endHour: 13 }) });
  assert.equal((await service.editRentalInTx(zero, ID, edit(), "a", NOW)).ok, false);
  assert.equal(updateOf(zero), undefined);

  const member = fakeTx({ row: current({ memberFree: true, usageFee: 0, deposit: 0, totalAmount: 0 }) });
  assert.equal((await service.editRentalInTx(member, ID, edit({ durationMinutes: 180 }), "a", NOW)).ok, true);
  assert.deepEqual(updateOf(member).values.slice(10, 13), [30_000, 0, 30_000]); // 3시간 중 2시간분(70,000)만 무료
});
