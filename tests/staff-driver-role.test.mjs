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
  assert.match(authRoutesSource, /if \(role === "DRIVER"\) return "\/staff\/shuttle"/);
  assert.match(authRoutesSource, /target === "\/staff\/shuttle"/);
  // 선생님 화면이 없는 사람(기사님만)은 셔틀 화면으로. 「선생님 + 기사님」은 수업 화면에 머문다.
  assert.match(staffHomeSource, /if \(!staff\.roles\.teacher\) redirect\("\/staff\/shuttle"\)/);
  // 사진 빠른 업로드도 선생님 화면이 있는 사람만.
  assert.match(quickPostSource, /if \(!staff\.roles\.teacher\)/);
});

test("staff mobile navigation is role-aware", () => {
  // 하단 메뉴는 «수업 메뉴·셔틀 메뉴를 각각 쓸 수 있는가» 두 가지로 받는다.
  assert.match(staffLayoutSource, /StaffBottomNav canTeach=\{staff\.roles\.teacher\} canShuttle=\{canShuttle\}/);
  assert.match(staffLayoutSource, /StaffProfileMenu staffName=\{staff\.appUserName\} staffRole=\{staff\.appUserRole\}/);
  assert.match(staffNavSource, /\.\.\.\(canTeach \? \[\.\.\.teachingItems, seasonalItem\] : \[\]\)/);
  assert.match(staffNavSource, /\.\.\.\(canShuttle \? \[shuttleItem\] : \[\]\)/);
  assert.match(staffNavSource, /airport_shuttle/);
  // 기사님 전용 색은 «기사님만»인 사람에게.
  assert.match(staffLayoutSource, /const isDriverOnly = staff\.roles\.driver && !staff\.roles\.teacher/);
});

test("driver shuttle page does not open instructor-only staff screens", () => {
  // 관리자 또는 기사님(승인된 추가 역할 포함)만. 선생님만인 사람은 /staff 로 돌려보낸다.
  assert.match(staffShuttleSource, /const canUseShuttle = shuttleScope\(staff\.roles\) !== "NONE"/);
  assert.match(staffShuttleSource, /redirect\("\/staff"\)/);
  assert.match(staffShuttleSource, /const canManageShuttle = staff\.roles\.admin/);
  // API 도 같은 판정을 쓴다 — 화면만 막고 API 가 열려 있으면 소용없다.
  assert.match(shuttleApiSource, /if \(shuttleScope\(staff\.roles\) === "NONE"\)/);
  // 예전 방식(역할 하나 비교)이 남아 있으면 「선생님 + 기사님」이 다시 막힌다.
  for (const source of [staffHomeSource, staffShuttleSource, shuttleApiSource, quickPostSource, staffLayoutSource]) {
    assert.doesNotMatch(source, /appUserRole (===|!==) "(DRIVER|INSTRUCTOR)"/);
  }
});
