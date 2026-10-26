import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/lib/shuttle/parent.ts", "utf8");
const page = fs.readFileSync("src/app/mypage/page.tsx", "utf8");

test("학부모 셔틀 조회는 인증된 앱 계정의 자녀 ID로만 범위를 제한한다", () => {
  assert.match(page, /requireVerifiedParent\(\)/);
  assert.match(page, /getParentShuttleOverview\(parentAuth\.appUserId\)/);
  // 병합 학생 필터(NOT_MERGED_STUDENT)가 뒤에 붙어도 통과해야 한다. 핵심은 parentId로 범위를 좁히는 것.
  assert.match(source, /where:\s*\{\s*\.\.\.await childAccessWhere\(appUserId\)/);
  assert.match(source, /studentId:\s*\{\s*in:\s*studentIds\s*\}/);
  // 특강 셔틀은 게이트웨이가 준 studentId(전환 완료된 경우에만 채워진다)로 자녀를 좁힌다.
  assert.match(source, /studentIds\.includes\(entry\.studentId\)/);
  assert.doesNotMatch(source, /parentPhone/);
});

test("회원 전환이 완료된 특강 신청만 조회한다", () => {
  const gateway = fs.readFileSync("src/lib/seasonal/shuttleRoster.ts", "utf8");
  // 전환 완료(conversionStatus='COMPLETED')일 때만 studentId를 채우는 규칙은 게이트웨이가 갖는다.
  assert.match(gateway, /WHEN it\."conversionStatus" = 'COMPLETED' THEN a\."convertedStudentId"/);
  assert.match(source, /entry\.studentId != null/);
  assert.match(source, /sourceType:\s*"SPECIAL_PROGRAM"/);
  assert.match(source, /sourceType:\s*"REGULAR_CLASS"/);
  // 대상자 판정은 게이트웨이 한 곳에만 있다. 화면이 목록을 따로 적으면 기준이 갈린다.
  assert.match(source, /import \{ getConfirmedShuttleRoster \} from "@\/lib\/seasonal\/shuttleRoster"/);
  assert.doesNotMatch(source, /prisma\.specialProgramShuttleRequest\.findMany/);
  // 미탑승(취소·거절)은 예전처럼 목록에서 빠져야 한다.
  assert.match(source, /entry\.ride &&/);
});

test("보관 노선은 제외하고 초안 노선 상세는 숨긴다", () => {
  assert.match(source, /status:\s*\{\s*not:\s*"ARCHIVED"\s*\}/g);
  assert.match(source, /const isDraft = .*status === "DRAFT"/);
  assert.match(source, /routeName:\s*isDraft \? null/);
  assert.match(source, /stopAddress:\s*isDraft \? null/);
  assert.match(source, /vehicleName:\s*isDraft \? null/);
  assert.match(source, /rideStatus:\s*isDraft \? null/);
});

test("특강 운행을 한 건으로 축약하지 않고 routeKey별 최신 버전을 각각 표시한다", () => {
  assert.match(source, /seasonalEntries\.flatMap/);
  assert.match(source, /activeByRoute/);
  assert.match(source, /preferRouteVersion/);
  assert.match(source, /currentIsOperational/);
  assert.match(source, /candidateIsOperational/);
  assert.doesNotMatch(source, /\]\s*\[0\]/);
});

test("정규 셔틀 미배정 신청도 본인 계정 또는 본인 학생 연결 범위에서만 표시한다", () => {
  assert.match(source, /FROM "EnrollmentApplication"/);
  assert.match(source, /"shuttleNeeded" = true/);
  assert.match(source, /"parentUserId" = \$1/);
  assert.match(source, /"convertedStudentId" = ANY\(\$2::text\[\]\)/);
  assert.match(source, /status IN \('PENDING', 'APPROVED'\)/);
  assert.match(source, /assignedClassKeys/);
  assert.match(source, /application\.convertedStudentId\s*\?\s*\(studentIds\.includes/);
});

test("민감하거나 불필요한 운행 정보는 select하지 않는다", () => {
  assert.doesNotMatch(source, /driver:\s*\{/);
  assert.doesNotMatch(source, /phone:\s*true/);
  assert.doesNotMatch(source, /latitude:\s*true/);
  assert.doesNotMatch(source, /longitude:\s*true/);
  assert.doesNotMatch(source, /stops:\s*\{/);
  assert.match(source, /stop:\s*\{\s*select:/);
});
