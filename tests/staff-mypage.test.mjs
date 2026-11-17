// 2026-11-16 원장 지시 — 「선생님 메뉴에도 내 계정이 아니라 마이페이지 만들고 필요한 기능 추가」(단 「청구는 필요 없어」).
// ① «이번 달» 범위 계산을 실제로 돌린다 — 월말·연말·윤년·자정 경계(KST 00:00 = UTC 전날 15:00).
//    배포 서버는 UTC 라 이 계산이 틀리면 매달 1일 새벽에 «지난달» 숫자가 나온다(눈으로는 못 찾는다).
// ② 메뉴·화면은 소스로 못박는다: 메뉴에 «마이페이지»가 있고 «청구»·«내 계정»이 없다,
//    화면은 requireStaff 아래이고 선생님 전용 칸은 roles.teacher 일 때만.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const rules = await loadTsModule("src/lib/staff/mypageRules.ts");

test("이번 달 범위: 1일부터 다음 달 1일 앞까지 — 월말·연말·윤년", () => {
  assert.deepEqual(rules.kstMonthRangeOf("2026-11-16"), {
    ym: "2026-11", startYmd: "2026-11-01", nextStartYmd: "2026-12-01", lastYmd: "2026-11-30", label: "11월",
  });
  // 월말 당일도 그 달
  assert.equal(rules.kstMonthRangeOf("2026-11-30").nextStartYmd, "2026-12-01");
  assert.equal(rules.kstMonthRangeOf("2026-10-31").lastYmd, "2026-10-31");
  // 연말: 12월 → 다음 해 1월
  assert.deepEqual(rules.kstMonthRangeOf("2026-12-31"), {
    ym: "2026-12", startYmd: "2026-12-01", nextStartYmd: "2027-01-01", lastYmd: "2026-12-31", label: "12월",
  });
  // 연초: 1월
  assert.equal(rules.kstMonthRangeOf("2027-01-01").startYmd, "2027-01-01");
  assert.equal(rules.kstMonthRangeOf("2027-01-01").label, "1월");
  // 윤년 2월은 29일까지, 평년은 28일까지
  assert.equal(rules.kstMonthRangeOf("2028-02-10").lastYmd, "2028-02-29");
  assert.equal(rules.kstMonthRangeOf("2028-02-29").nextStartYmd, "2028-03-01");
  assert.equal(rules.kstMonthRangeOf("2027-02-10").lastYmd, "2027-02-28");
  // 없는 날짜·형식이 틀린 값은 범위를 만들지 않는다
  for (const bad of ["2027-02-29", "2026-13-01", "2026-11", "", null, undefined]) {
    assert.equal(rules.kstMonthRangeOf(bad), null, String(bad));
  }
});

test("이번 달 범위: KST 자정에 달이 넘어간다(서버가 UTC 여도 같다)", () => {
  // 11/30 23:59:59 KST = 11/30 14:59:59 UTC → 아직 11월
  assert.equal(rules.kstMonthRangeAt(Date.parse("2026-11-30T14:59:59Z")).ym, "2026-11");
  // 12/1 00:00 KST = 11/30 15:00 UTC → 12월(UTC 날짜로 보면 아직 11월 30일이다)
  assert.equal(rules.kstMonthRangeAt(Date.parse("2026-11-30T15:00:00Z")).ym, "2026-12");
  // 12/1 08:59 KST = 11/30 23:59 UTC → 12월(예전 함정: UTC 로 자르면 11월이 나온다)
  assert.equal(rules.kstMonthRangeAt(Date.parse("2026-11-30T23:59:00Z")).startYmd, "2026-12-01");
  // 연말 자정: 1/1 00:00 KST = 12/31 15:00 UTC
  assert.equal(rules.kstMonthRangeAt(Date.parse("2026-12-31T14:59:59Z")).ym, "2026-12");
  assert.deepEqual(rules.kstMonthRangeAt(Date.parse("2026-12-31T15:00:00Z")), {
    ym: "2027-01", startYmd: "2027-01-01", nextStartYmd: "2027-02-01", lastYmd: "2027-01-31", label: "1월",
  });
  // 윤년 2월 말 자정: 3/1 00:00 KST = 2/29 15:00 UTC
  assert.equal(rules.kstMonthRangeAt(Date.parse("2028-02-29T14:59:59Z")).ym, "2028-02");
  assert.equal(rules.kstMonthRangeAt(Date.parse("2028-02-29T15:00:00Z")).ym, "2028-03");
});

