import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 출결 화면 주소 쿼리(?date=&lesson=) 해석 — 대시보드 «오늘 수업 처리 현황» 줄이 보내는 주소를
// 출결 화면이 읽어 그 날짜·그 수업을 여는지 «실제로 실행»해서 확인한다. 실제 시계·DB 는 쓰지 않는다.

const q = await loadTsModule("src/lib/attendance/lessonQuery.ts");
const board = await loadTsModule("src/lib/class-nudge/board.ts");

test("정상 주소 — 날짜와 두 가지 수업 형식을 읽는다", () => {
  assert.deepEqual(q.parseAttendanceOpenQuery({ date: "2026-11-17", lesson: "regular:cls_1" }), { date: "2026-11-17", lesson: { kind: "regular", id: "cls_1" } });
  assert.deepEqual(q.parseAttendanceOpenQuery({ date: "2026-11-17", lesson: "seasonal:sd-9" }), { date: "2026-11-17", lesson: { kind: "seasonal", id: "sd-9" } });
  // uuid 모양 id 도 통과
  assert.deepEqual(q.parseAttendanceLessonKey("regular:0b9c2a1e-7f3d-4c1a-9b2e-1234567890ab"), { kind: "regular", id: "0b9c2a1e-7f3d-4c1a-9b2e-1234567890ab" });
});

test("쿼리가 없거나 날짜가 틀리면 null — 예전처럼 오늘 화면", () => {
  assert.equal(q.parseAttendanceOpenQuery(undefined), null);
  assert.equal(q.parseAttendanceOpenQuery(null), null);
  assert.equal(q.parseAttendanceOpenQuery({}), null);
  // 수업만 있고 날짜가 없으면 무시
  assert.equal(q.parseAttendanceOpenQuery({ lesson: "regular:cls_1" }), null);
  for (const bad of ["", "2026-11-7", "2026/11/17", "20261117", "2026-11-17T00:00", " 2026-11-17", "2026-11-17 ", "2026-13-01", "2026-02-30", "2027-02-29", "abcd-ef-gh", "2026-11-17\n"]) {
    assert.equal(q.parseAttendanceOpenQuery({ date: bad, lesson: "regular:cls_1" }), null, JSON.stringify(bad));
  }
  // 문자열이 아닌 값
  assert.equal(q.parseAttendanceOpenQuery({ date: 20261117 }), null);
  assert.equal(q.parseAttendanceOpenQuery({ date: {} }), null);
});

test("윤년·월말·연말 경계 날짜는 실제 달력대로", () => {
  assert.equal(q.parseAttendanceOpenQuery({ date: "2028-02-29" })?.date, "2028-02-29");
  assert.equal(q.parseAttendanceOpenQuery({ date: "2026-12-31" })?.date, "2026-12-31");
  assert.equal(q.parseAttendanceOpenQuery({ date: "2027-01-01" })?.date, "2027-01-01");
  assert.equal(q.parseAttendanceOpenQuery({ date: "2026-11-31" }), null);
});

test("볼 수 있는 기간(2020~2030) 밖 날짜는 무시", () => {
  assert.equal(q.parseAttendanceOpenQuery({ date: "2019-12-31" }), null);
  assert.equal(q.parseAttendanceOpenQuery({ date: "2031-01-01" }), null);
  assert.equal(q.parseAttendanceOpenQuery({ date: "2020-01-01" })?.date, "2020-01-01");
  assert.equal(q.parseAttendanceOpenQuery({ date: "2030-12-31" })?.date, "2030-12-31");
});

test("날짜는 맞고 수업이 틀리면 그 날짜만 연다(lesson = null)", () => {
  for (const bad of [undefined, "", "regular:", "seasonal:", "cls_1", "REGULAR:cls_1", "makeup:cls_1", "regular:a b", "regular:a/b", "regular:a?x=1", "regular:../x", "regular:<script>", " regular:cls_1", "regular:cls_1 ", "regular:a:b", "regular:" + "a".repeat(101), 123, {}]) {
    assert.deepEqual(q.parseAttendanceOpenQuery({ date: "2026-11-17", lesson: bad }), { date: "2026-11-17", lesson: null }, JSON.stringify(bad));
  }
  assert.equal(q.parseAttendanceLessonKey("regular:" + "a".repeat(100))?.id.length, 100);
});

