import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { buildAddRows, buildCounterpartReorderUpdates, buildMoveUpdates, buildReorderUpdates, reassignSortSlots, validateReorderInput, catchUpDateRange, findCounterpartRows, idPairArrays, formatRosterMonths, groupRosterDay, isSameRosterStudent, nextServiceMonth, normalizeRosterScope, planEnsureMonths, remapStopRowIds, rosterStudentKeyResolver, nextSortOrder, normalizeArriveTime, normalizeClassTime, normalizeCoords, rosterRowIdsForStudent, RosterInputError, validateAddInput, validateCopyInput, validateMoveInput, validateRemoveInput, validateStopEditInput, type RosterExistingRow } from "./regularRosterEditLogic.ts";

// 기존 행 한 줄
function row(over: Partial<RosterExistingRow> = {}): RosterExistingRow {
  return { id: "r1", weekday: 1, direction: "BOARD", classTime: "17:00~18:00", sortOrder: 3, studentId: "s1", studentName: "김민준", ...over };
}
const stop = { stopName: "다산자이 정문", arriveTime: "16:40", latitude: 37.6, longitude: 127.15 };

test("다음 달은 문자열 계산으로 연말을 넘긴다", () => {
  assert.equal(nextServiceMonth("2026-09"), "2026-10");
  assert.equal(nextServiceMonth("2026-12"), "2027-01");
  assert.throws(() => nextServiceMonth("2026-13"), RosterInputError);
});

test("도착시각은 HH:MM 으로 맞추고 비우면 null", () => {
  assert.equal(normalizeArriveTime("9:05"), "09:05");
  assert.equal(normalizeArriveTime(""), null);
  assert.equal(normalizeArriveTime(null), null);
  assert.throws(() => normalizeArriveTime("24:00"), RosterInputError);
  assert.throws(() => normalizeArriveTime("오후5시"), RosterInputError);
});

test("수업시간은 물결 주변 공백만 정리한다", () => {
  assert.equal(normalizeClassTime(" 17:00 ~ 18:00 "), "17:00~18:00");
  assert.throws(() => normalizeClassTime("  "), RosterInputError);
});

test("좌표는 둘 다 있거나 둘 다 없어야 하고 한국 범위여야 한다", () => {
  assert.deepEqual(normalizeCoords(null, null), { latitude: null, longitude: null });
  assert.deepEqual(normalizeCoords(37.6, 127.1), { latitude: 37.6, longitude: 127.1 });
  assert.throws(() => normalizeCoords(37.6, null), RosterInputError);
  assert.throws(() => normalizeCoords(0, 0), RosterInputError);
});

test("학생 추가 입력: 학생·요일·등하원 중 하나는 필수", () => {
  const base = { serviceMonth: "2026-10", studentId: "s1", weekdays: [3, 1, 1], classTime: "17:00~18:00", board: stop, alight: null };
  const ok = validateAddInput(base);
  assert.deepEqual(ok.weekdays, [1, 3]);
  assert.equal(ok.alight, null);
  assert.throws(() => validateAddInput({ ...base, studentId: "", studentName: "" }), /학생을 선택/);
  assert.throws(() => validateAddInput({ ...base, weekdays: [] }), /요일/);
  assert.throws(() => validateAddInput({ ...base, board: null }), /하나 이상/);
  assert.throws(() => validateAddInput({ ...base, board: { ...stop, stopName: " " } }), /등원 정류장 이름/);
  assert.throws(() => validateAddInput({ ...base, serviceMonth: "2026-9" }), /YYYY-MM/);
});

test("정렬순서는 같은 요일·방향·수업의 마지막 뒤, 없으면 그 요일 맨 뒤", () => {
  const rows = [row({ sortOrder: 2 }), row({ id: "r2", sortOrder: 5 }), row({ id: "r3", direction: "ALIGHT", sortOrder: 9 })];
  assert.equal(nextSortOrder(rows, 1, "BOARD", "17:00~18:00"), 6);
  assert.equal(nextSortOrder(rows, 1, "BOARD", "19:00~20:00"), 10);
  assert.equal(nextSortOrder(rows, 2, "BOARD", "17:00~18:00"), 0);
});

