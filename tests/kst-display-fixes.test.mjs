// 화면 날짜 표시를 KST 로 고정한 4곳을 **배포 서버와 같은 UTC 시간대에서 실제로 실행**해 확인한다.
//
// 왜 TZ=UTC 인가: 배포 서버(Vercel)는 UTC, 사용자 휴대폰은 KST 다. timeZone 없이 날짜를 그리면
//  (1) KST 00~09시 기록이 하루 전으로 보이고
//  (2) 서버 첫 렌더와 브라우저 렌더 글자가 달라 React #418(하이드레이션 불일치)이 난다.
// 그래서 "UTC 에서 돌려도 KST 휴대폰에서 보던 글자와 똑같이 나오는가"를 본다.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as kst from "../src/lib/datetime/kst.ts";

const require = createRequire(import.meta.url);

// 어떤 이름을 꺼내도 빈 컴포넌트/함수를 돌려주는 가짜 모듈(화면 부품·서버 액션 대용).
const stub = new Proxy({}, {
  get: (_t, key) => (key === "__esModule" ? true : () => null),
});

/** TSX 파일을 CommonJS 로 바꿔 실행한다. kst 는 진짜, 나머지 앱 모듈은 overrides 또는 가짜. */
function loadTsx(file, overrides = {}) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === "@/lib/datetime/kst") return kst;
    if (id.startsWith("@/") || id.startsWith(".") || id.startsWith("next/")) return stub;
    return require(id);
  }, exports);
  return exports;
}

// KST 휴대폰이 예전 코드로 그리던 글자 = 같은 옵션 + timeZone Asia/Seoul.
const kstRef = (v, opts) => new Date(v).toLocaleDateString("ko-KR", { ...opts, timeZone: "Asia/Seoul" });

// 경계 시각들
const BEFORE_MIDNIGHT = "2026-10-30T14:59:00.000Z"; // KST 10/30(금) 23:59
const AFTER_MIDNIGHT = "2026-10-30T15:05:00.000Z";  // KST 10/31(토) 00:05
const MONTH_END = "2026-11-30T15:00:00.000Z";       // KST 12/1(화) 00:00
const YEAR_END = "2026-12-31T15:00:00.000Z";        // KST 2027/1/1(금) 00:00

test("전제 — 이 테스트는 UTC 시간대에서 돈다", () => {
  assert.equal(new Date(0).getTimezoneOffset(), 0);
});

test("kst.kstHm — KST 24시간제 HH:MM, 자정은 00 시", () => {
  assert.equal(kst.kstHm(BEFORE_MIDNIGHT), "23:59");
  assert.equal(kst.kstHm(AFTER_MIDNIGHT), "00:05");
  assert.equal(kst.kstHm(new Date("2026-10-31T00:00:00.000Z")), "09:00");
  assert.equal(kst.kstHm("엉뚱한 값"), "");
});

