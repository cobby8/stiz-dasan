import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { classTimeWarning, dowToWeekday, enrolledClassSlots, estimateInsertTime, findRouteCell, matchRosterClassTime, placementToRequest, resolveCellPlacement, resolveStudentPoint, defaultStopFromRiding, rosterClassTimeFor, studentRosterRows, suggestPlacement } from "./regularRosterPlacementLogic.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { buildAddRows, mapPlacementsToMonth, planRosterInsert, validateAddInput, RosterInputError } from "./regularRosterEditLogic.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { buildFallbackClasses, selectDriverDayRows } from "./regularDriverRouteLogic.ts";

// ── 명단 행 만들기(월요일 기본) ──
let seq = 0;
function r(over: Record<string, unknown> = {}): any {
  seq += 1;
  return {
    id: `r${seq}`, serviceMonth: "2026-10", weekday: 1, weekdayLabel: "월", classTime: "17:00~18:00", arriveTime: "16:40",
    stopName: "A", direction: "BOARD", studentName: `학생${seq}`, studentId: `s${seq}`, studentPhone: null, parentPhone: `010-0000-${String(1000 + seq)}`,
    note: null, sortOrder: seq, latitude: null, longitude: null, ...over,
  };
}

// 위도 0.001 ≈ 111m. 학원(37.600,127.100) ← C(37.610) ← B(37.620) ← A(37.630) 순으로 학원에 가까워지는 등원 노선.
const ACADEMY = { lat: 37.6, lng: 127.1 };
const DEPOT = { lat: 37.64, lng: 127.1 };

/** 삽입 계획을 메모리 명단에 적용(서버 SQL 과 같은 규칙: ① spread 행 번호 바꾸기 ② 요일 전체 sortOrder ≥ shiftFrom +1, 그다음 새 행). */
function applySteps(rows: any[], plan: any, who = { studentName: "신입", studentId: "new" }) {
  const out = rows.map((x) => ({ ...x }));
  for (const u of plan.spread) out.find((x) => x.id === u.id).sortOrder = u.sortOrder;
  plan.steps.forEach((s: any, i: number) => {
    if (s.shiftFrom != null) for (const x of out) if (x.weekday === s.row.weekday && x.sortOrder >= s.shiftFrom) x.sortOrder += 1;
    out.push({ ...r(), ...s.row, id: `ins${i}`, ...who });
  });
  return out;
}
/** 기사님 화면 그대로 그린 결과를 「수업|방향: 정차(학생…)」 문자열로. */
function drawn(rows: any[], weekday = 1) {
  // 명단 조회와 같은 순서(sortOrder, 겹치면 id 바이트 순)로 넘긴다.
  const ordered = [...rows].sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const classes = buildFallbackClasses(selectDriverDayRows(ordered, weekday), () => false);
  return classes.flatMap((c: any) => [
    `${c.classTime}|BOARD: ${c.board.map((s: any) => `${s.label}@${s.arriveTime ?? ""}(${s.rows.map((x: any) => x.name).join(",")})`).join(" > ")}`,
    `${c.classTime}|ALIGHT: ${c.alight.map((s: any) => `${s.label}@${s.arriveTime ?? ""}(${s.rows.map((x: any) => x.name).join(",")})`).join(" > ")}`,
  ]);
}
/** 운영 정차(PIVOT/RETURN) 포함 그 요일 전체 행의 상대 순서(새 행 제외). */
function relativeOrder(rows: any[], weekday = 1) {
  return rows.filter((x) => x.weekday === weekday && !String(x.id).startsWith("ins")).sort((a, b) => a.sortOrder - b.sortOrder).map((x) => x.id);
}

function sampleDay() {
  seq = 0;
  // 17시 등원/하원·18시 등원·운영 정차가 sortOrder 로 서로 섞여 있는 하루.
  return [
    r({ stopName: "A", arriveTime: "16:30", latitude: 37.63, longitude: 127.1 }), // r1 so1
    r({ classTime: "18:00~19:00", stopName: "X", arriveTime: "17:30" }),             // r2 so2 (다른 수업)
    r({ stopName: "B", arriveTime: "16:40", latitude: 37.62, longitude: 127.1 }), // r3 so3
    r({ direction: "PIVOT", studentName: null, stopName: "학원" }),                  // r4 so4 (운영 정차)
    r({ stopName: "A", arriveTime: "16:30", latitude: 37.63, longitude: 127.1 }), // r5 so5 (A 두 번째 학생)
    r({ stopName: "C", arriveTime: "16:50", latitude: 37.61, longitude: 127.1 }), // r6 so6
    r({ direction: "ALIGHT", stopName: "C", arriveTime: "18:10", latitude: 37.61, longitude: 127.1 }), // r7 so7
    r({ direction: "ALIGHT", stopName: "A", arriveTime: "18:30", latitude: 37.63, longitude: 127.1 }), // r8 so8
  ];
}

