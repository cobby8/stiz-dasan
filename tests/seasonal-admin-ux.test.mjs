import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const adminClient = readFileSync(
  new URL("../src/app/admin/seasonal/SeasonalAdminClient.tsx", import.meta.url),
  "utf8",
);
const adminRoute = readFileSync(
  new URL("../src/app/api/admin/seasonal/route.ts", import.meta.url),
  "utf8",
);
const adminOverview = readFileSync(
  new URL("../src/lib/seasonal/admin-overview.ts", import.meta.url),
  "utf8",
);

test("special lecture editing preserves schedule and linked operation settings", () => {
  assert.match(adminClient, /initial\?\.sessionDates\?\.length/);
  assert.match(adminClient, /shuttleAvailable: payload\.shuttleAvailable === "on"/);
  assert.match(adminClient, /name="status" value=\{attendanceReadiness\.status\}/);
  assert.match(adminRoute, /SESSION_DATE_REQUIRED/);
  assert.doesNotMatch(adminClient, /status: "DRAFT" \}\);/);
  assert.match(adminRoute, /if \(data\.code !== undefined\)/);
  assert.match(adminRoute, /update\.code = code/);
  assert.match(adminRoute, /OFFERING_CODE_DUPLICATED/);
});

test("방학특강 신청 상세는 셔틀 요청 세부 정보를 버리지 않고 보여준다", () => {
  assert.match(adminRoute, /shuttleRequest:\s*true/);
  assert.match(adminClient, /shuttleRequest:\s*\(item\.shuttleRequest \?\? null\)/);
  assert.match(adminClient, /function ShuttleRequestBox/);
  assert.match(adminClient, /탑승 위치/);
  assert.match(adminClient, /하차 위치/);
  assert.match(adminClient, /희망 시간/);
});

test("방학특강 신청 상세는 관리자 빠른 처리 버튼과 필수 신청 정보를 제공한다", () => {
  assert.match(adminClient, /const quickStatuses: ItemStatus\[\] = \["APPROVED", "WAITLISTED", "REJECTED", "CANCELLED"\]/);
  assert.match(adminClient, /formatDateTime\(application\.createdAt\)/);
  assert.match(adminClient, /application\.address/);
  assert.match(adminClient, /application\.processedNote/);
  assert.match(adminClient, /대기 \{item\.waitlistOrder\}번/);
});

test("방학특강 신청 목록은 복수 선택과 일괄 상태 변경을 제공한다", () => {
  assert.match(adminClient, /selectedItemIds/);
  assert.match(adminClient, /BULK_ITEM_STATUSES/);
  assert.match(adminClient, /현재 목록 전체 선택/);
  assert.match(adminClient, /선택한 신청 반 \{selectedItemCount\}개/);
  assert.match(adminClient, /handleBulkItemStatus/);
  assert.match(adminClient, /resource: "bulkItems"/);
});

