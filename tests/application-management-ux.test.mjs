import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const adminAction = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const trialClient = readFileSync(new URL("../src/app/admin/trial/TrialCrmClient.tsx", import.meta.url), "utf8");
const trialModals = readFileSync(new URL("../src/app/admin/trial/TrialCrmModals.tsx", import.meta.url), "utf8");
const applyPage = readFileSync(new URL("../src/app/admin/apply/page.tsx", import.meta.url), "utf8");
const applyClient = readFileSync(new URL("../src/app/admin/apply/ApplyAdminClient.tsx", import.meta.url), "utf8");
const applyModals = readFileSync(new URL("../src/app/admin/apply/ApplyAdminModals.tsx", import.meta.url), "utf8");
const applySourceStatsRoute = readFileSync(new URL("../src/app/api/admin/apply/source-stats/route.ts", import.meta.url), "utf8");
const adminShell = readFileSync(new URL("../src/app/admin/AdminShellClient.tsx", import.meta.url), "utf8");
const adminReadPayloads = readFileSync(new URL("../src/lib/adminReadPayloads.ts", import.meta.url), "utf8");
const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
const contactActions = readFileSync(new URL("../src/lib/application-contact-actions.ts", import.meta.url), "utf8");

test("체험 신청 목록과 상세 모달은 접수/희망/확정 일정을 분리해서 보여주고 취소 상태를 보존한다", () => {
  assert.match(trialClient, /function getTrialScheduleItems/);
  assert.match(trialClient, /label:\s*"신청일"/);
  assert.match(trialClient, /label:\s*"체험일"/);
  assert.match(trialClient, /label:\s*"수업교시"/);
  assert.match(trialClient, /label:\s*"확정일정"/);
  assert.match(trialClient, /function TrialLeadDetailModal/);
  assert.match(trialClient, /CLOSED_TRIAL_STATUSES = new Set\(\["CONVERTED", "LOST", "CANCELLED"\]\)/);
  assert.match(trialClient, /CANCELLED:\s*\{\s*label:\s*"취소"/);
  assert.match(queries, /CANCELLED:\s*statusMap\["CANCELLED"\]/);
});

test("관리자 신청 첫 화면은 기본 체험 탭 데이터만 서버에서 먼저 가져온다", () => {
  assert.match(applyPage, /getCachedAdminTrialPayload\(\{ limit: 50, offset: 0 \}\)/);
  assert.doesNotMatch(applyPage, /getCachedAdminApplySummaryPayload/);
  assert.doesNotMatch(applyPage, /initialStats=\{/);
});

test("체험 신청은 수정, 일정 변경, 취소 모달로 관리할 수 있다", () => {
  assert.match(trialClient, /setShowEditModal/);
  assert.match(trialClient, /setShowScheduleModal/);
  assert.match(trialClient, /setShowCancelModal/);
  assert.match(trialModals, /function TrialEditModal/);
  assert.match(trialModals, /function TrialScheduleModal/);
  assert.match(trialModals, /function TrialCancelModal/);
  assert.match(trialModals, /label="선택한 날짜의 수업 \*"/);
  assert.match(trialModals, /label="확정 날짜 \*"/);
  assert.match(trialModals, /label="확정 시간 \*"/);
  assert.match(trialModals, /scheduledClassId/);
  assert.match(trialModals, /status:\s*"CANCELLED"/);
  assert.match(adminAction, /"childSchool",\s*"basketballExp"/);
  assert.match(adminAction, /"preferredDay",\s*"preferredPeriod"/);
  // 입금 확인은 공용 수정에서 빠지고 전용 action(confirmTrialFeePayment)만 바꾼다(2026-10-09)
  assert.match(adminAction, /"trialDate",\s*"hopeNote"/);
});

test("체험 일정 변경은 선택 날짜의 운영 수업만 조회하고 실제 확정값을 저장한다", () => {
  const scheduleOptionsRoute = readFileSync(new URL("../src/app/api/admin/trial/schedule-options/route.ts", import.meta.url), "utf8");
  const scheduleServer = readFileSync(new URL("../src/lib/trial-schedule-server.ts", import.meta.url), "utf8");
  assert.match(scheduleOptionsRoute, /await requireAdmin\(\)/);
  assert.match(scheduleOptionsRoute, /listTrialScheduleOptionsForDate\(date\)/);
  assert.match(scheduleServer, /resolveTrialScheduleFromRow\(row/);
  assert.match(trialModals, /fetch\(`\/api\/admin\/trial\/schedule-options\?date=/);
  assert.match(trialModals, /options\.map\(\(option\) =>/);
  assert.match(trialModals, /setScheduledClassId\(""\);[\s\S]*setScheduledTime\(""\);/);
  assert.match(trialModals, /options\.some\(\(option\) => option\.classId === scheduledClassId\)/);
  assert.match(adminAction, /if \(typeof data\.scheduledClassId !== "string" \|\| !data\.scheduledClassId\.trim\(\)\)/);
  assert.match(trialClient, /getLocalDateTime\(getTrialListDateValue\(lead\)\)/);
  assert.match(adminAction, /history\?\.sendScheduleNotification === true/);
  assert.doesNotMatch(trialModals, /sendScheduleNotification:\s*true/);
});

test("체험 신청 수정은 최신 목록 반영을 확인한 뒤에만 성공으로 처리한다", () => {
  assert.match(trialClient, /onSaved=\{\(\) => loadTrialData\(\)\}/);
  assert.doesNotMatch(trialClient, /onSaved=\{\(\) => void loadTrialData\(\)\}/);
  assert.match(trialModals, /const refreshed = await onSaved\(\);/);
  assert.match(trialModals, /if \(!refreshed\) \{/);
  assert.match(trialModals, /목록을 새로 불러오지 못했습니다/);
  assert.match(trialModals, /if \(!refreshed\)[\s\S]*onDone\(\);/);
});

test("체험 신청 일정은 DB 수업 정보와 연결해 실제 수업 시간을 표시한다", () => {
  assert.match(adminReadPayloads, /getCachedAdminTrialPayload/);
  assert.match(adminReadPayloads, /getClasses\(\)/);
  assert.match(adminReadPayloads, /classes,/);
  assert.match(adminReadPayloads, /admin-trial-v4/);
  assert.match(adminReadPayloads, /"admin-classes"/);
  assert.match(queries, /COALESCE\(ss_co\.name, cso_co\.name, ccs_co\.name, u\.name\) AS coach_name/);
  assert.match(applyClient, /initialTrialClasses/);
  assert.match(trialClient, /interface ClassInfo/);
  assert.match(trialClient, /coachName\?: string \| null/);
  assert.match(trialClient, /instructorName\?: string \| null/);
  assert.match(trialClient, /classesBySlotKey/);
  assert.match(trialClient, /classesById/);
  assert.match(trialClient, /function formatClassLabel/);
  assert.match(trialClient, /function formatConfirmedSchedule/);
  assert.match(trialClient, /formatCompactDate\(lead\.scheduledDate\).*formatClassLabel\(matchedClass\)/s);
  assert.match(trialClient, /function formatTrialListScheduleShort/);
  assert.match(trialClient, /function formatTrialListTeacherName/);
  assert.match(trialClient, /const confirmedClass = lead\.scheduledClassId \? classesById\?\.get\(lead\.scheduledClassId\) : null/);
  assert.match(trialClient, /const scheduleLabel = formatTrialListScheduleShort\(lead, classesById, classesBySlotKey\)/);
  assert.match(trialClient, /const teacherLabel = formatTrialListTeacherName\(lead, classesById, classesBySlotKey\)/);
  assert.match(trialClient, /function isLikelyDefaultScheduleTime/);
  assert.match(trialClient, /시간 확인 필요/);
  assert.match(trialClient, /const DAY_CODE_BY_LABEL/);
  assert.match(trialClient, /function normalizeSlotKey/);
  assert.match(trialClient, /function getPreferredSlotKeyCandidates/);
  assert.match(trialClient, /function getPreferredClass/);
  assert.match(trialModals, /function isDateOnlySchedulePlaceholder/);
  assert.match(trialModals, /option\.startTime/);
  assert.match(trialModals, /function normalizeSlotKey/);
  assert.match(trialModals, /function getPreferredSlotKeyCandidates/);
  assert.match(trialModals, /getPreferredClass\(lead, classes\)/);
});

test("체험 신청은 한 줄 목록에서 핵심 정보와 빠른 처리만 보여준다", () => {
  assert.match(trialClient, /function renderTrialList\(\)/);
  // 목록 개편(2026-10-30): 고정폭·가운데 정렬 표 → 공통 목록 표(admin-list-table: 글자 왼쪽·날짜 오른쪽, 내용 폭)
  assert.match(trialClient, /<table className="admin-list-table/);
  assert.match(trialClient, /상태[\s\S]*신청일[\s\S]*체험일[\s\S]*수업[\s\S]*담당교사[\s\S]*수강생이름[\s\S]*학교[\s\S]*학년[\s\S]*액션/);
  assert.doesNotMatch(trialClient, />상태변경</);
  assert.match(trialClient, /function formatMonthDayDate/);
  assert.match(trialClient, /function getTrialListDateValue/);
  assert.match(trialClient, /const createdDateMobileLabel = formatMonthDayDate\(lead\.createdAt\)/);
  assert.match(trialClient, /const trialListDate = getTrialListDateValue\(lead\)/);
  assert.match(trialClient, /const trialDateLabel = trialListDate \? formatCompactDate\(trialListDate\) : getScheduleValue\("체험일"\)/);
  assert.match(trialClient, /const trialDateMobileLabel = trialListDate \? formatMonthDayDate\(trialListDate\) : trialDateLabel/);
  assert.match(trialClient, /sm:hidden[\s\S]*\{createdDateMobileLabel\}/);
  assert.match(trialClient, /sm:hidden[\s\S]*\{trialDateMobileLabel\}/);
  // 휴대폰에선 상태 아이콘만, sm 이상에서 글자 — 말줄임(truncate) 없이
  assert.match(trialClient, /"hidden sm:inline"/);
  assert.match(trialClient, /setShowDetailModal\(lead\)/);
  assert.match(trialClient, /setOpenQuickActionId/);
  assert.match(trialClient, /LIST_ACTION_TRIGGER_CLASS/);
  assert.match(trialClient, /LIST_ACTION_MENU_CLASS/);
  assert.match(trialClient, /LIST_ACTION_MENU_CLASS = "fixed z-\[80\]/);
  assert.match(trialClient, /getQuickActionMenuPosition/);
  assert.match(trialClient, /quickActionMenuPosition/);
  assert.match(trialClient, /flash_on/);
  assert.match(trialClient, /async function handleConfirmTrialFee/);
  assert.match(trialClient, /confirmTrialFeePayment\(lead\.id\)/);
  assert.doesNotMatch(trialClient, /lead\.trialFeeConfirmed \? "입금" : "미입금"/);
  assert.match(trialClient, /trialFeeBusyId === lead\.id \? "확인 중…" : "입금 확인"/);
  assert.match(trialClient, /<span>입금 완료<\/span>/);
  assert.match(trialClient, /onConfirmTrialFee/);
  assert.doesNotMatch(trialClient, /function renderStatusChangeCell/);
  assert.doesNotMatch(trialClient, /renderEnrollGuideButton\(lead, "inline"\)/);
  assert.match(trialClient, /lead\.status === "ATTENDED" && renderEnrollGuideButton\(lead\)/);
  assert.match(trialClient, /onCoachNotice=\{\(\) => void handleSendCoachNotice\(showDetailModal\)\}/);
  assert.match(trialClient, /type TrialDateFilter/);
  assert.match(trialClient, /const TRIAL_DATE_FILTERS/);
  assert.match(trialClient, /matchesTrialDateFilter\(lead, dateFilter\)/);
  assert.match(trialClient, /getLocalDateTime\(b\.createdAt\).*getLocalDateTime\(a\.createdAt\)/);
  assert.match(trialClient, /value=\{dateFilter\}/);
  assert.doesNotMatch(trialClient, /<th className="px-3 py-2(?:\.5)?">보호자<\/th>/);
  assert.doesNotMatch(trialClient, /<th className="px-3 py-2(?:\.5)?">쌤알림<\/th>/);
  assert.match(trialClient, /setShowScheduleModal\(lead\)/);
  assert.match(trialClient, /setContactModal\(\{ lead, defaultAction: "CONTACTED" \}\)/);
  assert.match(trialClient, /lead\.childGrade \|\| lead\.childAge/);
  assert.match(trialClient, /NAVER_SEARCH: "네이버 키워드 검색"/);
  assert.match(trialClient, /lead\.status === "SCHEDULED" \? "일정 변경" : "일정 확정"/);
  assert.match(trialClient, /\[lead\.childName, lead\.childGrade \|\| lead\.childAge, lead\.childSchool\]/);
  assert.match(trialModals, /체험비 상태: \{trialFeeStatusLabel\(lead\)\}/);
  assert.doesNotMatch(trialModals, /onChange=\{\(e\) => setForm\(\{ \.\.\.form, trialFeeConfirmed: e\.target\.checked \}\)\}/);
  assert.doesNotMatch(trialClient, /viewMode/);
  assert.doesNotMatch(trialClient, /setViewMode/);
  assert.doesNotMatch(trialClient, /grid_view/);
});

test("체험수업과 수강신청은 접수일 최신순으로 표시한다", () => {
  assert.match(trialClient, /const createdAtCompare = \(getLocalDateTime\(b\.createdAt\) \?\? 0\) - \(getLocalDateTime\(a\.createdAt\) \?\? 0\)/);
  assert.match(applyClient, /const createdAtCompare = \(Date\.parse\(b\.createdAt\) \|\| 0\) - \(Date\.parse\(a\.createdAt\) \|\| 0\)/);
  assert.match(trialClient, /return createdAtCompare \|\| b\.id\.localeCompare\(a\.id\)/);
  assert.match(applyClient, /return createdAtCompare \|\| b\.id\.localeCompare\(a\.id\)/);
});

test("수강신청은 승인 전 내용 수정과 취소 이력 처리를 지원한다", () => {
  assert.match(adminAction, /export async function updateEnrollApplication/);
  assert.match(adminAction, /export async function cancelEnrollApplication/);
  assert.match(adminAction, /status = 'CANCELLED'/);
  assert.match(adminAction, /이미 승인된 신청서는 원생\/수강 등록 메뉴에서 수정/);
  assert.match(applyClient, /setShowEditModal/);
  assert.match(applyClient, /setShowCancelModal/);
  assert.match(applyModals, /function EditApplicationModal/);
  assert.match(applyModals, /function CancelApplicationModal/);
  assert.match(applyModals, /updateEnrollApplication/);
  assert.match(applyModals, /cancelEnrollApplication/);
});

test("수강신청 수정 모달은 신청 폼의 주요 입력 항목을 관리자용 이름으로 노출한다", () => {
  assert.match(applyModals, /아이 정보/);
  assert.match(applyModals, /보호자 정보/);
  assert.match(applyModals, /수강 정보/);
  assert.match(applyModals, /희망 시간/);
  assert.match(applyModals, /셔틀\/메모/);
  assert.match(applyModals, /applicationNoticeConfirmed/);
  assert.match(applyModals, /shuttleNoticeConfirmed/);
});

test("신청 수정, 일정 변경, 취소는 운영 이력으로 남고 관리자 화면에 읽기 쉬운 라벨로 표시된다", () => {
  assert.match(contactActions, /"UPDATED"/);
  assert.match(contactActions, /"SCHEDULED"/);
  assert.match(contactActions, /"CANCELLED"/);
  assert.match(adminAction, /function recordApplicationHistoryLog/);
  assert.match(adminAction, /action:\s*"UPDATED"/);
  assert.match(adminAction, /action:\s*"CANCELLED"/);
  assert.match(trialModals, /action:\s*"UPDATED"/);
  assert.match(trialModals, /action:\s*"SCHEDULED"/);
  assert.match(trialModals, /action:\s*"CANCELLED"/);
  assert.match(applyClient, /UPDATED:\s*"내용 수정"/);
  assert.match(applyClient, /CANCELLED:\s*"취소 처리"/);
  assert.match(applyModals, /최근 운영 이력/);
  assert.match(applyModals, /원생 상세 열기/);
});

test("관리자 신청 화면은 제목을 반복하는 설명과 중복 요약을 제거한다", () => {
  assert.match(adminShell, /label="신청·상담"/);
  assert.match(adminShell, /label="청구·수납"/);
  assert.match(adminShell, /업무별 상세 메뉴/);
  assert.match(adminShell, /설정·도구/);
  assert.doesNotMatch(adminShell, /label="체험\/수강신청 관리"/);
  assert.match(applyClient, /체험\/수강신청 관리/);
  assert.match(applyClient, /체험\/수강신청 관리/);
  assert.doesNotMatch(applyClient, /체험 문의와 수강신청을 한 화면에서 확인하고 처리합니다/);
  assert.doesNotMatch(applyClient, /신청 페이지 미리보기/);
  assert.doesNotMatch(applyClient, /오늘 먼저/);
  assert.doesNotMatch(applyClient, /새 체험/);
  assert.doesNotMatch(applyClient, /수강 대기/);
  assert.doesNotMatch(trialClient, /체험 문의 관리/);
  assert.match(trialClient, /체험 신청 등록/);
  assert.match(applyClient, /학생, 보호자, 전화번호로 검색/);
  assert.match(applyClient, /<select\b[^>]*value=\{filter\}/);
  assert.match(applyClient, /aria-label="신청 관리 업무"/);
  assert.match(applyClient, /<CompactListFilters/);
  assert.match(trialClient, /<CompactListFilters/);
  assert.doesNotMatch(applyClient, /aria-label="신청 관리 메뉴"/);
  assert.match(applyClient, /LIST_ACTION_TRIGGER_CLASS/);
  assert.match(applyClient, /LIST_ACTION_MENU_CLASS/);
  assert.match(applyClient, /setShowDetailModal\(app\)/);
  // 목록 개편(2026-10-30): «학생/연락처»처럼 한 칸에 이어 붙이던 것을 칸별로 나눴다
  assert.match(applyClient, />학생<\/th>/);
  assert.match(applyClient, />연락처<\/th>/);
  assert.match(applyClient, /빠른 처리/);
  // 탭 목록을 그대로 단정해 두는 이유: 탭이 슬금슬금 늘어나는 것을 막는다.
  // waitlist 는 "대기자를 신청 관리 탭으로" 옮기며 의도적으로 추가됐다(9e2bea6).
  assert.match(applyClient, /type TabType = "trial" \| "applications" \| "waitlist" \| "sources" \| "settings"/);
  assert.match(applyClient, /유입 통계/);
  assert.doesNotMatch(applyClient, /LIST_QUICK_ACTION_CLASS/);
  assert.doesNotMatch(applyClient, /<th className="px-3 py-2(?:\.5)?">보호자<\/th>/);
  assert.doesNotMatch(applyClient, /COMPACT_CARD_ACTION_CLASS/);
  assert.doesNotMatch(applyClient, /COMPACT_CARD_CHIP_CLASS/);
  assert.doesNotMatch(applyClient, /className="rounded-lg border border-gray-200 bg-white p-3/);
  assert.doesNotMatch(applyClient, /mt-3 grid gap-2 sm:grid-cols-2/);
  assert.doesNotMatch(applyClient, /workFlags\.map/);
});

test("체험수업과 수강신청은 카드형을 폐기하고 목록형만 제공한다", () => {
  assert.match(applyClient, /renderApplicationList/);
  assert.match(applyClient, /LIST_ACTION_TRIGGER_CLASS/);
  assert.match(applyClient, /\{renderApplicationList\(\)\}/);
  assert.doesNotMatch(applyClient, /type ViewMode/);
  assert.doesNotMatch(applyClient, /setViewMode/);
  assert.doesNotMatch(applyClient, /grid_view/);
  assert.match(trialClient, /renderTrialList/);
  assert.match(trialClient, /LIST_ACTION_TRIGGER_CLASS/);
  assert.match(trialClient, /\{renderTrialList\(\)\}/);
  assert.doesNotMatch(trialClient, /type ViewMode/);
  assert.doesNotMatch(trialClient, /setViewMode/);
  assert.doesNotMatch(trialClient, /grid_view/);
  assert.doesNotMatch(trialClient, /handleStatusChange\(lead, event\.target\.value\)/);
});

test("목록형은 스프레드시트처럼 실제 테이블 구조로 보여준다", () => {
  assert.match(trialClient, /function renderTrialList\(\)[\s\S]*<table className="admin-list-table/);
  assert.match(trialClient, /<thead[\s\S]*상태[\s\S]*신청일[\s\S]*체험일[\s\S]*수업[\s\S]*담당교사[\s\S]*수강생이름[\s\S]*학교[\s\S]*학년[\s\S]*액션/);
  assert.match(trialClient, /<tbody[\s\S]*visibleLeads\.map/);
  assert.doesNotMatch(trialClient, /hidden grid-cols-\[1fr_0\.9fr_2\.2fr_0\.8fr_1\.2fr\]/);
  assert.match(applyClient, /function renderApplicationList\(\)[\s\S]*<table className="admin-list-table/);
  // 칸 구성: 상태 | 학생 | 학년 | 학교 | 보호자 | 연락처 | 접수일 | 희망 수업 | 수강 시작월 | 셔틀 | 빠른 처리
  assert.match(applyClient, /<thead[\s\S]*상태[\s\S]*학생[\s\S]*학년[\s\S]*학교[\s\S]*보호자[\s\S]*연락처[\s\S]*접수일[\s\S]*희망 수업[\s\S]*수강 시작월[\s\S]*셔틀[\s\S]*빠른 처리/);
  assert.match(applyClient, /<tbody[\s\S]*visibleApps\.map/);
  assert.doesNotMatch(applyClient, /hidden grid-cols-\[1\.1fr_1fr_1\.3fr_0\.9fr_1\.2fr\]/);
});

test("신청 관리에는 유입경로 통계를 탭에서 지연 로딩한다", () => {
  assert.match(applyClient, /type SourceStatsRange = "ALL" \| "30D" \| "THIS_MONTH"/);
  assert.match(applyClient, /SOURCE_STATS_RANGES/);
  assert.match(applyClient, /const \[sourceStatsData, setSourceStatsData\]/);
  assert.match(applyClient, /fetch\(`\/api\/admin\/apply\/source-stats\?range=\$\{range\}`/);
  assert.match(applyClient, /activeTab !== "sources"/);
  assert.match(applyClient, /function renderSourceStats\(\)/);
  assert.match(applyClient, /등록 전환/);
  assert.doesNotMatch(applyClient, /체험 문의와 수강신청이 어떤 경로에서 들어오는지 확인합니다/);
  assert.match(applyClient, /activeTab === "sources" \?[\s\S]*renderSourceStats\(\)/);
  assert.match(adminReadPayloads, /getCachedAdminApplySourceStatsPayload/);
  assert.match(adminReadPayloads, /FROM "TrialLead"/);
  assert.match(adminReadPayloads, /FROM "EnrollmentApplication"/);
  assert.match(adminReadPayloads, /COALESCE\(NULLIF\(TRIM\(source\), ''\), 'UNKNOWN'\)/);
  assert.match(applySourceStatsRoute, /requireTimedAdmin/);
  assert.match(applySourceStatsRoute, /getCachedAdminApplySourceStatsPayload\(range\)/);
  assert.match(applySourceStatsRoute, /private, max-age=60/);
});
