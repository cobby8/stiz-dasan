// 게슈탈트 디자인 점검(선생님 앱·기사님 화면) 가드 — 2026-10-30
// 실제 색·크기는 브라우저에서 봐야 하지만, «약속이 코드에서 빠지는 것»은 여기서 막는다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(path, "utf8");
const statusButton = await read("src/components/staff/StatusChoiceButton.tsx");
const livePill = await read("src/components/staff/LiveStatusPill.tsx");
const rideButtons = await read("src/app/staff/shuttle/ShuttleRideStatusButtons.tsx");
const shuttleDashboard = await read("src/app/staff/shuttle/StaffShuttleDashboardClient.tsx");
const session = await read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
const driver = await read("src/components/shuttle/UnifiedDriverClient.tsx");
const driverCss = await read("src/components/shuttle/DriverWorkspace.module.css");
const home = await read("src/app/staff/StaffHomeClient.tsx");
const quickPost = await read("src/app/staff/quick-post/QuickPostClient.tsx");
const photo = await read("src/components/staff/SessionPhotoUploader.tsx");
const billing = await read("src/app/staff/billing/StaffBillingClient.tsx");
const seasonal = await read("src/app/staff/seasonal/StaffSeasonalClient.tsx");
const students = await read("src/app/staff/students/StaffStudentsClient.tsx");
const requestModal = await read("src/components/shuttle/DriverRequestModal.tsx");

test("C-T1 공용 상태 버튼: 의미색 토큰·44px·눌림 표시·안 눌린 테두리", () => {
  for (const tone of ["success", "warning", "danger"]) {
    assert.match(statusButton, new RegExp(`${tone}: "border-\\[var\\(--color-academy-${tone}\\)\\] bg-\\[var\\(--color-academy-${tone}\\)\\]`), `${tone} 채움`);
    assert.match(statusButton, new RegExp(`${tone}: "border-\\[var\\(--color-academy-${tone}\\)\\] bg-\\[var\\(--color-academy-surface\\)\\]`), `${tone} 테두리`);
  }
  assert.match(statusButton, /aria-pressed=\{active\}/);
  assert.match(statusButton, /min-h-11/);
  assert.match(statusButton, /material-symbols-outlined/);
  // 되돌리기는 별도 글자 버튼(44px 터치)
  assert.match(statusButton, /export function StatusUndoButton[\s\S]*min-h-11[\s\S]*undo/);
  // 하드코딩 색 금지
  assert.doesNotMatch(statusButton, /(bg|text|border)-(red|green|emerald|amber|violet|gray)-\d/);
});

test("T-02 선생님 탑승: 탑승(넓게)|미탑승 12px, 대기는 아래 되돌리기, 저장 흐름 그대로", () => {
  assert.match(rideButtons, /grid grid-cols-\[2fr_1fr\] gap-3/);
  assert.match(rideButtons, /<StatusChoiceButton tone="success" icon="check" active=\{status === primaryStatus\}/);
  assert.match(rideButtons, /<StatusChoiceButton tone="danger" icon="close" active=\{status === "NO_SHOW"\}/);
  assert.match(rideButtons, /status !== "PENDING" && <StatusUndoButton disabled=\{isPending\} onClick=\{\(\) => update\("PENDING"\)\} \/>/);
  assert.doesNotMatch(rideButtons, /text-\[11px\]|bg-red-500|bg-emerald-500|bg-gray-900/);
  // 상태 알약도 같은 의미색
  assert.match(shuttleDashboard, /function RideStatusPill[\s\S]*?<StatusPill tone=\{tone\}/);
  assert.doesNotMatch(shuttleDashboard, /text-\[11px\]/);
});