test("1. 마이페이지 — 알림·요청 시각, 공지·피드백 날짜, 셔틀 운행일이 KST 로 나온다", () => {
  const m = loadTsx("src/app/mypage/MyPageClient.tsx");
  const alertOpts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

  // 알림 시각: 자정 직후 기록이 전날 오후 3시로 보이던 문제
  assert.equal(m.formatAlertTime(AFTER_MIDNIGHT), "10월 31일 AM 12:05");
  assert.equal(m.formatAlertTime(BEFORE_MIDNIGHT), "10월 30일 PM 11:59");
  assert.equal(m.formatAlertTime(new Date(MONTH_END)), "12월 1일 AM 12:00");
  for (const v of [BEFORE_MIDNIGHT, AFTER_MIDNIGHT, MONTH_END, YEAR_END]) {
    assert.equal(m.formatAlertTime(v), kstRef(v, alertOpts), `휴대폰(KST)과 글자가 달라지면 하이드레이션 불일치: ${v}`);
  }

  // 공지·피드백 날짜 "2026. 10. 31."
  assert.equal(m.formatShortDate(AFTER_MIDNIGHT), "2026. 10. 31.");
  assert.equal(m.formatShortDate(BEFORE_MIDNIGHT), "2026. 10. 30.");
  assert.equal(m.formatShortDate(MONTH_END), "2026. 12. 1.");
  assert.equal(m.formatShortDate(YEAR_END), "2027. 1. 1.");
  for (const v of [BEFORE_MIDNIGHT, AFTER_MIDNIGHT, MONTH_END, YEAR_END]) {
    assert.equal(m.formatShortDate(v), kstRef(v, {}));
  }

  // 셔틀 운행일(날짜만 문자열·UTC 자정·KST 자정 timestamp 모두 같은 KST 날짜)
  // 2026-11-09 셔틀 배정 칸이 홈에서 «일정» 탭으로 옮겨 가며 함수도 ParentShuttleDetail 로 옮겼다.
  const s = loadTsx("src/app/mypage/ParentShuttleDetail.tsx");
  for (const v of ["2026-10-31", "2026-10-31T00:00:00.000Z", "2026-10-30T15:00:00.000Z"]) {
    assert.equal(s.formatShuttleDate(v), "2026년 10월 31일 토", v);
    assert.equal(s.formatShuttleDate(v), kstRef("2026-10-31T00:00:00+09:00", { year: "numeric", month: "long", day: "numeric", weekday: "short" }));
  }
  assert.equal(s.formatShuttleDate(null), "운행일 확인 중");
  assert.equal(s.formatShuttleDate("엉뚱한 값"), "엉뚱한 값", "읽을 수 없는 값은 예전처럼 원문 그대로");
});

test("2. 리포트 상세 — 서버(UTC)가 그려도 수업 날짜가 KST 달력으로 나온다", async () => {
  // 2026-11-14 수업 피드: 수업일은 SQL 이 KST 달력 문자열로 만든다(무tz 칼럼 «두 번» 변환 — feed/rules sessionKstDateSql).
  // 화면은 그 "YYYY-MM-DD" 를 formatKstDate 로 그리기만 한다(서버 UTC 시계가 끼어들 자리가 없다).
  async function renderWith(ymd) {
    const { default: Page } = loadTsx("src/app/mypage/reports/[sessionId]/page.tsx", {
      "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }) },
      "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: "p1" }) },
      "@/lib/prisma": { prisma: { $queryRawUnsafe: async () => [] } },
      "@/lib/feed/server": {
        loadParentViewableSession: async () => ({
          session: { id: "s1", classId: "k1", ymd, topic: "드리블", content: "", photosJSON: null, className: "초등A", dayOfWeek: "Sat", startTime: "10:00", endTime: "11:00", programName: "정규", coachName: "김코치" },
          children: [{ id: "st1", name: "가나" }],
        }),
        listViewableSessionPhotos: async () => new Map(),
        countSessionVideos: async () => new Map(),
      },
      "@/components/parent/FeedPhotoGallery": { default: () => null },
      "@/components/parent/SessionVideoPlayer": { SessionVideoList: () => null },
      "next/navigation": { notFound: () => { throw new Error("not found"); } },
      "next/link": { default: ({ children, ...p }) => React.createElement("a", p, children) },
      // 보조 조회 기본값(2026-11-14) — 성공하면 그 값, 실패하면 기본값
      "@/lib/server/loadOrDefault": { loadOrDefault: async (_stage, load, fallback) => { try { return await load(); } catch { return fallback; } } },
    });
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ sessionId: "s1" }) }));
  }
  // 형식은 예전 그대로 "2026년 10월 31일 토"(month: long + weekday: short 의 ko-KR 모양)
  assert.match(await renderWith("2026-10-31"), /2026년 10월 31일 토 ·/);
  // 월말·연말
  assert.match(await renderWith("2026-12-01"), /2026년 12월 1일 화 ·/);
  assert.match(await renderWith("2027-01-01"), /2027년 1월 1일 금 ·/);
  // 수업일을 만드는 SQL 은 두 번 변환 조각을 쓴다(옛 기록 «전날 15:00» 모양도 같은 날짜)
  const feedServer = readFileSync("src/lib/feed/server.ts", "utf8");
  assert.equal((feedServer.match(/\$\{sessionKstDateSql\("se"\)\}::text AS ymd/g) ?? []).length, 2);
  assert.doesNotMatch(feedServer, /date::date::text AS ymd/);
});

