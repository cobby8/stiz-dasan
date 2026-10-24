import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildRegularRows,
  buildSeasonalRows,
  buildUnifiedRun,
  countProgress,
  formatHHMM,
  hasRunOfKind,
  parseHHMM,
  sortUnifiedRows,
} from "../src/lib/shuttle/unifiedDriverRunLogic.ts";

// 기사님 통합 운행 화면 — 그날 방학특강·정규를 "출발 시각 순서대로 한 줄씩" 합치는 병합·정렬을 못박는다.
// 여기가 어긋나면 기사님이 순서를 오인해 학생을 두고 출발하는 실사고가 난다.

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────
function seasonalSection({ direction = "PICKUP", time = "09:30", vehicles = [] } = {}) {
  return {
    direction, time,
    startName: direction === "PICKUP" ? "차고지" : "STIZ 다산점",
    endName: direction === "PICKUP" ? "STIZ 다산점" : "차고지",
    vehicles,
  };
}
function seasonalVehicle({ name = "1호차", depart = null, arrive = null, depot = null, stops = [] } = {}) {
  return { vehicleName: name, tripLabel: null, departTime: depart, arriveTime: arrive, depotTime: depot, stops };
}
function seasonalStop({ label, eta = null, isHub = false, students = [], lat = 37.6, lng = 127.1 } = {}) {
  return { label, isHub, etaLabel: eta, lat, lng, students };
}
function seasonalStudent(id, name) {
  return { requestId: id, name, grade: "초3", parentPhone: "010-1111-2222", childPhone: null };
}
function regularClass({ classTime = "17:00~18:00", title, pending = false, board = [], alight = [] } = {}) {
  return { classTime, title, pending, board, alight };
}
function regularStop({ label, arriveTime = null, direction = "BOARD", rows = [] } = {}) {
  return { label, arriveTime, lat: 37.6, lng: 127.1, direction, rows };
}
function regularRow(rowId, name, absent = false) {
  return { rowId, name, parentPhone: "010-3333-4444", studentPhone: null, absent };
}

const stopsOnly = (rows) => rows.filter((r) => !r.isTerminal);

// ── 시각 파싱 ─────────────────────────────────────────────────────────────────
test("시각 파싱 — '08:57 승차' 같은 라벨에서도 HH:MM 을 뽑는다", () => {
  assert.equal(parseHHMM("08:57 승차"), 8 * 60 + 57);
  assert.equal(parseHHMM("13:45"), 13 * 60 + 45);
  assert.equal(parseHHMM("8:5"), null);          // 분 두 자리가 아니면 시각으로 보지 않는다
  assert.equal(parseHHMM("99:99"), null);
  assert.equal(parseHHMM(null), null);
  assert.equal(parseHHMM(undefined), null);
  assert.equal(formatHHMM(8 * 60 + 7), "08:07");
  assert.equal(formatHHMM(null), null);
});

// ── 특강만 있는 날 ────────────────────────────────────────────────────────────
test("특강만 있는 날 — 정규 행은 하나도 생기지 않는다", () => {
  const rows = buildUnifiedRun({
    seasonal: [seasonalSection({
      vehicles: [seasonalVehicle({
        stops: [
          seasonalStop({ label: "다산 푸르지오", eta: "09:10 승차", students: [seasonalStudent("r1", "김예준")] }),
          seasonalStop({ label: "새봄중", eta: "09:06 승차", students: [seasonalStudent("r2", "이승민")] }),
        ],
      })],
    })],
    regular: [],
  });
  const stops = stopsOnly(rows);
  assert.equal(stops.length, 2);
  assert.deepEqual(stops.map((r) => r.label), ["새봄중", "다산 푸르지오"]); // 시각 오름차순
  assert.ok(stops.every((r) => r.kind === "SEASONAL"));
  assert.equal(hasRunOfKind(rows, "SEASONAL"), true);
  assert.equal(hasRunOfKind(rows, "REGULAR"), false);
});

