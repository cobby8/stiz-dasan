import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-17 뒤로 가기 전수 조사 — «같은 화면의 보기 설정»(날짜·모드·조회 조건)은 기록에 쌓지 않는다(replace).
// 쌓으면 바꾼 수만큼 뒤로를 눌러야 앞 화면으로 간다. 그리고 날짜를 옮겨도 운행 모드(mode=drive)가 풀리면 안 된다.

const { driverDateHref } = await loadTsModule("src/lib/shuttle/driverDateHref.ts");
const read = (file) => fs.readFileSync(file, "utf8");

test("날짜 주소: date 만 바꾸고 주소의 다른 값은 그대로 둔다", () => {
  assert.equal(driverDateHref("", "2026-11-18"), "?date=2026-11-18");
  assert.equal(driverDateHref(null, "2026-11-18"), "?date=2026-11-18");
  assert.equal(driverDateHref(undefined, "2026-11-18"), "?date=2026-11-18");
  // 선생님 운행 중 날짜를 넘겨도 운행 모드가 남는다(예전엔 보기로 돌아갔다)
  assert.equal(driverDateHref("mode=drive", "2026-11-18"), "?mode=drive&date=2026-11-18");
  assert.equal(driverDateHref("?mode=drive&date=2026-11-17", "2026-11-18"), "?mode=drive&date=2026-11-18");
  // 이미 있던 date 는 한 번만(겹쳐 쌓이지 않는다), 순서 유지
  assert.equal(driverDateHref("date=2026-11-17&mode=drive", "2026-12-31"), "?date=2026-12-31&mode=drive");
  assert.equal(driverDateHref("date=2026-11-17&date=2026-11-16", "2027-01-01"), "?date=2027-01-01");
});

test("날짜 주소: 알림 전용 값 focus 는 다른 날짜로 끌고 가지 않는다", () => {
  assert.equal(driverDateHref("date=2026-11-14&focus=BOARD", "2026-11-15"), "?date=2026-11-15");
  assert.equal(driverDateHref("mode=drive&focus=ALIGHT", "2026-11-15"), "?mode=drive&date=2026-11-15");
});

test("날짜 주소: 값은 주소에 안전하게 실린다", () => {
  const href = driverDateHref("mode=a b&x=1%262", "2026-11-18");
  const parsed = new URLSearchParams(href.slice(1));
  assert.equal(parsed.get("mode"), "a b");
  assert.equal(parsed.get("x"), "1&2");
  assert.equal(parsed.get("date"), "2026-11-18");
});

test("운행 화면 날짜 이동은 기록에 쌓지 않는 링크이고, 주소 조립은 순수 함수 하나로 한다", () => {
  const nav = read("src/components/shuttle/DriverDateNav.tsx");
  const links = [...nav.matchAll(/<Link\s+href=\{([^}]+)\}\s+(replace\s+)?className/g)];
  assert.equal(links.length, 3, "이전·오늘로·다음 세 링크");
  for (const link of links) {
    assert.match(link[1], /^hrefFor\((prevDate|today|nextDate)\)$/);
    assert.ok(link[2], `${link[1]} 링크에 replace 가 없다`);
  }
  assert.doesNotMatch(nav, /href=\{`\?date=/, "date 만 쓰는 옛 링크가 남았다(다른 쿼리를 지운다)");
  assert.match(nav, /const hrefFor = \(target: string\) => driverDateHref\(search, target\);/);
  // 날짜 부품을 쓰는 곳은 운행 화면 부품 하나 — props 는 그대로다
  assert.match(read("src/components/shuttle/UnifiedDriverClient.tsx"), /<DriverDateNav date=\{date\} prevDate=\{prevDate\} nextDate=\{nextDate\} today=\{today\} \/>/);
});

test("셔틀 화면: 보기 ↔ 선생님 운행 전환은 replace, 다른 화면으로 가는 링크는 그대로 쌓는다", () => {
  const page = read("src/app/staff/shuttle/page.tsx");
  assert.match(page, /<Link href=\{`\/staff\/shuttle\?mode=drive\$\{dateQuery \? `&\$\{dateQuery\}` : ""\}`\} replace className=/);
  assert.match(page, /<Link href=\{`\/staff\/shuttle\$\{dateQuery \? `\?\$\{dateQuery\}` : ""\}`\} replace className="[^"]*">보기로 돌아가기<\/Link>/);
  // 별도 확정 노선(편집 화면)·정규 운행표·검토·배정·운행 시작은 «다른 화면»이라 뒤로로 돌아올 수 있어야 한다
  for (const href of ['"?view=routes"', '"/staff/shuttle"', '"/staff/shuttle/intake"', '"/staff/shuttle/assign"', '"/staff/driver"']) {
    assert.ok(page.includes(`<Link href=${href} className=`), `${href} 링크는 replace 없이 그대로여야 한다`);
  }
});

test("선생님 홈 날짜·청구 조회 달은 replace, 사진 올리기 «이전»은 공개 홈으로 나가지 않는다", () => {
  const home = read("src/app/staff/StaffHomeClient.tsx");
  assert.match(home, /startDateMove\(\(\) => router\.replace\(target === todayKey \? "\/staff" : `\/staff\?date=\$\{target\}`\)\);/);
  assert.doesNotMatch(home, /router\.push\(target === todayKey/);

  const billing = read("src/app/staff/billing/StaffBillingClient.tsx");
  assert.match(billing, /if \(draftMonth !== month\) router\.replace\(draftMonth === currentMonth \? "\/staff\/billing" : `\/staff\/billing\?month=\$\{draftMonth\}`\);/);
  assert.doesNotMatch(billing, /router\.push\(/);

  const quickPost = read("src/app/staff/quick-post/QuickPostClient.tsx");
  assert.match(quickPost, /function goBack\(\) \{[\s\S]*?window\.location\.href = "\/staff";\s*\}/);
  assert.doesNotMatch(quickPost, /window\.location\.href = "\/";/);
});

test("수업 종료 뒤 도착지는 시작 취소와 같다(특강에서 시작했으면 특강 화면)", () => {
  const session = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
  const moves = [...session.matchAll(/router\.replace\(session\.sessionDateId \? "\/staff\/seasonal" : "\/staff"\);/g)];
  assert.equal(moves.length, 2, "시작 취소·수업 종료 두 곳");
  assert.doesNotMatch(session, /router\.replace\("\/staff"\);/);
});
