import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const client = readFileSync("src/app/admin/seasonal/SeasonalAdminClient.tsx", "utf8");

test("신청 목록과 상세는 추적 안내 상태를 직접 문자와 구분한다", () => {
  assert.match(client, /latestApplicationNotification\(application\)/);
  assert.match(client, /<Icon name="sms" \/>직접 문자/);
  assert.match(client, /label="특강 신청 접수 안내"/);
  assert.match(client, /aria-live="polite"/);
});

test("신청 상태에 따라 승인·대기·반려·취소 템플릿을 선택한다", () => {
  assert.match(client, /APPROVED: \{ label: "특강 승인 안내", trigger: "SPECIAL_APPLICATION_APPROVED_PARENT" \}/);
  assert.match(client, /WAITLISTED: \{ label: "특강 대기 안내", trigger: "SPECIAL_APPLICATION_WAITLISTED_PARENT" \}/);
  assert.match(client, /REJECTED: \{ label: "특강 반려 안내", trigger: "SPECIAL_APPLICATION_REJECTED_PARENT" \}/);
  assert.match(client, /CANCELLED: \{ label: "특강 취소 안내", trigger: "SPECIAL_APPLICATION_CANCELLED_PARENT" \}/);
});

test("청구 안내와 신규 보호자 활성화 안내를 구분한다", () => {
  assert.match(client, /activationRequired \? "SPECIAL_ACCOUNT_ACTIVATION_PARENT" : "SPECIAL_PAYMENT_REQUEST_PARENT"/);
  // "계정 활성화" → "가입"으로 재구성되며 라벨이 바뀌었다(07e6143).
  // 지켜야 할 것은 두 안내가 갈라져 있다는 것이다.
  assert.match(client, /activationRequired \? "가입 안내·결제" : "결제 요청 안내"/);
});

test("발송과 재발송은 서버 계약을 사용하고 진행 중 중복 클릭을 막는다", () => {
  assert.match(client, /resource: "notificationRetry"/);
  assert.match(client, /data: \{ scope, trigger \}/);
  assert.match(client, /summary\?\.status === "PENDING" \|\| summary\?\.status === "SENDING"/);
  assert.match(client, /summary\.status === "FAILED"/);
  assert.match(client, /"PENDING" \| "SENDING" \| "SENT" \| "FAILED" \| "SKIPPED" \| "UNKNOWN"/);
  assert.match(client, /summary\.status === "SENDING"/);
  assert.match(client, /needsReview \? "확인 후 재시도" : summary \? "재발송" : "발송"/);
});

test("상태 변경 후 현재 상태의 안내 요약만 반영한다", () => {
  assert.match(client, /const expected = itemNotification\(status\)/);
  assert.match(client, /status: result\.notification\.status/);
  assert.match(client, /item\.notificationSummary\?\.trigger === expected\?\.trigger \? item\.notificationSummary : null/);
});

