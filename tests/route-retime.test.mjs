import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 순서를 옮기면 시각을 다시 계산하는 규칙(routeRetime.ts) — 2026-11-13 원장 결정.
// 원장 예: 첫 탑승 14:30 · 학원 도착 15:00 에서 14:35 정류장을 14:55 자리로 옮기면,
//          첫 탑승은 고정되고 그 사이 정류장들은 조금씩 앞으로 당겨져야 한다.
const { retimeRun, neededLegs, classWindowOfGroupKey, legKey, straightLineMinutes } = await loadTsModule("src/lib/shuttle/routeRetime.ts");

// 지점마다 좌표를 하나씩 두고, 지도 이동 분은 표로 준다(계산을 손으로 검산할 수 있게).
const P = {
  A: { lat: 37.60, lng: 127.10 },
  B: { lat: 37.61, lng: 127.11 },
  C: { lat: 37.60, lng: 127.12 },
  D: { lat: 37.60, lng: 127.13 },
  E: { lat: 37.60, lng: 127.14 },
  ACADEMY: { lat: 37.60, lng: 127.15 },
};
const nameOf = (p) => Object.keys(P).find((k) => P[k].lat === p.lat && P[k].lng === p.lng);
function table(minutes) {
  const map = new Map();
  for (const [pair, m] of Object.entries(minutes)) {
    const [a, b] = pair.split("-");
    map.set(`${a}-${b}`, m);
    if (!map.has(`${b}-${a}`)) map.set(`${b}-${a}`, m);
  }
  return (a, b) => map.get(`${nameOf(a)}-${nameOf(b)}`) ?? null;
}
const stop = (label, time) => ({ key: label, label, time, point: P[label] });

// B 는 길에서 벗어난 곳(A→C 직행 6분, A→B→C 는 10분).
const LEGS = table({ "A-B": 5, "B-C": 5, "C-D": 5, "D-E": 10, "E-ACADEMY": 5, "A-C": 6, "E-B": 8, "B-ACADEMY": 6 });
const BEFORE = [stop("A", "14:30"), stop("B", "14:35"), stop("C", "14:40"), stop("D", "14:45"), stop("E", "14:55")];

test("원장 예시 — 14:35 정류장(B)을 14:55 자리(E 뒤)로 옮기면 첫 탑승 고정, 사이 정류장은 앞으로 당겨진다", () => {
  const after = [BEFORE[0], BEFORE[2], BEFORE[3], BEFORE[4], BEFORE[1]];
  const r = retimeRun({ direction: "BOARD", before: BEFORE, after, academy: P.ACADEMY, legMinutes: LEGS });
  assert.equal(r.ok, true);
  assert.equal(r.pace, 1); // 운행표 25분 = 지도 25분
  assert.deepEqual(r.times, { A: "14:30", C: "14:36", D: "14:41", E: "14:51", B: "14:59" });
  // 당겨짐 확인: C·D·E 모두 예전보다 이르다.
  assert.ok(r.times.C < "14:40" && r.times.D < "14:45" && r.times.E < "14:55");
  assert.equal(r.arrival, "15:05"); // 화면은 수업 시작 15:00 보다 늦다고 경고한다.
  assert.equal(r.estimated, false);
});

test("맨 앞 정류장이 바뀌어도 출발(첫 탑승) 시각은 그대로", () => {
  const after = [BEFORE[1], BEFORE[0], BEFORE[2], BEFORE[3], BEFORE[4]];
  const r = retimeRun({ direction: "BOARD", before: BEFORE, after, academy: P.ACADEMY, legMinutes: LEGS });
  assert.equal(r.times.B, "14:30");
  assert.equal(r.times.A, "14:35");
});

test("원장이 첫 탑승 시각을 고쳐 뒀으면 그 시각을 기준으로 쌓는다", () => {
  const after = [BEFORE[0], BEFORE[2], BEFORE[3], BEFORE[4], BEFORE[1]];
  const r = retimeRun({ direction: "BOARD", before: BEFORE, after, anchorTime: "14:25", academy: P.ACADEMY, legMinutes: LEGS });
  assert.equal(r.times.A, "14:25");
  assert.equal(r.times.C, "14:31");
});

test("기사님 속도 배율 — 운행표가 지도보다 1.5배 걸리면 새 시간표도 1.5배로", () => {
  // 지도 25분 구간이 실제로는 37~38분: 14:30 → 15:07.5
  const slow = [stop("A", "14:30"), stop("B", "14:37"), stop("C", "14:45"), stop("D", "14:52"), stop("E", "15:07")];
  const r = retimeRun({ direction: "BOARD", before: slow, after: slow, academy: P.ACADEMY, legMinutes: LEGS });
  assert.ok(Math.abs(r.pace - 37 / 25) < 1e-9);
  // 순서를 안 바꿔도 같은 배율로 다시 쌓으면 처음·끝은 그대로다.
  assert.equal(r.times.A, "14:30");
  assert.equal(r.times.E, "15:07");
});