test("요일 표기: Class.dayOfWeek(Mon…) 와 한국어 요일을 0~6 으로", () => {
  assert.equal(dowToWeekday("Mon"), 1);
  assert.equal(dowToWeekday("Sun"), 0);
  assert.equal(dowToWeekday("수요일"), 3);
  assert.equal(dowToWeekday("x"), null);
});

test("수업시간: 명단에 같은 시각 글자가 있으면 그 글자를 그대로 쓴다", () => {
  assert.equal(matchRosterClassTime("17:00", "18:00", ["17:00 ~ 18:00"]), "17:00 ~ 18:00");
  assert.equal(matchRosterClassTime("9:30", "10:30:00", []), "09:30~10:30");
  assert.equal(matchRosterClassTime("오후", "18:00", []), null);
});

test("등록 수업 → 수업 칸 후보: 요일 월→일·시각 순, 같은 칸 하나", () => {
  const out = enrolledClassSlots([
    { weekday: 0, startTime: "10:00", endTime: "11:00", className: "주말반", programName: null },
    { weekday: 3, startTime: "17:00", endTime: "18:00", className: "초등A", programName: "정규" },
    { weekday: 1, startTime: "17:00", endTime: "18:00", className: "초등A", programName: "정규" },
    { weekday: 1, startTime: "17:00", endTime: "18:00", className: "중복", programName: null },
  ], ["17:00~18:00"]);
  assert.deepEqual(out.map((o: any) => `${o.weekday} ${o.classTime}`), ["1 17:00~18:00", "3 17:00~18:00", "0 10:00~11:00"]);
  assert.match(out[0].label, /월 17:00~18:00 · 정규 · 초등A/);
});

test("운행표 한 칸은 기사님 화면과 같은 묶음(같은 정류장은 처음 나온 위치에 합침)", () => {
  const rows = sampleDay();
  const cell = findRouteCell(rows, 1, "17:00 ~ 18:00", "BOARD");
  assert.deepEqual(cell.map((s: any) => `${s.label}:${s.rows.length}`), ["A:2", "B:1", "C:1"]);
  assert.deepEqual(findRouteCell(rows, 1, "17:00~18:00", "ALIGHT").map((s: any) => s.label), ["C", "A"]);
  assert.deepEqual(findRouteCell(rows, 2, "17:00~18:00", "BOARD"), []);
});

test("추천 ①: 같은 정류장 이름(공백 무시)이면 합류 · 그 정차 시각", () => {
  const cell = findRouteCell(sampleDay(), 1, "17:00~18:00", "BOARD");
  const s = suggestPlacement({ stops: cell, direction: "BOARD", stopName: " B ", student: null, academy: ACADEMY, depot: DEPOT });
  assert.deepEqual(s.choice, { kind: "JOIN", stopIndex: 1 });
  assert.equal(s.arriveTime, "16:40");
});

test("추천 ②: 직선 300m 이내 정차가 있으면 가장 가까운 정차에 합류", () => {
  const cell = findRouteCell(sampleDay(), 1, "17:00~18:00", "BOARD");
  // B(37.620) 에서 북쪽 약 222m, A(37.630) 에서 약 888m
  const s = suggestPlacement({ stops: cell, direction: "BOARD", stopName: "새 아파트", student: { lat: 37.622, lng: 127.1 }, academy: ACADEMY, depot: DEPOT });
  assert.deepEqual(s.choice, { kind: "JOIN", stopIndex: 1 });
  assert.match(s.reason, /「B」 정류장과 직선 22\dm/);
});

test("추천 ③: 가까운 정차가 없으면 추가 거리 최소 자리 + 앞뒤 시각을 거리 비율로 보간", () => {
  const cell = findRouteCell(sampleDay(), 1, "17:00~18:00", "BOARD");
  // B(37.620)와 C(37.610) 사이(37.6125, 동쪽 500m) — B 다음(position 2)이 최소, 시각은 16:40~16:50 사이
  const s = suggestPlacement({ stops: cell, direction: "BOARD", stopName: "새 아파트", student: { lat: 37.6125, lng: 127.1057 }, academy: ACADEMY, depot: DEPOT });
  assert.deepEqual(s.choice, { kind: "INSERT", position: 2 });
  assert.match(s.reason, /2번 「B」 다음/);
  const at = String(s.arriveTime);
  const t = Number(at.slice(3));
  assert.ok(at.startsWith("16:") && t > 40 && t < 50, at);
  // 학원 바로 옆(37.601) → 마지막 정차 C 뒤(맨 뒤), 뒤 정차가 없어 시각은 비움
  const last = suggestPlacement({ stops: cell, direction: "BOARD", stopName: "학원앞", student: { lat: 37.601, lng: 127.106 }, academy: ACADEMY, depot: DEPOT });
  assert.deepEqual(last.choice, { kind: "INSERT", position: 3 });
  assert.equal(last.arriveTime, null);
});