test("역할 이름·담당 반 정렬·연락처·링크 조건", () => {
  assert.equal(rules.staffRoleLabel("ADMIN", { teacher: true, driver: false }), "원장");
  assert.equal(rules.staffRoleLabel("VICE_ADMIN", { teacher: true, driver: false }), "부원장");
  assert.equal(rules.staffRoleLabel("INSTRUCTOR", { teacher: true, driver: false }), "선생님");
  assert.equal(rules.staffRoleLabel("DRIVER", { teacher: false, driver: true }), "기사님");
  assert.equal(rules.staffRoleLabel("INSTRUCTOR", { teacher: true, driver: true }), "선생님 · 기사님");

  // 요일(월→일) · 시작 시간 · 반 이름 순. 모르는 요일은 맨 뒤, 원본 배열은 건드리지 않는다
  const rows = [
    { name: "나", dayOfWeek: "Sat", startTime: "10:00" },
    { name: "가", dayOfWeek: "Mon", startTime: "17:00" },
    { name: "다", dayOfWeek: "Mon", startTime: "16:00" },
    { name: "라", dayOfWeek: "", startTime: "09:00" },
    { name: "마", dayOfWeek: "Sun", startTime: "09:00" },
    { name: "가", dayOfWeek: "Sat", startTime: "10:00" },
  ];
  assert.deepEqual(rules.sortStaffClasses(rows).map((row) => `${row.dayOfWeek}${row.startTime}${row.name}`),
    ["Mon16:00다", "Mon17:00가", "Sat10:00가", "Sat10:00나", "Sun09:00마", "09:00라"]);
  assert.equal(rows[0].name, "나");
  assert.equal(rules.classDayLabel("Mon"), "월");
  assert.equal(rules.classDayLabel("Sun"), "일");
  // 모르는 값은 영어 원문을 화면에 내지 않는다
  assert.equal(rules.classDayLabel("Holiday"), "");

  assert.equal(rules.staffPhoneLabel("01012345678"), "010-1234-5678");
  assert.equal(rules.staffPhoneLabel("010-1234-5678"), "010-1234-5678");
  assert.equal(rules.staffPhoneLabel("0311234567"), "031-123-4567");
  assert.equal(rules.staffPhoneLabel(null), "");

  // «지난 수업 보기»는 안 쓴 수업이나 안 보낸 수업이 있을 때만
  assert.equal(rules.needsPastSessionsLink({ completed: 5, noFeed: 0, unpublished: 0 }), false);
  assert.equal(rules.needsPastSessionsLink({ completed: 5, noFeed: 1, unpublished: 0 }), true);
  assert.equal(rules.needsPastSessionsLink({ completed: 5, noFeed: 0, unpublished: 2 }), true);
});

test("순수 규칙 모듈은 DB·next 를 끌어오지 않는다", () => {
  const source = read("src/lib/staff/mypageRules.ts");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["@/lib/datetime/kst"]);
  assert.doesNotMatch(source, /\.toISOString\(\)|\.getDate\(\)|\.getMonth\(\)|\.getDay\(\)|\.getHours\(\)/);
});

test("메뉴: «마이페이지»가 있고 «청구»·«내 계정» 링크는 없다", () => {
  const menu = read("src/app/staff/StaffProfileMenu.tsx");
  // 수업 중 이동 확인(requestPublicNavigation) 흐름은 그대로
  assert.match(menu, /<Link href="\/staff\/mypage" onClick=\{\(event\) => requestPublicNavigation\(event, "\/staff\/mypage"\)\}[^>]*>\s*마이페이지\s*<\/Link>/);
  assert.doesNotMatch(menu, /href="\/staff\/billing"/);
  assert.doesNotMatch(menu, /href="\/account"/);
  assert.doesNotMatch(menu, />\s*(청구|내 계정)\s*</);
  // 청구 링크만을 위해 있던 prop 도 정리됐다(아래 탭의 canTeach 는 그대로)
  assert.doesNotMatch(menu, /canTeach/);
  const layout = read("src/app/staff/layout.tsx");
  assert.match(layout, /<StaffProfileMenu staffName=\{staff\.appUserName\} staffRole=\{staff\.appUserRole\} accountViews=\{views\} \/>/);
  assert.match(layout, /<StaffBottomNav canTeach=\{staff\.roles\.teacher\} canShuttle=\{canShuttle\} shuttleViewOnly=\{shuttleAccess\.teacherOnly\} \/>/);
  // 설치 안내·로그아웃·화면 바꾸기는 메뉴에 그대로 있다
  // 2026-11-17: 설치 안내는 스토어 앱 안내(/install) 하나로
  assert.match(menu, /!hideInstallGuide && <a href="\/install"/);
  assert.match(menu, /<form action=\{logoutStaff\}>/);
  assert.match(menu, /<AccountViewSwitcher views=\{accountViews\}/);
  // 청구 화면 자체는 지우지 않았다
  assert.match(read("src/app/staff/billing/page.tsx"), /export default/);
});

