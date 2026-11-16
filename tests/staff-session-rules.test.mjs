import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 출시 전 점검(2026-11-13 원장 승인) — 선생님·기사님 화면 판정 규칙을 실제로 실행해 본다.
// 날짜 판정은 자정 경계(KST 00:00 = UTC 15:00 전날)에서 틀리기 쉬워 경계 시각을 직접 넣는다.
const rules = await loadTsModule("src/lib/staff-session-rules.ts");

const report = (source) => ({ reason: "ILLNESS_INJURY", status: "REPORTED", source });

test("b1 전체 출석은 결석 신고(학부모·기간 결석) 아이를 빼고, 이미 찍은 아이는 건드리지 않는다", () => {
  const rows = [
    { id: "a", status: null, absenceReport: null },
    { id: "b", status: null, absenceReport: report("PARENT") },
    { id: "c", status: "ABSENT", absenceReport: report("PARENT") },
    { id: "d", status: "PRESENT", absenceReport: null },
    { id: "e", status: null, absenceReport: null },
  ];
  const { targets, reported } = rules.splitBulkPresent(rows);
  assert.deepEqual(targets.map((r) => r.id), ["a", "e"]);
  assert.deepEqual(reported.map((r) => r.id), ["b"]);
  assert.equal(rules.bulkReportedNotice(reported.length), "결석 신고 1명은 직접 확인해 주세요.");
  assert.equal(rules.bulkReportedNotice(0), "");
});

test("b2 화면 날짜가 KST 오늘과 다르면 낡은 화면이다(자정 경계)", () => {
  // 2026-11-13 23:59 KST = 2026-11-13T14:59Z, 2026-11-14 00:00 KST = 2026-11-13T15:00Z
  const before = Date.UTC(2026, 10, 13, 14, 59);
  const after = Date.UTC(2026, 10, 13, 15, 0);
  assert.equal(rules.isStaleDateKey("2026-11-13", before), false);
  assert.equal(rules.isStaleDateKey("2026-11-13", after), true);
  assert.equal(rules.isStaleDateKey("2026-11-14", after), false);
  // 새벽 3시(KST) — UTC 로는 아직 전날이지만 KST 로는 오늘이다.
  assert.equal(rules.isStaleDateKey("2026-11-14", Date.UTC(2026, 10, 13, 18, 0)), false);
});

test("b6 지난 날짜 수업은 학부모 알림을 보내지 않는다(월말·연말 경계 포함)", () => {
  const jan1Kst = Date.UTC(2026, 11, 31, 15, 30); // 2027-01-01 00:30 KST
  assert.equal(rules.isPastSessionDate("2026-12-31", jan1Kst), true);
  assert.equal(rules.shouldNotifyParentsForSession("2026-12-31", jan1Kst), false);
  assert.equal(rules.shouldNotifyParentsForSession("2027-01-01", jan1Kst), true);
  // DB 가 날짜 뒤에 시각을 붙여 줘도 앞 10글자로 판정한다.
  assert.equal(rules.isPastSessionDate("2026-11-30T00:00:00.000Z", Date.UTC(2026, 10, 30, 16, 0)), true);
});

test("b6 진행 중 수업 안내 문구", () => {
  assert.equal(rules.activeSessionNotice("월3반", "2026-11-12"), "월3반(11월 12일) 수업이 아직 진행 중입니다. 먼저 끝내 주세요.");
  assert.equal(rules.activeSessionNotice("월3반", null), "월3반 수업이 아직 진행 중입니다. 먼저 끝내 주세요.");
});