test("3. 연간일정 패널 — 날짜·요일·시각을 KST 로", () => {
  const { formatDate } = loadTsx("src/app/annual/EventDetailPanel.tsx");
  assert.equal(formatDate(BEFORE_MIDNIGHT, false), "10월 30일 (금) 23:59");
  assert.equal(formatDate(AFTER_MIDNIGHT, false), "10월 31일 (토) 00:05");
  assert.equal(formatDate(MONTH_END, false), "12월 1일 (화) 00:00");
  assert.equal(formatDate(YEAR_END, true), "1월 1일 (금)");
  // 구글 종일 일정(UTC 자정)·DB 일정 모두 같은 날
  assert.equal(formatDate("2026-10-31T00:00:00.000Z", true), "10월 31일 (토)");
  assert.equal(formatDate("엉뚱한 값", true), "");
});

test("4. 셔틀 대시보드 — 오늘 노선이 오늘로 분류된다(서버 todayKey 와 같은 KST 달력)", () => {
  const m = loadTsx("src/app/staff/shuttle/StaffShuttleDashboardClient.tsx");
  // 서버 getStaffShuttleDashboard 의 koreaDateOnly() 와 같은 계산(en-CA + Asia/Seoul).
  const serverToday = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  const at = (iso) => new Date(iso).getTime();

  // serviceDate 는 @db.Date → 페이지 첫 렌더는 UTC 자정 Date, 새로고침(API JSON)은 같은 값의 ISO 문자열.
  const r = (id, serviceDate) => ({ id, serviceDate, stops: [], passengerCount: 0 });
  const ids = (list) => list.map((x) => x.id);

  // ── KST 10/31 00:05 (자정 직후 — 예전 UTC 계산이라면 아직 10/30 인 시각)
  {
    const todayKey = serverToday(at(AFTER_MIDNIGHT));
    assert.equal(todayKey, "2026-10-31");
    assert.equal(todayKey, kst.todayKst(at(AFTER_MIDNIGHT)), "서버 today 와 화면 기준이 같아야 한다");
    const routes = [
      r("today-date", new Date("2026-10-31T00:00:00.000Z")),
      r("today-json", "2026-10-31T00:00:00.000Z"),
      r("today-ymd", "2026-10-31"),
      r("today-kst-midnight", "2026-10-30T15:00:00.000Z"), // KST 자정 timestamptz 로 와도 오늘
      r("yesterday", new Date("2026-10-30T00:00:00.000Z")),
      r("tomorrow", new Date("2026-11-01T00:00:00.000Z")),
      r("regular", null),
    ];
    const { todayRoutes, upcomingRoutes, needsReviewRoutes } = m.splitRoutesByDate(routes, todayKey);
    assert.deepEqual(ids(todayRoutes), ["today-date", "today-json", "today-ymd", "today-kst-midnight"]);
    assert.deepEqual(ids(upcomingRoutes), ["tomorrow"]);
    assert.deepEqual(ids(needsReviewRoutes), ["yesterday", "regular"]);
  }

  // ── KST 10/30 23:59 (자정 직전)
  {
    const todayKey = serverToday(at(BEFORE_MIDNIGHT));
    assert.equal(todayKey, "2026-10-30");
    const routes = [r("today", new Date("2026-10-30T00:00:00.000Z")), r("tomorrow", "2026-10-31T00:00:00.000Z")];
    const { todayRoutes, upcomingRoutes } = m.splitRoutesByDate(routes, todayKey);
    assert.deepEqual(ids(todayRoutes), ["today"]);
    assert.deepEqual(ids(upcomingRoutes), ["tomorrow"]);
  }

  // ── 월말 → 다음 달 첫날 (KST 12/1 00:00)
  {
    const todayKey = serverToday(at(MONTH_END));
    assert.equal(todayKey, "2026-12-01");
    const routes = [r("nov30", new Date("2026-11-30T00:00:00.000Z")), r("dec1", "2026-12-01T00:00:00.000Z"), r("dec2", "2026-12-02")];
    const { todayRoutes, upcomingRoutes, needsReviewRoutes } = m.splitRoutesByDate(routes, todayKey);
    assert.deepEqual(ids(todayRoutes), ["dec1"]);
    assert.deepEqual(ids(upcomingRoutes), ["dec2"]);
    assert.deepEqual(ids(needsReviewRoutes), ["nov30"]);
  }

  // 날짜 키·표시
  assert.equal(m.routeDateKey(null), null);
  assert.equal(m.routeDateKey("엉뚱한 값"), null, "읽을 수 없는 값은 '일정 확인 필요'로");
  assert.equal(m.formatRouteDate(null), "정기");
  assert.equal(m.formatRouteDate(new Date("2026-10-31T00:00:00.000Z")), "10월 31일 (토)");
  assert.equal(m.formatRouteDate("2026-12-01T00:00:00.000Z"), "12월 1일 (화)");
  assert.equal(m.formatRouteDate("2026-10-30T15:00:00.000Z"), "10월 31일 (토)");
});

