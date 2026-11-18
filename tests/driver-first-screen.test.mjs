// 기사님 첫 화면 = 셔틀 명단(2026-11-18 원장 결정 F) · 운행 링크가 없을 때의 안내(결정 G).
//  F: 로그인 직후처럼 «그냥» 들어온 기사님 첫 화면(/staff/driver)은 운행 화면이 아니라 셔틀 명단(/staff/shuttle)으로 넘긴다.
//     운행 화면에는 아래 메뉴·이름 메뉴가 없다. 명단의 «운행 시작»(?start=1)을 눌러 온 경우에만 운행 화면으로 간다.
//  G: 스토어 앱에서 «운행 시작»을 눌렀는데 오늘 운행 링크가 없으면 명단으로 돌아오며 한 줄 안내를 보인다.
//  규칙은 실제로 실행하고, 화면 연결은 소스 문자열로 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/staff-session-rules.ts");
const hist = await loadTsModule("src/lib/navigation/inAppHistory.ts");
const { resolveBackAction } = await loadTsModule("src/lib/navigation/backAction.ts");
const read = (p) => readFileSync(p, "utf8");

const android = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";

test("F — 기사님 첫 화면이 넘길 주소: «운행 시작»을 눌러 왔을 때만 운행 화면, 그 밖은 셔틀 명단", () => {
  // 로그인 직후·앱을 다시 엶·/staff 에서 넘겨짐 → 명단(기기와 상관없이)
  for (const [storeApp, ua] of [[true, android], [false, android], [false, iphone], [false, null]]) {
    assert.equal(rules.driverEntryTarget(false, storeApp, ua), "/staff/shuttle");
  }
  // «운행 시작» → 예전과 같은 길(안드로이드 스토어 앱은 위치 공유가 켜지는 앱 길, 그 밖은 운행표)
  assert.equal(rules.driverEntryTarget(true, true, android), "/staff/run/open");
  assert.equal(rules.driverEntryTarget(true, false, android), "/staff/run");
  assert.equal(rules.driverEntryTarget(true, false, iphone), "/staff/run");
  assert.equal(rules.driverEntryTarget(true, true, android), rules.driverRunPathFor(true, android));
  // 버튼이 다는 표시
  assert.equal(rules.DRIVER_START_PARAM, "start");
  assert.equal(rules.DRIVER_START_HREF, "/staff/driver?start=1");
  // 로그인 뒤 도착지·푸시·바로가기가 가리키는 주소는 그대로다(표시 없는 /staff/driver)
  assert.equal(rules.DRIVER_ENTRY_PATH, "/staff/driver");
  assert.equal(rules.DRIVER_SHUTTLE_PATH, "/staff/shuttle");
});