test("b5 로그인 풀림·권한 없음·연결 끊김을 구분한다", () => {
  assert.equal(rules.classifyStaffFailure("인증이 필요합니다. 로그인해주세요."), "login");
  assert.equal(rules.classifyStaffFailure("Staff permission is required."), "forbidden");
  assert.equal(rules.classifyStaffFailure("담당 수업에만 접근할 수 있습니다."), "forbidden");
  assert.equal(rules.classifyStaffFailure("Failed to fetch"), "network");
  assert.equal(rules.classifyStaffFailure("Load failed"), "network");
  assert.equal(rules.classifyStaffFailure("무언가 다른 오류"), "other");

  const login = rules.staffAccessFailure(new Error("인증이 필요합니다. 로그인해주세요."));
  assert.equal(login.ok, false);
  assert.equal(login.needsLogin, true);
  const forbidden = rules.staffAccessFailure(new Error("Staff permission is required."));
  assert.equal(forbidden.needsLogin, undefined);
  assert.match(forbidden.message, /[가-힣]/); // 영어 원문을 그대로 띄우지 않는다
  assert.equal(rules.staffAccessFailure(new Error("담당 수업에만 접근할 수 있습니다.")).message, "담당 수업에만 접근할 수 있습니다.");
  assert.equal(rules.staffAccessFailure(new Error("DB 연결 오류")), null); // 권한 문제가 아니면 원래대로 던진다
  assert.equal(rules.staffReloginHref("/staff/sessions/s1?view=attendance"), "/staff/login?redirect=%2Fstaff%2Fsessions%2Fs1%3Fview%3Dattendance");
  assert.equal(rules.staffReloginHref("/admin"), "/staff/login?redirect=%2Fstaff");
});

test("b4 코치 미연결은 선생님만 해당(원장·부원장 제외)", () => {
  assert.equal(rules.needsCoachLink({ canAccessAllClasses: false, coachId: null }), true);
  assert.equal(rules.needsCoachLink({ canAccessAllClasses: false, coachId: "c1" }), false);
  assert.equal(rules.needsCoachLink({ canAccessAllClasses: true, coachId: null }), false);
});

test("b7 아이폰 스토어 앱일 때만 기사님 안내 화면에 머문다", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
  const android = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
  assert.equal(rules.shouldShowIosDriverNotice(true, iphone), true);
  assert.equal(rules.shouldShowIosDriverNotice(false, iphone), false); // 아이폰 사파리·설치 앱은 운행 화면으로
  assert.equal(rules.shouldShowIosDriverNotice(true, android), false); // 안드로이드 스토어 앱은 막히지 않는다
  assert.equal(rules.shouldShowIosDriverNotice(true, null), false);
  assert.equal(rules.DRIVER_ENTRY_PATH, "/staff/driver");
  assert.equal(rules.DRIVER_RUN_PATH, "/staff/run");
});

// ── 화면·API 연결 확인 — 규칙을 실제로 «쓰는지» 못박는다(빠져도 tsc·빌드가 통과해 신호가 없다) ──
const home = readFileSync("src/app/staff/StaffHomeClient.tsx", "utf8");
const homePage = readFileSync("src/app/staff/page.tsx", "utf8");
const photos = readFileSync("src/app/api/staff/sessions/[sessionId]/photos/route.ts", "utf8");
const photoItem = readFileSync("src/app/api/staff/sessions/[sessionId]/photos/[photoId]/route.ts", "utf8");
const driverEntry = readFileSync("src/app/staff/driver/DriverEntryClient.tsx", "utf8");
const driverEntryPage = readFileSync("src/app/staff/driver/page.tsx", "utf8");
const driverClient = readFileSync("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");
const errorPage = readFileSync("src/app/staff/error.tsx", "utf8");
const nav = readFileSync("src/app/staff/StaffBottomNav.tsx", "utf8");

test("b2 홈·기사님 화면은 화면 복귀 때 날짜가 바뀌었으면 새로 불러온다", () => {
  assert.match(home, /addEventListener\("visibilitychange", refreshIfStale\)/);
  assert.match(home, /isStaleDateKey\((?:dateKey|todayKey)\)\) router\.refresh\(\)/);
  // 새로 불러오면 수업 목록 상태도 새 날짜로 다시 만든다
  assert.match(homePage, /<StaffHomeClient key=\{`\$\{todayKey\}:\$\{dateKey\}`\}/);
  assert.match(driverClient, /if \(todayKst\(\) !== today\) router\.refresh\(\)/);
  // 운행 중(위치 전송)·순서 편집 중에는 새로 불러오지 않는다
  assert.match(driverClient, /runState === "running" \|\| editing\) return;/);
});

test("b4 코치 미연결은 «오늘 수업 없음»과 다른 안내", () => {
  assert.match(homePage, /coachLinkMissing=\{needsCoachLink\(access\)\}/);
  assert.match(home, /코치 연결이 필요합니다 — 원장님께 문의해 주세요\./);
});

