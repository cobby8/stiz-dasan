import test from "node:test";
import assert from "node:assert/strict";
import {
  makeSourceKey, calcExpiry, isExpired, isUsable, summarize,
  recommendClasses, remainingSeats, MAKEUP_OVER_CAPACITY, normalizeGrade,
} from "../src/lib/makeup/credit-rules.ts";

// 보강권은 학부모의 권리다. 만료를 하루 잘못 계산하면 "쓸 수 있던 보강권이 사라졌다"는
// 분쟁이 되므로, 약관 문구를 그대로 테스트로 옮겨 잠근다.
//
// 근거 — 2026-08-09 개정 이용약관 「수업의 보강」

const D = (s) => new Date(`${s}T00:00:00Z`);

test("만료는 **결석일**로부터 2개월 — 발급일이 아니다", () => {
  // 약관: "결석이 발생한 날로부터 2개월 이내". 출결을 늦게 입력해도 기준은 결석일.
  assert.equal(calcExpiry(D("2026-08-09")).toISOString().slice(0, 10), "2026-10-09");
  assert.equal(calcExpiry(D("2026-01-15")).toISOString().slice(0, 10), "2026-03-15");
});

test("말일 결석도 정확히 처리한다(2/31 같은 날짜를 만들지 않는다)", () => {
  // 12/31 + 2개월 = 2/31 은 없다. 그냥 더하면 3/3 으로 넘어가 학부모에게 유리하게 어긋난다.
  assert.equal(calcExpiry(D("2025-12-31")).toISOString().slice(0, 10), "2026-02-28");
  assert.equal(calcExpiry(D("2027-12-31")).toISOString().slice(0, 10), "2028-02-29", "윤년");
  assert.equal(calcExpiry(D("2026-03-31")).toISOString().slice(0, 10), "2026-05-31");
});

test("만료 경계는 학부모에게 유리하게 — 같은 순간은 아직 유효", () => {
  const c = { expiresAt: D("2026-10-09"), status: "AVAILABLE" };
  assert.equal(isExpired(c, D("2026-10-09")), false, "만료일 당일은 사용 가능");
  assert.equal(isExpired(c, new Date("2026-10-09T00:00:01Z")), true);
  assert.equal(isUsable(c, D("2026-10-08")), true);
});

test("이미 끝난 보강권은 만료 대상이 아니다", () => {
  // 참석 완료한 걸 나중에 '만료'로 덮으면 이력이 틀어진다.
  for (const status of ["USED", "NO_SHOW", "EXPIRED", "REVOKED"]) {
    assert.equal(isExpired({ expiresAt: D("2020-01-01"), status }, D("2026-08-09")), false, status);
  }
});

test("예약된 보강권은 아직 쓴 게 아니다(취소하면 돌아온다)", () => {
  const reserved = { expiresAt: D("2026-10-09"), status: "RESERVED" };
  assert.equal(isUsable(reserved, D("2026-08-09")), false, "예약 중엔 다시 쓸 수 없다");
  const s = summarize([reserved], D("2026-08-09"));
  assert.equal(s.reserved, 1);
  assert.equal(s.used, 0, "예약만으로 사용 처리하면 안 된다");
});

test("무단 불참은 사용한 것으로 센다(약관 명시)", () => {
  const s = summarize([{ expiresAt: D("2026-10-09"), status: "NO_SHOW" }], D("2026-08-09"));
  assert.equal(s.used, 1);
  assert.equal(s.available, 0);
});

test("크론이 아직 안 돌았어도 화면에는 만료로 보인다", () => {
  // status 는 AVAILABLE 인데 기간이 지난 경우. 잔여로 세면 학부모가 예약을 시도했다 실패한다.
  const s = summarize([{ expiresAt: D("2026-08-01"), status: "AVAILABLE" }], D("2026-08-09"));
  assert.equal(s.expired, 1);
  assert.equal(s.available, 0);
});

test("중복 발급 방지 키 — 한 결석에 한 장", () => {
  const a = makeSourceKey({ sourceType: "REGULAR", classId: "c1", absenceYmd: "2026-08-03" });
  const b = makeSourceKey({ sourceType: "REGULAR", classId: "c1", absenceYmd: "2026-08-03" });
  assert.equal(a, b, "같은 결석은 같은 키여야 DB 유니크가 막아준다");
  assert.notEqual(a, makeSourceKey({ sourceType: "REGULAR", classId: "c2", absenceYmd: "2026-08-03" }));
  assert.notEqual(a, makeSourceKey({ sourceType: "SEASONAL", enrollmentDateId: "e1" }));
});