// ── 정규만 있는 날 ────────────────────────────────────────────────────────────
test("정규만 있는 날 — 특강 행은 하나도 생기지 않는다", () => {
  const rows = buildUnifiedRun({
    seasonal: [seasonalSection({ vehicles: [] }), seasonalSection({ direction: "DROPOFF", vehicles: [] })],
    regular: [regularClass({
      board: [regularStop({ label: "금교초 앞", arriveTime: "14:50", rows: [regularRow("row-1", "이재인")] })],
      alight: [regularStop({ label: "복호두 앞", arriveTime: "16:08", direction: "ALIGHT", rows: [regularRow("row-2", "이하율")] })],
    })],
  });
  const stops = stopsOnly(rows);
  assert.equal(stops.length, 2);
  assert.ok(stops.every((r) => r.kind === "REGULAR"));
  assert.equal(hasRunOfKind(rows, "SEASONAL"), false);
  assert.deepEqual(stops.map((r) => r.direction), ["PICKUP", "DROPOFF"]); // BOARD→등원 · ALIGHT→하원
});

test("운행이 하나도 없는 날 — 빈 목록", () => {
  assert.deepEqual(buildUnifiedRun({ seasonal: [], regular: [] }), []);
  assert.deepEqual(buildUnifiedRun({}), []);
});

// ── 둘 다 있는 날(핵심) ───────────────────────────────────────────────────────
test("특강·정규가 섞인 날 — 종류를 가리지 않고 시각순 한 줄로 정렬된다", () => {
  const rows = buildUnifiedRun({
    seasonal: [
      seasonalSection({
        direction: "PICKUP",
        vehicles: [seasonalVehicle({
          stops: [
            seasonalStop({ label: "특강A", eta: "09:00 승차", students: [seasonalStudent("s1", "김특강")] }),
            seasonalStop({ label: "특강B", eta: "16:00 승차", students: [seasonalStudent("s2", "박특강")] }),
          ],
        })],
      }),
    ],
    regular: [regularClass({
      board: [
        regularStop({ label: "정규A", arriveTime: "14:50", rows: [regularRow("row-1", "이정규")] }),
        regularStop({ label: "정규B", arriveTime: "17:00", rows: [regularRow("row-2", "최정규")] }),
      ],
    })],
  });
  const stops = stopsOnly(rows);
  assert.deepEqual(stops.map((r) => r.label), ["특강A", "정규A", "특강B", "정규B"]);
  assert.deepEqual(stops.map((r) => r.kind), ["SEASONAL", "REGULAR", "SEASONAL", "REGULAR"]);
  assert.deepEqual(stops.map((r) => r.time), ["09:00", "14:50", "16:00", "17:00"]);
});

test("같은 시각이면 원래 순서를 지킨다(안정 정렬)", () => {
  const rows = stopsOnly(buildUnifiedRun({
    seasonal: [seasonalSection({
      vehicles: [seasonalVehicle({
        stops: [
          seasonalStop({ label: "특강-먼저", eta: "10:00 승차", students: [seasonalStudent("s1", "가")] }),
          seasonalStop({ label: "특강-나중", eta: "10:00 승차", students: [seasonalStudent("s2", "나")] }),
        ],
      })],
    })],
    regular: [regularClass({ board: [regularStop({ label: "정규-같은시각", arriveTime: "10:00", rows: [regularRow("r1", "다")] })] })],
  }));
  assert.deepEqual(rows.map((r) => r.label), ["특강-먼저", "특강-나중", "정규-같은시각"]);
});