test("b6 진행 중 수업으로 이동하기 전에 안내를 보인다", () => {
  assert.match(home, /askConfirm\(`\$\{result\.message\}\\n\\n그 수업 화면으로 이동할까요\?`\)/);
});

test("G11 특강 미리 작성은 회차를 보내고, 사진 권한은 수업 시작·출석과 같은 함수", () => {
  // 2026-11-15 선생님 수업 화면 한 화면 구조: «미리 작성» 창이 수업 줄 안의 통합 글칸으로 옮겨졌다 — 회차를 함께 보내는 약속은 그대로.
  assert.match(home, /savePlannedClassContent\(\{[\s\S]{0,160}lesson\.sessionDateId \? \{ sessionDateId: lesson\.sessionDateId \}/);
  assert.doesNotMatch(photos, /requireStaffClassAccess/);
  assert.equal((photos.match(/requireStaffSessionAccess\(sessionId\)/g) ?? []).length, 2);
  assert.match(photoItem, /requireManageablePhoto[\s\S]*?await requireStaffSessionAccess\(sessionId\)/);
  const actions = readFileSync("src/app/actions/staff-sessions.ts", "utf8");
  assert.match(actions, /async function requireSessionAccess\(sessionId: string\) \{\s*return requireStaffSessionAccess\(sessionId\);/);
});

test("b7 기사님 첫 화면 — 아이폰 스토어 앱이면 안내, 아니면 위치 전송 운행 화면으로", () => {
  assert.match(driverEntryPage, /if \(shuttleScope\(staff\.roles\) === "NONE"\) redirect\("\/staff"\)/);
  assert.match(driverEntry, /shouldShowIosDriverNotice\(isStoreApp\(\), navigator\.userAgent\)/);
  // 2026-11-16: 안드로이드 스토어 앱은 위치 공유가 켜지는 앱 길(페이지 통째 이동), 그 밖은 기존 운행표
  assert.match(driverEntry, /driverRunPathFor\(isStoreApp\(\), navigator\.userAgent\)/);
  assert.match(driverEntry, /if \(target === DRIVER_APP_RUN_PATH\) window\.location\.replace\(target\);\s*else router\.replace\(target\);/);
  assert.match(driverEntry, /아이폰 앱의 운행 기능은 다음 업데이트에 열립니다/);
  assert.match(driverEntry, /문자로 받은 운행 링크를 이용해 주세요/);
  // 하단 셔틀 탭도 아이폰 스토어 앱이면 안내 화면으로
  assert.match(nav, /setShuttleHref\(DRIVER_ENTRY_PATH\)/);
});

test("b5 오류 화면은 로그인·권한·연결을 구분한다", () => {
  assert.match(errorPage, /classifyStaffFailure\(error\?\.message\)/);
  assert.match(errorPage, /kind === "login" \?[\s\S]*?다시 로그인/);
  assert.match(errorPage, /로그인이 풀렸습니다/);
  assert.match(errorPage, /인터넷 연결이 끊겼습니다/);
});

// ── 날짜 이동(2026-11-16 원장 지시) — 다가올 수업을 미리 보고 수업 내용을 미리 쓴다 ──

test("날짜 이동: 오늘~14일 뒤만 미리 볼 수 있고, 그 밖의 주소 값은 오늘로 돌아간다(월말·연말 경계)", () => {
  const today = "2026-12-25";
  assert.equal(rules.canPlanOnDate("2026-12-25", today), true);
  assert.equal(rules.canPlanOnDate("2027-01-08", today), true); // 딱 14일 뒤(해를 넘김)
  assert.equal(rules.canPlanOnDate("2027-01-09", today), false);
  assert.equal(rules.canPlanOnDate("2026-12-24", today), false); // 지난 날짜는 «지난 수업»에서
  assert.equal(rules.canPlanOnDate("2026-13-01", today), false);

  assert.equal(rules.resolveStaffViewDate("2026-12-31", today), "2026-12-31");
  assert.equal(rules.resolveStaffViewDate(["2026-12-31", "2027-01-01"], today), "2026-12-31");
  for (const bad of [undefined, "", "내일", "2026-12-24", "2027-02-01", "2026-12-31T00:00", 20261231]) {
    assert.equal(rules.resolveStaffViewDate(bad, today), today);
  }

  const dates = rules.staffPreviewDates(today);
  assert.equal(dates.length, 15);
  assert.equal(dates[0], today);
  assert.equal(dates[7], "2027-01-01");
  assert.equal(dates[14], "2027-01-08");
});

test("날짜 이동: 반 요일 키는 그 날짜의 KST 요일이다(서버 시간대와 무관)", () => {
  assert.equal(rules.classDayKeyOf("2026-11-16"), "Mon");
  assert.equal(rules.classDayKeyOf("2026-11-21"), "Sat");
  assert.equal(rules.classDayKeyOf("2026-11-22"), "Sun");
  assert.equal(rules.classDayKeyOf("2028-02-29"), "Tue"); // 윤년
});

test("날짜 이동: 화면·서버가 같은 규칙을 쓴다 — 다른 날짜는 시작 버튼이 없고, 서버는 지난 날·먼 날·수업 없는 요일을 막는다", () => {
  const page = readFileSync("src/app/staff/page.tsx", "utf8");
  assert.match(page, /resolveStaffViewDate\(\(await searchParams\)\.date, todayKey\)/);
  assert.match(page, /getTodayStaffClasses\(dateKey\)/);

  const home = readFileSync("src/app/staff/StaffHomeClient.tsx", "utf8");
  assert.match(home, /const preview = dateKey !== todayKey;/);
  assert.match(home, /isStaleDateKey\(todayKey\)/);
  // 날짜를 옮기기 전에 쓰던 기록을 먼저 저장한다
  assert.match(home, /async function moveDate[\s\S]*?await prepareStaffNavigation\(\)[\s\S]*?router\.push\(target === todayKey \? "\/staff" : `\/staff\?date=\$\{target\}`\)/);
  assert.match(home, /if \(preview\) return;/);
  assert.match(home, /previewNotice: preview \?/);

  const panel = readFileSync("src/components/staff/LessonWorkspacePanels.tsx", "utf8");
  assert.match(panel, /\{previewNotice \? \(\s*<p role="note"/);
  // 쓰던 수업 내용은 옮기기 전에 저장하고, 실패하면 이동을 막는다
  assert.match(panel, /addEventListener\("staff:prepare-navigation", prepareToLeave\)/);
  assert.match(panel, /detail\.complete\(\{ ok: false, message: result\.message \|\|/);

  const actions = readFileSync("src/app/actions/staff-sessions.ts", "utf8");
  const save = actions.slice(actions.indexOf("export async function savePlannedClassContent"), actions.indexOf("export async function saveSessionMemo"));
  assert.match(save, /if \(input\.date < today\) return \{ ok: false as const, message: STALE_DATE_MESSAGE \};/);
  assert.match(save, /if \(!canPlanOnDate\(input\.date, today\)\) return \{ ok: false as const, message: PLAN_TOO_FAR_MESSAGE \};/);
  assert.match(save, /"dayOfWeek" = \$2 LIMIT 1`,\s*input\.classId, classDayKeyOf\(input\.date\)/);
  // 수업 시작은 여전히 오늘만
  const start = actions.slice(actions.indexOf("export async function startClassSession"));
  assert.match(start, /code: "STALE_DATE", message: STALE_DATE_MESSAGE/);
});

// ── 날짜 이동 후속(2026-11-16 원장 지시) — 명단 날짜 기준 · 휴무 표시 · 학원 일정 메뉴 ──

test("다가올 날짜의 명단은 그 날짜 기준으로 읽는다 — 기록이 있으면 기록 날짜가 정본, 범위 밖 날짜는 버린다", () => {
  const people = readFileSync("src/lib/staff-class-people.ts", "utf8");
  assert.match(people, /const planDate = !sessionId && viewDate && canPlanOnDate\(viewDate\) \? viewDate : null;/);
  assert.match(people, /substituteDate: planDate \?\? await regularSessionDateOrToday\(classId, sessionId\)/);
  // 세 곳 모두 «기록 날짜 → 보는 날짜 → 오늘» 순서
  assert.match(people, /WHERE se\.id=\$2\), \$3::date, \(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date\)/);
  assert.match(people, /prior\.date::date=COALESCE\(\$3::date, \(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date\)/);
  assert.match(people, /se\.date = COALESCE\(\$3::date, \(CURRENT_TIMESTAMP AT TIME ZONE 'Asia\/Seoul'\)::date\)/);
  assert.match(people, /sessionId \?\? null,\s*\/\/[^\n]*\n\s*planDate,\s*\);/);

  const action = readFileSync("src/app/actions/staff-class-people.ts", "utf8");
  assert.match(action, /getStaffClassPeople\(classId, sessionId, sessionDateId, date\)/);
  const hook = readFileSync("src/components/staff/RosterPersonInfo.tsx", "utf8");
  assert.match(hook, /loadStaffClassPeople\(\{ classId, sessionId, sessionDateId, date \}\)/);
  const panel = readFileSync("src/components/staff/LessonWorkspacePanels.tsx", "utf8");
  assert.match(panel, /sessionDateId: lesson\.sessionDateId, date: rosterDate, enabled: rosterWanted/);
  assert.match(readFileSync("src/app/staff/StaffHomeClient.tsx", "utf8"), /rosterDate: preview \? dateKey : undefined,/);
});

test("휴무 표시는 기사님 운행표와 같은 판정 함수를 쓰고, 연간일정을 못 읽어도 화면은 열린다", () => {
  const page = readFileSync("src/app/staff/page.tsx", "utf8");
  assert.match(page, /Promise\.race\(\[\s*loadRegularRunPlan\(\)\.catch\(\(\) => null\),\s*new Promise<null>\(\(resolve\) => setTimeout\(\(\) => resolve\(null\), 3000\)\),/);
  assert.match(page, /regularRunHoliday\(ymd, plan\.monthlyDates, plan\.events\)/);
  assert.match(page, /holidays=\{holidays\}/);
  const home = readFileSync("src/app/staff/StaffHomeClient.tsx", "utf8");
  // 색만이 아니라 글자로 — 날짜 칸의 «휴무», 화면의 안내 한 줄. 수업 줄은 막지 않는다
  assert.match(home, /\{holiday && <span[^>]*>휴무<\/span>\}/);
  assert.match(home, /\{holidays\[dateKey\] && \(\s*<p role="note"/);
});

test("일정: 아래 탭 «일정»에서 앱 안 화면(/staff/annual)으로 — 사이트 연간일정과 같은 자료·같은 부품", () => {
  const annual = readFileSync("src/app/staff/annual/page.tsx", "utf8");
  // 사이트(/annual)와 같은 자료 함수·같은 부품
  assert.match(annual, /await loadAnnualPageData\(\)/);
  assert.match(annual, /<PublicSiteTheme publicScope>\s*<AnnualEventsClient allEvents=\{allEvents\} classDays=\{classDays\} yearlySchedules=\{yearlySchedules\} \/>/);
  const site = readFileSync("src/app/annual/page.tsx", "utf8");
  assert.match(site, /const \{ phone, allEvents, classDays, yearlySchedules \} = await loadAnnualPageData\(\);/);
  // 선생님 앱은 밝은 화면 — 사이트의 어두운 모드 표시를 이 화면에서만 떼고, 떠나면 되돌린다
  assert.match(annual, /<ForceLightScope \/>/);
  const light = readFileSync("src/components/staff/ForceLightScope.tsx", "utf8");
  assert.match(light, /root\.classList\.remove\("dark"\)/);
  // 떠날 때 되돌리지 않는다(선생님 앱은 원래 밝은 화면 고정 — 되돌리면 다른 화면이 어두워진다)
  assert.doesNotMatch(light, /classList\.add\("dark"\)/);
  // 선생님 전용 판정(기사님 튕기기)을 넣지 않는다 — 기사님도 본다
  assert.doesNotMatch(annual, /DRIVER_ENTRY_PATH|roles\.teacher/);
  // 2026-11-16 원장 「청구는 필요 없어」: 이름 버튼 메뉴에서도 청구 링크를 뺐다. 그 자리는 «마이페이지».
  const menu = readFileSync("src/app/staff/StaffProfileMenu.tsx", "utf8");
  assert.doesNotMatch(menu, /href="\/staff\/billing"|canTeach/);
  assert.match(menu, /<Link href="\/staff\/mypage" onClick=\{\(event\) => requestPublicNavigation\(event, "\/staff\/mypage"\)\}[^>]*>\s*마이페이지\s*<\/Link>/);
  // 화면·서버 기능은 지우지 않았다 — 주소로는 계속 열린다
  assert.match(readFileSync("src/app/staff/billing/page.tsx", "utf8"), /export default/);
});