test("학생 추가는 요일×방향마다 행을 만들고 같은 요청 안에서도 순서를 이어 붙인다", () => {
  const input = validateAddInput({ serviceMonth: "2026-10", studentId: "s9", weekdays: [1, 2], classTime: "17:00~18:00", board: stop, alight: { ...stop, arriveTime: "" } });
  const rows = buildAddRows(input, [row()], "이서연");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => [r.weekday, r.direction, r.sortOrder]), [[1, "BOARD", 4], [1, "ALIGHT", 5], [2, "BOARD", 0], [2, "ALIGHT", 1]]);
  assert.equal(rows[1].arriveTime, null);
});

test("이미 같은 요일·방향·수업에 있는 학생은 중복 추가를 거부한다", () => {
  const input = validateAddInput({ serviceMonth: "2026-10", studentId: "s1", weekdays: [1], classTime: "17:00~18:00", board: stop, alight: null });
  assert.throws(() => buildAddRows(input, [row()], "김민준"), /이미 명단에 있습니다/);
  // 이름만 등록된 학생도 이름으로 중복을 막는다
  const byName = validateAddInput({ serviceMonth: "2026-10", studentName: "김 민준", weekdays: [1], classTime: "17:00~18:00", board: stop, alight: null });
  assert.throws(() => buildAddRows(byName, [row({ studentId: null })], "김 민준"), /이미 명단에 있습니다/);
});

test("반이동은 새 요일·수업으로 옮기고 그 자리에 이미 있으면 거부한다", () => {
  const rows = [row(), row({ id: "r2", direction: "ALIGHT", sortOrder: 4 }), row({ id: "x1", weekday: 3, classTime: "18:00~19:00", studentId: "s2", sortOrder: 7 })];
  const updates = buildMoveUpdates(["r1", "r2"], 3, "18:00~19:00", rows);
  assert.deepEqual(updates, [
    { id: "r1", weekday: 3, classTime: "18:00~19:00", sortOrder: 8 },
    { id: "r2", weekday: 3, classTime: "18:00~19:00", sortOrder: 9 },
  ]);
  const clash = [...rows, row({ id: "r9", weekday: 3, classTime: "18:00~19:00" })];
  assert.throws(() => buildMoveUpdates(["r1"], 3, "18:00~19:00", clash), /이미 있습니다/);
  assert.throws(() => buildMoveUpdates(["nope"], 3, "18:00~19:00", rows), /찾지 못했습니다/);
  assert.throws(() => buildMoveUpdates(["r1"], 3, "18:00~19:00", [row({ direction: "PIVOT" })]), /찾지 못했습니다/);
});

test("반이동은 한 학생의 행만 받는다(다른 학생 행이 섞이면 거부)", () => {
  // studentId 가 다른 두 학생
  const mixed = [row(), row({ id: "r2", direction: "ALIGHT", studentId: "s2", studentName: "이서연" })];
  assert.throws(() => buildMoveUpdates(["r1", "r2"], 3, "18:00~19:00", mixed), /한 학생/);
  // 이름만 등록된 행: 같은 이름이라도 학부모 전화가 다르면 다른 학생
  const byName = [
    row({ studentId: null, studentName: "박지호", parentPhone: "010-1111-2222" }),
    row({ id: "r2", direction: "ALIGHT", studentId: null, studentName: "박지호", parentPhone: "010-3333-4444" }),
  ];
  assert.throws(() => buildMoveUpdates(["r1", "r2"], 3, "18:00~19:00", byName), /한 학생/);
  // 이름·전화가 같으면 같은 학생 → 통과
  const same = [byName[0], { ...byName[1], parentPhone: "010-1111-2222" }];
  assert.equal(buildMoveUpdates(["r1", "r2"], 3, "18:00~19:00", same).length, 2);
});