test("추천: 좌표 없는 정차는 거리 계산에서 빼고 표시, 학생 좌표 없으면 맨 뒤", () => {
  seq = 100;
  const rows = [r({ stopName: "A", latitude: 37.63, longitude: 127.1 }), r({ stopName: "무좌표", arriveTime: "16:45" }), r({ stopName: "C", latitude: 37.61, longitude: 127.1, arriveTime: "16:50" })];
  const cell = findRouteCell(rows, 1, "17:00~18:00", "BOARD");
  const s = suggestPlacement({ stops: cell, direction: "BOARD", stopName: "새", student: { lat: 37.62, lng: 127.108 }, academy: ACADEMY, depot: DEPOT });
  assert.deepEqual(s.skippedNoCoord, ["무좌표"]);
  assert.deepEqual(s.choice, { kind: "INSERT", position: 1 }); // A 바로 뒤(좌표 있는 앞 정차 뒤)
  const none = suggestPlacement({ stops: cell, direction: "BOARD", stopName: "새", student: null, academy: ACADEMY, depot: DEPOT });
  assert.deepEqual(none.choice, { kind: "INSERT", position: 3 });
  assert.match(none.reason, /좌표가 없어 맨 뒤/);
  assert.equal(estimateInsertTime(cell, 1, null), "16:43"); // 좌표 비교 불가 → 16:40·16:45 가운데(반올림)
});

test("수업시간 대조 경고: 등원은 시작 이후, 하원은 종료 이전이면 경고(정각은 정상)", () => {
  assert.match(classTimeWarning("BOARD", "17:00~18:00", "17:05") ?? "", /수업 시작 17:00보다 늦습니다/);
  assert.equal(classTimeWarning("BOARD", "17:00~18:00", "17:00"), null);
  assert.match(classTimeWarning("ALIGHT", "17:00~18:00", "17:50") ?? "", /수업 종료 18:00보다 이릅니다/);
  assert.equal(classTimeWarning("ALIGHT", "17:00~18:00", null), null);
});

test("화면 선택 → 서버 요청: 합류는 그 정차 마지막 행, 새 정차는 다음 정차의 첫 행 앞, 맨 뒤는 END", () => {
  const cell = findRouteCell(sampleDay(), 1, "17:00~18:00", "BOARD");
  assert.deepEqual(placementToRequest(cell, { kind: "JOIN", stopIndex: 0 }), { mode: "JOIN", rowId: "r5" });
  assert.deepEqual(placementToRequest(cell, { kind: "INSERT", position: 1 }), { mode: "BEFORE", rowId: "r3" });
  assert.deepEqual(placementToRequest(cell, { kind: "INSERT", position: 3 }), { mode: "END", rowId: null });
});

// ── 저장 후 기사님 화면으로 다시 그렸을 때 ──────────────────────

function addInput(placements: unknown[], extra: Record<string, unknown> = {}) {
  return validateAddInput({
    serviceMonth: "2026-10", studentId: "new", slots: [{ weekday: 1, classTime: "17:00~18:00" }],
    board: { stopName: "신규정류장", arriveTime: null, latitude: 37.615, longitude: 127.1 }, alight: null, placements, ...extra,
  });
}

test("중간 삽입(BEFORE): 새 정차가 고른 자리에 나오고 다른 칸·운영 정차 순서는 그대로", () => {
  const rows = sampleDay();
  const before = drawn(rows);
  const input = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "BEFORE", rowId: "r6", arriveTime: "16:45" }]);
  const plan = planRosterInsert(buildAddRows(input, rows, "신입"), input.placements, rows);
  assert.equal(plan.steps[0].shiftFrom, 6);
  assert.deepEqual(plan.spread, []); // 칸 안 겹침 없음 → 벌리기 없음
  const after = applySteps(rows, plan);
  const now = drawn(after);
  assert.equal(now[0], "17:00~18:00|BOARD: A@16:30(학생1,학생5) > B@16:40(학생3) > 신규정류장@16:45(신입) > C@16:50(학생6)");
  assert.deepEqual(now.slice(1), before.slice(1)); // 17시 하원·18시 칸은 그대로
  assert.deepEqual(relativeOrder(after), relativeOrder(rows)); // PIVOT 포함 기존 행 상대 순서 불변
});

test("중간 삽입: 같은 정류장이 앞뒤에 흩어져 있어도(A,B,A) 다음 정차 첫 행 앞에 넣으면 정확히 그 사이", () => {
  const rows = sampleDay();
  const cell = findRouteCell(rows, 1, "17:00~18:00", "BOARD");
  const req = placementToRequest(cell, { kind: "INSERT", position: 1 }); // A 와 B 사이
  const input = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", ...req, arriveTime: "16:35" }]);
  const after = applySteps(rows, planRosterInsert(buildAddRows(input, rows, "신입"), input.placements, rows));
  assert.match(drawn(after)[0], /^17:00~18:00\|BOARD: A@16:30\(학생1,학생5\) > 신규정류장@16:35\(신입\) > B@16:40/);
  assert.deepEqual(relativeOrder(after), relativeOrder(rows));
});

