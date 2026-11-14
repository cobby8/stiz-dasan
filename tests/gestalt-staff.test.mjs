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
const studentSheet = await read("src/components/staff/SessionStudentSheet.tsx");
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
    // 꽉 찬 위험색은 danger-fill(맑은 빨강, 2026-11-09 위험색 역할 분리) — 테두리 버튼 글자는 그대로 danger
    const fill = tone === "danger" ? "danger-fill" : tone;
    assert.match(statusButton, new RegExp(`${tone}: "border-\\[var\\(--color-academy-${fill}\\)\\] bg-\\[var\\(--color-academy-${fill}\\)\\]`), `${tone} 채움`);
    assert.match(statusButton, new RegExp(`${tone}: "border-\\[var\\(--color-academy-${tone}\\)\\] bg-\\[var\\(--color-academy-surface\\)\\]`), `${tone} 테두리`);
  }
  assert.match(statusButton, /aria-pressed=\{active\}/);
  assert.match(statusButton, /min-h-11/);
  // 2026-11-14 아이콘 완전 제거(원장 재지시): 상태 버튼·알약은 ✓·시계·✕ 아이콘 없이 글자만 — 아이콘 글꼴도 icon 인자도 없다.
  assert.doesNotMatch(statusButton, /material-symbols-outlined|\bicon\b/);
  // 되돌리기는 별도 글자 버튼(44px 터치)
  // 2026-11-13 UI 통일: 되돌리기 버튼의 undo 아이콘을 뺐다(글자가 말한다) — 글자 버튼·44px 은 그대로 지킨다
  assert.match(statusButton, /export function StatusUndoButton[\s\S]*대기로 되돌리기[\s\S]*min-h-11[\s\S]*underline/);
  // 하드코딩 색 금지
  assert.doesNotMatch(statusButton, /(bg|text|border)-(red|green|emerald|amber|violet|gray)-\d/);
});

test("T-02 선생님 탑승: 탑승(넓게)|미탑승 12px, 대기는 아래 되돌리기, 저장 흐름 그대로", () => {
  assert.match(rideButtons, /grid grid-cols-\[2fr_1fr\] gap-3/);
  assert.match(rideButtons, /<StatusChoiceButton tone="success" active=\{status === primaryStatus\}/); // 2026-11-14 아이콘 완전 제거: icon 인자 없음
  assert.match(rideButtons, /<StatusChoiceButton tone="danger" active=\{status === "NO_SHOW"\}/);
  assert.match(rideButtons, /status !== "PENDING" && <StatusUndoButton disabled=\{isPending\} onClick=\{\(\) => update\("PENDING"\)\} \/>/);
  assert.doesNotMatch(rideButtons, /text-\[11px\]|bg-red-500|bg-emerald-500|bg-gray-900/);
  // 상태 알약도 같은 의미색
  assert.match(shuttleDashboard, /function RideStatusPill[\s\S]*?<StatusPill tone=\{tone\}/);
  assert.doesNotMatch(shuttleDashboard, /text-\[11px\]/);
});