test("빼기·반이동·정류장·복사 입력 검증", () => {
  assert.deepEqual(validateRemoveInput({ serviceMonth: "2026-10", ids: ["a", "a", " b "] }).ids, ["a", "b"]);
  assert.throws(() => validateRemoveInput({ serviceMonth: "2026-10", ids: [] }), RosterInputError);
  assert.equal(validateMoveInput({ serviceMonth: "2026-10", ids: ["a"], weekday: "2", classTime: "17:00~18:00" }).weekday, 2);
  assert.throws(() => validateMoveInput({ serviceMonth: "2026-10", ids: ["a"], weekday: 7, classTime: "x" }), /요일/);
  const edit = validateStopEditInput({ serviceMonth: "2026-10", id: "a", stop, applyToAll: "true" });
  assert.equal(edit.applyToAll, false); // 문자열 "true" 로는 일괄 변경이 켜지지 않는다
  assert.throws(() => validateCopyInput({ sourceMonth: "2026-10", targetMonth: "2026-10" }), /같습니다/);
});

test("화면 묶음: 수업시간별 학생에 등원·하원을 붙이고 운영 정차는 뺀다", () => {
  const base = { classTime: "17:00~18:00", arriveTime: null, stopName: "A", studentPhone: null, parentPhone: "010-1111-2222", note: null, sortOrder: 0 };
  const stops = [
    { ...base, id: "1", weekday: 1, direction: "BOARD", studentName: "나", studentId: "s2" },
    { ...base, id: "2", weekday: 1, direction: "ALIGHT", studentName: "나", studentId: "s2", stopName: "B" },
    { ...base, id: "3", weekday: 1, direction: "BOARD", studentName: "가", studentId: null },
    { ...base, id: "4", weekday: 1, direction: "PIVOT", studentName: null, studentId: null },
    { ...base, id: "5", weekday: 1, direction: "BOARD", studentName: "다", studentId: "s3", classTime: null },
    { ...base, id: "6", weekday: 2, direction: "BOARD", studentName: "나", studentId: "s2" },
  ];
  const groups = groupRosterDay(stops, 1);
  assert.deepEqual(groups.map((g) => g.classTime), ["17:00~18:00", ""]);
  assert.deepEqual(groups[0].students.map((s) => s.studentName), ["가", "나"]);
  assert.equal(groups[0].students[1].board?.id, "1");
  assert.equal(groups[0].students[1].alight?.id, "2");
  assert.deepEqual(rosterRowIdsForStudent(stops, "id:s2"), ["1", "2", "6"]);
});

// ── 2026-10-02 월 자동 생성 · 적용 범위 · 두 줄 표시 ─────────────────────

test("월 자동 생성 계획: 이번 달·다음 달이 없으면 직전 최근 달을 차례로 복사한다", () => {
  // 10월이 없으면 09→10, 그다음 10→11
  assert.deepEqual(planEnsureMonths(["2026-08", "2026-09"], "2026-10"), [
    { sourceMonth: "2026-09", targetMonth: "2026-10" },
    { sourceMonth: "2026-10", targetMonth: "2026-11" },
  ]);
  // 이미 둘 다 있으면 아무것도 안 한다(멱등)
  assert.deepEqual(planEnsureMonths(["2026-09", "2026-10", "2026-11"], "2026-10"), []);
  // 다음 달만 없으면 이번 달을 원본으로
  assert.deepEqual(planEnsureMonths(["2026-10"], "2026-10"), [{ sourceMonth: "2026-10", targetMonth: "2026-11" }]);
  // 몇 달 비어 있어도 가장 최근 달에서 이어 만든다
  assert.deepEqual(planEnsureMonths(["2026-06"], "2026-10").map((s) => s.sourceMonth), ["2026-06", "2026-10"]);
  // 연말 넘김
  assert.deepEqual(planEnsureMonths(["2026-11"], "2026-12"), [
    { sourceMonth: "2026-11", targetMonth: "2026-12" },
    { sourceMonth: "2026-12", targetMonth: "2027-01" },
  ]);
  // 명단이 아예 없거나 미래 달만 있으면 만들지 않는다
  assert.deepEqual(planEnsureMonths([], "2026-10"), []);
  assert.deepEqual(planEnsureMonths(["2027-03"], "2026-10"), []);
  // 형식이 이상한 달은 원본으로 쓰지 않는다
  assert.deepEqual(planEnsureMonths(["bad", "2026-13"], "2026-10"), []);
});

