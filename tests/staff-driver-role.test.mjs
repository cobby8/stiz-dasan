import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 2026-10-25 다중 역할로 문지기를 «역할 하나(appUserRole)»에서 «열린 화면 묶음(staff.roles)»으로 옮겼다.
// 역할 하나로는 「선생님 + 기사님」을 표현할 수 없다 — 선생님이라 셔틀이 막히거나, 기사님이라
// 수업 화면이 막히거나. 아래 단정은 예전 의도(기사님은 셔틀 화면으로, 선생님 전용 화면은 막음)를
// 그대로 지키되, 새 판정을 쓰는지 본다. 판정 자체는 tests/user-role-grants.test.mjs 가 실행으로 확인한다.

const authRoutesSource = await readFile("src/lib/auth-routes.ts", "utf8");
const staffLayoutSource = await readFile("src/app/staff/layout.tsx", "utf8");
const staffHomeSource = await readFile("src/app/staff/page.tsx", "utf8");
const staffNavSource = await readFile("src/app/staff/StaffBottomNav.tsx", "utf8");
const staffShuttleSource = await readFile("src/app/staff/shuttle/page.tsx", "utf8");
const shuttleApiSource = await readFile("src/app/api/staff/shuttle/route.ts", "utf8");
const quickPostSource = await readFile("src/app/staff/quick-post/page.tsx", "utf8");
const schemaSource = await readFile("prisma/schema.prisma", "utf8");

test("DRIVER role lands on the shuttle mobile workspace", () => {
  assert.match(schemaSource, /enum Role \{[\s\S]*?DRIVER[\s\S]*?\}/);
  // 2026-11-13 b7: 기사님 첫 화면은 /staff/driver — 위치 전송이 되는 운행 화면으로 넘기거나 아이폰 스토어 앱이면 안내.
  assert.match(authRoutesSource, /if \(role === "DRIVER"\) return "\/staff\/driver"/);
  assert.match(authRoutesSource, /target === "\/staff\/shuttle"/);
  assert.match(authRoutesSource, /target === "\/staff\/driver"/);
  // 선생님 화면이 없는 사람(기사님만)은 기사님 첫 화면으로. 「선생님 + 기사님」은 수업 화면에 머문다.
  assert.match(staffHomeSource, /if \(!staff\.roles\.teacher\) redirect\(DRIVER_ENTRY_PATH\)/);
  // 사진 빠른 업로드도 선생님 화면이 있는 사람만.
  assert.match(quickPostSource, /if \(!staff\.roles\.teacher\)/);
});

test("staff mobile navigation is role-aware", () => {
  // 하단 메뉴는 «수업 메뉴·셔틀 메뉴를 각각 쓸 수 있는가» 두 가지로 받는다.
  assert.match(staffLayoutSource, /StaffBottomNav canTeach=\{staff\.roles\.teacher\} canShuttle=\{canShuttle\}/);
  assert.match(staffLayoutSource, /StaffProfileMenu staffName=\{staff\.appUserName\} staffRole=\{staff\.appUserRole\}/);
  // 2026-11-16: «청구» 탭 자리에 «일정»(선생님·기사님 공통). 청구는 이름 버튼 메뉴로 옮겼다
  assert.match(staffNavSource, /\.\.\.\(canTeach \? teachingItems : \[\]\),\s*annualItem,\s*\.\.\.\(canTeach \? \[seasonalItem\] : \[\]\),/);
  assert.match(staffNavSource, /const annualItem = \{ href: "\/staff\/annual", label: "일정", exact: false \} as const;/);
  assert.doesNotMatch(staffNavSource, /label: "청구"/);
  assert.match(staffNavSource, /\.\.\.\(canShuttle \? \[shuttleItem\] : \[\]\)/);
  // 2026-11-13 UI 통일: 아래 메뉴는 아이콘 없이 글자만 — 셔틀 탭은 «셔틀» 글자로 확인한다
  assert.match(staffNavSource, /label: "셔틀"/);
  assert.doesNotMatch(staffNavSource, /material-symbols-outlined/);
  assert.match(staffNavSource, /aria-current=\{active \? "page" : undefined\}/);
  // 기사님 전용 색은 «기사님만»인 사람에게.
  assert.match(staffLayoutSource, /const isDriverOnly = staff\.roles\.driver && !staff\.roles\.teacher/);
});