test("합류(JOIN): 밀지 않고 칸 맨 뒤 + 대상 정차 이름·좌표·시각 → 기사님 화면에선 그 정차 학생 끝에 묶임", () => {
  const rows = sampleDay();
  const input = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "JOIN", rowId: "r3" }]);
  const plan = planRosterInsert(buildAddRows(input, rows, "신입"), input.placements, rows);
  const steps = plan.steps;
  assert.equal(steps[0].shiftFrom, null); // 다른 행 번호를 건드리지 않음
  assert.equal(steps[0].mode, "JOIN");
  assert.equal(steps[0].row.stopName, "B");
  assert.equal(steps[0].row.arriveTime, "16:40");
  assert.equal(steps[0].row.latitude, 37.62);
  const after = applySteps(rows, plan);
  assert.equal(drawn(after)[0], "17:00~18:00|BOARD: A@16:30(학생1,학생5) > B@16:40(학생3,신입) > C@16:50(학생6)");
  assert.deepEqual(relativeOrder(after), relativeOrder(rows));
});

test("맨 뒤(END)·위치 미지정은 예전과 똑같이 그 칸 마지막 뒤(밀기 없음)", () => {
  const rows = sampleDay();
  const input = addInput([]);
  const plain = buildAddRows(input, rows, "신입");
  const plan = planRosterInsert(plain, input.placements, rows);
  assert.equal(plan.steps[0].shiftFrom, null);
  assert.equal(plan.steps[0].row.sortOrder, plain[0].sortOrder);
  assert.match(drawn(applySteps(rows, plan))[0], /C@16:50\(학생6\) > 신규정류장@\(신입\)$/);
});

test("등원·하원을 한 요청에서 각각 중간에 넣어도 서로의 밀기를 반영해 둘 다 고른 자리", () => {
  const rows = sampleDay();
  const input = validateAddInput({
    serviceMonth: "2026-10", studentId: "new", slots: [{ weekday: 1, classTime: "17:00~18:00" }],
    board: { stopName: "신규", arriveTime: null, latitude: null, longitude: null },
    alight: { stopName: "신규", arriveTime: null, latitude: null, longitude: null },
    placements: [
      { weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "BEFORE", rowId: "r3", arriveTime: "16:35" },
      { weekday: 1, classTime: "17:00~18:00", direction: "ALIGHT", mode: "BEFORE", rowId: "r8", arriveTime: "18:20" },
    ],
  });
  const after = applySteps(rows, planRosterInsert(buildAddRows(input, rows, "신입"), input.placements, rows));
  const now = drawn(after);
  assert.match(now[0], /A@16:30\(학생1,학생5\) > 신규@16:35\(신입\) > B@16:40/);
  assert.equal(now[1], "17:00~18:00|ALIGHT: C@18:10(학생7) > 신규@18:20(신입) > A@18:30(학생8)");
  assert.deepEqual(relativeOrder(after), relativeOrder(rows));
});

test("기준 행이 그 칸이 아니거나 없으면 거부(화면과 DB 어긋남)", () => {
  const rows = sampleDay();
  const wrongCell = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "BEFORE", rowId: "r2" }]); // 18시 행
  assert.throws(() => planRosterInsert(buildAddRows(wrongCell, rows, "신입"), wrongCell.placements, rows), /넣을 위치를 찾지 못했습니다/);
  const pivot = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "JOIN", rowId: "r4" }]);
  assert.throws(() => planRosterInsert(buildAddRows(pivot, rows, "신입"), pivot.placements, rows), RosterInputError);
});

test("입력 검증: 고르지 않은 칸·중복 칸·기준 행 없는 BEFORE 는 거부", () => {
  assert.throws(() => addInput([{ weekday: 2, classTime: "17:00~18:00", direction: "BOARD", mode: "END" }]), /고르지 않은/);
  assert.throws(() => addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "ALIGHT", mode: "END" }]), /고르지 않은/); // 하원 안 탐
  assert.throws(() => addInput([
    { weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "END" },
    { weekday: 1, classTime: "17:00 ~ 18:00", direction: "BOARD", mode: "END" },
  ]), /두 번/);
  assert.throws(() => addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "BEFORE" }]), /기준 정차/);
  assert.throws(() => validateAddInput({ serviceMonth: "2026-10", studentId: "s", slots: [], board: { stopName: "A" }, alight: null }), /수업/);
});

test("요일마다 다른 수업시간(slots) — 요일별 칸에 각자 행, 공백만 다른 기존 글자로 맞춘다", () => {
  seq = 200;
  const rows = [r({ weekday: 3, classTime: "18:00 ~ 19:00", stopName: "Q" })];
  const input = validateAddInput({
    serviceMonth: "2026-10", studentId: "new",
    slots: [{ weekday: 3, classTime: "18:00~19:00" }, { weekday: 1, classTime: "17:00~18:00" }],
    board: { stopName: "신규", arriveTime: "16:40", latitude: null, longitude: null }, alight: null,
  });
  assert.deepEqual(input.weekdays, [1, 3]);
  const out = buildAddRows(input, rows, "신입");
  assert.deepEqual(out.map((x: any) => `${x.weekday}|${x.classTime}`), ["1|17:00~18:00", "3|18:00 ~ 19:00"]);
});