test("적용 범위: 비우면 이후 달까지(FROM_THIS_MONTH), 이상한 값은 거부", () => {
  assert.equal(normalizeRosterScope(undefined), "FROM_THIS_MONTH");
  assert.equal(normalizeRosterScope(""), "FROM_THIS_MONTH");
  assert.equal(normalizeRosterScope("THIS_MONTH"), "THIS_MONTH");
  assert.throws(() => normalizeRosterScope("ALL"), RosterInputError);
  assert.equal(validateRemoveInput({ serviceMonth: "2026-10", ids: ["a"] }).scope, "FROM_THIS_MONTH");
  assert.equal(validateMoveInput({ serviceMonth: "2026-10", ids: ["a"], weekday: 1, classTime: "17:00~18:00", scope: "THIS_MONTH" }).scope, "THIS_MONTH");
  assert.equal(validateStopEditInput({ serviceMonth: "2026-10", id: "a", stop }).scope, "FROM_THIS_MONTH");
  assert.equal(validateAddInput({ serviceMonth: "2026-10", studentId: "s1", weekdays: [1], classTime: "17:00~18:00", board: stop, alight: null, scope: "THIS_MONTH" }).scope, "THIS_MONTH");
});

test("반영 달 문구는 'N월·M월'", () => {
  assert.equal(formatRosterMonths(["2026-10", "2026-11"]), "10월·11월");
  assert.equal(formatRosterMonths(["2026-12", "2027-01"]), "12월·1월");
});

test("이후 달 대응 행: studentId 우선, 없으면 이름+학부모전화 끝4자리 + 요일·방향·수업시간", () => {
  const later = [
    row({ id: "n1", studentId: "s1", parentPhone: "010-1111-2222" }),
    row({ id: "n2", studentId: "s1", direction: "ALIGHT" }),
    row({ id: "n3", studentId: null, studentName: "이 서준", parentPhone: "01033334444" }),
    row({ id: "n4", studentId: "s9", studentName: "김민준" }), // 동명이인(다른 id)
    row({ id: "n5", studentId: "s1", classTime: "18:00~19:00" }),
  ];
  // id 로 찾고 방향·수업시간이 다르면 대응 행이 아니다
  assert.deepEqual(findCounterpartRows(row({ studentId: "s1" }), later).map((r) => r.id), ["n1"]);
  // 이름만 등록 행: 공백 무시 이름 + 전화 끝4자리
  assert.deepEqual(findCounterpartRows(row({ studentId: null, studentName: "이서준", parentPhone: "010-3333-4444" }), later).map((r) => r.id), ["n3"]);
  // 전화 끝자리가 다르면 다른 학생
  assert.deepEqual(findCounterpartRows(row({ studentId: null, studentName: "이서준", parentPhone: "010-3333-0000" }), later), []);
  // 요일이 다르면 없음
  assert.deepEqual(findCounterpartRows(row({ studentId: "s1", weekday: 3 }), later), []);
  // 한쪽만 studentId 가 있으면 이름+전화로 잇는다, 둘 다 있으면 id 로만
  assert.equal(isSameRosterStudent({ studentId: "s1", studentName: "김민준", parentPhone: "010-1-2222" }, { studentId: null, studentName: "김 민준", parentPhone: "2222" }), true);
  assert.equal(isSameRosterStudent({ studentId: "s1", studentName: "김민준" }, { studentId: "s9", studentName: "김민준" }), false);
  assert.equal(isSameRosterStudent({ studentId: null, studentName: "" }, { studentId: null, studentName: "" }), false);
});