test("T-03 출석부: 출석 success·지각 warning·결석 danger + 아이콘, 12px 간격, 이름 옆 같은 색 알약", () => {
  assert.match(session, /PRESENT: "success",\s*LATE: "warning",\s*ABSENT: "danger"/);
  // 2026-11-14 아이콘 완전 제거: 아이콘 이름 표(STATUS_ICON)를 없앴다 — 버튼·알약은 글자(출석·지각·결석·미확인)만 보인다.
  assert.doesNotMatch(session, /STATUS_ICON|icon=|material-symbols-outlined/);
  // 2026-11-14 수업 화면 간결화: 명단은 학생 한 줄(이름 + 출결 버튼 3개), «지금 상태» 알약은 학생 상세 시트에 있다.
  assert.match(studentSheet, /<StatusPill tone="neutral">미확인<\/StatusPill>/);
  assert.match(session, /grid shrink-0 grid-cols-3 gap-1\.5">\s*\{\(\["PRESENT", "LATE", "ABSENT"\] as AttendanceStatus\[\]\)\.map\(\(status\) => \(\s*<StatusChoiceButton/);
  assert.match(studentSheet, /<StatusPill tone=\{STATUS_TONE\[student\.status\]\}/);
  // 저장 함수는 그대로
  assert.match(session, /onClick=\{\(\) => void updateAttendance\(student\.id, status\)\}/);
  assert.match(session, /saveStaffAttendance\(\{ sessionId: session\.id, attendanceKey: target\.attendanceKey, status, absenceReason \}\)/);
});

test("T-04 기사님 탑승: 같은 버튼 재탭은 무시, 되돌리기는 별도 버튼(status null), 간격 12px, 미탑승 danger", () => {
  assert.match(driver, /if \(!verifyOnly && cur === next\) return;/);
  assert.doesNotMatch(driver, /cur === next \? null : next/);
  assert.match(driver, /<StatusUndoButton[^>]*onClick=\{\(\) => \{ setMenuKey\(null\); void setStatus\(rider, null\); \}\}/);
  assert.match(driver, /<StatusChoiceButton tone="danger"[^>]*active=\{status === "NOSHOW" \|\| status === "SELF"\}/);
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
  // 2026-11-13 UI 통일: 진행 알약은 꽉 찬 주 색 대신 보조 색(하늘색) 바탕 + 테두리 — 꽉 찬 주 색은 누르는 주 버튼만
  assert.match(livePill, /bg-\[var\(--color-academy-secondary-soft\)\]/);
  assert.match(livePill, /ring-\[var\(--color-academy-secondary-strong\)\]/);
  assert.doesNotMatch(livePill, /font-(black|extrabold)/);
  assert.match(livePill, /animate-pulse motion-reduce:animate-none/);
  assert.match(session, /<LiveStatusPill>수업 중<\/LiveStatusPill>/);
  assert.match(home, /if \(status === "IN_PROGRESS"\) return <LiveStatusPill>\{text\}<\/LiveStatusPill>;/);
  assert.match(driver, /runState === "running" && <LiveStatusPill>운행 중<\/LiveStatusPill>/);
});

test("T-06 수업 화면 보조 버튼: 메모 저장 secondary, 전체 출석은 미확인이 남았을 때만 보인다", () => {
  assert.match(session, /className="academy-button-secondary[^"]*">메모 지금 저장/);
  // 2026-11-14: «출석부 확인» 버튼이 없어졌다(명단이 바로 보인다). 주인공 버튼(전체 출석)은 처리할 학생이 있을 때만 그린다.
  assert.match(session, /\{\(bulkSplit\.targets\.length > 0 \|\| bulkBusy\) && \(\s*<button[^>]*className="academy-button-primary/);
  assert.doesNotMatch(session, /출석부 확인/);
});

test("T-08 홈: 경고 상자 대신 카드 안 한 줄 안내, 진행 중 카드 주황 2px", () => {
  assert.doesNotMatch(home, /bg-amber-50 p-4 text-sm font-bold leading-6 text-amber-900/);
  assert.match(home, /수업으로 돌아가기" : "수업 시작"\}\s*<\/button>[\s\S]{0,200}\{runningClass && \(\s*<p role="status" className="text-xs text-\[var\(--color-academy-muted\)\]">/);
  // 2026-11-13 UI 통일: 진행 중 카드 테두리 = 보조 색(«지금 이것»). 안내 줄 굵기는 본문(굵기 클래스 없음).
  assert.match(home, /\{ border: "2px solid var\(--color-academy-secondary-strong\)" \}/);
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
  // 2026-11-13 UI 통일: 버튼 안 화살표 아이콘을 뺐다 — «하나뿐인 이어하기만 primary» 는 그대로
  assert.match(seasonal, /className="academy-button-primary[^"]*"\s*>\s*수업 이어하기/);
  assert.match(seasonal, /onClick=\{\(\) => startLesson\(d\)\}\s*className="academy-button-tonal/);
  // 2026-11-13 UI 통일: 전화 아이콘 버튼 → «전화» 글자 버튼(tonal, 터치 화면 44px 은 테마 academy-button-sm 이 지킨다)
  assert.match(students, /className="academy-button-tonal academy-button-sm shrink-0"\s*>\s*전화/);
});

test("T-10 사진: 삭제는 오른쪽 휴지통 아이콘(확인 창 유지), 버튼·칩 44px", () => {
  // 2026-11-14 아이콘 완전 제거: 휴지통 아이콘 → 글자 «삭제» 위험 버튼(터치 화면 44px 은 테마 academy-button-sm 이 지킨다). 떨어진 자리·확인 창은 그대로.
  // 2026-11-14 수업 피드: «학생 수정» 버튼이 없어져(나온 학생 선택 제거) 사진 아래 «지우기» 위험 버튼 하나만 남았다. 확인 창은 그대로.
  assert.match(photo, /aria-label=\{`사진 \$\{index \+ 1\} 지우기`\} onClick=\{\(\) => void deletePhoto\(photo\)\} className="academy-button-danger academy-button-sm[^"]*">\s*지우기\s*</);
  assert.doesNotMatch(photo, /material-symbols-outlined/);
  assert.match(photo, /window\.confirm\("이 사진을 지울까요\? 학부모 소식에서도 사라집니다\."\)/);
  assert.doesNotMatch(photo, /min-h-(8|9|10)\b/);
});

test("T-11·T-12 현장 화면: 11px 글자 없음, 하드코딩 의미색은 토큰으로", () => {
  for (const [name, src] of [["session", session], ["rideButtons", rideButtons], ["shuttleDashboard", shuttleDashboard], ["quickPost", quickPost], ["requestModal", requestModal]]) {
    assert.doesNotMatch(src, /text-\[11px\]/, `${name} 11px`);
  }
  // 기사님 탑승 체크 영역(승객 줄 ~ 사용 안내)만 본다. 순서 편집 «저장»(파랑)은 이번 범위 밖.
  // 2026-11-09 운행표 부품(RunBoard) 추출: 승객 줄은 renderRider 함수(화면 JSX 바로 앞)로 옮겨졌다 → 그 함수 끝까지만 본다.
  const riderArea = driver.slice(driver.indexOf("const status = boarding[rider.key]"), driver.indexOf('<AcademyTheme role="driver"'));
  assert.ok(riderArea.length > 1000, "승객 줄 영역을 찾아야 한다");
  assert.doesNotMatch(riderArea, /bg-green-600|bg-red-500|bg-violet-600|bg-gray-700|border-red-300|bg-amber-400|bg-blue-600|text-red-\d/);
  assert.match(driver, /runState === "running" && <button[^\n]{0,200}className="academy-button-danger /);
  assert.doesNotMatch(session, /bg-green-50 p-2 text-green-700|bg-red-600 font-black text-white/);
  // 자차·오늘만 변경 색은 테마가 아닌 기사님 화면 CSS 변수로
  assert.match(driverCss, /--color-driver-self:/);
  assert.match(driverCss, /--color-driver-note:/);
});
