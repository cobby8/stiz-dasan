// 2026-11-14 관리자 «수업 피드» 화면 — 순수 규칙을 실제로 돌리고, 화면·조회의 권한·연결을 소스로 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const r = await loadTsModule("src/lib/feed/adminFeedRules.ts");
const read = (path) => readFileSync(path, "utf8");

const item = (over = {}) => ({
  sessionId: "s1", ymd: "2026-11-14", className: "토요일 1교시", startTime: "10:00", endTime: "11:00",
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

test("글 앞부분: 줄바꿈은 공백, 글자 단위로 자르고 말줄임표", () => {
  assert.equal(r.feedPreview(null), "");
  assert.equal(r.feedPreview("가\n나   다"), "가 나 다");
  assert.equal(r.feedPreview("가나다라마", 3), "가나다…");
  assert.equal(r.feedPreview("😀😀😀😀", 2), "😀😀…");
});

test("요일 번호는 KST 달력 기준(시간대 개입 없음) — 2026-11-14 = 토, 11-16 = 월", () => {
  assert.equal(r.feedWeekday("2026-11-14"), 6);
  assert.equal(r.feedWeekday("2026-11-16"), 1);
  assert.equal(r.feedWeekday("2026-11-15"), 0);
  assert.equal(r.feedWeekday("bad"), -1);
});

test("요일별 묶음: 월요일부터, 수업 있는 요일만, 묶음 안 순서 유지", () => {
  const items = [
    item({ sessionId: "sat2", ymd: "2026-11-14" }),
    item({ sessionId: "mon", ymd: "2026-11-09" }),
    item({ sessionId: "sun", ymd: "2026-11-08" }),
    item({ sessionId: "sat1", ymd: "2026-11-07" }),
  ];
  const groups = r.groupAdminFeed(items, "weekday");
  assert.deepEqual(groups.map((g) => g.label), ["월요일", "토요일", "일요일"]);
  assert.deepEqual(groups[1].items.map((i) => i.sessionId), ["sat2", "sat1"]);
});

test("선생님별 묶음: 가나다순, «담당 미지정»은 맨 뒤", () => {
  const groups = r.groupAdminFeed([
    item({ sessionId: "a", teacherName: null }),
    item({ sessionId: "b", teacherName: "이병하" }),
    item({ sessionId: "c", teacherName: "김영웅" }),
    item({ sessionId: "d", teacherName: "  " }),
  ], "teacher");
  assert.deepEqual(groups.map((g) => g.label), ["김영웅", "이병하", r.NO_TEACHER_LABEL]);
  assert.deepEqual(groups[2].items.map((i) => i.sessionId), ["a", "d"]);
});

test("전체 보기는 묶음 하나, 빈 목록은 묶음 없음", () => {
  assert.equal(r.groupAdminFeed([item()], "all").length, 1);
  assert.equal(r.groupAdminFeed([], "all").length, 0);
});

test("필터: 기본은 내용 있는 수업만, 발행·선생님·요일 조건", () => {
  const items = [
    item({ sessionId: "empty" }),
    item({ sessionId: "pubPhoto", photoCount: 2, published: true }),
    item({ sessionId: "draftLine", content: "슛", teacherName: "김영웅", ymd: "2026-11-09" }),
  ];
  const ids = (f) => r.applyAdminFeedFilter(items, { ...r.DEFAULT_ADMIN_FEED_FILTER, ...f }).map((i) => i.sessionId);
  assert.deepEqual(ids({}), ["pubPhoto", "draftLine"]);
  assert.deepEqual(ids({ includeEmpty: true }), ["empty", "pubPhoto", "draftLine"]);
  assert.deepEqual(ids({ publish: "PUBLISHED" }), ["pubPhoto"]);
  assert.deepEqual(ids({ publish: "DRAFT" }), ["draftLine"]);
  assert.deepEqual(ids({ teacher: "김영웅" }), ["draftLine"]);
  assert.deepEqual(ids({ weekday: 1 }), ["draftLine"]);
  assert.equal(r.countActiveFilters(r.DEFAULT_ADMIN_FEED_FILTER), 0);
  assert.equal(r.countActiveFilters({ publish: "DRAFT", includeEmpty: true, teacher: "x", weekday: 2 }), 4);
});

test("기간은 7·30·90일만, 나머지는 30일", () => {
  assert.equal(r.normalizeFeedDays("7"), 7);
  assert.equal(r.normalizeFeedDays(90), 90);
  assert.equal(r.normalizeFeedDays("365"), 30);
  assert.equal(r.normalizeFeedDays(undefined), 30);
  assert.equal(r.normalizeFeedDays("1; DROP"), 30);
});

test("담당 선생님 SQL: 수업 기록 코치 → 시간표 칸 → 반 담당 강사 순, 별칭을 그대로 쓴다", () => {
  const sql = r.classCoachNameSql("se", "c");
  const order = ['se."coachId"', '"ClassSlotOverride"', '"ScheduleSlot"', '"CustomClassSlot"', 'c."instructorId"'].map((s) => sql.indexOf(s));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("관리자 피드 화면은 관리자 확인 후에만 읽고, 학부모 화면 담당 이름도 같은 SQL 을 쓴다", () => {
  const page = read("src/app/admin/attendance/feed/page.tsx");
  assert.ok(page.indexOf("await requireAdmin()") >= 0 && page.indexOf("await requireAdmin()") < page.indexOf("getAdminFeedItems("));
  assert.match(read("src/lib/admin-sections.ts"), /\/admin\/attendance\/feed/);
  const server = read("src/lib/feed/server.ts");
  assert.equal((server.match(/classCoachNameSql\("se", "c"\) \}? ?AS "coachName"|\$\{classCoachNameSql\("se", "c"\)\} AS "coachName"/g) ?? []).length, 2);
  assert.match(read("src/lib/queries.ts"), /\$\{classCoachNameSql\("se", "c"\)\} AS coach_name/);
});
