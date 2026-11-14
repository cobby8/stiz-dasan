// 2026-11-14 관리자 «수업 피드» 화면(같은 날 인스타식 스크롤 + 오른쪽 편집으로 개편)
// — 순수 규칙(필터 정규화·커서·요일·화면 글자)을 실제로 돌리고, 화면·API·조회의 권한·연결을 소스로 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const r = await loadTsModule("src/lib/feed/adminFeedRules.ts");
const read = (path) => readFileSync(path, "utf8");

const item = (over = {}) => ({
  sessionId: "s1", classId: "c1", ymd: "2026-11-14", className: "토요일 1교시", startTime: "10:00", endTime: "11:00",
  teacherName: "이병하", endedByName: null, content: null, topic: null, status: "COMPLETED", published: false,
  photoCount: 0, videoCount: 0, photos: [], ...over,
});

test("내용 있는 수업 = 한 줄·사진·영상 중 하나라도 있음(공백만인 한 줄은 없음)", () => {
  assert.equal(r.hasFeedContent(item()), false);
  assert.equal(r.hasFeedContent(item({ content: "   " })), false);
  assert.equal(r.hasFeedContent(item({ content: "드리블" })), true);
  assert.equal(r.hasFeedContent(item({ photoCount: 1 })), true);
  assert.equal(r.hasFeedContent(item({ videoCount: 1 })), true);
});

test("요일 번호는 KST 달력 기준(시간대 개입 없음) — 2026-11-14 = 토, 11-16 = 월, 연말·윤년도", () => {
  assert.equal(r.feedWeekday("2026-11-14"), 6);
  assert.equal(r.feedWeekday("2026-11-16"), 1);
  assert.equal(r.feedWeekday("2026-11-15"), 0);
  assert.equal(r.feedWeekday("2026-12-31"), 4);
  assert.equal(r.feedWeekday("2028-02-29"), 2);
  assert.equal(r.feedWeekday("bad"), -1);
});

test("기간은 7·30·90일만, 나머지는 30일", () => {
  assert.equal(r.normalizeFeedDays("7"), 7);
  assert.equal(r.normalizeFeedDays(90), 90);
  assert.equal(r.normalizeFeedDays("365"), 30);
  assert.equal(r.normalizeFeedDays(undefined), 30);
  assert.equal(r.normalizeFeedDays("1; DROP"), 30);
});

test("필터 정규화: 허용값만 통과, 이상한 값은 그 항목만 기본값", () => {
  assert.deepEqual(r.normalizeAdminFeedFilter({}), r.DEFAULT_ADMIN_FEED_FILTER);
  const ok = r.normalizeAdminFeedFilter({ days: "7", teacher: " 김영웅 ", weekday: "1", classId: "cls_A-1", publish: "draft", includeEmpty: "1" });
  assert.deepEqual(ok, { days: 7, teacher: "김영웅", weekday: 1, classId: "cls_A-1", publish: "DRAFT", includeEmpty: true });
  // 요일은 0~6 한 글자만
  for (const bad of ["7", "-1", "1.5", "1e0", " ", "", "x", "01"]) {
    assert.equal(r.normalizeAdminFeedFilter({ weekday: bad }).weekday, -1, `요일 ${JSON.stringify(bad)}`);
  }
  assert.equal(r.normalizeAdminFeedFilter({ weekday: "0" }).weekday, 0);
  assert.equal(r.normalizeAdminFeedFilter({ weekday: 6 }).weekday, 6);
  // 반 id 는 영문·숫자·_- 만(따옴표·공백·SQL 조각 차단)
  assert.equal(r.normalizeAdminFeedFilter({ classId: "x' OR 1=1 --" }).classId, "");
  assert.equal(r.normalizeAdminFeedFilter({ classId: "a".repeat(65) }).classId, "");
  // 발행 상태는 세 값만
  assert.equal(r.normalizeAdminFeedFilter({ publish: "DELETED" }).publish, "ALL");
  // 선생님 이름은 40자 이하만
  assert.equal(r.normalizeAdminFeedFilter({ teacher: "가".repeat(41) }).teacher, "");
  assert.equal(r.normalizeAdminFeedFilter({ teacher: r.NO_TEACHER_LABEL }).teacher, r.NO_TEACHER_LABEL);
  // 내용 없는 수업은 "1"·"true"·true 만 켠다
  assert.equal(r.normalizeAdminFeedFilter({ includeEmpty: "yes" }).includeEmpty, false);
  assert.equal(r.normalizeAdminFeedFilter({ includeEmpty: "true" }).includeEmpty, true);
});

