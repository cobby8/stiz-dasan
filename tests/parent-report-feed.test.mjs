// 2026-11-14 학부모 «수업 리포트 피드»(원장 요청) — 홈 카드·소식 탭의 리포트를 누르면 피드 화면으로.
//  - 순수 규칙(커서·개수·날짜 구분줄·라벨·주소)을 실제로 돌린다(자정·월말·연말·윤년 경계 포함)
//  - 서버 조회는 소스 검사: 공개 기준(feedVisibleSessionSql·feedParticipantSql)·보호자 쪽 아이(childAccessSql)·값 바인딩
//  - 라우트: 보호자 확인이 조회보다 먼저, 입력값 모양 검사, 실패를 빈 목록으로 삼키지 않는다
//  - 연결: 홈 카드·소식 탭 리포트 줄이 새 주소
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const r = await loadTsModule("src/lib/feed/reportFeedRules.ts");
const read = (path) => readFileSync(path, "utf8");

const SERVER = "src/lib/feed/reportFeedServer.ts";
const ROUTE = "src/app/api/mypage/report-feed/route.ts";
const PAGE = "src/app/mypage/reports/feed/page.tsx";
const CLIENT = "src/app/mypage/reports/feed/ReportFeedClient.tsx";

// ── 순수 규칙 ─────────────────────────────────────────────────────────

test("수업 id 모양 검사 — 주소에서 온 값은 글자·숫자·-_ 64자까지만", () => {
  assert.equal(r.parseSessionIdParam("0b0c2c1e-7a7d-4b0e-9a0e-1c2d3e4f5a6b"), "0b0c2c1e-7a7d-4b0e-9a0e-1c2d3e4f5a6b");
  assert.equal(r.parseSessionIdParam("  s-a  "), "s-a", "앞뒤 공백은 지운다");
  for (const bad of ["", "a'b", "a;DROP", "a b", "x".repeat(65), "../x", null, undefined, 12, ["s-a"]]) {
    assert.equal(r.parseSessionIdParam(bad), null, `거절: ${String(bad)}`);
  }
});

test("커서 — 만들고 읽으면 같은 값, 모양이 틀리면 null", () => {
  const cursor = { ymd: "2026-11-13", id: "s-a" };
  const text = r.encodeReportFeedCursor(cursor);
  assert.equal(text, "2026-11-13~s-a");
  assert.deepEqual(r.parseReportFeedCursor(text), cursor);
  // id 안에 ~ 가 또 있으면 id 모양 검사에서 걸린다
  for (const bad of ["", "~s-a", "2026-11-13", "2026-11-13~", "2026-13-01~s-a", "2026-02-30~s-a", "2026-11-13~a'b", "2026-11-13~a~b", 3, null]) {
    assert.equal(r.parseReportFeedCursor(bad), null, `거절: ${String(bad)}`);
  }
  // 윤년 2월 29일은 받는다, 평년은 거절
  assert.deepEqual(r.parseReportFeedCursor("2028-02-29~s"), { ymd: "2028-02-29", id: "s" });
  assert.equal(r.parseReportFeedCursor("2027-02-29~s"), null);
});

test("받을 개수 — 정수 1~50, 틀리면 기본 20", () => {
  assert.equal(r.REPORT_FEED_PAGE_SIZE, 20);
  assert.equal(r.clampReportFeedLimit(undefined), 20);
  assert.equal(r.clampReportFeedLimit("10"), 10);
  assert.equal(r.clampReportFeedLimit(5), 5);
  assert.equal(r.clampReportFeedLimit("999"), 50, "상한");
  for (const bad of ["0", "-3", "1.5", "abc", "", null, NaN, Infinity]) {
    assert.equal(r.clampReportFeedLimit(bad), 20, `기본값: ${String(bad)}`);
  }
});