// ── 시각 없는 정차 ────────────────────────────────────────────────────────────
test("시각이 없는 정차는 목록 끝으로 간다(0시로 취급해 맨 앞에 오면 안 된다)", () => {
  const rows = stopsOnly(buildUnifiedRun({
    seasonal: [seasonalSection({
      vehicles: [seasonalVehicle({
        stops: [
          seasonalStop({ label: "시간없음-특강", eta: null, students: [seasonalStudent("s1", "가")] }),
          seasonalStop({ label: "09시-특강", eta: "09:00 승차", students: [seasonalStudent("s2", "나")] }),
        ],
      })],
    })],
    regular: [regularClass({
      board: [
        regularStop({ label: "시간없음-정규", arriveTime: null, rows: [regularRow("r1", "다")] }),
        regularStop({ label: "20시-정규", arriveTime: "20:00", rows: [regularRow("r2", "라")] }),
      ],
    })],
  }));
  assert.deepEqual(rows.map((r) => r.label), ["09시-특강", "20시-정규", "시간없음-특강", "시간없음-정규"]);
  // 시각이 없으면 화면에 '시간 미정'으로 표시하도록 time 은 null 이어야 한다.
  assert.equal(rows.at(-1).time, null);
  assert.equal(rows.at(-2).time, null);
});

// ── 탑승 체크 종류·저장 키 ────────────────────────────────────────────────────
test("각 행은 자기 종류에 맞는 탑승 체크 정보를 들고 있다(저장 경로 분기의 근거)", () => {
  const rows = stopsOnly(buildUnifiedRun({
    seasonal: [
      seasonalSection({ direction: "PICKUP", vehicles: [seasonalVehicle({ stops: [seasonalStop({ label: "등원정차", eta: "09:00 승차", students: [seasonalStudent("req-1", "김특강")] })] })] }),
      seasonalSection({ direction: "DROPOFF", vehicles: [seasonalVehicle({ stops: [seasonalStop({ label: "하원정차", eta: "12:00 하차", students: [seasonalStudent("req-1", "김특강")] })] })] }),
    ],
    regular: [regularClass({ board: [regularStop({ label: "정규정차", arriveTime: "15:00", rows: [regularRow("sheet-row-9", "이정규")] })] })],
  }));

  const [pickup, dropoff, regular] = [rows[0], rows[1], rows[2]];
  // 특강: 저장 키 = shuttleRequestId, 방향별로 따로 저장되므로 상태 키에 방향이 들어간다.
  assert.equal(pickup.riders[0].kind, "SEASONAL");
  assert.equal(pickup.riders[0].checkId, "req-1");
  assert.equal(pickup.riders[0].direction, "PICKUP");
  assert.equal(dropoff.riders[0].direction, "DROPOFF");
  assert.notEqual(pickup.riders[0].key, dropoff.riders[0].key); // 등원/하원 체크가 섞이면 안 된다
  // 정규: 저장 키 = 시트 정차행 id 그대로(과거 기록 연속성).
  assert.equal(regular.riders[0].kind, "REGULAR");
  assert.equal(regular.riders[0].checkId, "sheet-row-9");
  assert.equal(regular.riders[0].key, "R:sheet-row-9");
  // 종류가 달라도 상태 키는 절대 겹치지 않는다.
  const keys = rows.flatMap((r) => r.riders.map((x) => x.key));
  assert.equal(new Set(keys).size, keys.length);
});

// ── 안전장치 보존 ─────────────────────────────────────────────────────────────
test("정규 안전장치(확정 전 배지 · 노선에 없는 승객 · 결석 자동 제외)가 행에 그대로 실린다", () => {
  const rows = stopsOnly(buildUnifiedRun({
    regular: [
      regularClass({ classTime: "PICKUP@17:00", title: "🕒 17:00 수업 · 등원", pending: true,
        board: [regularStop({ label: "임시순서정차", arriveTime: "16:30", rows: [regularRow("r1", "가", true)] })] }),
      regularClass({ classTime: "PICKUP#leftover", title: "⚠️ 노선에 없는 승객 · 등원", pending: true,
        board: [regularStop({ label: "누락정차", arriveTime: "16:40", rows: [regularRow("r2", "나")] })] }),
    ],
  }));
  assert.equal(rows[0].pending, true);
  assert.equal(rows[0].riders[0].absent, true);          // 결석 자동 제외 표시가 살아 있다
  assert.equal(rows[1].warn, true);                      // '노선에 없는 승객'
  assert.match(rows[1].groupLabel, /노선에 없는 승객/);   // 경고 문구를 지우지 않는다
});