test("방학특강 일괄 처리는 단건 항목 처리 안전장치를 재사용한다", () => {
  assert.match(adminRoute, /body\.resource === "bulkItems"/);
  assert.match(adminRoute, /parseBulkItemIds/);
  assert.match(adminRoute, /updateSpecialProgramItemStatus/);
  assert.match(adminRoute, /Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(adminRoute, /BULK_LIMIT_EXCEEDED/);
});

test("방학특강 승인 항목은 여러 건을 묶어 수강 등록과 청구서를 생성한다", () => {
  assert.match(adminRoute, /body\.resource === "bulkConversion"/);
  assert.match(adminRoute, /BULK_CONVERSION_LIMIT_EXCEEDED/);
  assert.match(adminRoute, /convertApprovedItemToEnrollmentAndInvoice\(itemId, actor\.appUserId\)/);
  assert.match(adminClient, /handleBulkConversion/);
  assert.match(adminClient, /resource: "bulkConversion"/);
  assert.match(adminClient, /수강·청구 생성/);
});

test("방학특강 신청 상세는 수강·청구 전환 준비 상태를 확인할 수 있다", () => {
  assert.match(adminRoute, /linkedProgramId:\s*true/);
  assert.match(adminRoute, /linkedClassId:\s*true/);
  assert.match(adminClient, /linkedClassId:\s*item\.linkedClassId \?\? offering\?\.linkedClassId \?\? null/);
  assert.match(adminClient, /function ConversionReadinessBox/);
  assert.match(adminClient, /readyToConvert = approved && \(!hasEnrollment \|\| !hasPayment\)/);
  // "특강 청구 생성 가능" → "청구서 발행 가능"으로 문구가 바뀌었다.
  assert.match(adminClient, /title = "청구서 발행 가능"/);
  assert.match(adminClient, /전환 준비됨/);
  // "연결 완료" → "완료"로 줄었다. 상태 이름 6종이 모두 있는지 확인한다.
  assert.match(adminClient, /title = "수강·청구 완료"/);
  assert.match(adminClient, /title = "수강 등록 필요"/);
  assert.match(adminClient, /title = "청구서 발행 필요"/);
});

test("방학특강 승인 항목은 관리자 액션으로 수강 등록과 청구서를 생성한다", () => {
  assert.match(adminRoute, /resource === "conversion"/);
  assert.match(adminRoute, /convertApprovedItemToEnrollmentAndInvoice/);
  assert.match(adminRoute, /ensureInvoiceForPayment\(converted\.paymentId\)/);
  assert.match(adminRoute, /INSERT INTO "Enrollment"/);
  assert.match(adminRoute, /INSERT INTO "Payment"/);
  assert.match(adminRoute, /ITEM_CONVERTED_TO_ENROLLMENT_PAYMENT/);
  assert.match(adminClient, /resource: "conversion"/);
  assert.match(adminClient, /수강·청구 생성/);
});

test("방학특강 전환 후 관리자 상세에서 청구서를 열고 링크를 복사할 수 있다", () => {
  assert.match(adminRoute, /paymentInvoice\.findMany/);
  assert.match(adminRoute, /accountActivationRequired:\s*activationByPaymentId\.get\(item\.paymentId!\) \?\? false/);
  assert.match(adminClient, /function getItemInvoiceHref/);
  assert.match(adminClient, /function InvoiceActionBox/);
  assert.match(adminClient, /청구서 열기/);
  assert.match(adminClient, /링크 복사/);
  assert.match(adminClient, /navigator\.clipboard\.writeText/);
});

test("방학특강 가져오기 신청은 운영 검토 정보를 개인정보와 분리해 보여준다", () => {
  assert.match(adminClient, /function ApplicationReviewSummary/);
  assert.match(adminClient, /applicantTypeLabel/);
  assert.match(adminClient, /selectedWeekdays/);
  assert.match(adminClient, /원본 가져오기/);
  assert.match(adminClient, /확인 필요/);
  assert.match(adminClient, /paymentReviewLabel/);
  assert.match(adminClient, /결제 확인 전/);
});

test("방학특강 신청 상세에서 반, 요일, 금액을 저장할 수 있다", () => {
  assert.match(adminClient, /function ApplicationAssignmentEditor/);
  assert.match(adminClient, /resource: input\.itemId \? "itemAssignment" : "applicationAssignment"/);
  assert.match(adminClient, /수업 정보를 저장했습니다/);
  assert.match(adminClient, /수강·청구 연결 후에는 이 화면에서 반 정보를 바꿀 수 없습니다/);
  assert.match(adminRoute, /body\.resource === "itemAssignment" \|\| body\.resource === "applicationAssignment"/);
  assert.match(adminRoute, /ITEM_ASSIGNMENT_UPDATED/);
  assert.match(adminRoute, /ITEM_ASSIGNMENT_CREATED/);
  assert.match(adminRoute, /ITEM_ALREADY_CONVERTED/);
});

test("방학특강 공개에는 정원이 필요하고 반과 강사는 나중에 배정할 수 있다", () => {
  assert.match(adminRoute, /status === "OPEN" && capacity === null/);
  assert.match(adminRoute, /nextStatus === "OPEN" && nextCapacity === null/);
  assert.doesNotMatch(adminRoute, /ATTENDANCE_LINK_REQUIRED/);
  assert.match(adminRoute, /function ensureSpecialProgramOperationalCapacity/);
  assert.match(adminRoute, /candidate\."linkedClassId" = \${target\.linkedClassId}/);
  assert.match(adminRoute, /item\.status IN \(\${Prisma\.join\(statuses\)}\)/);
});

test("방학특강 반이 없는 신청은 상세에서 신청 자체를 취소하거나 반려할 수 있다", () => {
  assert.match(adminClient, /type ApplicationCloseStatus = "REJECTED" \| "CANCELLED"/);
  assert.match(adminClient, /APPLICATION_CLOSE_STATUSES/);
  assert.match(adminClient, /hasNoItems && \(/);
  assert.match(adminClient, /onUpdateApplicationStatus\(application\.id, status\)/);
  assert.match(adminRoute, /closesApplication \? \{ requiresReview: false, reviewReasons: \[\] \} : \{\}/);
});

test("방학특강 출석부는 운영 반과 학생 신청 요일을 기준으로 필터링한다", () => {
  const roster = adminRoute.slice(adminRoute.indexOf("async function seasonalRoster"), adminRoute.indexOf("async function ensureApplicationCapacity"));
  assert.match(roster, /filter_offering\."linkedClassId" IS NOT NULL/);
  assert.match(roster, /ANY\(app\."selectedWeekdays"\)/);
  assert.match(roster, /unnest\(app\."selectedWeekdays"\) AS selected\(day_key\)/);
  assert.match(roster, /params\.get\("date"\)/);
  assert.match(adminClient, /일자별 출석부/);
  assert.match(adminClient, /type="date" value=\{filters\.date\}/);
});

test("특강 반 담당 선생님은 ID 직접 입력 대신 관리자 선택 목록으로 배정한다", () => {
  assert.match(adminClient, /fetch\("\/api\/admin\/coach-options"/);
  assert.match(adminClient, /coaches: CoachOption\[\]/);
  assert.match(adminClient, /<select name="instructorId" value=\{selectedInstructorId\}/);
  assert.match(adminClient, /<input type="hidden" name="instructorName"/);
  assert.match(adminClient, /function assignClassInstructor/);
  assert.match(adminClient, /resource: "operationalSlotInstructor"/);
  assert.match(adminClient, /onAssignInstructor=\{assignClassInstructor\}/);
  assert.match(adminClient, /assigningInstructorClassId/);
  assert.match(adminClient, /onOpenTodayRoster/);
  assert.match(adminClient, /todayDateInputValue\(\)/);
  assert.match(adminClient, />오늘 출석</);
  assert.match(adminClient, /groupOperationalClasses/);
  // 2026-11-19 원장 «반 이름은 하나, 횟수는 학생이 고르는 옵션» — 안내 문구 갱신
  assert.match(adminClient, /주 몇 회는 신청할 때 학생이 고르는 옵션입니다/);
  assert.match(adminClient, /요일별 운영/);
  assert.match(adminClient, /수강료 계산 규칙/);
  assert.match(adminRoute, /function updateOperationalSlotInstructor/);
  assert.match(adminRoute, /linkedClassId\s*:\s*target\.linkedClassId/);
  assert.match(adminRoute, /resource === "operationalSlotInstructor"/);
  assert.match(adminRoute, /OPERATIONAL_SLOT_INSTRUCTOR_UPDATED/);
  assert.match(adminRoute, /sessionDateForKorea/);
  assert.match(adminOverview, /operationalStats/);
  assert.match(adminOverview, /unnest\(app\."selectedWeekdays"\)/);
  assert.match(adminOverview, /session: \{ select: \{ coachId: true \} \}/);
  assert.doesNotMatch(adminClient, /ClassInput name="instructorId" label="담당 강사 ID"/);
});

test("방학특강 요일 변경은 회원 구분과 주차 수에 맞는 가격 반으로 저장한다", () => {
  assert.match(adminRoute, /function resolveSpecialProgramAssignment/);
  assert.match(adminRoute, /seasonalOfferingFrequency\(candidate\) === selectedCount/);
  assert.match(adminRoute, /priceSnapshot: assignment\.priceSnapshot/);
  assert.match(adminClient, /matchingOfferingForWeekdays/);
  assert.match(adminClient, /저장 시 \{applicantTypeLabel\(application\.applicantType\)\} · 주 \{selectedWeekdays\.length \|\| "-"\}회 기준/);
});

test("이전 API 응답에도 신청 검토 UI가 기본값으로 동작한다", () => {
  assert.match(adminClient, /application\.applicantType \?\? application\.memberType \?\? application\.customerType/);
  assert.match(adminClient, /application\.selectedWeekdays \?\? application\.weekdays \?\? application\.selectedDays/);
  assert.match(adminClient, /application\.imported \?\? application\.isImported \?\? importSource/);
  assert.match(adminClient, /reviewReasons = stringList/);
  assert.match(adminClient, /요일 미확인/);
  assert.match(adminClient, /구분 미확인/);
});

test("특강 반은 회원 유형별 가격과 미확정 정원을 입력할 수 있다", () => {
  assert.match(adminClient, /name="newApplicantPrice"/);
  assert.match(adminClient, /name="existingApplicantPrice"/);
  assert.match(adminClient, /capacity: capacity \? Number\(capacity\) : null/);
  assert.match(adminClient, /value="DRAFT">작성 중/);
  assert.match(adminClient, /value=\{attendanceReadiness\.status\}/);
});

test("확인 필요 항목은 관리자 검토 완료 액션을 제공한다", () => {
  assert.match(adminClient, /resource: "applicationReview"/);
  assert.match(adminClient, /action: "CLEAR", reviewNote/);
  assert.match(adminClient, /onResolveReview\(application\.id, reviewNote\.trim\(\)\)/);
  assert.match(adminClient, /disabled=\{resolving \|\| !reviewNote\.trim\(\)\}/);
  assert.doesNotMatch(adminClient, /resolved: true/);
  assert.match(adminClient, /검토 완료/);
  assert.match(adminClient, /검토 완료 처리에 실패했습니다/);
});