test("마이페이지: requireStaff 아래 · 선생님 전용 칸은 roles.teacher 일 때만 · 기사님도 들어온다", () => {
  const page = read("src/app/staff/mypage/page.tsx");
  assert.match(page, /export const dynamic = "force-dynamic";/);
  assert.match(page, /const staff = await requireStaff\(\);/);
  assert.match(page, /const isTeacher = staff\.roles\.teacher;/);
  // 기사님을 튕기지 않는다(지난 수업 화면과 다르다)
  assert.doesNotMatch(page, /DRIVER_ENTRY_PATH|redirect\(/);
  // 선생님 전용: 조회도, 칸도 isTeacher 일 때만
  assert.match(page, /isTeacher \? getStaffMyClasses\(\)\.catch\(\(\) => null\) : Promise\.resolve\(null\),/);
  assert.match(page, /isTeacher \? getStaffMonthSessionStats\(month\)\.catch\(\(\) => null\) : Promise\.resolve\(null\),/);
  assert.match(page, /\{isTeacher && \(\s*<Section id="staff-mypage-classes" title="내 담당 반"/);
  assert.match(page, /\{isTeacher && \(\s*<Section\s+id="staff-mypage-month"/);
  assert.equal((page.match(/getStaffMyClasses\(|getStaffMonthSessionStats\(/g) || []).length, 2);
  // 화면 틀·제목은 다른 선생님 화면과 같다
  assert.match(page, /<main className="mx-auto max-w-lg space-y-4 px-4 pb-8 pt-5">\s*<h1 className="academy-heading">마이페이지<\/h1>/);
  assert.match(page, /담당으로 연결된 반이 없습니다/);
  // «이번 달»은 공용 KST 규칙으로만
  assert.match(page, /const month = kstMonthRangeAt\(\);/);
  assert.doesNotMatch(page, /new Date\(|\.toISOString\(\)/);
  // 안 쓴·안 보낸 수업이 있을 때만 지난 수업 링크
  assert.match(page, /\{needsPastSessionsLink\(stats\) && \(\s*<Link href="\/staff\/sessions"/);
  // 기존 부품을 그대로 끼운다: 알림 종·앱 버전 줄·로그아웃·계정 화면
  assert.match(page, /<StaffPushToggle \/>/);
  assert.match(page, /appVersionLabels\(\{ userAgent: headerStore\.get\("user-agent"\), build: process\.env\.VERCEL_GIT_COMMIT_SHA \}\)/);
  assert.match(page, /<AppVersionRow appLabel=\{version\.app\} \/>/);
  assert.match(page, /<form action=\{logoutStaff\}/);
  assert.match(page, /<Link href="\/account"/);
  // 캘린더 연동은 자리만(총괄이 연결) · 청구는 넣지 않는다
  assert.match(page, /<Section id="staff-mypage-calendar" title="캘린더 연동">[\s\S]{0,700}<CalendarSyncButton theme="academy" \/>/);
  // 청구는 마이페이지에 넣지 않는다(원장 「청구는 필요 없어」)
  assert.doesNotMatch(page, /staff\/billing/);
  // 설치 안내 줄 = 메뉴와 같은 조건
  const install = read("src/app/staff/mypage/StaffInstallGuideRow.tsx");
  assert.match(install, /const hideInstallGuide = useStoreAppLacks\("install"\);\s*if \(hideInstallGuide\) return null;/);
  assert.match(install, /<a href="\/install"/);
  assert.doesNotMatch(install, /\/staff\/install/);
});

test("마이페이지 화면: 색은 토큰만 · 굵기 네 단계 · 아이콘 없음", () => {
  for (const file of ["src/app/staff/mypage/page.tsx", "src/app/staff/mypage/StaffInstallGuideRow.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|\b(bg|text|border)-(white|black|gray|slate|zinc|neutral|red|blue|green|yellow|orange)(-\d+)?\b/, `${file}: 직접 쓴 색`);
    assert.doesNotMatch(source, /font-(black|extrabold)|font-\[[89]00\]/, `${file}: 굵기`);
    assert.doesNotMatch(source, /material-symbols|<UiIcon|lucide/, `${file}: 아이콘`);
    assert.doesNotMatch(source, /text-\[(?:[0-9]|1[01])px\]/, `${file}: 12px 미만 글자`);
  }
  // 흑백만인 화면이 아니다 — 누르는 주 링크에 브랜드 주 색
  assert.match(read("src/app/staff/mypage/page.tsx"), /text-\[var\(--color-academy-primary\)\]/);
});

test("조회: 담당 반은 «본인이 코치로 연결된 반» · 이번 달 숫자는 지난 수업과 같은 판정 조각", () => {
  const data = read("src/lib/staff-mypage.ts");
  // 원장·부원장도 전체가 아니라 본인 코치 연결 기준으로 좁힌다
  assert.match(data, /if \(!access\.canAccessAllClasses\) return access;/);
  assert.match(data, /SELECT id AS "coachId" FROM "Coach" WHERE "userId" = \$1 LIMIT 1/);
  assert.match(data, /return \{ staff: access\.staff, coachId: rows\[0\]\?\.coachId \?\? null, canAccessAllClasses: false \};/);
  assert.match(data, /const classIds = await getAccessibleClassIds\(await ownClassAccess\(\)\);/);
  // 본인 행만 — id 는 로그인 정보에서
  assert.match(data, /WHERE u\.id = \$1\s+LIMIT 1`,\s+staff\.appUserId,/);
  assert.doesNotMatch(data, /findMany|findFirst|findUnique|\$\{classIds|\$\{staff\./);

  const query = read("src/lib/staff-past-sessions.ts");
  // 목록과 숫자가 같은 식을 쓴다(피드 유무·보냄·볼 수 있는 범위) — 식은 파일에 한 번씩만 적혀 있다
  for (const piece of ["${SESSION_HAS_FEED_SQL}", "${SESSION_PUBLISHED_SQL}", "${pastSessionScopeSql()}"]) {
    assert.ok(query.split(piece).length - 1 >= 2, `${piece} 를 목록과 숫자가 함께 써야 한다`);
  }
  assert.equal(query.split(`FROM "SessionVideo" v`).length - 1, 1);
  assert.equal(query.split(`$1::boolean = true`).length - 1, 1);
  // 이번 달: 완료한 수업 · 수업일(KST, 두 번 변환)이 이번 달 1일 이상 다음 달 1일 미만 · 오늘까지
  assert.match(query, /COUNT\(\*\) FILTER \(WHERE NOT \$\{SESSION_HAS_FEED_SQL\}\)::int AS "noFeed",\s+COUNT\(\*\) FILTER \(WHERE NOT \$\{SESSION_PUBLISHED_SQL\}\)::int AS unpublished/);
  assert.match(query, /AND \$\{day\} >= \$5::date AND \$\{day\} < \$6::date AND \$\{day\} <= \$\{TODAY_KST_SQL\}\s+AND \$\{pastSessionScopeSql\(\)\}/);
  assert.match(query, /access\.coachId,\s+range\.startYmd,\s+range\.nextStartYmd,/);
});

test("사용 설명: «청구(메뉴 안)» 줄이 없고 «내 계정» 대신 «마이페이지»", () => {
  const guide = read("src/app/teacher-guide/page.tsx");
  assert.doesNotMatch(guide, /청구\(메뉴 안\)|내 계정/);
  assert.match(guide, /화면 바꾸기\(학부모 화면 등\)·마이페이지·로그아웃을 해요/);
  assert.match(guide, /"마이페이지: 내 정보, 내 담당 반, 이번 달 수업 숫자/);
});