test("F — 화면 연결: 서버가 ?start=1 만 받아 넘기고, 화면은 규칙 모듈의 판단대로 넘긴다", () => {
  const page = read("src/app/staff/driver/page.tsx");
  assert.match(page, /const pressedStart = \(await searchParams\)\?\.\[DRIVER_START_PARAM\] === "1";/);
  // 진행 중인 운행이 있을 때만 예전처럼 운행 화면으로(눌러 온 경우엔 조회하지 않는다)
  assert.match(page, /const startRun = pressedStart \|\| \(await hasDriverRunInProgress\(\)\);/);
  assert.match(page, /<DriverEntryClient canTeach=\{staff\.roles\.teacher\} startRun=\{startRun\} \/>/);
  // 권한 확인이 먼저다(예전 그대로)
  assert.ok(page.indexOf('if (shuttleScope(staff.roles) === "NONE") redirect("/staff")') < page.indexOf("const pressedStart"));
  const entry = read("src/app/staff/driver/DriverEntryClient.tsx");
  assert.match(entry, /export default function DriverEntryClient\(\{ canTeach, startRun = false \}/);
  assert.match(entry, /const target = driverEntryTarget\(startRun, isStoreApp\(\), navigator\.userAgent\);/);
  // 아이폰 스토어 앱 안내가 먼저다(앱이 셔틀·운행 화면을 막는다 — 명단으로 넘기면 멈춘다)
  assert.ok(entry.indexOf("shouldShowIosDriverNotice(isStoreApp(), navigator.userAgent)") < entry.indexOf("driverEntryTarget(startRun"));
  // 넘기는 방식은 그대로(바꿔 끼우기 — 뒤로로 이 중간 화면에 머물지 않는다)
  assert.match(entry, /if \(target === DRIVER_APP_RUN_PATH\) window\.location\.replace\(target\);\s*else router\.replace\(target\);/);

  // 명단의 «운행 시작» 주 버튼이 표시를 달고 간다(글자만·주 버튼·48px)
  const shuttle = read("src/app/staff/shuttle/page.tsx");
  assert.match(shuttle, /<Link href=\{DRIVER_START_HREF\} className="academy-button-primary min-h-12! w-full text-base!">\s*운행 시작 \(위치 전송\)\s*<\/Link>/);
  assert.doesNotMatch(shuttle, /href="\/staff\/driver"/, "표시 없는 링크가 남으면 «운행 시작»이 명단으로 되돌아온다");
  // 첫 화면으로 보내는 다른 곳(로그인 뒤 도착지·/staff·수업 목록)은 표시 없이 보낸다 → 명단
  assert.match(read("src/app/staff/page.tsx"), /if \(!staff\.roles\.teacher\) redirect\(DRIVER_ENTRY_PATH\)/);
  assert.match(read("src/lib/auth-routes.ts"), /if \(role === "DRIVER"\) return "\/staff\/driver";/);
});

test("F — 이동 기록: 로그인 → 기사님 첫 화면(기록 안 함) → 명단 한 칸. 명단엔 «←» 가 없고, 운행표의 «←» 는 명단으로 back", () => {
  hist.resetPageLoadStateForTest();
  const m = new Map();
  const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  const env = { referrer: "https://stiz.example/login", origin: "https://stiz.example", historyLength: 3, documentPath: "/staff/driver", navigationType: "navigate" };
  const back = (stack, pathname) => resolveBackAction({ hasHistory: hist.hasInAppHistory(stack, pathname) === true, pathname, fallbackHref: "/staff/shuttle", scopeHref: "/staff", isInstalledApp: false });
  assert.equal(hist.isPassThroughPath("/staff/driver"), true);
  const list = hist.recordScopeNavigation("/staff", "/staff/shuttle", store, env);
  assert.deepEqual(list, ["/staff/shuttle"]);
  assert.deepEqual(back(list, "/staff/shuttle"), { type: "none" });
  // «운행 시작» → /staff/driver?start=1(기록 안 함) → 운행표
  const run = hist.recordScopeNavigation("/staff", "/staff/run", store, null);
  assert.deepEqual(run, ["/staff/shuttle", "/staff/run"]);
  assert.deepEqual(back(run, "/staff/run"), { type: "back" });
});

test("G — 운행 링크가 없으면 스토어 앱은 안내 표시를 달고 명단으로, 브라우저는 안내가 있는 운행표로(그대로)", () => {
  assert.equal(rules.SHUTTLE_NOTICE_PARAM, "notice");
  assert.equal(rules.SHUTTLE_NOTICE_NO_RUN, "no-run");
  assert.equal(rules.driverRunMissingKeyPath(true), "/staff/shuttle?notice=no-run");
  assert.equal(rules.driverRunMissingKeyPath(false), "/staff/run");
  // 앱이 막는 주소(/staff/run)로는 보내지 않는다
  assert.notEqual(rules.driverRunMissingKeyPath(true).split("?")[0], rules.DRIVER_RUN_PATH);

  const shuttle = read("src/app/staff/shuttle/page.tsx");
  assert.match(shuttle, /<NoRunNotice fromQuery=\{params\.notice === SHUTTLE_NOTICE_NO_RUN\} \/>/);
  // 안내가 명단·«운행 시작» 버튼보다 위에 있다
  assert.ok(shuttle.indexOf("<NoRunNotice fromQuery") < shuttle.indexOf("href={DRIVER_START_HREF}"));

  const notice = read("src/app/staff/shuttle/NoRunNotice.tsx");
  assert.match(notice, /^"use client";/);
  assert.match(notice, /<p role="status" className="[^"]*bg-\[var\(--color-academy-warning-soft\)\][^"]*">/);
  assert.match(notice, /아직 운행 링크가 없습니다\./);
  // 표시는 그린 뒤 주소에서 지운다(기록을 쌓지 않는다) — 다음 이동·새로 고침에 따라다니지 않게
  assert.match(notice, /params\.delete\(SHUTTLE_NOTICE_PARAM\);/);
  // 주소는 Next 에도 알리는 공용 함수로 바꾼다 — 안 그러면 운행표의 30초 새로 읽기(router.refresh)가 지운 쿼리를 되살린다(검수 N-2)
  assert.match(notice, /replaceUrlSyncingNext\(/);
  assert.doesNotMatch(notice, /window\.history\.replaceState|pushState|router\.push/);
  // 안내는 표시로 왔을 때만 보인다(평소 명단엔 없다)
  assert.match(notice, /const \[visible, setVisible\] = useState\(fromQuery\);/);
  assert.match(notice, /if \(!visible\) return null;/);
  // 아이콘·색 코드 없음(토큰만)
  assert.doesNotMatch(notice, /UiIcon|material-symbols|#[0-9a-fA-F]{3,6}\b/);
});

// ── F 보완: 운행 중에 앱이 다시 켜지면 운행 화면으로 바로(2026-11-18) ──

test("F 보완 — «운행 진행 중» 판단: 위치 공유가 켜져 있고 최근(10분 안)에 갱신된 위치 기록이 있을 때만", () => {
  assert.equal(rules.DRIVER_RUN_ACTIVE_WINDOW_SECONDS, 600);
  assert.equal(rules.isDriverRunInProgress({ sharing: true, secondsAgo: 0 }), true);
  assert.equal(rules.isDriverRunInProgress({ sharing: true, secondsAgo: 12 }), true);
  assert.equal(rules.isDriverRunInProgress({ sharing: true, secondsAgo: 600 }), true, "경계 포함");
  assert.equal(rules.isDriverRunInProgress({ sharing: true, secondsAgo: 601 }), false, "오래된 기록 = 어제 운행 등");
  assert.equal(rules.isDriverRunInProgress({ sharing: false, secondsAgo: 5 }), false, "운행 종료(공유 끔)");
  // 줄이 없거나 값이 이상하면 «아님»(명단으로)
  for (const odd of [null, undefined, {}, { sharing: true }, { sharing: true, secondsAgo: "5" }, { sharing: true, secondsAgo: NaN }, { sharing: true, secondsAgo: -3 }, { sharing: "true", secondsAgo: 5 }, { sharing: 1, secondsAgo: 5 }]) {
    assert.equal(rules.isDriverRunInProgress(odd), false, JSON.stringify(odd));
  }
  // DB 가 큰 정수로 돌려줘도 읽는다
  assert.equal(rules.isDriverRunInProgress({ sharing: true, secondsAgo: 30n }), true);
  // 기준 시간을 바꿔 넣을 수 있다
  assert.equal(rules.isDriverRunInProgress({ sharing: true, secondsAgo: 90 }, 60), false);
  // 진행 중이면 첫 화면이 넘길 주소는 «운행 시작»을 눌렀을 때와 같다
  assert.equal(rules.driverEntryTarget(rules.isDriverRunInProgress({ sharing: true, secondsAgo: 5 }), true, android), "/staff/run/open");
  assert.equal(rules.driverEntryTarget(rules.isDriverRunInProgress({ sharing: false, secondsAgo: 5 }), true, android), "/staff/shuttle");
});

test("F 보완 — 조회: 고정 운행 링크의 위치 기록만, 열쇠는 읽어 오지 않고, 경과 시간은 DB 시계로", () => {
  const src = read("src/app/staff/driver/activeRun.ts");
  assert.match(src, /prisma\.\$queryRawUnsafe</);
  assert.doesNotMatch(src, /prisma\.\w+\.(findMany|findFirst|findUnique|count)\(/, "ORM 기본 메서드 금지");
  assert.match(src, /FROM "DriverLocation" l\s+JOIN "ShuttleRunLink" r ON r\.token = l\.token/);
  assert.match(src, /WHERE r\."serviceDate" = 'ROLLING' AND r\."direction" IN \('REGULAR', 'ALL'\)/);
  assert.match(src, /EXTRACT\(EPOCH FROM \(now\(\) - l\."updatedAt"\)\)::int AS "secondsAgo"/);
  // 열쇠(token)를 고르지 않는다 — SELECT 목록에 token 이 없다
  const select = src.slice(src.indexOf("`SELECT"), src.indexOf("FROM \"DriverLocation\""));
  assert.doesNotMatch(select, /token/);
  assert.doesNotMatch(src, /findRollingDriverRunToken\(/, "열쇠 함수를 부르는 곳을 늘리지 않는다");
  // 서버·기기 시계를 쓰지 않는다
  assert.doesNotMatch(src, /new Date\(|Date\.now\(/);
  assert.match(src, /return isDriverRunInProgress\(rows\[0\]\);/);
  // 조회가 실패해도 첫 화면을 막지 않는다(명단으로)
  assert.match(src, /\} catch \{\s*return false;\s*\}/);
  // 권한 확인이 먼저다
  const page = read("src/app/staff/driver/page.tsx");
  assert.ok(page.indexOf('if (shuttleScope(staff.roles) === "NONE") redirect("/staff")') < page.indexOf("hasDriverRunInProgress()"));
});

// ── G 보완: 되돌아온 명단 칸을 하나로(2026-11-18) ──

test("G 보완 — 앞 칸이 같은 명단일 때만 한 칸 뒤로 접고, 탭 안 표시는 수 초만 유효하다", () => {
  assert.equal(rules.canCollapseNoRunEntry("/staff/shuttle"), true);
  for (const other of ["/staff", "/staff/run", "/staff/driver", "/staff/shuttle/assign", "/login", "/", null, undefined, ""]) {
    assert.equal(rules.canCollapseNoRunEntry(other), false, String(other));
  }
  const T0 = 1_700_000_000_000;
  assert.equal(rules.SHUTTLE_NO_RUN_FLAG_TTL_MS, 10_000);
  assert.equal(rules.isNoRunFlagFresh(String(T0), T0 + 300), true);
  assert.equal(rules.isNoRunFlagFresh(String(T0), T0 + 10_000), true);
  assert.equal(rules.isNoRunFlagFresh(String(T0), T0 + 10_001), false, "오래된 표시 — 나중에 명단에 왔을 때 엉뚱하게 뜨지 않는다");
  assert.equal(rules.isNoRunFlagFresh(String(T0), T0 - 1), false);
  for (const odd of [null, undefined, "", "abc"]) assert.equal(rules.isNoRunFlagFresh(odd, T0), false);

  const notice = read("src/app/staff/shuttle/NoRunNotice.tsx");
  // 접는 조건: 브라우저가 알려 준 앞 칸이 같은 명단 + 기록이 2칸 이상. 모르면 접지 않고 쿼리만 지운다
  assert.match(notice, /if \(previous\.kind === "ok" && canCollapseNoRunEntry\(previous\.path\) && window\.history\.length > 1\) \{\s*window\.sessionStorage\.setItem\(SHUTTLE_NO_RUN_FLAG_KEY, String\(Date\.now\(\)\)\);\s*window\.history\.back\(\);\s*return;/);
  // 돌아온 명단은 표시를 한 번 읽고 지운다
  assert.match(notice, /window\.sessionStorage\.removeItem\(SHUTTLE_NO_RUN_FLAG_KEY\);\s*if \(isNoRunFlagFresh\(raw, Date\.now\(\)\)\) setVisible\(true\);/);
});