test("같은 이름이 두 번 온 주소(배열)는 첫 값만 본다", () => {
  assert.deepEqual(q.parseAttendanceOpenQuery({ date: ["2026-11-17", "2026-11-18"], lesson: ["seasonal:sd1", "regular:c1"] }), { date: "2026-11-17", lesson: { kind: "seasonal", id: "sd1" } });
  assert.equal(q.parseAttendanceOpenQuery({ date: [] }), null);
});

test("그날 목록에서 수업 찾기 — 정규는 반 id, 특강은 회차 id, 종류가 다르면 고르지 않는다", () => {
  const lessons = [
    { id: "c1", kind: "REGULAR", sessionDateId: null, name: "정규 A" },
    { id: "c2", name: "종류 표시 없는 옛 정규" },
    { id: "sc1", kind: "SEASONAL", sessionDateId: "sd1", name: "특강 1회차" },
    { id: "sc1", kind: "SEASONAL", sessionDateId: "sd2", name: "특강 2회차" },
  ];
  assert.equal(q.findLessonForTarget(lessons, { kind: "regular", id: "c1" })?.name, "정규 A");
  assert.equal(q.findLessonForTarget(lessons, { kind: "regular", id: "c2" })?.name, "종류 표시 없는 옛 정규");
  assert.equal(q.findLessonForTarget(lessons, { kind: "seasonal", id: "sd2" })?.name, "특강 2회차");
  // 특강 반 id 를 정규로, 정규 반 id 를 특강으로 가리키면 못 찾는다
  assert.equal(q.findLessonForTarget(lessons, { kind: "regular", id: "sc1" }), null);
  assert.equal(q.findLessonForTarget(lessons, { kind: "seasonal", id: "c1" }), null);
  // 목록에 없는 수업(휴강·지난 주소)·대상 없음
  assert.equal(q.findLessonForTarget(lessons, { kind: "regular", id: "none" }), null);
  assert.equal(q.findLessonForTarget(lessons, null), null);
  assert.equal(q.findLessonForTarget([], { kind: "regular", id: "c1" }), null);
});

test("대시보드가 만드는 주소(classDayHref)를 그대로 해석할 수 있다 — 두 쪽 형식이 어긋나지 않게", () => {
  for (const key of ["regular:cls_abc", "seasonal:sd_123"]) {
    const url = new URL(board.classDayHref("2026-11-17", key), "https://example.test");
    assert.equal(url.pathname, "/admin/attendance");
    const parsed = q.parseAttendanceOpenQuery({ date: url.searchParams.get("date"), lesson: url.searchParams.get("lesson") });
    assert.equal(parsed?.date, "2026-11-17");
    assert.equal(`${parsed?.lesson?.kind}:${parsed?.lesson?.id}`, key);
  }
});

test("출결 화면이 해석 결과를 실제로 쓴다(연결 확인)", () => {
  const page = readFileSync("src/app/admin/attendance/page.tsx", "utf8");
  // 관리자 확인이 쿼리 해석·조회보다 먼저
  const guard = page.indexOf("await requireAdmin()");
  assert.ok(guard > 0 && guard < page.indexOf("parseAttendanceOpenQuery(await searchParams)"));
  assert.ok(page.includes("getCachedAdminAttendancePayload(target?.date)"), "지정한 날짜의 수업 목록을 읽는다");
  assert.ok(page.includes("initialOpen={target}"));
  const client = readFileSync("src/app/admin/attendance/AttendanceClient.tsx", "utf8");
  assert.ok(client.includes("findLessonForTarget(initialClasses ?? [], initialOpen?.lesson ?? null)"), "그날 목록에서 수업을 찾는다");
  assert.ok(client.includes("useState(initialLessonKey)"), "찾은 수업으로 패널을 연다");
  assert.ok(client.includes("useState(() => initialOpen?.date ?? todayKst())"), "날짜는 주소 값 → 없으면 오늘");
  assert.ok(client.includes("mondayOf(initialOpen?.date ?? todayKst())"), "주간 보드도 그 날짜가 든 주");
});
