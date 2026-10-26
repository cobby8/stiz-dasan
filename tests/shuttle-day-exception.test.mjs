import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// "오늘만" 셔틀 변경(안 탐 / 다른 곳에서 탐).
// 결석과 다르다 — 아이는 수업에 온다. 기사님 화면에서도 다른 배지로 보여야 한다.

const rulesSource = await readFile("src/lib/shuttle/dayExceptionRules.ts", "utf8");
const { validateShuttleException, describeException, appliesToDirection, addDays } = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(rulesSource, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString("base64")}`
);

const logicSource = await readFile("src/lib/shuttle/regularDriverRouteLogic.ts", "utf8");
const { attachShuttleDayNotes } = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(logicSource, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString("base64")}`
);

const parentLib = await readFile("src/lib/shuttle/parent-shuttle-exception.ts", "utf8");
const route = await readFile("src/lib/shuttle/regularDriverRoute.ts", "utf8");
const client = await readFile("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");

const TODAY = { today: "2026-08-09" };

test("지난 날과 너무 먼 날은 막는다", () => {
  // 지난 날은 기사님이 이미 운행을 마쳤다. 바꿔봐야 아무 일도 일어나지 않는다.
  assert.equal(
    validateShuttleException({ serviceDate: "2026-08-08", direction: "PICKUP", kind: "SKIP" }, TODAY).error,
    "DATE_IN_PAST",
  );
  assert.equal(
    validateShuttleException({ serviceDate: "2026-09-30", direction: "PICKUP", kind: "SKIP" }, TODAY).error,
    "DATE_TOO_FAR",
  );
  // 오늘은 된다 — 아침에 갑자기 안 타는 경우가 실제로 많다.
  assert.equal(
    validateShuttleException({ serviceDate: "2026-08-09", direction: "PICKUP", kind: "SKIP" }, TODAY).ok,
    true,
  );
  assert.equal(addDays("2026-08-09", 14), "2026-08-23");
});

test("장소 변경은 장소가 있어야 하고, 안 타는 날은 장소를 받지 않는다", () => {
  assert.equal(
    validateShuttleException({ serviceDate: "2026-08-10", direction: "PICKUP", kind: "LOCATION" }, TODAY).error,
    "LOCATION_REQUIRED",
  );
  // 화면과 서버가 어긋난 신호라 조용히 버리지 않는다.
  assert.equal(
    validateShuttleException(
      { serviceDate: "2026-08-10", direction: "PICKUP", kind: "SKIP", location: "다산초" },
      TODAY,
    ).error,
    "LOCATION_NOT_ALLOWED",
  );
  assert.equal(
    validateShuttleException(
      { serviceDate: "2026-08-10", direction: "BOTH", kind: "LOCATION", location: "다산초 정문" },
      TODAY,
    ).ok,
    true,
  );
});

test("엉뚱한 방향·종류를 거른다", () => {
  assert.equal(
    validateShuttleException({ serviceDate: "2026-08-10", direction: "SIDEWAYS", kind: "SKIP" }, TODAY).error,
    "INVALID_DIRECTION",
  );
  assert.equal(
    validateShuttleException({ serviceDate: "2026-08-10", direction: "PICKUP", kind: "DELETE" }, TODAY).error,
    "INVALID_KIND",
  );
  assert.equal(validateShuttleException({ serviceDate: "2026-02-30" }, TODAY).error, "INVALID_DATE");
});

test("BOTH 는 등원·하원 모두에 적용된다", () => {
  assert.equal(appliesToDirection("BOTH", "PICKUP"), true);
  assert.equal(appliesToDirection("BOTH", "DROPOFF"), true);
  assert.equal(appliesToDirection("PICKUP", "DROPOFF"), false);
  assert.equal(appliesToDirection("DROPOFF", "DROPOFF"), true);
});

test("기사님이 읽을 한 줄에 '셔틀'을 넣어 결석과 구분한다", () => {
  assert.equal(describeException({ kind: "SKIP" }), "오늘 셔틀 안 탐");
  assert.match(describeException({ kind: "LOCATION", location: "다산초 정문" }), /오늘 탑승 장소: 다산초 정문/);
});

test("명단에 예외를 덧붙일 때 방향을 지킨다", () => {
  const classes = [{
    classTime: "15:00",
    board: [{ label: "A", arriveTime: null, lat: null, lng: null, direction: "BOARD",
      rows: [{ rowId: "r1", name: "김루빈", parentPhone: "01011112222", studentPhone: null }] }],
    alight: [{ label: "B", arriveTime: null, lat: null, lng: null, direction: "ALIGHT",
      rows: [{ rowId: "r2", name: "김루빈", parentPhone: "01011112222", studentPhone: null }] }],
  }];
  const exceptions = [{ name: "김루빈", phone: "01011112222", direction: "PICKUP", kind: "SKIP", location: null }];
  const out = attachShuttleDayNotes(
    classes,
    exceptions,
    (row, entry) => row.name === entry.name,
    describeException,
  );
  // 등원만 신청했으면 하원에는 붙으면 안 된다.
  assert.equal(out[0].board[0].rows[0].shuttleNote, "오늘 셔틀 안 탐");
  assert.equal(out[0].alight[0].rows[0].shuttleNote, undefined);
});

test("예외가 없으면 명단을 건드리지 않는다", () => {
  const classes = [{ classTime: "15:00", board: [], alight: [] }];
  assert.equal(attachShuttleDayNotes(classes, [], () => true, describeException), classes);
});

test("본인 자녀·재원생만 신청할 수 있다", () => {
  assert.match(parentLib, /s\.id = \$1 AND \$\{await childAccessSql\("s", "\$2"\)\}/);
  assert.match(parentLib, /e\.status = 'ACTIVE'/);
  assert.match(parentLib, /본인 자녀만 신청할 수 있습니다/);
});

test("날짜는 서버 시계로 판정한다", () => {
  // 클라이언트 시계를 믿으면 지난 날도 바꿀 수 있다.
  assert.match(parentLib, /validateShuttleException\(input, \{ today: kstTodayYmd\(\) \}\)/);
});

test("같은 날·같은 방향에 살아있는 예외는 한 건만 둔다", () => {
  // 두 건이 살아 있으면 기사님이 무엇을 따를지 모른다.
  assert.match(parentLib, /SET "canceledAt" = now\(\)[\s\S]{0,200}direction = \$3\s*\n\s*AND "canceledAt" IS NULL/);
});

test("예외 조회가 실패해도 운행 명단은 뜬다", () => {
  // 부가 정보 때문에 기사님이 명단을 통째로 못 보면 더 큰 문제다.
  assert.match(parentLib, /catch \(error\)[\s\S]{0,200}return \[\];/);
});

test("명단을 다 만든 뒤 덧붙인다", () => {
  // 저장 노선·폴백 두 경로 모두에 적용되어야 하는데, 조립 안에 심으면 한쪽만 고쳐지기 쉽다.
  assert.match(route, /const classes = assembleRegularDriverClasses\(\{/);
  assert.match(route, /return attachShuttleDayNotes\(/);
  // 결석과 같은 이름·전화 매칭을 쓴다(시트 명단에는 학생 id 가 없다).
  assert.match(route, /matchAbsentee\(row, \[\{ name: entry\.name, phone: entry\.phone \}\]\)/);
});

test("기사님 화면에서 결석과 다른 배지로 보인다", () => {
  // 결석 배지(빨강)와 같으면 "아이가 안 온다"로 잘못 읽힌다.
  assert.match(client, /rider\.shuttleNote && <span className="rounded-md bg-blue-600/);
  assert.match(client, /오늘 결석/);
});