test("T-03 출석부: 출석 success·지각 warning·결석 danger + 아이콘, 12px 간격, 이름 옆 같은 색 알약", () => {
  assert.match(session, /PRESENT: "success",\s*LATE: "warning",\s*ABSENT: "danger"/);
  assert.match(session, /PRESENT: "check",\s*LATE: "schedule",\s*ABSENT: "close"/);
  assert.match(session, /grid grid-cols-3 gap-3">\s*\{\(\["PRESENT", "LATE", "ABSENT"\] as AttendanceStatus\[\]\)\.map\(\(status\) => \(\s*<StatusChoiceButton/);
  assert.match(session, /<StatusPill tone=\{STATUS_TONE\[student\.status\]\}/);
  // 저장 함수는 그대로
  assert.match(session, /onClick=\{\(\) => updateAttendance\(student\.id, status\)\}/);
  assert.match(session, /saveStaffAttendance\(\{ sessionId: session\.id, attendanceKey: target\.attendanceKey, status \}\)/);
});

test("T-04 기사님 탑승: 같은 버튼 재탭은 무시, 되돌리기는 별도 버튼(status null), 간격 12px, 미탑승 danger", () => {
  assert.match(driver, /if \(!verifyOnly && cur === next\) return;/);
  assert.doesNotMatch(driver, /cur === next \? null : next/);
  assert.match(driver, /<StatusUndoButton[^>]*onClick=\{\(\) => \{ setMenuKey\(null\); void setStatus\(rider, null\); \}\}/);
  assert.match(driver, /<StatusChoiceButton tone="danger" icon="close"[^>]*active=\{status === "NOSHOW" \|\| status === "SELF"\}/);
  assert.match(driverCss, /\.boardingActions \{[^}]*gap: 12px/);
  // 저장 경로·파라미터는 그대로
  assert.match(driver, /shuttleRequestId: rider\.checkId, status: target/);
  assert.match(driver, /rowId: rider\.checkId, status: target/);
});

test("T-01 운행 종료: 화면 안 확인 후에만 handleRunEnd, GPS 표시와 12px", () => {
  assert.match(driver, /onClick=\{\(\) => setConfirmEnd\(true\)\}[^>]*>\{transmission === "stopping" \? "종료 확인 중" : "운행 종료"\}/);
  assert.match(driver, /운행을 종료할까요\?/);
  assert.match(driver, /위치 공유가 멈춥니다/);
  assert.match(driver, /onClick=\{\(\) => \{ setConfirmEnd\(false\); void handleRunEnd\(\); \}\}/);
  assert.match(driver, /autoFocus onClick=\{\(\) => setConfirmEnd\(false\)\}[^>]*>계속 운행/);
  assert.match(driverCss, /\.headerActions \{[^}]*gap: 12px/);
});

test("T-07 진행 알약: 수업 진행·홈·기사님 헤더가 같은 LiveStatusPill", () => {
  assert.match(livePill, /bg-\[var\(--brand-accent\)\]/);
  assert.match(livePill, /animate-pulse motion-reduce:animate-none/);
  assert.match(session, /<LiveStatusPill>수업 중<\/LiveStatusPill>/);
  assert.match(home, /if \(status === "IN_PROGRESS"\) return <LiveStatusPill>\{text\}<\/LiveStatusPill>;/);
  assert.match(driver, /runState === "running" && <LiveStatusPill>운행 중<\/LiveStatusPill>/);
});

test("T-06 수업 화면 보조 버튼: 메모 저장 secondary, 미확인 0명이면 출석부 확인도 secondary", () => {
  assert.match(session, /className="academy-button-secondary[^"]*">메모 지금 저장/);
  assert.match(session, /counts\.UNCHECKED > 0 \? "academy-button-primary" : "academy-button-secondary"/);
});

test("T-08 홈: 경고 상자 대신 카드 안 한 줄 안내, 진행 중 카드 주황 2px", () => {
  assert.doesNotMatch(home, /bg-amber-50 p-4 text-sm font-bold leading-6 text-amber-900/);
  assert.match(home, /수업으로 돌아가기" : "수업 시작"\}\s*<\/button>[\s\S]{0,200}\{runningClass && \(\s*<p role="status" className="text-xs font-bold text-\[var\(--color-academy-muted\)\]">/);
  assert.match(home, /\{ border: "2px solid var\(--brand-accent\)" \}/);
  // 시작 잠금은 그대로
  assert.match(home, /setError\(`\$\{runningClass\.name\} 수업을 먼저 종료해 주세요\.`\)/);
});

test("T-05 빠른 게시: 꽉 찬 버튼은 바로 게시 하나, 게시·새로 작성 확인, 새로 작성은 text", () => {
  assert.match(quickPost, /onClick=\{handleSave\}[\s\S]{0,80}className="academy-button-secondary/);
  assert.match(quickPost, /onClick=\{confirmPublish\}[\s\S]{0,120}className="academy-button-primary/);
  assert.match(quickPost, /function confirmPublish\(\) \{[\s\S]*?window\.confirm\(question\)[\s\S]*?handlePublish\(\);/);
  assert.match(quickPost, /function confirmReset\(\) \{[\s\S]*?window\.confirm\("작성 중인 내용을 지우고 새로 작성할까요\?"\)[\s\S]*?resetFlow\(\);/);
  assert.match(quickPost, /onClick=\{confirmReset\}[\s\S]{0,80}className="academy-button-text/);
  assert.doesNotMatch(quickPost, /bg-brand-navy-900/);
});

test("T-09 행 안 반복 버튼은 tonal, 하나뿐인 이어하기만 primary", () => {
  assert.match(billing, /aria-label=\{`\$\{bill\.studentName\} 납부 확인 요청`\} className="academy-button-tonal/);
  assert.match(seasonal, /className="academy-button-primary[^"]*"\s*>\s*<span[^>]*>arrow_forward<\/span>\s*수업 이어하기/);
  assert.match(seasonal, /onClick=\{\(\) => startLesson\(d\)\}\s*className="academy-button-tonal/);
  assert.match(students, /className="academy-button-tonal grid size-11/);
});

test("T-10 사진: 삭제는 오른쪽 휴지통 아이콘(확인 창 유지), 버튼·칩 44px", () => {
  assert.match(photo, /aria-label="사진 삭제"[^>]*onClick=\{\(\) => void deletePhoto\(photo\)\}[^>]*size-11/);
  assert.match(photo, />delete<\/span>/);
  assert.match(photo, /window\.confirm\("이 사진을 수업 기록과 관리자 검토 목록에서 삭제할까요\?"\)/);
  assert.doesNotMatch(photo, /min-h-(8|9|10)\b/);
});

test("T-11·T-12 현장 화면: 11px 글자 없음, 하드코딩 의미색은 토큰으로", () => {
  for (const [name, src] of [["session", session], ["rideButtons", rideButtons], ["shuttleDashboard", shuttleDashboard], ["quickPost", quickPost], ["requestModal", requestModal]]) {
    assert.doesNotMatch(src, /text-\[11px\]/, `${name} 11px`);
  }
  // 기사님 탑승 체크 영역(승객 줄 ~ 사용 안내)만 본다. 순서 편집 «저장»(파랑)은 이번 범위 밖.
  const riderArea = driver.slice(driver.indexOf("const status = boarding[rider.key]"), driver.indexOf("탑승 체크 사용 안내"));
  assert.ok(riderArea.length > 1000, "승객 줄 영역을 찾아야 한다");
  assert.doesNotMatch(riderArea, /bg-green-600|bg-red-500|bg-violet-600|bg-gray-700|border-red-300|bg-amber-400|bg-blue-600|text-red-\d/);
  assert.match(driver, /runState === "running" && <button[^\n]{0,200}className="academy-button-danger /);
  assert.doesNotMatch(session, /bg-green-50 p-2 text-green-700|bg-red-600 font-black text-white/);
  // 자차·오늘만 변경 색은 테마가 아닌 기사님 화면 CSS 변수로
  assert.match(driverCss, /--color-driver-self:/);
  assert.match(driverCss, /--color-driver-note:/);
});