test("다음 커서 — 꽉 찬 장이면 마지막 게시물, 덜 찼으면 끝(null)", () => {
  const posts = [{ id: "c", ymd: "2026-11-13" }, { id: "b", ymd: "2026-11-12" }];
  assert.equal(r.nextReportFeedCursor(posts, 2), "2026-11-12~b");
  assert.equal(r.nextReportFeedCursor(posts, 3), null);
  assert.equal(r.nextReportFeedCursor([], 20), null);
});

test("이어 붙이기 — 같은 게시물은 한 번만(다시 불러오기를 두 번 눌러도)", () => {
  const merged = r.appendReportFeedPage([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }, { id: "c" }]);
  assert.deepEqual(merged.map((p) => p.id), ["a", "b", "c"]);
});

test("날짜 구분줄 글자 — 요일이 밀리지 않는다(월말·연말·윤년)", () => {
  assert.equal(r.reportFeedDayLabel("2026-11-13"), "11월 13일 (금)");
  assert.equal(r.reportFeedDayLabel("2026-11-30"), "11월 30일 (월)");
  assert.equal(r.reportFeedDayLabel("2026-12-31"), "12월 31일 (목)");
  assert.equal(r.reportFeedDayLabel("2027-01-01"), "1월 1일 (금)");
  assert.equal(r.reportFeedDayLabel("2028-02-29"), "2월 29일 (화)");
  assert.equal(r.reportFeedDayLabel("2026-13-01"), "");
});

test("머리줄 날짜·시간 — «11/13(금) 15:00», 시간이 이상하면 날짜만", () => {
  assert.equal(r.reportFeedWhenLabel("2026-11-13", "15:00"), "11/13(금) 15:00");
  assert.equal(r.reportFeedWhenLabel("2026-11-13", null), "11/13(금)");
  assert.equal(r.reportFeedWhenLabel("2026-11-13", "오후"), "11/13(금)");
});

test("날짜 구분줄 끼우기 — 첫 게시물 앞과 날짜가 바뀌는 곳마다", () => {
  const rows = r.withReportFeedDayDividers([
    { id: "a", ymd: "2026-11-13" }, { id: "b", ymd: "2026-11-13" }, { id: "c", ymd: "2026-11-12" }, { id: "d", ymd: "2026-10-31" },
  ]);
  assert.deepEqual(rows.map((row) => (row.kind === "day" ? `[${row.label}]` : row.post.id)), [
    "[11월 13일 (금)]", "a", "b", "[11월 12일 (목)]", "c", "[10월 31일 (토)]", "d",
  ]);
  assert.deepEqual(r.withReportFeedDayDividers([]), []);
});

test("출결 글자 — 상세 화면과 같은 말, 모르는 값은 «확인 중»", () => {
  assert.equal(r.reportFeedAttendanceLabel("PRESENT"), "출석");
  assert.equal(r.reportFeedAttendanceLabel("LATE"), "지각");
  assert.equal(r.reportFeedAttendanceLabel("ABSENT"), "결석");
  assert.equal(r.reportFeedAttendanceLabel(null), "확인 중");
  assert.equal(r.reportFeedAttendanceLabel("WHATEVER"), "확인 중");
});

test("피드 주소 — start 는 모양이 맞을 때만 붙인다", () => {
  assert.equal(r.reportFeedHref(), "/mypage/reports/feed");
  assert.equal(r.reportFeedHref("s-a"), "/mypage/reports/feed?start=s-a");
  assert.equal(r.reportFeedHref("a'b"), "/mypage/reports/feed");
});

// ── 서버 조회(소스 검사) ──────────────────────────────────────────────