test("필터 → 주소 값 → 필터 왕복이 같고, 기본값 항목은 주소에서 빠진다", () => {
  assert.equal(r.adminFeedFilterToParams(r.DEFAULT_ADMIN_FEED_FILTER).toString(), "");
  const f = { days: 90, teacher: "박찬이", weekday: 5, classId: "c9", publish: "PUBLISHED", includeEmpty: true };
  const params = r.adminFeedFilterToParams(f);
  assert.deepEqual(r.normalizeAdminFeedFilter(Object.fromEntries(params.entries())), f);
  assert.equal(r.countActiveFilters(r.DEFAULT_ADMIN_FEED_FILTER), 0);
  assert.equal(r.countActiveFilters(f), 6);
  assert.equal(r.countActiveFilters({ ...r.DEFAULT_ADMIN_FEED_FILTER, weekday: 0 }), 1, "일요일(0)도 적용으로 센다");
});

test("커서: 만들고 되읽기, 모양이 틀리면 null", () => {
  const cursor = r.encodeAdminFeedCursor(item({ ymd: "2026-11-13", startTime: "15:00", sessionId: "cmabc_1" }));
  assert.equal(cursor, "2026-11-13~15:00~cmabc_1");
  assert.deepEqual(r.decodeAdminFeedCursor(cursor), { ymd: "2026-11-13", startTime: "15:00", id: "cmabc_1" });
  // 시작 시각이 없는 반은 빈 문자열(SQL 의 COALESCE(startTime, '') 와 같은 값)
  assert.deepEqual(r.decodeAdminFeedCursor(r.encodeAdminFeedCursor(item({ startTime: null, sessionId: "s2" }))), { ymd: "2026-11-14", startTime: "", id: "s2" });
  for (const bad of [null, undefined, 3, "", "2026-11-13~15:00", "2026-13-01~15:00~a", "2026-11-13~15:00~a b", "2026-11-13~15:00~x'--", "2026-11-13~123456789012~a", "a~b~c~d", "x".repeat(121)]) {
    assert.equal(r.decodeAdminFeedCursor(bad), null, `커서 ${JSON.stringify(bad)}`);
  }
});

test("한 장 나누기: 한 개 더 읽었으면 다음 커서 = 이번 몫의 마지막", () => {
  const rows = Array.from({ length: 21 }, (_, i) => item({ sessionId: `s${i}`, ymd: "2026-11-10" }));
  const page = r.splitAdminFeedPage(rows, 20);
  assert.equal(page.items.length, 20);
  assert.equal(page.nextCursor, "2026-11-10~10:00~s19");
  const last = r.splitAdminFeedPage(rows.slice(0, 20), 20);
  assert.equal(last.items.length, 20);
  assert.equal(last.nextCursor, null);
  assert.equal(r.splitAdminFeedPage([], 20).nextCursor, null);
  assert.equal(r.ADMIN_FEED_PAGE_SIZE, 20);
});

test("이어 붙이기: 이미 받은 수업은 다시 붙이지 않는다(같은 몫 안 중복도)", () => {
  const merged = r.appendAdminFeedItems([item({ sessionId: "a" }), item({ sessionId: "b" })], [item({ sessionId: "b" }), item({ sessionId: "c" }), item({ sessionId: "c" })]);
  assert.deepEqual(merged.map((i) => i.sessionId), ["a", "b", "c"]);
});

test("화면 글자: 날짜 구분줄·게시물 머리줄", () => {
  assert.equal(r.feedDateHeading("2026-11-13"), "11월 13일 (금)");
  assert.equal(r.feedDateHeading("bad"), "bad");
  assert.equal(r.feedPostHeading(item({ className: "금요일 3교시", ymd: "2026-11-13", startTime: "15:00", teacherName: "박찬이" })), "금요일 3교시 · 11/13(금) 15:00 · 박찬이");
  assert.equal(r.feedPostHeading(item({ className: "토요일 1교시", startTime: null, teacherName: "  " })), `토요일 1교시 · 11/14(토) · ${r.NO_TEACHER_LABEL}`);
  const list = [item({ ymd: "2026-11-14" }), item({ ymd: "2026-11-14" }), item({ ymd: "2026-11-13" })];
  assert.deepEqual(list.map((_, i) => r.needsDateDivider(list, i)), [true, false, true]);
  assert.equal(r.needsDateDivider(list, 3), false);
});