test("특강 안내 줄(차고지 출발 · 학원 도착)은 시각이 있을 때만 만들고 진행률에서 빠진다", () => {
  const rows = buildUnifiedRun({
    seasonal: [seasonalSection({
      direction: "PICKUP", time: "09:30",
      vehicles: [seasonalVehicle({
        depart: "08:50", arrive: "09:20",
        stops: [seasonalStop({ label: "정차", eta: "09:00 승차", students: [seasonalStudent("s1", "가")] })],
      })],
    })],
  });
  const terminals = rows.filter((r) => r.isTerminal);
  assert.deepEqual(terminals.map((r) => r.label), ["차고지 출발", "STIZ 다산점 도착"]);
  assert.deepEqual(terminals.map((r) => r.time), ["08:50", "09:20"]);
  assert.equal(terminals[1].subLabel, "수업 09:30 시작");
  assert.deepEqual(rows.map((r) => r.label), ["차고지 출발", "정차", "STIZ 다산점 도착"]);
  assert.equal(countProgress(rows, {}).total, 1); // 안내 줄은 진행률 분모에 들어가지 않는다

  // 시각이 없으면 안내 줄 자체를 만들지 않는다(시간 미정 줄이 끝에 쌓이지 않게).
  const noTime = buildUnifiedRun({
    seasonal: [seasonalSection({ vehicles: [seasonalVehicle({ stops: [seasonalStop({ label: "정차", eta: "09:00 승차" })] })] })],
  });
  assert.equal(noTime.filter((r) => r.isTerminal).length, 0);
});

test("차량이 둘 이상일 때만 차량 이름을 붙인다(정보 최소화)", () => {
  const one = buildSeasonalRows([seasonalSection({ vehicles: [seasonalVehicle({ stops: [seasonalStop({ label: "A", eta: "09:00" })] })] })]);
  assert.equal(one[0].groupLabel, null);
  const two = buildSeasonalRows([seasonalSection({
    vehicles: [
      seasonalVehicle({ name: "1호차", stops: [seasonalStop({ label: "A", eta: "09:00" })] }),
      seasonalVehicle({ name: "2호차", stops: [seasonalStop({ label: "B", eta: "09:05" })] }),
    ],
  })]);
  assert.match(two[0].groupLabel, /1호차/);
  assert.match(two[1].groupLabel, /2호차/);
  assert.notEqual(two[0].groupKey, two[1].groupKey); // 순서 편집이 차량을 넘나들지 않게
});

// ── 진행률 ────────────────────────────────────────────────────────────────────
test("진행률 — 탑승/결석/자차를 세고, 같은 학생이 여러 줄에 있어도 한 번만 센다", () => {
  const rows = buildUnifiedRun({
    seasonal: [seasonalSection({ vehicles: [seasonalVehicle({ stops: [
      seasonalStop({ label: "A", eta: "09:00", students: [seasonalStudent("s1", "가"), seasonalStudent("s2", "나")] }),
      seasonalStop({ label: "B", eta: "09:10", students: [seasonalStudent("s1", "가")] }), // 같은 학생 중복 노출
    ] })] })],
    regular: [regularClass({ board: [regularStop({ label: "C", arriveTime: "15:00", rows: [regularRow("r1", "다")] })] })],
  });
  const p = countProgress(rows, { "S:PICKUP:s1": "BOARDED", "S:PICKUP:s2": "NOSHOW", "R:r1": "SELF" });
  assert.deepEqual(p, { total: 3, boarded: 1, noshow: 1, self: 1 });
});

