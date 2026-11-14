import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

// 2026-11-14 원장 지시 — 선생님 «수업 진행» 화면 간결화.
//   ① «영상 촬영»이 옛 안드로이드 앱에서 파일 선택으로 떨어진다 → 버전 안내
//   ② «오늘 수업 내용»과 «수업 피드»가 같은 칸처럼 보인다 → «오늘 수업» 한 칸
//   ③ 같은 학생이 출석 확인·출석부·학생 정보에 여러 번 나온다 → 학생 한 명 = 한 줄, 상세는 시트
// 화면 배치만 바꿨다. 저장·조회 함수는 그대로여야 한다(아래 «기능 보존»).

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const client = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
const sheet = read("src/components/staff/SessionStudentSheet.tsx");
const uploader = read("src/components/staff/SessionVideoUploader.tsx");
const feed = read("src/components/staff/SessionFeedPanel.tsx");

// 실제 모듈을 돌린다(.ts/.tsx 를 그 자리에서 변환) — «@/…» 의존은 대역을 넘긴 것만 허용
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) throw new Error(`대역 없는 의존: ${name}`);
    return require(name);
  };
  module._compile(compiled, absolute);
  return module.exports;
}
const storeApp = load("src/lib/storeApp.ts");
const statusTones = load("src/lib/ui/statusTones.ts");
const { SessionStudentSheet } = load("src/components/staff/SessionStudentSheet.tsx", {
  "@/components/staff/ClassPeopleSheet": {
    ContactLink: ({ phone, label, sms }) => React.createElement("a", { href: phone ? `${sms ? "sms" : "tel"}:${phone}` : undefined }, phone ? label : "연락처 없음"),
  },
  "@/components/staff/StatusChoiceButton": load("src/components/staff/StatusChoiceButton.tsx", { "@/lib/ui/statusTones": statusTones }),
  "@/components/staff/StaffMonthlyFeeSummary": { monthlyFeeLabel: (month) => `${month} 수강료` },
  "@/components/staff/useStaffDialog": { useStaffDialog: () => {} },
  "@/lib/regular/regularAbsenceRules": { REASON_LABEL: { ILLNESS_INJURY: "질병·부상" } },
  "@/lib/ui/statusTones": statusTones,
});

// 주석을 걷어낸 본문 — «없어야 하는 글자» 검사가 설명 주석에 걸리지 않게
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const clientCode = stripComments(client);
const sheetCode = stripComments(sheet);
const count = (source, pattern) => (source.match(pattern) ?? []).length;
const PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

// ── A. 영상 촬영 ─────────────────────────────────────────────

test("영상 촬영 안내: 안드로이드 앱 1.0.3 미만만 «업데이트» 안내를 본다", () => {
  const needs = storeApp.needsAppUpdateForVideoCapture;
  assert.equal(storeApp.NATIVE_VIDEO_CAPTURE_MIN_ANDROID_VERSION, "1.0.3");
  assert.equal(needs({ userAgent: `${ANDROID} STIZApp/1.0.2 (android)` }), true);
  assert.equal(needs({ userAgent: `${ANDROID} STIZApp/1.0.1 (android)` }), true);
  assert.equal(needs({ userAgent: `${ANDROID} STIZApp/1.0.3 (android)` }), false);
  assert.equal(needs({ userAgent: `${ANDROID} STIZApp/1.0.10 (android)` }), false, "1.0.10 은 1.0.3 보다 높다");
  assert.equal(needs({ userAgent: `${ANDROID} STIZApp/1.1 (android)` }), false);
  // 아이폰 앱은 버전과 무관하게 안내하지 않는다(WKWebView 가 촬영을 직접 연다)
  assert.equal(needs({ userAgent: `${IPHONE} STIZApp/1.0.1 (ios)` }), false);
  assert.equal(needs({ userAgent: IPHONE, storeApp: true }), false);
  // 일반 브라우저(휴대폰 크롬·PC)는 안내하지 않는다
  assert.equal(needs({ userAgent: ANDROID }), false);
  assert.equal(needs({ userAgent: ANDROID, storeApp: false }), false);
  assert.equal(needs({ userAgent: PC, storeApp: true }), false);
  // 표식을 붙이기 전의 옛 안드로이드 앱(1.0)
  assert.equal(needs({ userAgent: ANDROID, storeApp: true }), true);
  assert.equal(needs({ userAgent: null }), false);
});

