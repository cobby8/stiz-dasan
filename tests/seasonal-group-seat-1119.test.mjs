import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// 2026-11-19 «특강 반 = 교시 하나» 검수 보완 4건을 고정한다.
//   1) 공개 남은 자리 = 묶음 전체 인원(서버 대기 판정과 같은 인원표) 2) 요일 후보 = 묶음 전체 합집합 + 요일 수보다 큰 횟수 막기
//   3) «○원부터» = 고른 구분(재원생/신입생) 금액만 4) 관리자 매일반 표기 «매일(주5회)»
const read = (file) => readFileSync(file, "utf8");
const service = read("src/lib/seasonal/service.ts");
const apply = read("src/components/seasonal/SeasonalApplyClient.tsx");
const admin = read("src/app/admin/seasonal/SeasonalAdminClient.tsx");

test("공개 남은 자리: 묶음 전체 인원(가장 찬 날짜)으로 단계를 정하고 숫자는 내보내지 않는다", () => {
  const seatState = service.slice(service.indexOf("async function seatStateByOffering"), service.indexOf("function publicOffering"));
  // 서버 대기 판정과 같은 범위(같은 시즌·연결 반·OPEN)와 같은 인원표
  assert.match(seatState, /offering: \{ seasonId: \{ in: seasons\.map\(\(season\) => season\.id\) \}, status: "OPEN" \}/);
  assert.match(seatState, /countOccupancyByDate\(/);
  assert.match(seatState, /peakOccupancy\(occupancy, scope\.dateMode \? todayYmd : undefined\)/);
  // 날짜별 정원 = 신청서 단위(findFullDates), 요일별 정원 = 항목 단위(isOperationalOfferingFull)
  assert.match(seatState, /scope\.dateMode \? item\.applicationId : item\.id/);
  const publicOfferingSource = service.slice(service.indexOf("function publicOffering"), service.indexOf("type SeatState"));
  assert.match(publicOfferingSource, /const enrolled = scopePeak \?\? \(offering\._count\?\.applicationItems \|\| 0\)/);
  // 응답에는 단계만(숫자 칸 없음)
  assert.doesNotMatch(publicOfferingSource, /\n\s+(enrolled|occupied|remaining|peak|scopePeak):/);
});

test("요일 후보는 묶음 전체 회차 요일의 합집합, 요일 수보다 큰 횟수는 비활성 + 안내", () => {
  assert.match(apply, /const weekdaySourceOfferings = scopeOfferings\.length \? scopeOfferings : selectedOfferings;/);
  assert.match(apply, /weekdaySourceOfferings\.some\(\(item\) => offeringWeekdays\(item\)\.includes\(weekday\)\)/);
  // 고른 반만으로 요일을 세던 옛 코드가 남아 있지 않다
  assert.doesNotMatch(apply, /selectedOfferings\.some\(\(item\) => offeringWeekdays\(item\)/);
  assert.match(apply, /disabled=\{blocked\}/);
  assert.match(apply, /이 반은 요일이 \{availableWeekdays\.length\}개뿐이라 주\{frequency\}회를 고를 수 없습니다\./);
  // 막힌 횟수는 골라 둔 값으로도 쓰지 않는다
  assert.match(apply, /!frequencyTooMany\(selectedFrequency\) \? selectedFrequency : null/);
});

test("«○원부터»: 재원생·신입생을 골랐으면 그 구분 금액만", () => {
  assert.match(apply, /applicantType === "NEW" \? \[row\.newPrice\]\s*\n?\s*: applicantType === "EXISTING" \? \[row\.existingPrice\] : \[row\.newPrice, row\.existingPrice\]/);
});

test("관리자 신청 상세: 매일반은 «매일(주5회)», 이름에 «매일»이 있으면 겹치지 않게", () => {
  const fn = admin.slice(admin.indexOf("function classDisplayName"), admin.indexOf("function applicationClassInfo"));
  assert.match(fn, /\/매일\/\.test\(base\) \? freq : weeklyFrequencyLabel\(count\)/);
});