test("driver shuttle page does not open instructor-only staff screens", () => {
  // 2026-11-16 원장 지시: 셔틀 탭은 일반 선생님에게도 연다(보기 + 선생님 운행). 직원이 아니면 /staff 로 돌려보낸다.
  // 기사님·관리자 전용 화면(운행·배정·검토)이 여전히 막혀 있는지는 아래 «일반 선생님 셔틀 탭» 테스트가 확인한다.
  assert.match(staffShuttleSource, /if \(!canOpen\) redirect/);
  assert.match(staffShuttleSource, /redirect\("\/staff"\)/);
  assert.match(staffShuttleSource, /canManageShuttle=\{staff\.roles\.admin\}/);
  assert.match(staffShuttleSource, /await authorizeAssign\(staff\)/);
  // API 도 같은 판정을 쓴다 — 화면만 막고 API 가 열려 있으면 소용없다.
  assert.match(shuttleApiSource, /if \(shuttleScope\(staff\.roles\) === "NONE"\)/);
  // 예전 방식(역할 하나 비교)이 남아 있으면 「선생님 + 기사님」이 다시 막힌다.
  for (const source of [staffHomeSource, staffShuttleSource, shuttleApiSource, quickPostSource, staffLayoutSource]) {
    assert.doesNotMatch(source, /appUserRole (===|!==) "(DRIVER|INSTRUCTOR)"/);
  }
});

test("셔틀 API는 로그인·직원 확인 실패를 401로 돌려준다(서버 오류 500과 섞지 않는다)", () => {
  // 2026-10-25: 비로그인 요청이 500(「불러오지 못했습니다」)으로 떨어져 진짜 장애와 구분이 안 됐다.
  for (const method of ["GET", "PATCH"]) {
    const start = shuttleApiSource.indexOf(`export async function ${method}`);
    const body = shuttleApiSource.slice(start, shuttleApiSource.indexOf("try {", start));
    assert.match(body, /const staff = await staffOrNull\(\);\s*if \(!staff\) return unauthorized\(\);/, `${method} 가 try 밖에서 문지기를 먼저 거쳐야 한다`);
  }
  assert.match(shuttleApiSource, /function unauthorized\(\) \{\s*return NextResponse\.json\([^)]*\{ status: 401 \}\)/);
});

