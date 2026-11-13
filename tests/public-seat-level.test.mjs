// 공개 화면 «잔여 인원» 3단계(여유/임박/마감) 테스트(2026-11-13 원장 점검표 f9).
// 숫자(«잔여 N명»·«N/N명»)가 공개 화면과 공개 응답(JSON·페이지 데이터)에 남지 않았는지 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const seats = await loadTsModule("src/lib/seats/seatLevel.ts");
const merge = await loadTsModule("src/lib/mergeSlots.ts");
const seasonalTypes = await loadTsModule("src/components/seasonal/types.ts");
const read = (p) => readFileSync(p, "utf8");

test("3단계 기준 — 0 이하 마감 · 1~3 임박 · 4 이상 여유(기준값 상수 한 곳)", () => {
  assert.equal(seats.SEAT_LOW_MAX, 3);
  assert.equal(seats.seatLevel(-1), "FULL");
  assert.equal(seats.seatLevel(0), "FULL");
  assert.equal(seats.seatLevel(1), "LOW");
  assert.equal(seats.seatLevel(3), "LOW");
  assert.equal(seats.seatLevel(4), "AVAILABLE");
  assert.equal(seats.seatLevel(Number.NaN), "FULL", "숫자를 못 읽으면 안전 쪽 마감");
  assert.equal(seats.seatLevelFromCounts(12, 9), "LOW");
  assert.equal(seats.seatLevelFromCounts(12, 12), "FULL");
  assert.equal(seats.seatLevelFromCounts(12, 2), "AVAILABLE");
  assert.deepEqual(seats.SEAT_LEVEL_LABEL, { AVAILABLE: "여유", LOW: "임박", FULL: "마감" });
  // 색은 CSS 변수만
  for (const table of [seats.SEAT_LEVEL_BADGE_CLASS, seats.SEAT_LEVEL_TEXT_CLASS, seats.SEAT_LEVEL_DOT_CLASS]) {
    for (const cls of Object.values(table)) assert.match(cls, /var\(--color-academy-/);
  }
});

test("시간표·수업 찾기 공개 슬롯 — 정원·등록 인원 숫자를 빼고 3단계만 넘긴다", () => {
  const merged = [{
    slotKey: "Mon-1", dayKey: "Mon", dayLabel: "월", startTime: "16:00", endTime: "17:00", gradeRange: "초1~2",
    enrolled: 10, displayLabel: "월 1교시", note: null, capacity: 12, isFull: false,
    coach: { name: "김코치", role: "HEAD", imageUrl: null, phone: "010-0000-0000" }, programId: "p1",
  }];
  const [pub] = merge.toPublicScheduleSlots(merged);
  assert.equal(pub.seatLevel, "LOW");
  assert.equal(pub.isFull, false);
  assert.equal("enrolled" in pub, false);
  assert.equal("capacity" in pub, false);
  assert.deepEqual(Object.keys(pub.coach).sort(), ["imageUrl", "name", "role"], "코치 객체도 고른 칸만");
  assert.doesNotMatch(JSON.stringify(pub), /:10\b|:12\b/);
  const full = merge.toPublicScheduleSlots([{ ...merged[0], enrolled: 12 }])[0];
  assert.equal(full.seatLevel, "FULL");
  assert.equal(full.isFull, true);
});

test("공개 페이지가 숫자 대신 공개 슬롯을 넘긴다(페이지 데이터에 숫자 안 실림)", () => {
  for (const page of ["src/app/schedule/page.tsx", "src/app/simulator/page.tsx"]) {
    assert.match(read(page), /allSlots=\{toPublicScheduleSlots\(allSlots\)\}/, page);
  }
  const client = read("src/app/schedule/ScheduleClient.tsx");
  assert.match(client, /allSlots: PublicScheduleSlot\[\]/);
  assert.doesNotMatch(client, /slot\.enrolled|slot\.capacity/);
  const sim = read("src/app/simulator/SimulatorClient.tsx");
  assert.doesNotMatch(sim, /slot\.enrolled|slot\.capacity|\}명/);
  const table = read("src/components/ScheduleTableView.tsx");
  assert.doesNotMatch(table, /enrolled|capacity|잔여 \$\{/);
});

test("체험·수강 신청 공개 반 목록(getAvailableTrialSlots) — 응답에 정원·인원·남은 자리 숫자가 없다", () => {
  const pub = read("src/app/actions/public.ts");
  const iface = pub.slice(pub.indexOf("export interface AvailableSlot"), pub.indexOf("const DAY_LABELS"));
  assert.doesNotMatch(iface, /capacity|enrolled|available:/);
  assert.match(iface, /seatLevel: SeatLevel/);
  const fn = pub.slice(pub.indexOf("export async function getAvailableTrialSlots"), pub.indexOf("// 수강 신청 입력"));
  const mapped = fn.slice(fn.indexOf("return rows.map"));
  assert.doesNotMatch(mapped, /capacity:|enrolled:|available:/);
  assert.match(mapped, /seatLevel: seatLevelFromCounts\(/);
  for (const f of ["src/app/apply/trial/TrialApplicationForm.tsx", "src/app/apply/enroll/EnrollApplicationLaterSteps.tsx"]) {
    const src = read(f);
    assert.doesNotMatch(src, /잔여 \$\{|slot\.available/, f);
    assert.match(src, /SEAT_LEVEL_LABEL\[slot\.seatLevel\]/, f);
  }
});

test("방학특강 공개 응답 — 신청 인원·남은 자리 숫자 대신 seatLevel", () => {
  const service = read("src/lib/seasonal/service.ts");
  const offering = service.slice(service.indexOf("function publicOffering"), service.indexOf("function publicSeason"));
  const ret = offering.slice(offering.indexOf("return {"));
  assert.doesNotMatch(ret, /\benrolled\b|\bremaining\b/);
  assert.match(ret, /seatLevel: level/);
  // 화면 정규화: 새 응답(seatLevel) · 예전 캐시 응답(숫자)도 3단계로 바꾸고 숫자는 버린다
  const now = seasonalTypes.normalizeProgram({ id: "s", slug: "w", title: "겨울", classes: [
    { id: "a", title: "A", capacity: 10, seatLevel: "LOW" },
    { id: "b", title: "B", capacity: 10, remaining: 0 },
    { id: "c", title: "C", capacity: 10, enrolled: 2 },
    { id: "d", title: "D", capacity: null },
  ] });
  const classes = seasonalTypes.programClasses(now);
  assert.deepEqual(classes.map((c) => c.seatLevel), ["LOW", "FULL", "AVAILABLE", null]);
  for (const c of classes) {
    assert.equal("remaining" in c, false);
    assert.equal("enrolled" in c, false);
  }
  for (const f of ["src/components/seasonal/SeasonalDetailClient.tsx", "src/components/seasonal/SeasonalListClient.tsx", "src/components/seasonal/SeasonalApplyClient.tsx"]) {
    assert.doesNotMatch(read(f), /잔여 \$\{|\$\{seats\}석|\$\{remaining\}석|item\.remaining/, f);
  }
});

test("챗봇 문맥·학부모 마이페이지 — «N/N명»·«N자리» 숫자 대신 3단계", () => {
  const chat = read("src/app/api/chat/route.ts");
  assert.doesNotMatch(chat, /\$\{enrolled\}\/\$\{capacity\}명|\$\{s\.enrolled\}\/\$\{s\.capacity\}명|명 수강중/);
  assert.match(chat, /function chatSeatTag\(/);
  assert.doesNotMatch(read("src/app/mypage/makeup/MakeupClient.tsx"), /\{o\.remaining\}자리/);
  assert.doesNotMatch(read("src/app/mypage/seasonal/SeasonalMakeupClient.tsx"), /여유\{s\.remaining\}/);
  assert.doesNotMatch(read("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx"), /item\.capacity - item\.enrolled\}자리/);
});