test("이후 달 학생 추가는 이미 있는 행만 건너뛰고 나머지를 만든다", () => {
  const input = validateAddInput({ serviceMonth: "2026-10", studentId: "s1", weekdays: [1, 3], classTime: "17:00~18:00", board: stop, alight: null });
  const existing = [row({ id: "x", weekday: 1, studentId: "s1" })]; // 월요일은 이미 있음
  assert.throws(() => buildAddRows(input, existing, "김민준"), /이미 명단에 있습니다/); // 고른 달은 거부
  const extra = buildAddRows(input, existing, "김민준", { skipDuplicates: true });
  assert.deepEqual(extra.map((r) => r.weekday), [3]);
  assert.deepEqual(buildAddRows({ ...input, weekdays: [1] }, existing, "김민준", { skipDuplicates: true }), []);
});

test("두 줄 표시 버그: 같은 이름+전화 끝4자리 중 studentId 가 있으면 id 없는 행도 같은 학생으로 묶는다", () => {
  const base = { classTime: "17:00~18:00", arriveTime: null, stopName: "A", studentPhone: null, note: null, sortOrder: 0 };
  const stops = [
    { ...base, id: "b", weekday: 2, direction: "BOARD", studentName: "목주찬", studentId: "mok", parentPhone: "010-5555-6666" },
    { ...base, id: "a", weekday: 2, direction: "ALIGHT", studentName: "목 주찬", studentId: null, parentPhone: "01055556666" },
    // 다른 요일의 id 없는 행도 같은 학생
    { ...base, id: "c", weekday: 4, direction: "BOARD", studentName: "목주찬", studentId: null, parentPhone: "010-0000-6666" },
    // 전화 끝자리가 다르면 다른 학생으로 둔다
    { ...base, id: "d", weekday: 2, direction: "BOARD", studentName: "목주찬", studentId: null, parentPhone: "010-5555-7777" },
  ];
  const day = groupRosterDay(stops, 2)[0].students;
  assert.equal(day.length, 2);
  const mok = day.find((s) => s.key === "id:mok");
  assert.equal(mok?.board?.id, "b");
  assert.equal(mok?.alight?.id, "a");
  assert.equal(mok?.studentId, "mok");
  // 「이 달 전체 빼기」도 양쪽 행을 모두 대상으로
  assert.deepEqual(rosterRowIdsForStudent(stops, "id:mok"), ["b", "a", "c"]);
  // studentId 없는 행이 먼저 와도 entry.studentId 는 채워진다
  const reversed = groupRosterDay([stops[1], stops[0]], 2)[0].students;
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0].studentId, "mok");
  // 같은 이름+전화에 studentId 가 둘이면 판단하지 않는다(이름 키 유지)
  const keyOf = rosterStudentKeyResolver([
    { studentId: "x1", studentName: "가", parentPhone: "1234" },
    { studentId: "x2", studentName: "가", parentPhone: "1234" },
  ]);
  assert.equal(keyOf({ studentId: null, studentName: "가", parentPhone: "1234" }), "name:가|1234");
});

test("반이동은 id 있는 행·없는 행이 섞인 같은 학생을 함께 옮긴다", () => {
  const existing = [
    row({ id: "b", studentId: "mok", studentName: "목주찬", parentPhone: "010-5555-6666" }),
    row({ id: "a", direction: "ALIGHT", studentId: null, studentName: "목주찬", parentPhone: "01055556666" }),
  ];
  const updates = buildMoveUpdates(["b", "a"], 3, "18:00~19:00", existing);
  assert.deepEqual(updates.map((u) => [u.id, u.weekday]), [["b", 3], ["a", 3]]);
});

test("월 복사 시 저장 노선의 'stop:<행id>' 학생 식별값을 새 행 id 로 바꾼다", () => {
  const payload = { vehicles: [{ driverUserId: "u1", stops: [{ students: [{ requestId: "stop:old1", name: "가" }, { requestId: "s-real", name: "나" }, { requestId: "stop:unknown" }] }] }] };
  const out = remapStopRowIds(payload, new Map([["old1", "new1"]])) as typeof payload;
  assert.equal(out.vehicles[0].stops[0].students[0].requestId, "stop:new1");
  assert.equal(out.vehicles[0].stops[0].students[1].requestId, "s-real"); // 실제 학생 id 는 그대로
  assert.equal(out.vehicles[0].stops[0].students[2].requestId, "stop:unknown"); // 짝 없는 값은 그대로
  assert.equal(out.vehicles[0].driverUserId, "u1");
  assert.equal(payload.vehicles[0].stops[0].students[0].requestId, "stop:old1"); // 원본은 건드리지 않는다
});