test("영상 촬영 칸: accept 는 video/* 하나 + capture, 안내는 판정 함수 결과로만 보인다", () => {
  // 안드로이드는 받는 형식이 «전부 영상»일 때만 동영상 카메라를 연다 — 촬영 칸에 multiple·구체 형식을 섞지 않는다
  assert.match(uploader, /<input ref=\{cameraRef\} hidden type="file" accept="video\/\*" capture="environment" onChange/);
  assert.match(uploader, /needsAppUpdateForVideoCapture\(\{ userAgent: window\.navigator\.userAgent, storeApp: isStoreApp\(\) \}\)/);
  assert.match(uploader, /\{needsAppUpdate && \(\s*<p role="status"[^>]*>\s*앱을 업데이트하면 바로 촬영돼요\./);
  // 안내는 두 버튼 바로 아래(촬영 → 안내 → 크기 안내 순서)
  const shoot = uploader.indexOf("영상 촬영\n");
  const notice = uploader.indexOf("앱을 업데이트하면 바로 촬영돼요");
  const hint = uploader.indexOf("uploadHintMessage(maxBytes)}</p>");
  assert.ok(shoot > 0 && notice > shoot && hint > notice);
});

// ── B. «오늘 수업» 한 칸 ──────────────────────────────────────

test("«오늘 수업 내용»·«수업 피드» 두 칸이 «오늘 수업» 한 칸이 됐다", () => {
  assert.doesNotMatch(client, />오늘 수업 내용</);
  assert.doesNotMatch(client, />수업 피드</);
  assert.equal(count(client, /className="academy-section-title">오늘 수업<\/h2>/g), 1);
  // 수업 계획은 그 칸 안의 접힌 한 줄 — 계획 글이 없으면 줄 자체를 그리지 않는다
  assert.match(client, /const plan = \(session\.plannedContent \|\| ""\)\.trim\(\);/);
  assert.match(client, /\{plan && \(\s*<div[^>]*>\s*<button type="button" onClick=\{\(\) => setShowPlan/);
  assert.doesNotMatch(client, /미리 등록한 수업 내용이 없습니다/);
  // 순서: 계획 → 학부모에게 보낼 한 줄 → 사진 → 영상 → 특이사항
  const order = ["수업 계획 보기", "<FeedLineEditor", "<SessionPhotoUploader", "<SessionVideoUploader", 'id="session-memo"'].map((mark) => client.indexOf(mark));
  assert.ok(order.every((at) => at > 0), "칸이 빠졌다");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("수업 계획 불러오기: 한 줄 칸에 채우기만 한다(저장 흐름은 그대로)", () => {
  const fn = client.slice(client.indexOf("function loadPlanIntoLine"), client.indexOf("function loadPlanIntoLine") + 500);
  assert.match(fn, /if \(report\.trim\(\) && !window\.confirm\(/, "쓴 글이 있으면 덮어쓰기 전에 묻는다");
  assert.match(fn, /setReport\(Array\.from\(planText\)\.slice\(0, FEED_LINE_MAX\)\.join\(""\)\)/);
  assert.doesNotMatch(fn, /saveSessionFeedLine|completeClassSession/);
  // 한 줄 저장은 여전히 FeedLineEditor 의 saveSessionFeedLine 하나
  assert.match(feed, /await saveSessionFeedLine\(\{ sessionId, content: sending \}\)/);
  // 바깥에서 채운 글도 «저장 안 됨»으로 보인다
  assert.match(feed, /const unsaved = value !== savedValue;/);
});

test("종료 창: 이미 쓴 한 줄이 있으면 입력 칸을 또 보이지 않는다", () => {
  assert.doesNotMatch(client, /수업 피드 칸과 같은 내용/);
  // 열 때 정한다 — 쓴 글이 있으면 읽기 전용, 없으면 입력 칸
  assert.match(client, /function openEndConfirm\(\) \{\s*setFinishError\(""\);\s*setEditReport\(!report\.trim\(\)\);\s*setShowEndConfirm\(true\);/);
  assert.match(client, /onClick=\{openEndConfirm\}[^>]*>수업 종료 확인</);
  const dialog = client.slice(client.indexOf("data-end-report"));
  assert.match(dialog, /\{editReport \? \(/);
  assert.equal(count(client, /id="session-report"/g), 1, "입력 칸은 하나");
  assert.match(dialog, /학부모에게 보낼 글: <\/span>\{report\.trim\(\)\}/);
  assert.match(dialog, /onClick=\{\(\) => setEditReport\(true\)\}[^>]*>고치기</);
  // 종료할 때 보내는 값은 그대로(report·publishReport) — 서버의 CASE WHEN $5 THEN $3 처리와 맞물린다
  assert.match(client, /completeClassSession\(\{\s*sessionId: session\.id,\s*report,\s*publishReport,\s*\}\)/);
});

// ── C. 학생 한 명 = 한 줄 ─────────────────────────────────────

test("학생은 화면에 한 번만 나온다 — 명단 하나, 출석부 화면·펼침 없음", () => {
  assert.equal(count(client, /students\.map\(\(student\) =>/g), 1, "명단은 하나");
  assert.equal(count(client, /aria-label="학생 출결 명단"/g), 1);
  assert.equal(count(client, /aria-label="출결 현황"/g), 1);
  // 따로 있던 «출석부» 화면·«출석 확인» 칸·«학생 정보·수업 관리» 펼침이 없다
  assert.doesNotMatch(client, /view === "attendance"|setView\(/);
  assert.doesNotMatch(clientCode, /학생 정보·수업 관리|수업으로 돌아가기|aria-label="출석 확인"/);
  assert.doesNotMatch(client, /<details/);
  // 수업 시작 직후 주소(?view=attendance)는 그대로 받아 명단으로 맞춘다
  assert.match(client, /if \(initialView === "attendance"\) scrollToRoster\(\);/);
  // 명단이 «오늘 수업» 칸보다 위
  assert.ok(client.indexOf('aria-label="학생 출결 명단"') < client.indexOf('id="session-feed-title"'));
});

test("명단 한 줄: 이름(누르면 상세) + 표시 + 출결 버튼 3개, 터치 44px", () => {
  const row = clientCode.slice(clientCode.indexOf("data-student-row"), clientCode.indexOf("</article>"));
  assert.match(row, /aria-label=\{`\$\{student\.name\} 상세 정보`\} onClick=\{\(\) => \{ setPeopleWanted\(true\); setDetailId\(student\.id\); \}\} className="flex min-h-11 /);
  // 출결 버튼 사이는 8px 이상(오터치 방지), 버튼 폭 48px 이상
  assert.match(row, /grid shrink-0 grid-cols-3 gap-2">/);
  assert.match(row, /className="min-w-12">/);
  for (const badge of ["보강", "체험", "결석 신고", "특이"]) assert.match(row, new RegExp(`>${badge}</span>`), `${badge} 표시`);
  assert.match(row, /active=\{student\.status === status\} disabled=\{bulkBusy \|\| Boolean\(savingRows\[student\.id\]\)\} onClick=\{\(\) => void updateAttendance\(student\.id, status\)\}/);
  // 한 줄에는 연락처·수강료·보호자가 없다(시트에만)
  assert.doesNotMatch(row, /ContactLink|tel:|sms:|수강료|guardians/);
  // 질병·부상 표시는 결석인 줄에서만
  assert.match(row, /student\.status === "ABSENT" && !student\.makeup && !student\.trial && !session\.sessionDateId/);
});

test("학생 상세 시트: 연락처·수강료·메모·최근 출결·보호자를 한 곳에 모은다", () => {
  assert.match(client, /\{detailStudent && <SessionStudentSheet/);
  assert.match(client, /person=\{people\.get\(detailStudent\.studentId \|\| detailStudent\.id\) \?\? null\}/);
  for (const mark of ['label="학생 전화"', 'label="학부모 전화"', 'label="문자" sms', "메모·특이사항", "최근 출결", "보호자 {person.guardians.length}명", "수강료·청구 확인"]) {
    assert.ok(sheet.includes(mark), `시트에 ${mark}`);
  }
  // 전화·문자 버튼은 기존 «학생 정보» 시트와 같은 부품
  assert.match(sheet, /import \{ ContactLink \} from "@\/components\/staff\/ClassPeopleSheet";/);
  // 휴대폰 = 아래 시트, 넓은 화면 = 가운데 창 · 닫기는 글자
  assert.match(sheet, /flex items-end bg-black\/55 sm:items-center sm:justify-center" role="dialog" aria-modal="true"/);
  assert.match(sheet, /useStaffDialog\(true, sheetRef, onClose\);/);
  // 청구 확인을 누르면 시트를 닫고 기존 청구 시트(출결 맥락 포함)를 연다
  assert.match(client, /onOpenBilling=\{\(student\) => \{ setDetailId\(null\); setAttendanceBillingTarget\(student\); \}\}/);
  assert.match(client, /attendanceContext=\{\{ sessionId: session\.id, rosterId: attendanceBillingTarget\.id \}\}/);
});

// 시트를 실제로 그려 본다(선생님 / 원장 · 정규 학생 / 체험 학생)
const baseStudent = { id: "s1", attendanceKey: "s1", studentId: "s1", name: "김하늘", grade: null, phone: null, status: "ABSENT", attendanceNote: null, arrivedAt: null, absenceReport: { reason: "ILLNESS_INJURY", status: "CONFIRMED", source: "PARENT" }, makeup: false, trial: false };
const basePerson = { id: "s1", name: "김하늘", school: "다산초", grade: "초4", memo: "땅콩 알레르기", studentPhone: null, guardians: [{ id: "g1", name: "김엄마", relation: "모", phone: "010-1111-2222", isPrimary: true }], recentAttendance: { present: 9, late: 1, absent: 2, total: 12 }, todayStatus: "ABSENT", billing: null };
const sheetProps = { className: "초등 A반", student: baseStudent, person: basePerson, peopleState: "ready", onReloadPeople() {}, showFees: false, feeLoading: false, feeError: "", feeMonth: "2026-11", fee: { rosterId: "s1", amount: 150000, statusLabel: "미납" }, onReloadFees() {}, onOpenBilling() {}, onClose() {} };
const renderSheet = (props) => renderToStaticMarkup(React.createElement(SessionStudentSheet, { ...sheetProps, ...props }));

test("학생 상세 시트 렌더: 선생님에게는 수강료가 없고, 원장에게만 보인다", () => {
  const teacher = renderSheet({});
  assert.match(teacher, /김하늘/);
  assert.match(teacher, /다산초 · 초4/);
  assert.match(teacher, />결석</);
  assert.match(teacher, /학부모 결석 알림 · 질병·부상 · 확정/);
  assert.match(teacher, /href="tel:010-1111-2222"/);
  assert.match(teacher, /href="sms:010-1111-2222"/);
  assert.match(teacher, /땅콩 알레르기/);
  assert.match(teacher, /최근 12회: 출석 9 · 지각 1 · 결석 2/);
  assert.match(teacher, /김엄마 · 모/);
  assert.doesNotMatch(teacher, /수강료|150,000|미납/, "선생님 화면에 금액·미납이 새면 안 된다");

  const director = renderSheet({ showFees: true, person: { ...basePerson, billing: { unpaidCount: 2, pendingConfirmationCount: 0, unpaidAmount: 300000 } } });
  assert.match(director, /150,000원/);
  assert.match(director, /미납 · 청구 확인/);
  assert.match(director, /미납 2건/);
});

test("학생 상세 시트 렌더: 체험·보강 아이는 연락처·수강료 없이 이름·학년만", () => {
  const trial = renderSheet({ showFees: true, person: null, student: { ...baseStudent, id: "trial:1", studentId: null, grade: "초2", status: null, absenceReport: null, trial: true } });
  assert.match(trial, />미확인</);
  assert.match(trial, />체험</);
  assert.match(trial, /초2/);
  assert.match(trial, /체험 학생은 이름·학년만 보입니다/);
  assert.doesNotMatch(trial, /tel:|sms:|수강료/);
  // 학생 정보가 아직 안 왔을 때·실패했을 때
  assert.match(renderSheet({ person: null, peopleState: "loading" }), /연락처를 불러오는 중입니다/);
  assert.match(renderSheet({ person: null, peopleState: "error" }), /다시 불러오기/);
  // 명단이 준 전화가 있으면 조회가 늦거나 실패해도 바로 전화·문자를 건다
  for (const peopleState of ["loading", "error"]) {
    const html = renderSheet({ person: null, peopleState, student: { ...baseStudent, phone: "010-3333-4444" } });
    assert.match(html, /href="tel:010-3333-4444"/, peopleState);
    assert.match(html, /grid-cols-2/);
    assert.doesNotMatch(html, /불러오는 중|불러오지 못했습니다/);
  }
});

test("명단 줄 «미납» 표시는 원장·부원장에게만 — 선생님에겐 값도 조건도 닿지 않는다", () => {
  const row = clientCode.slice(clientCode.indexOf("data-student-row"), clientCode.indexOf("</article>"));
  // 표시 조건의 맨 앞이 showFees — 이 반 수강생(보강·체험 아님)이고 그 달 청구가 미납일 때만
  assert.match(row, /\{showFees && !student\.makeup && !student\.trial && feesByRoster\.get\(student\.id\)\?\.status === "UNPAID" && \(\s*<span[^>]*text-\[var\(--color-academy-warning\)\]">미납<\/span>/);
  assert.equal(count(row, /미납/g), 1, "미납 글자는 그 조건 안 한 곳뿐");
  // 선생님 화면은 수강료 조회 자체를 하지 않는다 → feesByRoster 가 비어 있다(이중 잠금)
  assert.match(clientCode, /if \(!showFees\) return;\s*let active = true;/);
  assert.match(clientCode, /const feesByRoster = useMemo\(\(\) => new Map\(feeData\?\.items\.map/);
  // 학생 정보의 미납(billing)은 명단 줄에서 쓰지 않는다
  assert.doesNotMatch(row, /billing/);
});

test("학생 정보 조회는 한가할 때 — 첫 출결 저장 앞에 줄 서지 않는다, 상세 시트는 일반 import", () => {
  assert.match(clientCode, /import \{ SessionStudentSheet \} from "@\/components\/staff\/SessionStudentSheet";/);
  assert.doesNotMatch(clientCode, /const SessionStudentSheet = dynamic/);
  // 화면이 뜬 직후가 아니라 잠시 뒤 또는 첫 이름 누름 때
  assert.match(clientCode, /window\.setTimeout\(\(\) => setPeopleWanted\(true\), PEOPLE_IDLE_DELAY_MS\)/);
  assert.match(clientCode, /const PEOPLE_IDLE_DELAY_MS = (\d+);/);
  assert.ok(Number(/const PEOPLE_IDLE_DELAY_MS = (\d+);/.exec(clientCode)[1]) >= 1000);
  // 출결 저장 중이면 미루고, 같은 차례를 두 번 부르지 않는다
  assert.match(clientCode, /const attendanceBusy = Object\.keys\(savingRows\)\.length > 0 \|\| Boolean\(bulkAttendanceProgress\);/);
  assert.match(clientCode, /if \(!peopleWanted \|\| attendanceBusy\) return;\s*if \(peopleStartedRef\.current === peopleReload\) return;/);
  assert.equal(count(clientCode, /loadStaffClassPeople\(\{/g), 1);
});

test("하단 안내: 실패 문구일 때만 주의색 + role=alert, 44px 버튼", () => {
  const pattern = new RegExp(/const SUCCESS_MESSAGE = \/(.+)\/;/.exec(clientCode)[1]);
  assert.equal(pattern.test("특이사항을 저장했습니다."), true);
  assert.equal(pattern.test("전체 출석을 저장했습니다. 2명은 건너뛰었어요(결석 신고·이미 기록됨) — 그 줄의 안내를 확인해 주세요."), true);
  for (const failure of ["특이사항을 저장하지 못했습니다. 네트워크 연결을 확인해 주세요.", "3명은 저장됐습니다. 로그인이 필요합니다.", "저장 중 연결이 끊겼습니다.", "음성 메모 처리가 끝난 뒤 이동해 주세요.", "수업 시작 취소 처리 중 문제가 발생했습니다."]) {
    assert.equal(pattern.test(failure), false, failure);
  }
  assert.match(clientCode, /\{message && \(SUCCESS_MESSAGE\.test\(message\) \? \(/);
  assert.match(clientCode, /<p role="alert" className="min-w-0 text-sm font-medium text-\[var\(--color-academy-warning\)\]">\{message\}<\/p>/);
  assert.match(clientCode, /<p aria-live="polite" className="min-w-0 text-sm text-\[var\(--color-academy-info\)\]">\{message\}<\/p>/);
  // «더보기»·«닫기»는 44px
  assert.match(clientCode, /academy-button-sm min-h-11! shrink-0">더보기</);
  assert.equal(count(clientCode, /academy-button-sm shrink-0">닫기</g), 0);
  assert.equal(count(sheetCode, /academy-button-sm shrink-0">닫기</g), 0);
  assert.match(sheetCode, /academy-button-sm min-h-11! shrink-0">닫기</);
});

test("기능 보존: 옮긴 기능이 «더보기»에 전부 있고 저장 함수는 그대로다", () => {
  const more = client.slice(client.indexOf('aria-labelledby="session-more-title"'), client.indexOf("{showPeople && <ClassPeopleSheet"));
  assert.match(more, /setShowMore\(false\); setShowPeople\(true\);/, "연락처 모아 보기(기존 학생 정보 시트)");
  assert.match(more, /setShowMore\(false\); setBillingStudent\(null\);/, "반 전체 청구 확인");
  assert.match(more, /setShowMore\(false\); cancelStart\(\);/, "수업 시작 취소");
  assert.match(client, /aria-haspopup="dialog" onClick=\{\(\) => setShowMore\(true\)\}[^>]*>더보기</);
  // 서버 기능 호출은 하나도 빠지지 않았다
  for (const call of ["saveStaffAttendance(", "saveSessionMemo(", "cancelClassSession(", "completeClassSession(", "loadStaffSessionMonthlyFees(", "loadStaffClassPeople("]) {
    assert.ok(client.includes(call), `${call} 호출이 사라졌다`);
  }
  for (const part of ["<ClassPeopleSheet", "<ClassBillingSheet", "<SessionPhotoUploader", "<SessionVideoUploader", "<FeedLineEditor", "<VoiceToTextButton", "markAllPresent", "수업 중 특이사항"]) {
    assert.ok(client.includes(part), `${part} 가 사라졌다`);
  }
});

test("모양 규칙: 아이콘·이모지 없음, 굵기 4단계, 11px 이하 글자 없음", () => {
  for (const [name, source] of [["화면", clientCode], ["시트", sheetCode]]) {
    assert.doesNotMatch(source, /material-symbols|lucide|font-extrabold|font-black/, name);
    assert.doesNotMatch(source, /text-\[(?:9|10|11)px\]/, name);
    assert.doesNotMatch(source, /\p{Extended_Pictographic}/u, `${name}: 이모지`);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b/, `${name}: 색 코드 직접 사용`);
  }
  // 굵은 글씨(700)는 제목에만 — 경과 시간 숫자는 600
  assert.doesNotMatch(client, /font-mono text-3xl font-bold/);
  assert.equal(count(client, /font-bold/g), 1, "화면의 700 은 종료 창 제목 하나");
  assert.equal(count(sheet, /font-bold/g), 1, "시트의 700 은 학생 이름(제목) 하나");
});