test("재시도는 이전 요약의 트리거 대신 현재 상태 트리거를 사용한다", () => {
  assert.match(client, /onRetryNotification\("application", application\.id, "SPECIAL_APPLICATION_RECEIVED_PARENT"\)/);
  assert.match(client, /onRetryNotification\("item", item\.id, statusNotification\.trigger\)/);
  assert.match(client, /onRetryNotification\("invoice", item\.id, defaultTrigger\)/);
  assert.doesNotMatch(client, /onRetryNotification\("item", item\.id, item\.notificationSummary\?\.trigger/);
  assert.doesNotMatch(client, /onRetryNotification\("invoice", item\.id, item\.invoice\?\.notificationSummary\?\.trigger/);
});

test("일괄 처리는 업무 실패와 안내 실패를 구분하고 재처리 항목을 선택 유지한다", () => {
  assert.match(client, /body\.summary\?\.notificationsFailed \?\? notificationFailedResults\.length/);
  assert.match(client, /result\.notificationWarning \|\| result\.notification\?\.status === "FAILED"/);
  assert.match(client, /setSelectedItemIds\(retryIds\)/);
  assert.match(client, /상태 처리 성공.*안내 실패/);
  assert.match(client, /수강·청구 처리 성공.*안내 실패/);
});

test("오래된 발송 중과 UNKNOWN은 발송 여부 확인 필요로 표시한다", () => {
  assert.match(client, /summary\.status === "UNKNOWN"/);
  assert.match(client, /summary\.errorCode === "FAILED_DELIVERY_UNCERTAIN"/);
  assert.match(client, /summary\.status === "SENDING" \? 2 \* 60 \* 1000 : 15 \* 60 \* 1000/);
  assert.match(client, /text: "발송 여부 확인 필요"/);
  assert.match(client, /중복 발송을 피하려면 발송 이력을 확인한 뒤 재시도하세요/);
});

test("SKIPPED는 발송 성공이 아닌 템플릿 설정 확인 상태로 표시한다", () => {
  assert.match(client, /summary\.status === "SKIPPED"/);
  assert.match(client, /text: "템플릿 꺼짐·미발송"/);
  assert.match(client, /문자 템플릿이 켜져 있는지 확인한 뒤 재시도하세요/);
});

test("단건 수강·청구는 업무 성공과 안내 실패를 분리하고 재발송 화면을 유지한다", () => {
  assert.match(client, /const result = await mutate\("PATCH", \{ resource: "conversion"/);
  assert.match(client, /notificationMutationFailed\(result\)/);
  assert.match(client, /수강·청구 생성 완료 \/ 안내 실패, 재발송이 필요합니다/);
  assert.match(client, /else \{\s*setSelectedApplication\(null\)/);
  assert.match(client, /setSelectedApplication\(\(current\) => current \? applications\.find/);
});

test("활성화 링크 재발급은 링크 성공과 자동 문자 실패를 구분한다", () => {
  assert.match(client, /NotificationMutationResponse & \{ activationUrl\?: string; error\?: string \}/);
  assert.match(client, /const notificationFailed = notificationMutationFailed\(body\)/);
  assert.match(client, /링크 재발급 완료 \/ 문자 안내 실패/);
  assert.match(client, /await load\(\)/);
});

test("안내 실패는 warning·FAILED·템플릿 오류를 모두 포함한다", () => {
  assert.match(client, /result\.notificationWarning/);
  assert.match(client, /result\.notification\?\.status === "FAILED"/);
  assert.match(client, /result\.notification\?\.errorCode === "TEMPLATE_DISABLED_OR_MISSING"/);
});

test("관리자 신청 항목은 상태 변경 중 중복 요청을 막는다", () => {
  assert.match(client, /updatingItemIdsRef = useRef\(new Set<string>\(\)\)/);
  assert.match(client, /if \(updatingItemIdsRef\.current\.has\(itemId\)\) return/);
  assert.match(client, /updatingItemIdsRef\.current\.add\(itemId\)/);
  assert.match(client, /finally \{[\s\S]*updatingItemIdsRef\.current\.delete\(itemId\)/);
  assert.match(client, /aria-busy=\{updating\}/);
  assert.match(client, /disabled=\{updating \|\| item\.status === status\}/);
  assert.match(client, /<select value=\{item\.status\} disabled=\{updating\} aria-busy=\{updating\}/);
});

test("관리자 상태 변경 실패는 열린 신청 항목 안에서 알린다", () => {
  assert.match(client, /const \[itemUpdateErrors, setItemUpdateErrors\] = useState<Record<string, string>>/);
  assert.match(client, /setItemUpdateErrors\(\(current\) => \(\{ \.\.\.current, \[itemId\]: message \}\)\)/);
  assert.match(client, /updateError=\{itemUpdateErrors\[item\.id\]\}/);
  assert.match(client, /updateError && <p role="alert" aria-live="assertive"/);
  assert.match(client, /setSelectedApplication\(null\); setItemUpdateErrors\(\{\}\)/);
});

test("신청 관리 안에 신청별·반별 명단 보기를 제공한다", () => {
  assert.match(client, /type ApplicationsMode = "applications" \| "roster"/);
  assert.match(client, /aria-label="신청 관리 보기"/);
  assert.match(client, /<option value="applications">신청별<\/option>/);
  assert.match(client, /<option value="roster">반별 명단<\/option>/);
  assert.match(client, /mode === "roster" \? <RosterView/);
});

test("명단 API는 모든 필터와 페이지를 전달하고 유연한 응답을 정규화한다", () => {
  assert.match(client, /view: "roster", page: String\(rosterFilters\.page\), pageSize: "100"/);
  for (const key of ["seasonId", "offeringId", "weekday", "paymentStatus", "shuttleStatus", "q"]) {
    assert.match(client, new RegExp(`${key}: ""`));
  }
  assert.match(client, /body\.roster && typeof body\.roster === "object"/);
  assert.match(client, /Array\.isArray\(source\.rows\).*Array\.isArray\(source\.items\)/);
});

test("반별 명단은 요약·데스크톱 표·모바일 카드와 상세 연결을 제공한다", () => {
  assert.match(client, /확정<\/span>/);
  assert.match(client, /미결제<\/span>/);
  assert.match(client, /셔틀<\/span>/);
  assert.match(client, /className="roster-desktop hidden overflow-x-auto md:block"/);
  assert.match(client, /className="roster-mobile space-y-3 md:hidden"/);
  assert.match(client, /openApplication\(row\.applicationId\)/);
});

test("인쇄와 CSV는 연락처를 마스킹하고 수식 주입을 방어한다", () => {
  assert.match(client, /@page \{ size: A4 landscape/);
  assert.match(client, /maskRosterName\(row\.parentName\)/);
  assert.match(client, /maskRosterPhone\(row\.parentPhone\)/);
  assert.match(client, /createCsv, createSafeCsvFilename, maskPhoneNumber/);
  assert.match(client, /const csv = createCsv\(/);
  assert.match(client, /text\/csv;charset=utf-8/);
  assert.match(client, /createSafeCsvFilename\(/);
  assert.match(client, />출석<\/th>/);
  assert.match(client, />메모<\/th>/);
});