test("배율은 0.6~3 사이로 묶는다(시각 오타로 튀지 않게)", () => {
  const typo = [stop("A", "14:30"), stop("B", "14:31"), stop("C", "14:31"), stop("D", "14:31"), stop("E", "14:31")];
  const r = retimeRun({ direction: "BOARD", before: typo, after: typo, academy: P.ACADEMY, legMinutes: LEGS });
  assert.equal(r.pace, 0.6);
});

test("하원 — 학원 출발 시각 고정(첫 하차 − 학원→첫 정류장), 이후 이동 시간을 쌓는다", () => {
  // 학원→E 5분, 첫 하차 E 19:25 → 학원 출발 19:20.
  const before = [stop("E", "19:25"), stop("D", "19:35"), stop("C", "19:40")];
  const legs = table({ "ACADEMY-E": 5, "E-D": 10, "D-C": 5, "ACADEMY-D": 4, "D-E": 10, "E-C": 12 });
  const after = [before[1], before[0], before[2]]; // D 를 맨 앞으로
  const r = retimeRun({ direction: "ALIGHT", before, after, academy: P.ACADEMY, legMinutes: legs });
  assert.equal(r.ok, true);
  assert.equal(r.departure, "19:20");
  assert.deepEqual(r.times, { D: "19:24", E: "19:34", C: "19:46" });
  assert.equal(r.arrival, null);
});

test("하원 — 학원 좌표를 모르면 첫 하차 시각을 고정한다", () => {
  const before = [stop("E", "19:25"), stop("D", "19:35")];
  const legs = table({ "E-D": 10 });
  const r = retimeRun({ direction: "ALIGHT", before, after: [before[1], before[0]], academy: null, legMinutes: legs });
  assert.deepEqual(r.times, { D: "19:25", E: "19:35" });
});

test("좌표 없는 정류장이 있으면 계산하지 않고 이유를 돌려준다", () => {
  const before = [stop("A", "14:30"), { key: "X", label: "새 정류장", time: "14:40", point: null }];
  const r = retimeRun({ direction: "BOARD", before, after: [before[1], before[0]], academy: P.ACADEMY, legMinutes: LEGS });
  assert.equal(r.ok, false);
  assert.match(r.reason, /새 정류장/);
});

test("첫 탑승 시각이 없으면 계산하지 않는다", () => {
  const before = [stop("A", null), stop("C", "14:40")];
  const r = retimeRun({ direction: "BOARD", before, after: before, academy: P.ACADEMY, legMinutes: LEGS });
  assert.equal(r.ok, false);
});

test("지도 시간을 모르는 구간은 직선 추정으로 채우고 estimated 를 켠다", () => {
  const r = retimeRun({ direction: "BOARD", before: BEFORE, after: [BEFORE[0], BEFORE[2]], academy: null, legMinutes: () => null });
  assert.equal(r.ok, true);
  assert.equal(r.estimated, true);
  const est = straightLineMinutes(P.A, P.C);
  assert.ok(est > 0);
});

test("같은 좌표 정류장끼리는 이동 0분(같은 시각)", () => {
  const twin = [stop("A", "14:30"), { key: "A2", label: "A", time: "14:30", point: P.A }, stop("C", "14:40")];
  const r = retimeRun({ direction: "BOARD", before: twin, after: twin, academy: null, legMinutes: LEGS });
  assert.equal(r.times.A2, "14:30");
});

test("neededLegs — 옮기기 전·후 이웃 쌍과 학원 구간만, 같은 좌표·중복 없이", () => {
  const legs = neededLegs({ direction: "BOARD", before: BEFORE.slice(0, 2), after: [BEFORE[1], BEFORE[0]], academy: P.ACADEMY });
  const keys = legs.map(([a, b]) => legKey(a, b)).sort();
  assert.deepEqual(keys, [legKey(P.A, P.B), legKey(P.A, P.ACADEMY), legKey(P.B, P.A), legKey(P.B, P.ACADEMY)].sort());
});

test("classWindowOfGroupKey — 묶음 키에서 수업 시작·끝", () => {
  assert.deepEqual(classWindowOfGroupKey("R:18:00~19:20:board"), { start: "18:00", end: "19:20" });
  assert.deepEqual(classWindowOfGroupKey("R:9:00 ~ 10:00:alight"), { start: "09:00", end: "10:00" });
  assert.deepEqual(classWindowOfGroupKey("S:PICKUP:0"), { start: null, end: null });
});