test("이후 달: 기준 행의 대응 행(같은 학생·요일·방향·수업) 기준으로 같은 자리, 없으면 맨 뒤 + 표시", () => {
  const oct = sampleDay();
  // 11월: 같은 학생들이 다른 id·다른 번호로 복사돼 있고, 학생6(C)은 빠졌다.
  const nov = oct.filter((x) => x.id !== "r6").map((x, i) => ({ ...x, id: `n${x.id}`, serviceMonth: "2026-11", sortOrder: (i + 1) * 10 }));
  const input = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "BEFORE", rowId: "r3", arriveTime: "16:35" }]);
  const mapped = mapPlacementsToMonth(input.placements, oct, nov);
  assert.equal(mapped[0].rowId, "nr3");
  const after = applySteps(nov, planRosterInsert(buildAddRows(input, nov, "신입", { skipDuplicates: true }), mapped, nov));
  assert.match(drawn(after)[0], /A@16:30\(학생1,학생5\) > 신규정류장@16:35\(신입\) > B@16:40/);

  const join = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "JOIN", rowId: "r6" }]);
  const fb = mapPlacementsToMonth(join.placements, oct, nov);
  assert.equal(fb[0].mode, "END");
  assert.equal(fb[0].fellBack, true);
  const steps = planRosterInsert(buildAddRows(join, nov, "신입", { skipDuplicates: true }), fb, nov).steps;
  assert.equal(steps[0].fellBack, true);
  assert.equal(steps[0].row.stopName, "C"); // 이 달 합류 정차 값으로 맨 뒤에
  assert.equal(steps[0].row.arriveTime, "16:50");
  // 그 달 칸에 같은 이름 정차가 있으면 맨 뒤에 넣어도 기사님 화면에서 합류로 묶이므로 fellBack 아님
  const joinB = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "JOIN", rowId: "r3" }]);
  const mb = mapPlacementsToMonth(joinB.placements, oct, nov);
  assert.equal(mb[0].fellBack, undefined);
  const afterB = applySteps(nov, planRosterInsert(buildAddRows(joinB, nov, "신입", { skipDuplicates: true }), mb, nov));
  assert.match(drawn(afterB)[0], /B@16:40\(학생3,신입\)/);
});

test("R-A1: 칸 안 번호 겹침 A(5)·B(5) 에서 「B 앞」은 A 와 B 사이 — 먼저 벌리고 넣는다", () => {
  seq = 300;
  const rows = [
    r({ id: "t0", direction: "PIVOT", studentName: null, stopName: "학원", sortOrder: 5 }), // 칸 밖 운영 정차(같은 번호)
    r({ id: "t1", stopName: "A", arriveTime: "16:30", sortOrder: 5 }),
    r({ id: "t2", stopName: "B", arriveTime: "16:40", sortOrder: 5 }),
    r({ id: "t3", classTime: "18:00~19:00", stopName: "X", sortOrder: 6 }), // 다른 칸
    r({ id: "t4", stopName: "C", arriveTime: "16:50", sortOrder: 7 }),
  ];
  assert.equal(drawn(rows)[0], "17:00~18:00|BOARD: A@16:30(학생302) > B@16:40(학생303) > C@16:50(학생305)");
  const cell = findRouteCell(rows, 1, "17:00~18:00", "BOARD");
  const req = placementToRequest(cell, { kind: "INSERT", position: 1 }); // A 와 B 사이
  assert.deepEqual(req, { mode: "BEFORE", rowId: "t2" });
  const input = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", ...req, arriveTime: "16:35" }]);
  const plan = planRosterInsert(buildAddRows(input, rows, "신입"), input.placements, rows);
  // 겹친 칸 행만 벌린다: B 5→6, 그보다 큰 행(X 6→7, C 7→8)은 함께 밀고 칸 밖 운영 정차(t0=5)는 그대로.
  assert.deepEqual(plan.spread.sort((a: any, b: any) => a.id.localeCompare(b.id)), [{ id: "t2", sortOrder: 6 }, { id: "t3", sortOrder: 7 }, { id: "t4", sortOrder: 8 }]);
  const after = applySteps(rows, plan);
  assert.equal(drawn(after)[0], "17:00~18:00|BOARD: A@16:30(학생302) > 신규정류장@16:35(신입) > B@16:40(학생303) > C@16:50(학생305)");
  assert.equal(drawn(after)[2], drawn(rows)[2]); // 18시 칸 그대로
  // 칸 밖 행과만 겹친 경우(학생 행 1개 + 운영 정차)는 벌리지 않는다.
  const solo = rows.filter((x) => x.id !== "t1");
  const p2 = planRosterInsert(buildAddRows(input, solo, "신입"), input.placements, solo);
  assert.deepEqual(p2.spread, []);
});

