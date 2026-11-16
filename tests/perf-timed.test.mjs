import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadTsModule } from "./_ts-module.mjs";

// 속도 개선(2026-11-16) — 조회 묶음의 함수별 소요 시간 도우미와, 같이 들어간 구조 변경을 못박는다.
const { startTiming, timed, reportTiming } = await loadTsModule("src/lib/perf/timed.ts");
const read = (file) => readFileSync(file, "utf8");

// 가짜 시계 — 부를 때마다 정해 둔 값을 차례로 돌려준다(실제 시간에 기대지 않는다)
const clockOf = (...values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };

test("timed 는 이름별 소요 시간을 남기고 결과는 그대로 돌려준다", async () => {
  const sink = startTiming(clockOf(1000));
  assert.deepEqual(sink, { startedAt: 1000, parts: {} });
  const a = await timed("a", Promise.resolve("값"), sink, clockOf(1120.4));
  const b = await timed("b", Promise.resolve(7), sink, clockOf(1350.6));
  assert.equal(a, "값");
  assert.equal(b, 7);
  // 묶음 출발 시각부터 잰 ms(반올림)
  assert.deepEqual(sink.parts, { a: 120, b: 351 });
});

test("timed 는 실제 시계로도 기다린 만큼을 잰다", async () => {
  const sink = startTiming();
  await timed("slow", new Promise((resolve) => setTimeout(resolve, 40)), sink);
  assert.ok(sink.parts.slow >= 30 && sink.parts.slow < 2000, `slow=${sink.parts.slow}`);
});

test("실패한 약속도 시간은 남기고 예외는 그대로 던진다", async () => {
  const sink = startTiming(clockOf(0));
  const boom = new Error("조회 실패");
  await assert.rejects(() => timed("broken", Promise.reject(boom), sink, clockOf(55)), (error) => error === boom);
  assert.deepEqual(sink.parts, { broken: 55 });
});

test("reportTiming 은 전체가 임계값을 넘을 때만 한 줄 남긴다(숫자만)", () => {
  const lines = [];
  const log = (label, detail) => lines.push([label, detail]);
  const sink = { startedAt: 100, parts: { a: 10, b: 20 } };
  // 미만·딱 임계값 = 기록 안 함
  assert.equal(reportTiming("[x]", sink, 300, clockOf(350), log), false);
  assert.equal(reportTiming("[x]", sink, 300, clockOf(400), log), false);
  assert.equal(lines.length, 0);
  // 초과 = 한 줄
  assert.equal(reportTiming("[x]", sink, 300, clockOf(401), log), true);
  assert.deepEqual(lines, [["[x]", { total: 301, parts: { a: 10, b: 20 } }]]);
  // 기록에 넘긴 것은 사본이다(나중에 그릇이 바뀌어도 이미 남긴 줄은 그대로)
  sink.parts.c = 1;
  assert.deepEqual(lines[0][1].parts, { a: 10, b: 20 });
  for (const value of [lines[0][1].total, ...Object.values(lines[0][1].parts)]) assert.equal(typeof value, "number");
});

test("기록 함수가 죽어도 reportTiming 은 던지지 않는다", () => {
  const sink = { startedAt: 0, parts: {} };
  assert.equal(reportTiming("[x]", sink, 1, clockOf(10), () => { throw new Error("로그 실패"); }), true);
});