// ── 2026-10-02 리뷰 수정: 따라잡기 생성 탑승체크 이전 · 전화 끝자리 빈 값 ─────────────

test("따라잡기 생성(대상 달 <= 이번 달)일 때만 그 달 날짜 범위를 돌려준다", () => {
  assert.deepEqual(catchUpDateRange("2026-10", "2026-10"), { from: "2026-10-01", to: "2026-11-01" });
  assert.deepEqual(catchUpDateRange("2026-12", "2027-01"), { from: "2026-12-01", to: "2027-01-01" }); // 연말
  assert.equal(catchUpDateRange("2026-11", "2026-10"), null); // 미래 달은 아직 기록이 없다
  assert.throws(() => catchUpDateRange("bad", "2026-10"), RosterInputError);
});

test("옛→새 행 id 짝을 unnest 용 두 배열로(빈 값·중복 제외, 순서 보존)", () => {
  assert.deepEqual(idPairArrays([{ oldId: "a", newId: "A" }, { oldId: "b", newId: "B" }, { oldId: "a", newId: "X" }, { oldId: "", newId: "C" }, { oldId: "d", newId: "" }]), {
    oldIds: ["a", "b"], newIds: ["A", "B"],
  });
  assert.deepEqual(idPairArrays([]), { oldIds: [], newIds: [] });
});

test("전화 끝자리가 비면 이름만으로 studentId 학생에 묶지 않는다(동명이인 오묶음 방지)", () => {
  const base = { classTime: "17:00~18:00", arriveTime: null, stopName: "A", studentPhone: null, note: null, sortOrder: 0, weekday: 1 };
  const stops = [
    { ...base, id: "1", direction: "BOARD", studentName: "김하준", studentId: "k1", parentPhone: null },
    { ...base, id: "2", direction: "ALIGHT", studentName: "김하준", studentId: null, parentPhone: null }, // 다른 김하준일 수 있음
  ];
  assert.equal(groupRosterDay(stops, 1)[0].students.length, 2);
  assert.deepEqual(rosterRowIdsForStudent(stops, "id:k1"), ["1"]); // 「이 달 전체 빼기」에 남의 행이 섞이지 않는다
  // 달을 건너 비교할 때도: 한쪽만 id 가 있고 전화가 없으면 같은 학생으로 보지 않는다
  assert.equal(isSameRosterStudent({ studentId: "k1", studentName: "김하준", parentPhone: null }, { studentId: null, studentName: "김하준", parentPhone: null }), false);
  // 이름만 등록 행끼리(복사된 같은 행)는 전화가 없어도 이어진다
  assert.equal(isSameRosterStudent({ studentId: null, studentName: "김하준", parentPhone: null }, { studentId: null, studentName: "김하준", parentPhone: "" }), true);
});

// ── 기사님 화면 순서·시각 편집(reorder) ──────────────────────────

test("순서 편집 입력: 방향·정차·중복 행을 검증하고 수업시간은 글자 그대로 둔다", () => {
  const ok = validateReorderInput({ serviceMonth: "2026-10", weekday: 3, classTime: "17:00 ~ 18:00", direction: "ALIGHT", stops: [{ rowIds: ["a", "b"], arriveTime: "18:10" }, { rowIds: ["c"], arriveTime: "" }] });
  assert.equal(ok.classTime, "17:00 ~ 18:00"); // 기사님 화면 섹션 키와 같은 글자
  assert.equal(ok.scope, "FROM_THIS_MONTH");
  assert.deepEqual(ok.stops[1], { rowIds: ["c"], arriveTime: null });
  assert.throws(() => validateReorderInput({ ...ok, direction: "PIVOT" }), RosterInputError);
  assert.throws(() => validateReorderInput({ ...ok, stops: [] }), RosterInputError);
  assert.throws(() => validateReorderInput({ ...ok, stops: [{ rowIds: ["a"] }, { rowIds: ["a"] }] }), RosterInputError);
  assert.throws(() => validateReorderInput({ ...ok, stops: [{ rowIds: ["a"], arriveTime: "25:00" }] }), RosterInputError);
});