test("R-A2·A4: 합류는 시각을 받지 않고(옛 표기 '16:40:00' 도 그대로 복사), 대상 좌표가 없으면 학생 좌표로 보강", () => {
  seq = 400;
  const rows = [r({ id: "u1", stopName: "옛정류장", arriveTime: "16:40:00", latitude: null, longitude: null })];
  // 화면이 실수로 비정형 시각을 보내도 합류면 검증하지 않는다
  const input = addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "JOIN", rowId: "u1", arriveTime: "16:40:00" }]);
  assert.equal(input.placements?.[0].arriveTime, undefined);
  const step = planRosterInsert(buildAddRows(input, rows, "신입"), input.placements, rows).steps[0];
  assert.equal(step.row.arriveTime, "16:40:00");
  assert.equal(step.row.latitude, 37.615); // addInput 의 학생 좌표
  assert.equal(step.row.longitude, 127.1);
  // BEFORE·END 의 비정형 시각은 여전히 거부
  assert.throws(() => addInput([{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "END", arriveTime: "16:40:00" }]), /도착시각/);
});

test("resolveCellPlacement: 추천 기본 → 원장 선택 덮어쓰기 · 시각 · 경고가 한 계산으로", () => {
  const rows = sampleDay();
  const base = { stops: rows, weekday: 1, classTime: "17:00~18:00", direction: "BOARD" as const, stopName: "새 아파트", student: { lat: 37.6125, lng: 127.1057 }, academy: ACADEMY, depot: DEPOT, studentId: "s3" };
  const auto = resolveCellPlacement(base);
  assert.equal(auto.isSuggested, true);
  assert.deepEqual(auto.request, { mode: "BEFORE", rowId: "r6" });
  assert.ok(auto.warnings.some((w: string) => /이미 이 수업·방향 명단/.test(w))); // s3 은 이미 B 에 있음
  const manual = resolveCellPlacement({ ...base, studentId: null, override: { choice: { kind: "INSERT", position: 3 }, arriveTime: "17:10" } });
  assert.equal(manual.isSuggested, false);
  assert.deepEqual(manual.request, { mode: "END", rowId: null });
  assert.equal(manual.arriveTime, "17:10");
  assert.ok(manual.warnings.some((w: string) => /수업 시작 17:00보다 늦습니다/.test(w)));
  const join = resolveCellPlacement({ ...base, studentId: null, override: { choice: { kind: "JOIN", stopIndex: 0 }, arriveTime: "16:00" } });
  assert.equal(join.arriveTime, "16:30"); // 합류는 늘 그 정차 시각
  const clash = resolveCellPlacement({ ...base, stopName: "C", studentId: null, override: { choice: { kind: "INSERT", position: 0 } } });
  assert.ok(clash.warnings.some((w: string) => /같은 이름 「C」/.test(w)));
  // 범위를 벗어난 옛 선택은 무시하고 추천으로
  assert.equal(resolveCellPlacement({ ...base, override: { choice: { kind: "JOIN", stopIndex: 9 } } }).isSuggested, true);
});

test("휴원 수업: 칩 후보에 paused 로 표시, 같은 칸에 다니는 수업이 있으면 다니는 쪽 우선", () => {
  const out = enrolledClassSlots([
    { weekday: 1, startTime: "17:00", endTime: "18:00", className: "초등A", programName: null, status: "PAUSED" },
    { weekday: 3, startTime: "17:00", endTime: "18:00", className: "초등A", programName: null, status: "PAUSED" },
    { weekday: 3, startTime: "17:00", endTime: "18:00", className: "초등B", programName: null, status: "ACTIVE" },
    { weekday: 5, startTime: "17:00", endTime: "18:00", className: "초등A", programName: null }, // 상태 없으면 다니는 수업
  ], []);
  assert.deepEqual(out.map((o: any) => `${o.weekday}:${o.paused}`), ["1:true", "3:false", "5:false"]);
});