// ── 수납 관리 목록·상세 날짜(FinanceClient.toDateStr) — 2026-11-08 «납부일 하루 전» 운영 사고
// paidDate 는 무tz UTC 로 저장된다(2026-11-07 16:50:45 = KST 11-08 01:50). UTC 날짜로 그리면 하루 전이 보인다.
test("수납 관리 날짜(toDateStr): UTC 서버에서도 KST 달력 날짜 — 자정~09시 경계·월말·연말", () => {
  const m = loadTsx("src/app/admin/finance/FinanceClient.tsx");
  // 운영 실측 값 그대로
  assert.equal(m.toDateStr(new Date("2026-11-07T16:50:45.000Z")), "2026-11-08");
  assert.equal(m.toDateStr("2026-11-07T16:50:45.000Z"), "2026-11-08", "JSON 으로 넘어온 문자열도 같다");
  // KST 자정 경계: 14:59:59Z = KST 23:59:59(같은 날), 15:00Z = KST 다음 날 00:00
  assert.equal(m.toDateStr("2026-11-07T14:59:59.000Z"), "2026-11-07");
  assert.equal(m.toDateStr("2026-11-07T15:00:00.000Z"), "2026-11-08");
  // KST 09시 경계(00:00Z = KST 09:00) — 날짜만 저장된 납부기한도 그대로
  assert.equal(m.toDateStr("2026-11-10T00:00:00.000Z"), "2026-11-10");
  assert.equal(m.toDateStr("2026-11-09T23:59:59.000Z"), "2026-11-10", "KST 08:59");
  // 월말·연말
  assert.equal(m.toDateStr("2026-11-30T15:30:00.000Z"), "2026-12-01");
  assert.equal(m.toDateStr("2026-12-31T15:00:00.000Z"), "2027-01-01");
  // 빈 값·못 읽는 값
  assert.equal(m.toDateStr(null), "-");
  assert.equal(m.toDateStr("엉뚱한 값"), "-");
});

test("수납 관리 첫 화면의 «이번 달»은 KST 기준(서버 getMonth 금지)", () => {
  const page = readFileSync("src/app/admin/finance/page.tsx", "utf8");
  assert.match(page, /todayKst\(\)\.split\("-"\)\.map\(Number\)/);
  assert.doesNotMatch(page, /\.getMonth\(\)|\.getFullYear\(\)/);
});