test("슬롯 재배정: 그 칸이 쓰던 번호만 새 순서대로 돌려 쓰고, 겹친 번호는 1씩 벌린다", () => {
  const sort = new Map([["a", 4], ["b", 9], ["c", 9]]);
  assert.deepEqual(reassignSortSlots([{ id: "c", arriveTime: "17:00" }, { id: "a", arriveTime: "17:10" }, { id: "b", arriveTime: "17:10" }], sort), [
    { id: "c", sortOrder: 4, arriveTime: "17:00" },
    { id: "a", sortOrder: 9, arriveTime: "17:10" },
    { id: "b", sortOrder: 10, arriveTime: "17:10" },
  ]);
  assert.throws(() => reassignSortSlots([{ id: "zz", arriveTime: null }], sort), RosterInputError);
});

test("이 달 순서 저장: 다른 수업·방향 행은 건드리지 않고, 칸의 행이 바뀌었으면 거부한다", () => {
  const rows = [
    row({ id: "b1", weekday: 3, direction: "BOARD", classTime: "17:00~18:00", sortOrder: 1, studentId: "s1", studentName: "가" }),
    row({ id: "x1", weekday: 3, direction: "BOARD", classTime: "18:00~19:00", sortOrder: 2, studentId: "s9", studentName: "다른반" }),
    row({ id: "b2", weekday: 3, direction: "BOARD", classTime: "17:00~18:00", sortOrder: 3, studentId: "s2", studentName: "나" }),
    row({ id: "a1", weekday: 3, direction: "ALIGHT", classTime: "17:00~18:00", sortOrder: 5, studentId: "s1", studentName: "가" }),
  ];
  const input = { weekday: 3, classTime: "17:00~18:00", direction: "BOARD" as const, stops: [{ rowIds: ["b2"], arriveTime: "16:30" }, { rowIds: ["b1"], arriveTime: "16:40" }] };
  assert.deepEqual(buildReorderUpdates(input, rows), [
    { id: "b2", sortOrder: 1, arriveTime: "16:30" },
    { id: "b1", sortOrder: 3, arriveTime: "16:40" },
  ]);
  // 그사이 학생이 추가·삭제되어 보낸 행 집합이 다르면 저장하지 않는다.
  assert.throws(() => buildReorderUpdates({ ...input, stops: [{ rowIds: ["b1"], arriveTime: null }] }, rows), RosterInputError);
  assert.throws(() => buildReorderUpdates({ ...input, stops: [{ rowIds: ["b1", "b2", "a1"], arriveTime: null }] }, rows), RosterInputError);
});

test("이후 달 순서 반영: 대응 행끼리만 같은 순서·시각, 그 달에만 있는 학생은 그대로", () => {
  const later = [
    row({ id: "L1", weekday: 3, classTime: "17:00~18:00", sortOrder: 10, studentId: "s1", studentName: "가" }),
    row({ id: "L2", weekday: 3, classTime: "17:00~18:00", sortOrder: 11, studentId: "s2", studentName: "나" }),
    row({ id: "L3", weekday: 3, classTime: "17:00~18:00", sortOrder: 12, studentId: "s3", studentName: "새학생" }),
  ];
  const source = [
    { weekday: 3, direction: "BOARD", classTime: "17:00~18:00", studentId: "s2", studentName: "나", arriveTime: "16:30" },
    { weekday: 3, direction: "BOARD", classTime: "17:00~18:00", studentId: "s1", studentName: "가", arriveTime: "16:40" },
  ];
  assert.deepEqual(buildCounterpartReorderUpdates(source, later), [
    { id: "L2", sortOrder: 10, arriveTime: "16:30" },
    { id: "L1", sortOrder: 11, arriveTime: "16:40" },
  ]);
  assert.deepEqual(buildCounterpartReorderUpdates(source, [later[2]]), []); // 대응 행이 없으면 건너뜀
});