test("학부모 화면에 «불러오는 중» 뼈대가 있다 — role=status·낭독 글자·움직임 줄이기", () => {
  assert.ok(existsSync("src/app/mypage/loading.tsx"));
  const loading = read("src/app/mypage/loading.tsx");
  assert.match(loading, /role="status"/);
  assert.match(loading, /className="sr-only">불러오는 중</);
  assert.match(loading, /motion-reduce:animate-none/);
  // 레이아웃이 머리줄·아래 탭을 그리므로 뼈대는 본문만(머리줄·main 을 또 그리지 않는다)
  assert.doesNotMatch(loading, /<header|<main|<nav/);
  // 색은 토큰만, 아이콘 없음
  assert.doesNotMatch(loading, /#[0-9a-fA-F]{3,8}\b|UiIcon|material-symbols|bg-(white|black|gray|slate|zinc)/);
});

test("학부모 홈: 자녀가 없으면 홈 조회 묶음 전에 먼저 반환하고, 특강 내역은 묶음과 같이 기다린다", () => {
  const page = read("src/app/mypage/page.tsx");
  const startAt = page.indexOf("const pendingSeasonalPromise = getPendingSeasonalChildren(parentAuth.appUserId, studentIds);");
  const emptyAt = page.indexOf("if (!data || data.children.length === 0) {");
  const returnAt = page.indexOf("return <EmptyParentState");
  const batchAt = page.indexOf("await Promise.all([");
  assert.ok(startAt > 0 && emptyAt > startAt, "특강 내역 조회는 빈 자녀 판정 전에 출발한다");
  assert.ok(returnAt > emptyAt && returnAt < batchAt, "자녀가 없으면 홈 조회 묶음 전에 반환한다");
  // 자녀 없음 갈래 안에는 특강 내역·학원 번호 두 가지만 기다린다(추가 조회 없음)
  const emptyBranch = page.slice(emptyAt, returnAt);
  assert.deepEqual(emptyBranch.match(/await [A-Za-z]+/g), ["await pendingSeasonalPromise", "await getUsableAcademyPhone"]);
  // 특강 내역을 혼자 기다리는 줄이 묶음 앞에 남아 있지 않다
  assert.equal((page.match(/getPendingSeasonalChildren\(/g) ?? []).length, 1);
  assert.doesNotMatch(page.slice(returnAt, batchAt), /await /);
  assert.match(page.slice(batchAt), /^await Promise\.all\(\[\s*(\/\/[^\n]*\s*)*timed\("pendingSeasonal", pendingSeasonalPromise, timing\),/);
  // 느릴 때만 한 줄
  assert.match(page, /reportTiming\("\[mypage timing\]", timing, 300\);/);
});

test("관리자 메뉴 배지: «표 있음» 확인 4개를 동시에 묻고 넘기는 순서는 그대로", () => {
  const inbox = read("src/lib/requests/admin-inbox.ts");
  assert.match(inbox, /const \[settlementReady, illnessReady, shuttleRegularReady, periodCarryReady\] = await Promise\.all\(\[\s*inboxSettlementTableReady\(\), inboxIllnessTableReady\(\), inboxShuttleRegularReady\(\), inboxPeriodCarryReady\(\),\s*\]\);/);
  assert.match(inbox, /buildInboxCountsSql\(\s*false, settlementReady, illnessReady, shuttleRegularReady, periodCarryReady,\s*\)/);
  // 차례로 기다리던 예전 모양이 남아 있지 않다
  assert.doesNotMatch(inbox, /await inboxSettlementTableReady\(\), await inboxIllnessTableReady\(\)/);
});

test("관리자 신청함·수납: 느릴 때만(500ms 초과) 한 줄 — 조회 묶음 모양은 그대로", () => {
  const inboxPage = read("src/app/admin/inbox/page.tsx");
  assert.match(inboxPage, /reportTiming\("\[admin inbox timing\]", timing, 500\);/);
  assert.match(inboxPage, /timed\("counts", getInboxCounts\(\), timing\)/);
  const financePage = read("src/app/admin/finance/page.tsx");
  assert.match(financePage, /reportTiming\("\[admin finance timing\]", timing, 500\);/);
  assert.match(financePage, /await Promise\.all\(\[\s*timed\("auth", requireAdmin\(\), timing\),\s*timed\("payload", getCachedAdminFinancePayload\(initialYear, initialMonth\), timing\),\s*\]\);/);
});