test("이미 타는 행: studentId 일치 + 미연결 행은 이름(공백 무시)+학부모 전화 끝4자리 일치만", () => {
  seq = 500;
  const rows = [
    r({ id: "v1", studentId: "kid", studentName: "이종현", parentPhone: "010-1234-5678" }),
    r({ id: "v2", studentId: null, studentName: "이 종현", parentPhone: "01099995678", direction: "ALIGHT" }), // 같은 학생(미연결)
    r({ id: "v3", studentId: null, studentName: "이종현", parentPhone: "010-1234-0000" }), // 전화 다름 → 다른 학생
    r({ id: "v4", studentId: null, studentName: "이종현", parentPhone: null }), // 전화 없음 → 이름만으로 묶지 않음
    r({ id: "v5", studentId: "kid", studentName: "이종현", direction: "PIVOT" }), // 운영 정차 제외
  ];
  assert.deepEqual(studentRosterRows(rows, { id: "kid", name: "이종현", parentPhone: "010-1234-5678" }).map((x: any) => x.id), ["v1", "v2"]);
  // 그 달에 studentId 연결 행이 하나도 없어도(새로 고른 학생) 이름+전화로 찾는다
  const unlinked = rows.filter((x) => x.id === "v2");
  assert.deepEqual(studentRosterRows(unlinked, { id: "kid", name: "이종현", parentPhone: "010-5555-5678" }).map((x: any) => x.id), ["v2"]);
  // 같은 이름+전화에 다른 학생 id 가 이미 있으면 묶지 않는다(남의 행 섞임 방지)
  const other = [r({ id: "w1", studentId: "other", studentName: "이종현", parentPhone: "010-1234-5678" }), ...unlinked];
  assert.deepEqual(studentRosterRows(other, { id: "kid", name: "이종현", parentPhone: "010-1234-5678" }).map((x: any) => x.id), []);
});

// 2026-10-03 운영 실측: 학원 Class 시각과 셔틀 명단 칸 글자는 시작이 같고 끝 표기만 다르다.
const ROSTER_FRI = ["15:00~16:00", "16:00~17:00", "17:00~18:00", "18:00~19:20", "19:20~20:40"];
const CLASS_TIMES: [string, string, string][] = [
  ["15:00", "15:55", "15:00~16:00"], ["16:00", "16:55", "16:00~17:00"], ["17:00", "17:55", "17:00~18:00"],
  ["18:00", "19:15", "18:00~19:20"], ["19:20", "20:35", "19:20~20:40"],
];

test("등록 수업 → 명단 칸: 시작 시각 기준(운영 실측 시각표 그대로)", () => {
  const rows = ROSTER_FRI.map((classTime) => ({ weekday: 5, classTime }));
  for (const [start, end, expected] of CLASS_TIMES) {
    assert.equal(rosterClassTimeFor(5, start, end, rows), expected, `${start}~${end}`);
  }
  // 수요일 19:20~20:55 도 같은 시작 시각 칸(19:20~20:40)으로
  assert.equal(rosterClassTimeFor(3, "19:20", "20:55", [{ weekday: 3, classTime: "19:20~20:40" }]), "19:20~20:40");
});

test("등록 수업 → 명단 칸 우선순위: 그 요일(가장 많이 쓰인 글자) > 다른 요일 > 등록 시각 그대로", () => {
  const rows = [
    { weekday: 5, classTime: "16:00~17:00" }, { weekday: 5, classTime: "16:00 ~ 17:00" }, { weekday: 5, classTime: "16:00 ~ 17:00" },
    { weekday: 1, classTime: "16:00~17:10" },
    { weekday: 2, classTime: "18:00~19:20" },
  ];
  assert.equal(rosterClassTimeFor(5, "16:00", "16:55", rows), "16:00 ~ 17:00"); // 그 요일에서 가장 많이 쓰인 글자
  assert.equal(rosterClassTimeFor(5, "18:00", "19:15", rows), "18:00~19:20"); // 그 요일엔 없어 다른 요일 글자
  assert.equal(rosterClassTimeFor(5, "9:30", "10:25", rows), "09:30~10:25"); // 어디에도 없으면 등록 시각
  assert.equal(rosterClassTimeFor(5, "오후", "10:25", rows), null);
});

test("등록 수업 칩: 대응 표시 「금 16:00~16:55 → 셔틀 16:00~17:00 칸」, 같은 칸 합치기는 변환 후 글자로", () => {
  const rows = ROSTER_FRI.map((classTime) => ({ weekday: 5, classTime }));
  const out = enrolledClassSlots([
    { weekday: 5, startTime: "16:00", endTime: "16:55", className: null, programName: null, status: "PAUSED" },
    { weekday: 5, startTime: "16:00", endTime: "17:00", className: "다른반", programName: null, status: "ACTIVE" }, // 같은 칸 → 하나로
    { weekday: 5, startTime: "17:00", endTime: "18:00", className: null, programName: null, status: "ACTIVE" },
  ], rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].classTime, "16:00~17:00");
  assert.equal(out[0].paused, false); // 같은 칸에 다니는 수업이 있어 휴원 아님
  assert.equal(out[0].label, "금 16:00~16:55 → 셔틀 16:00~17:00 칸");
  assert.equal(out[1].label, "금 17:00~18:00"); // 글자가 같으면 대응 표시 없이
  // 칸을 고르면 운행표가 비지 않는다(예전엔 글자 불일치로 0곳)
  seq = 600;
  const day = [r({ weekday: 5, classTime: "16:00~17:00", stopName: "다산자이" })];
  assert.equal(findRouteCell(day, 5, out[0].classTime, "BOARD").length, 1);
});