// ── 2026-11-16 원장 지시: 선생님 화면 «셔틀» 탭은 보기 전용, 직접 운행할 때만 «선생님 운행» ──
test("선생님 화면 셔틀 탭: 기사님이 아니면 보기 전용(탑승 버튼 없음)·«선생님 운행»으로만 체크 모드, 배정·검토 링크는 기사님에게만", async () => {
  const page = staffShuttleSource;
  assert.match(page, /const isDriver = staff\.roles\.driver;\s*\/\/[^\n]*\n\s*const driveMode = isDriver \|\| \(params\.mode === "drive" && \(!teacherOnly \|\| date === today\)\);/);
  assert.match(page, /«선생님 운행»은 오늘 날짜에서만 할 수 있어요\./);
  assert.match(page, /readOnly=\{!driveMode\}/);
  assert.match(page, /href=\{`\/staff\/shuttle\?mode=drive\$\{dateQuery \? `&\$\{dateQuery\}` : ""\}`\}[^>]*>\s*선생님 운행\s*<\/Link>/);
  assert.match(page, /<StaffVehicleLocation \/>/);
  // 배정·검토·확정 노선 링크는 기사 역할이 있는 사람에게만(선생님 화면에서는 뺀다)
  assert.match(page, /\{isDriver && \(\s*<div[^>]*>\s*<Link href="\/staff\/shuttle\/intake"[^>]*>신규 셔틀 검토<\/Link>\s*<Link href="\/staff\/shuttle\/assign"[^>]*>새 학생 배정<\/Link>\s*<Link href="\?view=routes"[^>]*>별도 확정 노선<\/Link>/);
  assert.equal((page.match(/신규 셔틀 검토<\/Link>/g) ?? []).length, 1);
  // 보기 ↔ 운행을 오가면 화면 상태를 새로 만든다
  assert.match(page, /key=\{`\$\{date\}:\$\{driveMode \? "drive" : "view"\}`\}/);

  const client = await readFile("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");
  // 보기 전용: 버튼 대신 상태 글자, 되돌리기·그래도 탑승 없음, 서버 값 그대로 + 30초마다 새로 읽기
  assert.match(client, /\{readOnly \? \(\s*\/\/[^\n]*\n\s*<span\s+role="status"/);
  assert.match(client, /const showAnyway = !readOnly && locked && anyway\.canBoardAnyway;/);
  assert.match(client, /\{!readOnly && \(saveState \|\| stored \|\| view\.absentDefault \|\| locked\) &&/);
  // 학생 줄과 «체크 N/M» 요약이 같은 값을 본다 — 보기 전용은 서버 값 그대로
  assert.match(client, /const boarding = readOnly \? initialBoarding : boardingState;/);
  assert.match(client, /\{!readOnly && <details/);
  assert.match(client, /if \(!readOnly\) return;\s*const timer = window\.setInterval\(\(\) => \{ if \(document\.visibilityState === "visible"\) router\.refresh\(\); \}, 30_000\);/);
});

// ── 2026-11-16 원장 지시: 일반 선생님에게 셔틀 탭을 연다(보기 + 선생님 운행) ──
test("일반 선생님 셔틀 탭: 보기에는 연락처·건강 정보가 내려가지 않고, 기사님·관리자 전용 화면은 그대로 막힌다", async () => {
  const { loadTsModule } = await import("./_ts-module.mjs");
  const rules = await loadTsModule("src/lib/shuttle/teacherShuttleView.ts");
  const R = (over) => ({ admin: false, teacher: false, driver: false, parent: false, ...over });
  assert.deepEqual(rules.staffShuttleAccess(R({ teacher: true })), { canOpen: true, teacherOnly: true });
  assert.deepEqual(rules.staffShuttleAccess(R({ driver: true })), { canOpen: true, teacherOnly: false });
  assert.deepEqual(rules.staffShuttleAccess(R({ teacher: true, driver: true })), { canOpen: true, teacherOnly: false });
  assert.deepEqual(rules.staffShuttleAccess(R({ admin: true, teacher: true })), { canOpen: true, teacherOnly: false });
  assert.deepEqual(rules.staffShuttleAccess(R({ parent: true })), { canOpen: false, teacherOnly: false });
  // 보기용 자료에서 연락처·건강 특이사항을 지운다(원본은 건드리지 않는다)
  const rows = [{ key: "a", riders: [{ name: "가", parentPhone: "01011112222", studentPhone: "01033334444", healthNote: "천식", hasHealthNote: true }] }];
  const stripped = rules.stripRiderPrivate(rows);
  assert.deepEqual(stripped[0].riders[0], { name: "가", parentPhone: null, studentPhone: null, healthNote: null, hasHealthNote: false, shuttleNote: null });
  assert.equal(rows[0].riders[0].parentPhone, "01011112222");

  const page = staffShuttleSource;
  assert.match(page, /const \{ canOpen, teacherOnly \} = staffShuttleAccess\(staff\.roles\);\s*if \(!canOpen\) redirect\("\/staff"\);/);
  assert.match(page, /rows=\{teacherOnly && !driveMode \? stripRiderPrivate\(buildUnifiedRun\(\{ regular: classes \}\)\) : buildUnifiedRun\(\{ regular: classes \}\)\}/);
  assert.match(page, /if \(params\.view === "routes" && !teacherOnly\)/);
  // 2026-11-18: «운행 시작» 버튼은 표시(?start=1)를 달고 기사님 첫 화면으로 간다(DRIVER_START_HREF)
  assert.match(page, /\{!teacherOnly && \(\s*<Link href=\{DRIVER_START_HREF\}/);
  // 기사님 첫 화면·운행·배정·검토 화면은 여전히 관리자·기사님만
  for (const file of ["src/app/staff/driver/page.tsx", "src/app/staff/run/page.tsx", "src/app/staff/shuttle/intake/page.tsx", "src/app/staff/shuttle/assign/page.tsx"]) {
    assert.match(await readFile(file, "utf8"), /if \(shuttleScope\(staff\.roles\) === "NONE"\) redirect\("\/staff"\)/, file);
  }
  // 차량 위치: 직원용 주소는 운행 링크 값을 내려보내지 않는다
  const loc = await readFile("src/app/api/staff/driver-locations/route.ts", "utf8");
  assert.match(loc, /md5\(token\) AS token/);
  assert.doesNotMatch(loc, /SELECT\s+token,/);
  assert.match(loc, /if \(!staffShuttleAccess\(staff\.roles\)\.canOpen\)/);
  // 탑승 기록: 일반 선생님은 «선생님 운행»으로 체크한다(관리자·기사님은 기존 확인 그대로)
  const api = await readFile("src/app/api/staff/shuttle/regular-boarding/route.ts", "utf8");
  assert.match(api, /if \(staffShuttleAccess\(staff\.roles\)\.teacherOnly\) return \{ error: null, teacherOnly: true \};\s*try \{\s*\/\/[^\n]*\n\s*await authorizeAssign\(staff\);/);
  // 선생님은 오늘 날짜만 체크하고, 기록에 «선생님»으로 남는다. 요청 사이에 섞이는 모듈 변수는 쓰지 않는다
  assert.match(api, /if \(gate\.teacherOnly && date !== todayKst\(\)\) \{\s*return json\(\{ error: "선생님 운행은 오늘 날짜만 체크할 수 있습니다\." \}, 409\);/);
  assert.match(api, /via: gate\.teacherOnly \? "teacher" : "driver"/);
  assert.doesNotMatch(api, /^let /m);
});