// ── 손상 입력 방어 ────────────────────────────────────────────────────────────
test("비어 있거나 빠진 필드가 있어도 터지지 않는다", () => {
  assert.deepEqual(buildSeasonalRows([{ direction: "PICKUP", startName: "차고지", endName: "학원" }]), []);
  assert.deepEqual(buildRegularRows([{ classTime: "17:00" }]), []);
  assert.deepEqual(sortUnifiedRows([]), []);
});

// ── 화면·API 계약 가드 ────────────────────────────────────────────────────────
test("통합 화면은 종류별 기존 저장 API·기존 파라미터를 그대로 쓴다", async () => {
  const src = await readFile("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");
  assert.match(src, /"\/api\/shuttle\/boarding"/);
  assert.match(src, /"\/api\/shuttle\/regular-boarding"/);
  // 특강은 direction + shuttleRequestId, 정규는 rowId — 파라미터 이름이 바뀌면 과거 기록과 끊긴다.
  assert.match(src, /shuttleRequestId: rider\.checkId/);
  assert.match(src, /rowId: rider\.checkId/);
  // 미탑승 사유 구분(결석 / 자차)도 종전대로.
  assert.match(src, /NOSHOW/);
  assert.match(src, /SELF/);
});

test("기사님 카드의 시간·길안내와 이름 옆 연락처 배치를 유지한다", async () => {
  const src = await readFile("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");
  const css = await readFile("src/components/shuttle/DriverWorkspace.module.css", "utf8");
  // 실제 크기·겹침은 별도 브라우저 검사에서 확인한다. 이 가드는 연결 누락만 확인한다.
  assert.match(src, /className=\{styles\.timeNavigation\}/);
  assert.match(src, /className=\{styles\.navigation\}/);
  assert.match(css, /\.timeNavigation\s*\{[^}]*display:\s*flex/);
  assert.match(src, /near_me<\/span> 길안내/);
  assert.doesNotMatch(src, /flex h-12 items-center justify-center gap-1\.5 rounded-xl bg-blue-600/);
  assert.match(src, /className=\{styles\.contacts\}/);
  assert.match(src, /className=\{styles\.riderMain\}/);
  assert.match(src, /className=\{styles\.boardingActions\}/);
  assert.match(css, /\.boardingActions button\s*\{[^}]*min-width:\s*52px/);
});

test("운행 시작은 헤더 오른쪽에만 두고 순서·시간 수정은 목록 제목 옆에 둔다", async () => {
  const src = await readFile("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");
  assert.match(src, /const orderControls = stopRows\.length > 0/);
  assert.match(src, /min-h-11[^\n]*[\s\S]*↕ 순서·시간 수정/);
  assert.match(src, /<header[\s\S]*runState === "idle"[\s\S]*운행 시작/);
  assert.doesNotMatch(src, /운행을 시작하면 위치가 관리자에게 공유됩니다/);
  assert.match(src, /운행 순서 ·[\s\S]*\{orderControls\}/);
});

test("탑승 상태 저장·조회 키는 특강/정규 접두사로만 합치고, 저장할 땐 원래 키로 되돌린다", async () => {
  const src = await readFile("src/lib/shuttle/unifiedDriverRun.ts", "utf8");
  assert.match(src, /S:PICKUP:/);
  assert.match(src, /S:DROPOFF:/);
  assert.match(src, /R:\$\{id\}/);
});

test("기사 통합 링크는 종료된 방학특강 시즌을 정규 운행에 섞지 않는다", async () => {
  const src = await readFile("src/lib/shuttle/unifiedDriverRun.ts", "utf8");
  assert.match(src, /hasSeasonalRunOnDate/);
  assert.match(src, /SpecialProgramSeason/);
  assert.match(src, /startsAt/);
  assert.match(src, /endsAt/);
  assert.match(src, /if \(!\(await hasSeasonalRunOnDate\(viewDate\)\)\) return \[\];/);
});