// ── 반 추천 ──────────────────────────────────────────────
const CLASSES = [
  { classId: "mon5", className: "월요일 5교시", dayOfWeek: "Mon", startTime: "17:00",
    grades: ["초2", "초3", "초4", "초5", "초6"], capacity: 12, enrolled: 11, booked: 0 },
  { classId: "tue4", className: "화요일 4교시", dayOfWeek: "Tue", startTime: "16:00",
    grades: ["초4", "초5", "초6"], capacity: 12, enrolled: 5, booked: 0 },
  { classId: "fri7", className: "금요일 7교시", dayOfWeek: "Fri", startTime: "19:20",
    grades: ["중1", "중2"], capacity: 12, enrolled: 8, booked: 0 },
  { classId: "sat1", className: "토요일 1교시", dayOfWeek: "Sat", startTime: "09:40",
    grades: ["7세", "초1", "초2", "초4"], capacity: 12, enrolled: 14, booked: 0 },
];

test("학년이 맞는 반만 추천한다", () => {
  const r = recommendClasses(CLASSES, "초5");
  const ids = r.map((c) => c.classId);
  assert.ok(ids.includes("mon5") && ids.includes("tue4"));
  assert.ok(!ids.includes("fri7"), "중1~중2 반은 초5에게 추천되면 안 된다");
  // 2026-11-14 결석 당일 취소·보강 연결: «학년이 맞는» = 학년 구성에 글자가 똑같이 있어야 → 반의 대상 학년 범위 ±1학년.
  // sat1(7세~초4)은 초5 가 구성에 없어도 범위 끝(초4)에서 1학년 차이라 학년으로는 후보다. 여기서 빠지는 이유는 자리(14/12)다.
  assert.ok(!ids.includes("sat1"), "정원 +2 를 넘겨 자리가 없다");
  const sat1Open = recommendClasses([{ ...CLASSES[3], enrolled: 5 }], "초5");
  assert.equal(sat1Open.length, 1, "자리가 있으면 ±1학년 반도 후보가 된다");
  // 2학년 이상 떨어진 학년은 여전히 후보가 아니다
  assert.equal(recommendClasses([{ ...CLASSES[3], enrolled: 5 }], "초6").length, 0);
  assert.equal(recommendClasses(CLASSES, "초4").some((c) => c.classId === "fri7"), false);
});

test("정원 +2 까지 받는다 (약관)", () => {
  assert.equal(MAKEUP_OVER_CAPACITY, 2);
  // 12명 정원에 11명 → 14까지 가능하므로 3자리 남는다.
  assert.equal(remainingSeats({ capacity: 12, enrolled: 11, booked: 0 }), 3);
  // 이미 보강 2명이 잡혀 있으면 1자리.
  assert.equal(remainingSeats({ capacity: 12, enrolled: 11, booked: 2 }), 1);
});

test("정원 +2 를 넘긴 반은 추천에서 빠진다", () => {
  const full = [{ ...CLASSES[1], enrolled: 14, booked: 0 }]; // 12+2 = 14, 남는 자리 0
  assert.equal(recommendClasses(full, "초5").length, 0);
  const almost = [{ ...CLASSES[1], enrolled: 13, booked: 0 }];
  assert.equal(recommendClasses(almost, "초5").length, 1, "13명이면 아직 1자리");
});

test("이미 잡힌 보강 예약도 자리로 센다", () => {
  const c = [{ ...CLASSES[1], enrolled: 12, booked: 2 }]; // 12+2 - 14 = 0
  assert.equal(recommendClasses(c, "초5").length, 0);
});

test("여유 많은 반을 먼저 권한다(쏠림 방지)", () => {
  const r = recommendClasses(CLASSES, "초5");
  assert.equal(r[0].classId, "tue4", "5/12 인 반이 11/12 인 반보다 먼저");
  assert.ok(r[0].remaining >= r[1].remaining);
});

test("원래 다니던 반은 추천하지 않는다", () => {
  const r = recommendClasses(CLASSES, "초5", { excludeClassId: "tue4" });
  assert.ok(!r.some((c) => c.classId === "tue4"));
});

test("손입력 학년 표기도 알아본다 — 이 학생만 추천 0건이 되면 안 된다", () => {
  // 2026-08-09 실측: 전체 316명 중 "4학년"·"5학년" 2명이 이 형태로 남아 있다.
  assert.equal(normalizeGrade("5학년"), "초5");
  assert.equal(normalizeGrade(" 초5 "), "초5");
  assert.equal(normalizeGrade("중1"), "중1", "중·고는 그대로 둔다");
  assert.equal(normalizeGrade("성인"), "성인");
  assert.equal(normalizeGrade(null), "");
  // 실제 추천까지 이어지는지
  assert.ok(recommendClasses(CLASSES, "5학년").some((c) => c.classId === "tue4"));
});

test("학년이 비어 있으면 추천하지 않는다(임의 배정 금지)", () => {
  assert.deepEqual(recommendClasses(CLASSES, null), []);
  assert.deepEqual(recommendClasses(CLASSES, "  "), []);
});