test("서버 조회 — 공개 기준을 새로 만들지 않고 공용 문장을 쓴다, 아이는 보호자 쪽에서만", () => {
  const src = read(SERVER);
  assert.match(src, /feedVisibleSessionSql\("se"\)/, "끝났고 발행된 수업만");
  assert.match(src, /feedParticipantSql\("st", "se"\)/, "내 아이가 참여한 수업만");
  assert.match(src, /childAccessSql\("st", "\$1"\)/, "아이는 로그인한 보호자($1) 쪽에서만");
  assert.match(src, /notMergedStudent\("st"\)/);
  // 공개 조건을 손으로 다시 쓰지 않는다
  assert.doesNotMatch(src, /status\s*=\s*'COMPLETED'|published\s*=\s*true/);
  // 날짜는 무tz 두 번 변환 공용 문장
  assert.match(src, /sessionKstDateSql\("se"\)/);
  // DB 는 $queryRawUnsafe 만, 값은 바인딩($n) — 커서·수업 id 를 문자열로 붙이지 않는다
  assert.doesNotMatch(src, /prisma\.\w+\.(findMany|findFirst|findUnique|create|update|upsert|delete)\(/);
  assert.doesNotMatch(src, /\$\{(range\.)?cursor\.|\$\{range\.sessionId\}|\$\{sessionId\}|\$\{startSessionId\}/);
  assert.match(src, /\$2::date, \$3::text/);
  // 출결 조회도 같은 참여 기준 + 보호자 쪽 아이
  const attendance = src.slice(src.indexOf("async function queryChildrenAttendance"), src.indexOf("async function decorate"));
  assert.match(attendance, /feedParticipantSql\("st", "se"\)/);
  assert.match(attendance, /childAccessSql\("st", "\$1"\)/);
});

test("서버 조회 — 부가 조회(사진·영상·출결)는 실패해도 그 칸만 비고, 목록 본체 실패는 던진다", () => {
  const src = read(SERVER);
  const decorate = src.slice(src.indexOf("async function decorate"), src.indexOf("export async function loadReportFeedPage"));
  assert.equal((decorate.match(/\.catch\(/g) || []).length, 3, "사진·영상·출결 셋 다 catch");
  assert.match(decorate, /console\.error\("\[report-feed\] 사진 조회 실패/);
  assert.match(decorate, /photos: photos \? .* : null/, "사진 실패 = null(화면이 다시 불러오기)");
  const page = src.slice(src.indexOf("export async function loadReportFeedPage"), src.indexOf("export async function loadReportFeedFromStart"));
  assert.doesNotMatch(page, /\.catch\(|try\s*\{/, "목록 본체 실패를 빈 목록으로 삼키지 않는다");
});

test("?start= — 같은 공개 기준으로 그 수업을 먼저 확인하고, 볼 수 없으면 null(맨 위부터)", () => {
  const src = read(SERVER);
  const start = src.slice(src.indexOf("export async function loadReportFeedFromStart"), src.indexOf("export async function loadReportFeedPost"));
  assert.match(start, /queryVisibleSessions\(appUserId, \{ kind: "one", sessionId: startSessionId \}, 1\)/);
  assert.match(start, /if \(!start\) return null/);
  assert.match(start, /REPORT_FEED_START_MAX/);
});

// ── 라우트 ────────────────────────────────────────────────────────────

test("라우트 — 보호자 확인이 조회보다 먼저, 실패하면 401(빈 목록으로 삼키지 않는다)", () => {
  const src = read(ROUTE);
  const auth = src.indexOf("requireVerifiedParent()");
  assert.ok(auth > 0);
  for (const call of ["loadReportFeedPage(", "loadReportFeedPost("]) {
    const at = src.indexOf(call, src.indexOf("export async function GET"));
    assert.ok(at > auth, `${call} 는 보호자 확인 뒤`);
  }
  assert.match(src, /status: 401/);
  assert.doesNotMatch(src, /requireVerifiedParent\(\)\.catch\(\(\) => null\)[\s\S]*posts: \[\]/);
  // 입력값 검증
  assert.match(src, /parseSessionIdParam\(params\.get\("session"\)\)/);
  assert.match(src, /parseReportFeedCursor\(rawCursor\)/);
  assert.match(src, /clampReportFeedLimit\(params\.get\("limit"\)\)/);
  assert.match(src, /status: 400/);
  // 볼 수 없는 수업 = 404 하나(있는지 떠볼 수 없게), 개인 정보라 캐시 금지
  assert.match(src, /status: 404/);
  assert.match(src, /private, no-store/);
});

test("화면 — 보호자 확인 뒤에만 조회, 시작 위치 실패는 맨 위부터, 본체 실패는 다시 불러오기", () => {
  const src = read(PAGE);
  const auth = src.indexOf("requireVerifiedParent()");
  assert.ok(auth > 0 && src.indexOf("loadReportFeedPage(") > auth && src.indexOf("loadReportFeedFromStart(") > auth);
  assert.match(src, /parseSessionIdParam\(/);
  assert.match(src, /다시 불러오기/);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  // 맨 위 «←» 는 학부모 공용 뒤로 부품(들어온 화면으로, 기록이 없으면 소식 탭)
  assert.match(src, /<ParentBackLink fallbackHref="\/mypage\/reports"/);
});

test("화면(클라이언트) — 다음 장 실패는 버튼으로만 다시, 사진 칸만 다시 불러오기, 영상은 상세와 같은 부품", () => {
  const src = read(CLIENT);
  assert.match(src, /\/api\/mypage\/report-feed\?cursor=/);
  assert.match(src, /IntersectionObserver/);
  assert.match(src, /if \(!target \|\| !cursor \|\| failed/, "실패한 뒤에는 자동으로 다시 부르지 않는다");
  assert.match(src, /다시 불러오기/);
  assert.match(src, /사진 다시 불러오기/);
  // 영상은 상세와 같은 부품을 «화면 근처에서만» 붙이고, 자리표시와 같은 격자 칸에 겹쳐 높이를 미리 잡는다
  assert.match(src, /<LazyVideoSlot sessionId=\{post\.id\} count=\{post\.videoCount\} \/>/);
  assert.match(src, /\{near && <SessionVideoList sessionId=\{sessionId\}[^>]*\[grid-area:1\/1\]/);
  assert.match(src, /rootMargin: "800px 0px"/);
  // 사진이 모두 안 열려도 칸을 없애지 않는다(정사각형 그대로 + 다시 불러오기)
  assert.match(src, /flex aspect-square w-full flex-col/);
  assert.doesNotMatch(src, /if \(visible\.length === 0\) return null/);
  // 사진 다시 불러오기는 사진 칸만 바꾼다(출결 줄 유지)
  assert.match(src, /post\.id === postId \? \{ \.\.\.post, photos \} : post/);
  assert.match(src, /onPhotos\(sessionId, body\.post\.photos\)/);
  // «확인 중»은 중립색
  assert.match(src, /if \(reportFeedAttendanceLabel\(status\) === "확인 중"\) return "neutral"/);
  // 시작 위치는 화면이 다 뜬 뒤 한 번 더(사용자가 움직였으면 그대로)
  assert.match(src, /window\.addEventListener\("load", realign, \{ once: true \}\)/);
  assert.match(src, /snap-x snap-mandatory/);
  assert.match(src, /\{shown \+ 1\}\/\{visible\.length\}/);
  assert.match(src, /scrollIntoView/);
  assert.match(src, /\/mypage\/reports\/\$\{encodeURIComponent\(post\.id\)\}/, "«자세히»는 상세로");
});

// ── 연결 ──────────────────────────────────────────────────────────────

test("연결 — 홈 «최신 수업 피드» 카드와 소식 탭 리포트 줄이 피드 주소로 간다", () => {
  const card = read("src/components/parent/LatestFeedCard.tsx");
  assert.match(card, /const href = reportFeedHref\(card\.sessionId\)/);
  assert.match(card, /<Link href=\{reportFeedHref\(\)\}[^>]*>\s*더보기/);
  assert.doesNotMatch(card, /#news-reports|\/mypage\/reports\/\$\{/);

  const news = read("src/app/mypage/reports/page.tsx");
  assert.match(news, /href=\{reportFeedHref\(r\.sessionId\)\}/);
  assert.doesNotMatch(news, /href=\{`\/mypage\/reports\/\$\{r\.sessionId\}`\}/);
  // 공지 줄은 그대로(앱 안 공지 상세)
  assert.match(news, /href=\{`\/mypage\/news\/\$\{n\.id\}`\}/);
});