test("학생 위치 우선순위: 지도 지정 > 명단 정류장 이름 > 학생 상세 위치 > 이미 타는 정류장(같은 방향 우선)", () => {
  seq = 700;
  const roster = [
    r({ id: "x1", stopName: "다산자이 정문", latitude: 37.61, longitude: 127.15 }),
    r({ id: "x2", stopName: "좌표없는곳", latitude: null, longitude: null }),
  ];
  const riding = [
    r({ id: "y1", weekday: 3, direction: "ALIGHT", stopName: "하원정류장", latitude: 37.62, longitude: 127.16 }),
    r({ id: "y2", weekday: 1, direction: "BOARD", stopName: "등원정류장", latitude: 37.63, longitude: 127.17 }),
  ];
  const places = { pickup: { name: "집", address: "주소", latitude: 37.64, longitude: 127.18 }, dropoff: null };
  const base = { direction: "BOARD" as const, rosterStops: roster, places, riding };
  const empty = { stopName: "", latitude: null, longitude: null };

  // ① 지도 지정
  const map = resolveStudentPoint({ ...base, draft: { stopName: "다산자이 정문", latitude: 37.6, longitude: 127.1, coordSource: "MAP" } });
  assert.equal(map.source, "MAP");
  assert.deepEqual(map.point, { lat: 37.6, lng: 127.1 });
  // ② 이름 일치(공백 무시) → 명단 정류장 좌표, 입력값에 좌표 없으면 저장 때 채움
  const named = resolveStudentPoint({ ...base, draft: { stopName: "다산자이정문", latitude: null, longitude: null } });
  assert.equal(named.source, "ROSTER_STOP");
  assert.deepEqual(named.point, { lat: 37.61, lng: 127.15 });
  assert.deepEqual(named.fillCoords, { lat: 37.61, lng: 127.15 });
  assert.match(named.label, /명단 정류장 「다산자이 정문」 기준/);
  // 좌표 없는 명단 정류장 이름은 ②로 안 잡히고 ③으로
  assert.equal(resolveStudentPoint({ ...base, draft: { ...empty, stopName: "좌표없는곳" } }).source, "STUDENT_PLACE");
  // ③ 학생 상세 위치(하원 위치가 없으면 등원 위치)
  const alightPlace = resolveStudentPoint({ ...base, direction: "ALIGHT", draft: empty });
  assert.equal(alightPlace.source, "STUDENT_PLACE");
  assert.match(alightPlace.label, /학생 상세 등원 위치 기준/);
  // ④ 이미 타는 정류장: 같은 방향 우선
  const noPlace = { ...base, places: { pickup: null, dropoff: null } };
  const rideBoard = resolveStudentPoint({ ...noPlace, draft: empty });
  assert.equal(rideBoard.source, "RIDING");
  assert.match(rideBoard.label, /월요일에 타는 정류장 「등원정류장」 기준/);
  const rideAlight = resolveStudentPoint({ ...noPlace, direction: "ALIGHT", draft: empty });
  assert.match(rideAlight.label, /수요일에 타는 정류장 「하원정류장」 기준/);
  // 같은 방향이 없으면 반대 방향
  assert.match(resolveStudentPoint({ ...noPlace, riding: [riding[0]], draft: empty }).label, /하원정류장/);
  // 아무 출처도 없으면 좌표 없음
  const none = resolveStudentPoint({ ...noPlace, riding: [], draft: empty });
  assert.equal(none.point, null);
  assert.equal(none.label, "학생 위치 좌표 없음");
});

test("정류장 입력칸 미리 채우기: 이미 타는 셔틀 정류장(같은 방향, 좌표 있는 행 우선)", () => {
  seq = 800;
  const riding = [
    r({ direction: "ALIGHT", stopName: "하원A", latitude: 37.6, longitude: 127.1 }),
    r({ direction: "BOARD", stopName: "등원무좌표", latitude: null, longitude: null }),
  ];
  assert.equal(defaultStopFromRiding(riding, "ALIGHT")?.stopName, "하원A");
  // 등원 행은 좌표가 없어 좌표 있는 반대 방향을 먼저 쓴다
  assert.equal(defaultStopFromRiding(riding, "BOARD")?.stopName, "하원A");
  assert.equal(defaultStopFromRiding([riding[1]], "BOARD")?.stopName, "등원무좌표");
  assert.equal(defaultStopFromRiding([], "BOARD"), null);
});

test("이름 일치 출처면 그 칸 같은 이름 정차에 합류 추천(학생 위치가 그 정류장 좌표라서)", () => {
  const rows = sampleDay();
  const res = resolveStudentPoint({ direction: "BOARD", draft: { stopName: "B", latitude: null, longitude: null }, rosterStops: rows, places: { pickup: null, dropoff: null }, riding: [] });
  const cell = resolveCellPlacement({ stops: rows, weekday: 1, classTime: "17:00~18:00", direction: "BOARD", stopName: "B", student: res.point, academy: ACADEMY, depot: DEPOT, studentId: null });
  assert.deepEqual(cell.choice, { kind: "JOIN", stopIndex: 1 });
});