test("담당 선생님 SQL: 수업 기록 코치 → 시간표 칸 → 반 담당 강사 순, 별칭을 그대로 쓴다", () => {
  const sql = r.classCoachNameSql("se", "c");
  const order = ['se."coachId"', '"ClassSlotOverride"', '"ScheduleSlot"', '"CustomClassSlot"', 'c."instructorId"'].map((s) => sql.indexOf(s));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("화면·API 는 관리자 확인을 가장 먼저 하고, 조회는 바인딩 값만 쓴다", () => {
  const page = read("src/app/admin/attendance/feed/page.tsx");
  const guard = page.indexOf("await requireAdmin()");
  assert.ok(guard >= 0 && guard < page.indexOf("getAdminFeedPage(") && guard < page.indexOf("getAdminFeedFacets("));

  const api = read("src/app/api/admin/feed/route.ts");
  const apiGuard = api.indexOf("await requireAdmin()");
  assert.ok(apiGuard >= 0, "API 가 requireAdmin 을 부른다");
  for (const call of ["searchParams", "getAdminFeedItem(", "getAdminFeedPage(", "getAdminFeedFacets(", "normalizeAdminFeedFilter(", "decodeAdminFeedCursor("]) {
    assert.ok(api.indexOf(call) > apiGuard, `${call} 는 관리자 확인 뒤에`);
  }
  assert.match(api, /normalizeFeedId\(search\.get\("sessionId"\)\)/, "카드 다시 읽기 id 도 모양 검사");
  assert.doesNotMatch(api, /apiSuccess\(|import[^;]*apiSuccess/, "snake_case 자동 변환을 거치지 않는다");

  const server = read("src/lib/feed/adminFeedServer.ts");
  // 사용자 값은 bind() 로만 — 필터 값이 SQL 문자열에 직접 붙지 않는다
  assert.doesNotMatch(server, /\$\{filter\.(teacher|classId|publish|weekday|days)\}/);
  assert.doesNotMatch(server, /\$\{cursor\.(ymd|startTime|id)\}/);
  assert.match(server, /bind\(filter\.teacher\)/);
  assert.match(server, /bind\(filter\.classId\)/);
  assert.match(server, /bind\(cursor\.id\)/);
  // 정렬과 커서 비교가 같은 세 값(수업일·시작 시각·id)
  assert.match(server, /ORDER BY \$\{SESSION_DATE\} DESC, COALESCE\(c\."startTime", ''\) DESC, se\.id DESC/);
  assert.match(server, /const ORDER_KEY = `\$\{SESSION_DATE\}, COALESCE\(c\."startTime", ''\), se\.id`/);
  // 수업일은 무tz 칼럼 «두 번» 변환 조각을 쓴다
  assert.match(server, /sessionKstDateSql\("se"\)/);
});

test("학부모 화면 담당 이름도 같은 SQL 을 쓴다", () => {
  const server = read("src/lib/feed/server.ts");
  assert.equal((server.match(/\$\{classCoachNameSql\("se", "c"\)\} AS "coachName"/g) ?? []).length, 2);
  assert.match(read("src/lib/queries.ts"), /\$\{classCoachNameSql\("se", "c"\)\} AS coach_name/);
});

test("편집은 기존 서버 액션 재사용 · 리포트 편집 화면과 피드 패널이 같은 부품 · 옛 목록 주소는 피드로", () => {
  const editor = read("src/components/admin/SessionReportEditor.tsx");
  for (const action of ["saveSessionReport(", "saveStudentSessionNotes(", "publishSessionReport("]) assert.ok(editor.includes(action), action);
  assert.match(editor, /from "@\/app\/actions\/admin"/);
  assert.doesNotMatch(editor, /\bconfirm\(/, "발행 확인은 confirm 창 대신 버튼 자리에서");
  assert.match(read("src/app/admin/attendance/report/[sessionId]/ReportEditClient.tsx"), /<SessionReportEditor /);
  const client = read("src/app/admin/attendance/feed/AdminFeedClient.tsx");
  assert.match(client, /<SessionReportEditorLoader/);
  assert.match(client, /IntersectionObserver/);
  assert.match(client, /snap-x snap-mandatory/);
  assert.match(client, /\/api\/admin\/feed\?/);
  const list = read("src/app/admin/attendance/report/page.tsx");
  assert.ok(list.indexOf("await requireAdmin()") >= 0 && list.indexOf("await requireAdmin()") < list.indexOf('redirect("/admin/attendance/feed")'));
  assert.match(read("src/lib/admin-sections.ts"), /\/admin\/attendance\/feed/);
});
