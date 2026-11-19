import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 체험 셔틀(2026-11-19 원장 결정) — 체험 학생을 «체험 날 하루만» 정규 운행 묶음 안에 끼운다.
// 어긋나면: ① 기사님 운행표에서 체험 아이가 빠지거나 엉뚱한 자리에 나온다 ② 정규 줄 순서·탑승 체크가 바뀐다
//           ③ 배정이 풀렸는데 상태가 «배정됨»으로 남는다 ④ 청구 자동 발행이 멈춘다(정규 명단에 들어가면).
// 순수 로직은 실제로 실행하고, DB·화면 연결은 소스 글자로 못박는다. 실제 날짜·시계에 기대지 않는다.

const logic = await loadTsModule("src/lib/shuttle/unifiedDriverRunLogic.ts");
const rules = await loadTsModule("src/lib/shuttle/trialShuttleRules.ts");
const placement = await loadTsModule("src/lib/shuttle/trialShuttlePlacement.ts");
const blocks = await loadTsModule("src/lib/shuttle/runBlocks.ts");
const read = (path) => readFile(path, "utf8");

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────
function regularClass({ classTime = "16:00~17:00", board = [], alight = [] } = {}) {
  return { classTime, pending: false, board, alight };
}
function stop(label, arriveTime, direction = "BOARD", rowIds = [`row-${label}`]) {
  return { label, arriveTime, lat: 37.6, lng: 127.1, direction, rows: rowIds.map((rowId) => ({ rowId, name: `학생-${rowId}`, parentPhone: null, studentPhone: null })) };
}
function ride(overrides = {}) {
  return {
    rideId: "ride-1", direction: "BOARD", classTime: "16:00~17:00", afterStopName: "가 정류장", sortOrder: 0,
    stopName: "체험 정류장", arriveTime: "15:33", lat: 37.61, lng: 127.11, childName: "김체험", grade: "초2", parentPhone: "010-0000-0000",
    ...overrides,
  };
}
const REGULAR = [regularClass({
  board: [stop("가 정류장", "15:30"), stop("나 정류장", "15:40"), stop("다 정류장", "15:45")],
  alight: [stop("다 정류장", "17:10", "ALIGHT", ["out-다"]), stop("가 정류장", "17:20", "ALIGHT", ["out-가"])],
})];

// ── 운행표 조립 ───────────────────────────────────────────────────────────────

test("체험 줄이 없으면 운행표는 종전과 글자 그대로 같다(정규·특강 회귀 0)", () => {
  assert.deepEqual(logic.buildUnifiedRun({ regular: REGULAR, trial: [] }), logic.buildUnifiedRun({ regular: REGULAR }));
});

test("체험 줄은 지정한 정류장 바로 다음에 «체험»(TRIAL)으로 나오고 정규 줄은 그대로다", () => {
  const before = logic.buildUnifiedRun({ regular: REGULAR });
  const rows = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride()] });
  assert.equal(rows.length, before.length + 1);
  const labels = rows.filter((r) => r.direction === "PICKUP").map((r) => `${r.kind}:${r.label}`);
  assert.deepEqual(labels, ["REGULAR:가 정류장", "TRIAL:체험 정류장", "REGULAR:나 정류장", "REGULAR:다 정류장"]);
  // 정규 줄은 내용이 하나도 바뀌지 않는다(순서 번호 seq 만 한 칸씩 밀린다)
  const strip = (list) => list.filter((r) => r.kind === "REGULAR").map(({ seq, ...rest }) => rest);
  assert.deepEqual(strip(rows), strip(before));
});

test("체험 줄의 탑승 체크 키는 하루 탑승 id — 정규(R:)·특강(S:)과 겹치지 않는다", () => {
  const rows = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride()] });
  const trial = rows.find((r) => r.kind === "TRIAL");
  assert.equal(trial.key, "T:ride-1");
  assert.equal(trial.direction, "PICKUP");
  assert.equal(trial.time, "15:33");
  assert.deepEqual(trial.riders.map((r) => [r.key, r.checkId, r.kind, r.name, r.grade, r.parentPhone]), [["T:ride-1", "ride-1", "TRIAL", "김체험", "초2", "010-0000-0000"]]);
  // 묶음 키를 따로 둔다 — 정규 묶음의 순서 편집·시각 다시 계산에 섞이지 않는다
  assert.ok(trial.groupKey.startsWith("T:"));
  assert.ok(rows.filter((r) => r.kind === "REGULAR").every((r) => r.groupKey.startsWith("R:")));
  // 같은 묶음 이름표를 쓴다(기사님이 어느 수업 운행인지 안다)
  assert.equal(trial.groupLabel, rows.find((r) => r.kind === "REGULAR" && r.direction === "PICKUP").groupLabel);
});

test("같은 시각이면 끼운 자리가 순서를 정한다 — 지정 정류장 다음, 다음 정류장 앞", () => {
  const rows = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride({ afterStopName: "나 정류장", arriveTime: "15:40" })] });
  const labels = rows.filter((r) => r.direction === "PICKUP").map((r) => r.label);
  assert.deepEqual(labels, ["가 정류장", "나 정류장", "체험 정류장", "다 정류장"]);
});

test("시각이 모두 없는 묶음에서도 지정한 자리 그대로다(시간 미정은 원래 순서)", () => {
  const untimed = [regularClass({ board: [stop("가 정류장", null), stop("나 정류장", null)] })];
  const rows = logic.buildUnifiedRun({ regular: untimed, trial: [ride({ afterStopName: "가 정류장", arriveTime: null })] });
  assert.deepEqual(rows.map((r) => r.label), ["가 정류장", "체험 정류장", "나 정류장"]);
  const first = logic.buildUnifiedRun({ regular: untimed, trial: [ride({ afterStopName: null, arriveTime: null })] });
  assert.deepEqual(first.map((r) => r.label), ["체험 정류장", "가 정류장", "나 정류장"]);
});

test("하원 체험 줄은 하원 묶음에만 끼운다(같은 이름의 등원 정류장에 붙지 않는다)", () => {
  const rows = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride({ rideId: "ride-2", direction: "ALIGHT", afterStopName: "다 정류장", arriveTime: "17:10" })] });
  const dropoff = rows.filter((r) => r.direction === "DROPOFF").map((r) => `${r.kind}:${r.label}`);
  assert.deepEqual(dropoff, ["REGULAR:다 정류장", "TRIAL:체험 정류장", "REGULAR:가 정류장"]);
  assert.equal(rows.find((r) => r.kind === "TRIAL").direction, "DROPOFF");
});

test("명단이 바뀌어 정류장·묶음을 못 찾아도 체험 줄은 절대 빠지지 않는다", () => {
  const gone = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride({ afterStopName: "없어진 정류장", arriveTime: "15:50" })] });
  assert.equal(gone.filter((r) => r.kind === "TRIAL").length, 1);
  const noGroup = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride({ classTime: "19:00~20:00", arriveTime: "18:40" })] });
  const trial = noGroup.find((r) => r.kind === "TRIAL");
  assert.ok(trial);
  assert.equal(trial.groupLabel, "19:00~20:00 수업");
  // 그 요일에 정규 운행이 아예 없어도 나온다
  assert.equal(logic.buildUnifiedRun({ regular: [], trial: [ride()] }).length, 1);
});

test("수업시간 글자의 공백 차이는 같은 묶음으로 본다 — 묶음을 찾았다는 표시(이름표·hostGroupKey)와 시각 없는 자리로 확인", () => {
  // 시각 정렬에 기대지 않는다: 묶음을 못 찾으면 이름표가 «16:00 ~ 17:00 수업»이 되고 hostGroupKey 가 없다
  const rows = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride({ classTime: "16:00 ~ 17:00", arriveTime: "15:30" })] });
  const trial = rows.find((r) => r.kind === "TRIAL");
  const host = rows.find((r) => r.kind === "REGULAR" && r.direction === "PICKUP");
  assert.equal(trial.groupLabel, host.groupLabel);
  assert.equal(trial.hostGroupKey, host.groupKey);
  // 시각이 하나도 없는 묶음 — 자리를 정하는 것은 끼운 위치뿐이다(묶음을 못 찾으면 맨 끝으로 간다)
  const untimed = [regularClass({ board: [stop("가 정류장", null), stop("나 정류장", null), stop("다 정류장", null)] })];
  const placed = logic.buildUnifiedRun({ regular: untimed, trial: [ride({ classTime: " 16:00  ~ 17:00 ", afterStopName: "가  정류장", arriveTime: null })] });
  assert.deepEqual(placed.map((r) => r.label), ["가 정류장", "체험 정류장", "나 정류장", "다 정류장"]);
  // 수업시간이 정말 다르면 같은 묶음이 아니다
  const other = logic.buildUnifiedRun({ regular: untimed, trial: [ride({ classTime: "17:00~18:00", afterStopName: "가 정류장", arriveTime: null })] });
  assert.deepEqual(other.map((r) => r.label), ["가 정류장", "나 정류장", "다 정류장", "체험 정류장"]);
  assert.equal(other.find((r) => r.kind === "TRIAL").hostGroupKey, undefined);
});

test("정류장 이름 비교는 공백만 무시한다 — 글자 s 를 지우지 않는다(Xi 와 Xis 는 다른 정류장)", () => {
  const untimed = [regularClass({ board: [stop("Xi", null), stop("Xis", null), stop("끝 정류장", null)] })];
  const afterXi = logic.buildUnifiedRun({ regular: untimed, trial: [ride({ afterStopName: "Xi", arriveTime: null })] });
  assert.deepEqual(afterXi.map((r) => r.label), ["Xi", "체험 정류장", "Xis", "끝 정류장"]);
  const afterXis = logic.buildUnifiedRun({ regular: untimed, trial: [ride({ afterStopName: "Xis", arriveTime: null })] });
  assert.deepEqual(afterXis.map((r) => r.label), ["Xi", "Xis", "체험 정류장", "끝 정류장"]);
  // 수업시간 글자도 마찬가지 — «class» 와 «cla» 는 다른 묶음
  const named = [{ classTime: "class", pending: false, board: [stop("가", null)], alight: [] }];
  assert.equal(logic.buildUnifiedRun({ regular: named, trial: [ride({ classTime: "cla", afterStopName: null, arriveTime: null })] }).find((r) => r.kind === "TRIAL").hostGroupKey, undefined);
});

// ── 화면 묶음(블록) ───────────────────────────────────────────────────────────

test("체험 줄은 정규 묶음 머리를 쪼개지 않는다 — 그 묶음 안의 한 줄로 들어가고 순서·정규 편집 단위는 그대로", () => {
  const rows = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride()] });
  const out = blocks.groupRunBlocks(rows);
  // 등원 묶음 하나 + 하원 묶음 하나(«이어서» 조각이 생기지 않는다)
  assert.deepEqual(out.map((b) => [b.label, b.continued, b.rows.length]), [["16:00~17:00 수업 · 등원", false, 4], ["16:00~17:00 수업 · 하원", false, 2]]);
  // 순서는 한 줄도 바뀌지 않는다
  assert.deepEqual(out.flatMap((b) => b.rows), rows);
  // 순서 편집·저장 대조는 «같은 groupKey 의 정규 줄»만 본다 — 체험 줄은 블록 안에 보여도 그 집합에 들어가지 않는다
  const board = out[0];
  const editable = board.rows.filter((r) => r.groupKey === board.groupKey && !r.isTerminal);
  assert.deepEqual(editable.map((r) => r.label), ["가 정류장", "나 정류장", "다 정류장"]);
  assert.ok(editable.every((r) => r.kind === "REGULAR"));
  assert.deepEqual(board.rows.filter((r) => r.kind === "TRIAL").map((r) => r.groupKey), ["T:ride-1"]);
  // 체험 줄이 없을 때의 묶음과 머리·정규 줄이 같다
  const plain = blocks.groupRunBlocks(logic.buildUnifiedRun({ regular: REGULAR }));
  assert.deepEqual(out.map((b) => [b.key, b.label, b.kind]), plain.map((b) => [b.key, b.label, b.kind]));
});

test("체험 줄이 혼자 머리를 가질 때는 «체험 · 등원»으로 구분된다(정규 머리와 같은 글자가 되지 않는다)", () => {
  assert.equal(blocks.runBlockLabel({ kind: "TRIAL", direction: "PICKUP", groupLabel: "🕒 16:00~17:00 수업" }), "체험 · 등원 · 16:00~17:00 수업");
  assert.equal(blocks.runBlockLabel({ kind: "TRIAL", direction: "DROPOFF", groupLabel: null }), "체험 · 하원");
  // 묶음 맨 앞에 끼운 체험 줄 — 앞 블록이 그 묶음이 아니라 자기 머리를 갖고, 뒤 정규 묶음은 «이어서» 없이 시작한다
  const first = blocks.groupRunBlocks(logic.buildUnifiedRun({ regular: REGULAR, trial: [ride({ afterStopName: null, arriveTime: "15:20" })] }));
  assert.deepEqual(first.slice(0, 2).map((b) => [b.kind, b.label, b.continued]), [["TRIAL", "체험 · 등원 · 16:00~17:00 수업", false], ["REGULAR", "16:00~17:00 수업 · 등원", false]]);
  // 끼어들 묶음이 없는 체험 줄
  const alone = blocks.groupRunBlocks(logic.buildUnifiedRun({ regular: [], trial: [ride()] }));
  assert.deepEqual(alone.map((b) => b.label), ["체험 · 등원 · 16:00~17:00 수업"]);
});

// ── 운행표에 내보낼지 ─────────────────────────────────────────────────────────

test("체험 당일 «등록 전환»해도 그날 줄은 운행표에 남는다 — 취소·이탈만 빠진다", () => {
  const on = (over = {}) => rules.trialRideOnRunSheet({ leadStatus: "SCHEDULED", shuttleStatus: "ASSIGNED", serviceDate: "2026-11-20", scheduledYmd: "2026-11-20", todayYmd: "2026-11-20", ...over });
  assert.equal(on(), true);
  // 수업 뒤 바로 등록 → 아직 안 돈 하원 줄이 사라지면 안 된다
  assert.equal(on({ leadStatus: "CONVERTED" }), true);
  assert.equal(on({ leadStatus: "ATTENDED" }), true);
  assert.equal(on({ leadStatus: "CANCELLED" }), false);
  assert.equal(on({ leadStatus: "LOST" }), false);
  // 배정 게이트는 여전히 등록 전환을 막는다(새 배정은 안 된다)
  assert.equal(rules.trialShuttleAssignGate({ leadStatus: "CONVERTED", scheduledYmd: "2026-11-20", todayYmd: "2026-11-20" }).ok, false);
  assert.equal(rules.isTrialLeadClosedForShuttle("CONVERTED"), true);
  assert.equal(rules.isTrialLeadClosedForShuttle("SCHEDULED"), false);
});

test("운행표 노출 — 배정됨만 · 체험 날짜와 같은 날만 · 지난 날짜는 안 나온다(날짜 경계)", () => {
  const on = (over = {}) => rules.trialRideOnRunSheet({ leadStatus: "SCHEDULED", shuttleStatus: "ASSIGNED", serviceDate: "2026-11-20", scheduledYmd: "2026-11-20", todayYmd: "2026-11-19", ...over });
  assert.equal(on(), true); // 내일 운행표를 미리 볼 수 있다
  // 요청이 고쳐져 «다시 배정 필요»가 된 건은 살아 있는 줄이 남아 있어도 안 나온다
  for (const shuttleStatus of ["REQUESTED", "UNAVAILABLE", "NONE", undefined]) assert.equal(on({ shuttleStatus }), false, String(shuttleStatus));
  // 체험 날짜가 바뀌었으면 옛 날짜 줄은 안 나온다
  assert.equal(on({ scheduledYmd: "2026-11-27" }), false);
  assert.equal(on({ scheduledYmd: null }), false);
  // 지난 날짜(하루만 지나도) — 등록하지 않은 아이의 이름·전화가 과거 운행표에 남지 않는다
  assert.equal(on({ todayYmd: "2026-11-20" }), true);
  assert.equal(on({ todayYmd: "2026-11-21" }), false);
  // 월말·연말 경계
  assert.equal(on({ serviceDate: "2026-12-31", scheduledYmd: "2026-12-31", todayYmd: "2027-01-01" }), false);
  assert.equal(on({ serviceDate: "2027-01-01", scheduledYmd: "2027-01-01", todayYmd: "2026-12-31" }), true);
});

test("등록 전환된 신청 — 살아 있는 배정이 오늘 이후일 때만 «배정 풀기» 하나가 남는다", () => {
  const can = (over = {}) => rules.canReleaseConvertedTrialShuttle({ leadStatus: "CONVERTED", activeRideDates: ["2026-11-20"], todayYmd: "2026-11-20", ...over });
  assert.equal(can(), true); // 전환 당일
  assert.equal(can({ todayYmd: "2026-11-19" }), true); // 체험 전날 미리 등록
  assert.equal(can({ todayYmd: "2026-11-21" }), false); // 지난 날
  assert.equal(can({ activeRideDates: [] }), false); // 풀 줄이 없다
  assert.equal(can({ activeRideDates: ["2026-11-13", "2026-11-20"] }), true);
  assert.equal(can({ activeRideDates: ["엉뚱한 값"] }), false);
  // 월말·연말 경계
  assert.equal(can({ activeRideDates: ["2027-01-01"], todayYmd: "2026-12-31" }), true);
  assert.equal(can({ activeRideDates: ["2026-12-31"], todayYmd: "2027-01-01" }), false);
  // 취소·이탈은 버튼 없음, 살아 있는 신청은 보통 버튼 줄을 쓴다(이 판정 대상 아님)
  for (const leadStatus of ["CANCELLED", "LOST", "SCHEDULED", "ATTENDED", null]) assert.equal(can({ leadStatus }), false, String(leadStatus));
  assert.match(rules.CONVERTED_RELEASE_CONFIRM_TEXT, /등록 전환된 학생이라 풀면 다시 배정할 수 없습니다\./);
});

test("패널 — 등록 전환된 신청에는 «배정 풀기»만 남고 판정은 서버(KST)가 한다", async () => {
  const panel = await read("src/app/admin/trial/TrialShuttleAssignPanel.tsx");
  const tail = panel.slice(panel.indexOf("{closed && lead.canReleaseAfterConvert && ("), panel.indexOf("{/* 배정 입력 */}"));
  assert.ok(tail.length > 0);
  assert.match(tail, /onClick=\{\(\) => void submitRelease\(\)\}/);
  assert.doesNotMatch(tail, /학부모에게 문자|배정 수정|셔틀 어려움|setSmsOpen|setEditing|setUnavailableOpen/);
  assert.match(panel, /panel\?\.lead\?\.closed \? CONVERTED_RELEASE_CONFIRM_TEXT :/);
  const server = await read("src/lib/shuttle/trialShuttle.ts");
  assert.match(server, /canReleaseAfterConvert: canReleaseConvertedTrialShuttle\(\{ leadStatus: lead\.status, activeRideDates: rides\.map\(\(ride\) => ride\.serviceDate\), todayYmd: todayKst\(\) \}\)/);
});

// ── 글자 다듬기·요청 도장 ─────────────────────────────────────────────────────

test("위치명 등의 줄바꿈·제어문자는 공백이 된다 — 기사 알림·문자 초안의 줄 모양이 깨지지 않는다", () => {
  assert.equal(rules.cleanTrialLine(" 롯데캐슬\r\n정문\t(후문 아님)\u0000 "), "롯데캐슬 정문 (후문 아님)");
  assert.equal(rules.cleanTrialLine("가 나\u0085다"), "가 나 다");
  assert.equal(rules.cleanTrialLine(null), "");
  const parsed = rules.parseTrialAssignLegs([{ direction: "BOARD", classTime: "16:00~17:00\n", afterStopName: "가\n정류장", stopName: "정문\n하원: 다른 곳 23:59 도착 예정", address: "다산동\r\n1", latitude: null, longitude: null, arriveTime: "16:40" }]);
  assert.equal(parsed.ok, true);
  assert.deepEqual([parsed.legs[0].classTime, parsed.legs[0].afterStopName, parsed.legs[0].stopName, parsed.legs[0].address], ["16:00~17:00", "가 정류장", "정문 하원: 다른 곳 23:59 도착 예정", "다산동 1"]);
  // 줄바꿈만 있는 위치명은 빈 값이다
  assert.match(rules.parseTrialAssignLegs([{ direction: "BOARD", classTime: "16:00~17:00", stopName: "\n\t", arriveTime: "16:40" }]).error, /위치명/);
  // 이미 저장된 값에 줄바꿈이 있어도 문구는 한 줄씩 유지된다
  const legs = [{ direction: "BOARD", stopName: "정문\n하원: 가짜 줄", arriveTime: "16:40" }];
  const sms = rules.buildTrialShuttleParentSms({ childName: "김\n체험", serviceDate: "2026-11-20", legs });
  assert.equal(sms.split("\n").length, 4);
  assert.equal(sms.split("\n")[2], "등원: 정문 하원: 가짜 줄 16:40 탑승 예정");
  const notice = rules.buildTrialShuttleDriverNotice({ childName: "김\n체험", grade: "초2\n", serviceDate: "2026-11-20", legs });
  assert.doesNotMatch(notice.message, /[\r\n]/);
  assert.match(notice.message, /^체험 셔틀 배정: 김 체험\(초2\) /);
  assert.doesNotMatch(rules.buildTrialShuttleCancelNotice({ childName: "김\n체험", grade: null, serviceDate: "2026-11-20", directions: ["BOARD"] }).message, /[\r\n]/);
});

test("요청 도장 — 방향·위치가 바뀌면 달라지고, 그대로면 같다(위치 글자는 도장에 실리지 않는다)", () => {
  const lead = { shuttleNeeded: true, shuttleDirection: "BOTH", shuttlePickupName: "롯데캐슬 정문", shuttlePickupAddress: "다산동 1", shuttlePickupLat: 37.62, shuttlePickupLng: 127.15 };
  const stamp = rules.trialShuttleRequestStamp(lead);
  assert.equal(rules.trialShuttleRequestStamp({ ...lead }), stamp);
  // DB 가 준 값(숫자·null)과 화면 값(빈 칸)이 같은 요청이면 같은 도장
  assert.equal(rules.trialShuttleRequestStamp({ ...lead, shuttleDropoffName: null, shuttleDropoffAddress: undefined }), stamp);
  assert.notEqual(rules.trialShuttleRequestStamp({ ...lead, shuttlePickupName: "롯데캐슬 후문" }), stamp);
  assert.notEqual(rules.trialShuttleRequestStamp({ ...lead, shuttleDirection: "PICKUP" }), stamp);
  assert.notEqual(rules.trialShuttleRequestStamp({ ...lead, shuttlePickupLat: 37.63 }), stamp);
  assert.notEqual(rules.trialShuttleRequestStamp({ ...lead, shuttleDropoffName: "할머니 댁" }), stamp);
  assert.notEqual(rules.trialShuttleRequestStamp({ ...lead, shuttleNeeded: false }), stamp);
  assert.doesNotMatch(stamp, /롯데|다산/);
});

test("같은 자리에 체험 학생이 둘이면 sortOrder 순서대로 선다", () => {
  const rows = logic.buildUnifiedRun({ regular: REGULAR, trial: [
    ride({ rideId: "b", sortOrder: 2, childName: "둘째", arriveTime: "15:30" }),
    ride({ rideId: "a", sortOrder: 1, childName: "첫째", arriveTime: "15:30" }),
  ] });
  assert.deepEqual(rows.filter((r) => r.kind === "TRIAL").map((r) => r.riders[0].name), ["첫째", "둘째"]);
});

test("체험 줄은 진행률에 들어가고, 잠금·결석 기본값이 붙지 않는다", () => {
  const rows = logic.buildUnifiedRun({ regular: REGULAR, trial: [ride()] });
  const without = logic.countProgress(logic.buildUnifiedRun({ regular: REGULAR }), {});
  assert.equal(logic.countProgress(rows, {}).total, without.total + 1);
  assert.equal(logic.countProgress(rows, { "T:ride-1": "BOARDED" }).boarded, 1);
  const rider = rows.find((r) => r.kind === "TRIAL").riders[0];
  assert.deepEqual(logic.riderBoardingView(rider, null), { absentReported: false, status: null, absentDefault: false, dimmed: false, blocked: false });
  assert.equal(logic.riderLockLabel(rider), null);
});

// ── 상태 전이 ─────────────────────────────────────────────────────────────────

test("상태 이름 — 대기·배정됨·어려움·없음, 모르는 값은 «요청 없음»", () => {
  assert.equal(rules.trialShuttleStatusLabel("REQUESTED"), "셔틀 배정 대기");
  assert.equal(rules.trialShuttleStatusLabel("ASSIGNED"), "셔틀 배정됨");
  assert.equal(rules.trialShuttleStatusLabel("UNAVAILABLE"), "셔틀 어려움");
  assert.equal(rules.trialShuttleStatusLabel("NONE"), "셔틀 요청 없음");
  assert.equal(rules.trialShuttleStatusLabel(undefined), "셔틀 요청 없음");
  assert.equal(rules.normalizeTrialShuttleStatus("이상한 값"), "NONE");
});

test("요청 저장 때의 다음 상태 — 끄면 NONE, 내용이 바뀌면 다시 배정 대기", () => {
  const next = rules.nextShuttleStatusOnRequestChange;
  assert.equal(next({ current: "ASSIGNED", needed: false, requestChanged: false }), "NONE");
  assert.equal(next({ current: "NONE", needed: true, requestChanged: true }), "REQUESTED");
  assert.equal(next({ current: "REQUESTED", needed: true, requestChanged: false }), "REQUESTED");
  assert.equal(next({ current: "ASSIGNED", needed: true, requestChanged: false }), "ASSIGNED");
  assert.equal(next({ current: "ASSIGNED", needed: true, requestChanged: true }), "REQUESTED");
  assert.equal(next({ current: "UNAVAILABLE", needed: true, requestChanged: false }), "UNAVAILABLE");
  assert.equal(next({ current: "UNAVAILABLE", needed: true, requestChanged: true }), "REQUESTED");
  assert.equal(next({ current: undefined, needed: true, requestChanged: false }), "REQUESTED");
});

test("배정이 풀리면 «배정 대기»(다시 배정 필요)로 — 셔틀 어려움만 UNAVAILABLE", () => {
  const after = rules.shuttleStatusAfterRelease;
  for (const reason of ["RESCHEDULED", "CANCELLED", "LOST", "REQUEST_CHANGED", "ADMIN_RELEASE"]) {
    assert.equal(after("ASSIGNED", reason), "REQUESTED", reason);
    assert.equal(after("REQUESTED", reason), "REQUESTED", reason);
    assert.equal(after("NONE", reason), "NONE", reason);
    assert.equal(after("UNAVAILABLE", reason), "UNAVAILABLE", reason);
  }
  assert.equal(after("ASSIGNED", "UNAVAILABLE"), "UNAVAILABLE");
  assert.equal(after("REQUESTED", "UNAVAILABLE"), "UNAVAILABLE");
  assert.equal(after("NONE", "UNAVAILABLE"), "NONE");
});

test("배정 가능 판정 — 일정 확정 뒤·지나지 않은 날·살아 있는 신청(날짜 경계 포함)", () => {
  const gate = rules.trialShuttleAssignGate;
  assert.deepEqual(gate({ leadStatus: "SCHEDULED", scheduledYmd: "2026-11-20", todayYmd: "2026-11-19" }), { ok: true });
  // 당일은 배정할 수 있다
  assert.deepEqual(gate({ leadStatus: "SCHEDULED", scheduledYmd: "2026-11-19", todayYmd: "2026-11-19" }), { ok: true });
  assert.equal(gate({ leadStatus: "SCHEDULED", scheduledYmd: null, todayYmd: "2026-11-19" }).reason, "일정 확정 뒤 배정할 수 있습니다.");
  assert.equal(gate({ leadStatus: "SCHEDULED", scheduledYmd: "2026-11-18", todayYmd: "2026-11-19" }).ok, false);
  // 월말·연말 경계
  assert.deepEqual(gate({ leadStatus: "SCHEDULED", scheduledYmd: "2027-01-01", todayYmd: "2026-12-31" }), { ok: true });
  assert.equal(gate({ leadStatus: "SCHEDULED", scheduledYmd: "2026-12-31", todayYmd: "2027-01-01" }).ok, false);
  for (const closed of ["CANCELLED", "LOST", "CONVERTED"]) {
    assert.equal(gate({ leadStatus: closed, scheduledYmd: "2026-11-20", todayYmd: "2026-11-19" }).ok, false, closed);
  }
});

test("배정 대기 판정·문구 — 취소·이탈·등록·다녀간 신청은 세지 않고 0건이면 글자가 없다", () => {
  assert.equal(rules.isTrialShuttleWaiting({ shuttleStatus: "REQUESTED", status: "SCHEDULED" }), true);
  assert.equal(rules.isTrialShuttleWaiting({ shuttleStatus: "REQUESTED", status: "NEW" }), true);
  for (const status of ["CANCELLED", "LOST", "CONVERTED", "ATTENDED"]) {
    assert.equal(rules.isTrialShuttleWaiting({ shuttleStatus: "REQUESTED", status }), false, status);
  }
  assert.equal(rules.isTrialShuttleWaiting({ shuttleStatus: "ASSIGNED", status: "SCHEDULED" }), false);
  assert.equal(rules.trialShuttleWaitingLabel(0), null);
  assert.equal(rules.trialShuttleWaitingLabel(3), "체험 셔틀 배정 대기 3건");
});

test("요청 방향 → 배정할 방향", () => {
  assert.deepEqual(rules.requestedRideDirections("BOTH"), ["BOARD", "ALIGHT"]);
  assert.deepEqual(rules.requestedRideDirections("PICKUP"), ["BOARD"]);
  assert.deepEqual(rules.requestedRideDirections("DROPOFF"), ["ALIGHT"]);
  assert.deepEqual(rules.requestedRideDirections(null), ["BOARD", "ALIGHT"]);
});

test("하원 위치 4칸이 전부 비어 있으면 «등원과 같은 곳»", () => {
  const lead = { shuttlePickupName: "롯데캐슬 정문", shuttlePickupAddress: "다산동 1", shuttlePickupLat: 37.62, shuttlePickupLng: 127.15 };
  assert.deepEqual(rules.requestedTrialPlace(lead, "ALIGHT"), { name: "롯데캐슬 정문", address: "다산동 1", lat: 37.62, lng: 127.15 });
  const separate = { ...lead, shuttleDropoffName: "할머니 댁", shuttleDropoffAddress: "다산동 9" };
  assert.deepEqual(rules.requestedTrialPlace(separate, "ALIGHT"), { name: "할머니 댁", address: "다산동 9", lat: null, lng: null });
  assert.equal(rules.requestedTrialPlace(separate, "BOARD").name, "롯데캐슬 정문");
  // 위치명이 없으면 주소를 이름 자리에 미리 채운다(관리자가 고친다)
  assert.equal(rules.requestedTrialPlace({ shuttlePickupAddress: "다산동 4002-1" }, "BOARD").name, "다산동 4002-1");
  // 좌표가 한쪽만 있으면 쓰지 않는다
  assert.deepEqual(rules.requestedTrialPlace({ shuttlePickupName: "가", shuttlePickupLat: 37.6 }, "BOARD"), { name: "가", address: "", lat: null, lng: null });
});

// ── 배정 요청 검증 ─────────────────────────────────────────────────────────────

test("배정 내용 검증 — 위치명·예상 시각·운행 묶음은 필수", () => {
  const leg = { direction: "BOARD", classTime: "16:00~17:00", afterStopName: "가 정류장", stopName: " 롯데캐슬 정문 ", address: "다산동 1", latitude: 37.62, longitude: 127.15, arriveTime: "9:05" };
  const ok = rules.parseTrialAssignLegs([leg]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.legs[0], { direction: "BOARD", classTime: "16:00~17:00", afterStopName: "가 정류장", stopName: "롯데캐슬 정문", address: "다산동 1", latitude: 37.62, longitude: 127.15, arriveTime: "09:05" });
  assert.match(rules.parseTrialAssignLegs([{ ...leg, stopName: "  " }]).error, /위치명/);
  assert.match(rules.parseTrialAssignLegs([{ ...leg, arriveTime: "" }]).error, /예상 시각/);
  assert.match(rules.parseTrialAssignLegs([{ ...leg, arriveTime: "25:00" }]).error, /예상 시각/);
  assert.match(rules.parseTrialAssignLegs([{ ...leg, classTime: "" }]).error, /운행/);
  assert.match(rules.parseTrialAssignLegs([{ ...leg, longitude: null }]).error, /좌표/);
  assert.match(rules.parseTrialAssignLegs([{ ...leg, latitude: 0, longitude: 0 }]).error, /좌표/);
  assert.equal(rules.parseTrialAssignLegs([]).ok, false);
  assert.equal(rules.parseTrialAssignLegs([leg, leg]).ok, false);
  assert.equal(rules.parseTrialAssignLegs([{ ...leg, direction: "PIVOT" }]).ok, false);
  // 좌표 없이도 배정은 된다(위치명이 정본) · 맨 앞 = afterStopName null · 등원이 먼저 오게 정리
  const both = rules.parseTrialAssignLegs([
    { ...leg, direction: "ALIGHT", afterStopName: "", latitude: null, longitude: null, arriveTime: "17:10" },
    leg,
  ]);
  assert.deepEqual(both.legs.map((x) => [x.direction, x.afterStopName, x.latitude]), [["BOARD", "가 정류장", 37.62], ["ALIGHT", null, null]]);
});

// ── 문구 ─────────────────────────────────────────────────────────────────────

test("날짜 글자 — 요일은 시간대 없이 계산한다(월말·연말·윤년)", () => {
  assert.equal(rules.trialShuttleDateLabel("2026-11-20"), "11/20(금)");
  assert.equal(rules.trialShuttleDateLabel("2026-11-30"), "11/30(월)");
  assert.equal(rules.trialShuttleDateLabel("2026-12-31"), "12/31(목)");
  assert.equal(rules.trialShuttleDateLabel("2027-01-01"), "1/1(금)");
  assert.equal(rules.trialShuttleDateLabel("2028-02-29"), "2/29(화)");
  assert.equal(rules.trialShuttleDateLabel("엉뚱한 값"), "");
});

test("기사님 알림 — 배정·취소 문구와 그 날짜 셔틀 명단 주소, 전화·주소는 없다", () => {
  const notice = rules.buildTrialShuttleDriverNotice({
    childName: "김체험", grade: "초2", serviceDate: "2026-11-20",
    legs: [{ direction: "ALIGHT", stopName: "롯데캐슬 정문", arriveTime: "18:10" }, { direction: "BOARD", stopName: "롯데캐슬 정문", arriveTime: "16:40" }],
  });
  assert.equal(notice.title, "체험 셔틀 배정");
  assert.equal(notice.message, "체험 셔틀 배정: 김체험(초2) 11/20(금) 등원 — 롯데캐슬 정문 · 예상 16:40 / 하원 — 롯데캐슬 정문 · 예상 18:10");
  assert.equal(notice.linkUrl, "/staff/shuttle?date=2026-11-20");
  const one = rules.buildTrialShuttleDriverNotice({ childName: "김체험", grade: null, serviceDate: "2026-11-20", legs: [{ direction: "BOARD", stopName: "정문", arriveTime: "16:40" }] });
  assert.equal(one.message, "체험 셔틀 배정: 김체험 11/20(금) 등원 — 정문 · 예상 16:40");
  const cancel = rules.buildTrialShuttleCancelNotice({ childName: "김체험", grade: "초2", serviceDate: "2026-11-20", directions: ["ALIGHT", "BOARD"] });
  assert.equal(cancel.title, "체험 셔틀 취소");
  assert.equal(cancel.message, "체험 셔틀 취소: 김체험(초2) 11/20(금) 등원·하원 — 태우지 않습니다");
  assert.equal(cancel.linkUrl, "/staff/shuttle?date=2026-11-20");
});

test("학부모 문자 초안 — 탈 곳·예상 시각·무료 안내(머리말은 발송 함수가 붙인다)", () => {
  const text = rules.buildTrialShuttleParentSms({
    childName: "김체험", serviceDate: "2026-11-20",
    legs: [{ direction: "BOARD", stopName: "롯데캐슬 정문", arriveTime: "16:40" }, { direction: "ALIGHT", stopName: "롯데캐슬 정문", arriveTime: "18:10" }],
  });
  assert.deepEqual(text.split("\n"), [
    "김체험 체험 수업 셔틀 안내드립니다.",
    "날짜: 11/20(금)",
    "등원: 롯데캐슬 정문 16:40 탑승 예정",
    "하원: 롯데캐슬 정문 18:10 도착 예정",
    "도로 사정에 따라 몇 분 달라질 수 있어 5분 전에 나와 주시면 좋습니다. 체험 셔틀은 무료입니다.",
  ]);
  assert.doesNotMatch(text, /\[스티즈/);
});

// ── 끼울 자리 추천 ─────────────────────────────────────────────────────────────

function rosterRow(id, weekday, classTime, direction, stopName, arriveTime, sortOrder, lat = null, lng = null) {
  return { id, serviceMonth: "2026-11", weekday, weekdayLabel: "", classTime, arriveTime, stopName, direction, studentName: `학생${id}`, studentId: null, studentPhone: null, parentPhone: null, note: null, sortOrder, latitude: lat, longitude: lng };
}
const ROSTER = [
  rosterRow("a", 5, "16:00~17:00", "BOARD", "가 정류장", "15:30", 1, 37.600, 127.100),
  rosterRow("b", 5, "16:00~17:00", "BOARD", "나 정류장", "15:40", 2, 37.610, 127.100),
  rosterRow("c", 5, "16:00~17:00", "BOARD", "다 정류장", "15:50", 3, 37.620, 127.100),
  rosterRow("d", 5, "17:00~18:00", "BOARD", "라 정류장", "16:35", 4, 37.630, 127.100),
  rosterRow("e", 5, "16:00~17:00", "ALIGHT", "다 정류장", "17:10", 5, 37.620, 127.100),
  rosterRow("f", 1, "16:00~17:00", "BOARD", "월요일 정류장", "15:30", 6),
];

test("그 요일·방향의 운행 묶음만 고른다(기사님 화면과 같은 정차 순서)", () => {
  const board = placement.trialRunOptions(ROSTER, 5, "BOARD");
  assert.deepEqual(board.map((o) => o.classTime), ["16:00~17:00", "17:00~18:00"]);
  assert.deepEqual(board[0].stops.map((s) => [s.label, s.arriveTime]), [["가 정류장", "15:30"], ["나 정류장", "15:40"], ["다 정류장", "15:50"]]);
  assert.deepEqual(placement.trialRunOptions(ROSTER, 5, "ALIGHT").map((o) => o.stops.length), [1]);
  assert.deepEqual(placement.trialRunOptions(ROSTER, 2, "BOARD"), []);
  // 학생 이름·전화는 싣지 않는다(패널로 내려가는 값)
  assert.deepEqual(Object.keys(board[0].stops[0]).sort(), ["arriveTime", "label", "lat", "lng"]);
});

test("체험 수업 시작 시각으로 운행 묶음을 미리 고른다", () => {
  const options = placement.trialRunOptions(ROSTER, 5, "BOARD");
  assert.equal(placement.pickTrialClassTime({ weekday: 5, start: "16:00", end: "16:55", options }), "16:00~17:00");
  assert.equal(placement.pickTrialClassTime({ weekday: 5, start: "17:00", end: "17:55", options }), "17:00~18:00");
  // 딱 맞는 묶음이 없으면 가장 가까운 시작 시각
  assert.equal(placement.pickTrialClassTime({ weekday: 5, start: "17:20", end: "18:10", options }), "17:00~18:00");
  assert.equal(placement.pickTrialClassTime({ weekday: 5, start: null, end: null, options }), "16:00~17:00");
  assert.equal(placement.pickTrialClassTime({ weekday: 5, start: "16:00", end: "17:00", options: [] }), null);
});

test("추천 — 같은 이름 정류장은 그 정류장 다음·같은 시각, 사이 위치는 앞뒤 시각 사이", () => {
  const stops = placement.trialRunOptions(ROSTER, 5, "BOARD")[0].stops;
  const same = placement.suggestTrialPlacement({ stops, direction: "BOARD", stopName: "나 정류장", point: null, academy: null, depot: null });
  assert.equal(same.afterStopName, "나 정류장");
  assert.equal(same.arriveTime, "15:40");
  // 가(37.600)와 나(37.610) 사이 가운데 → «가 정류장 다음», 시각은 15:30~15:40 사이
  const between = placement.suggestTrialPlacement({ stops, direction: "BOARD", stopName: "새 아파트", point: { lat: 37.605, lng: 127.105 }, academy: null, depot: null });
  assert.equal(between.afterStopName, "가 정류장");
  assert.ok(between.arriveTime > "15:30" && between.arriveTime < "15:40", between.arriveTime);
  assert.ok(between.reason.length > 0);
  // 정차가 없는 묶음은 첫 정차로(시각은 관리자가 적는다)
  const empty = placement.suggestTrialPlacement({ stops: [], direction: "BOARD", stopName: "새 아파트", point: null, academy: null, depot: null });
  assert.deepEqual([empty.afterStopName, empty.arriveTime], [null, null]);
});

test("자리 고르기 목록 — «맨 앞» + 정차마다 «○○ 다음»", () => {
  const stops = placement.trialRunOptions(ROSTER, 5, "BOARD")[0].stops;
  assert.deepEqual(placement.trialPlacementChoices(stops).map((c) => c.value), ["", "가 정류장", "나 정류장", "다 정류장"]);
  assert.equal(placement.trialPlacementChoices(stops)[1].label, "1. 가 정류장 15:30 다음");
  assert.equal(placement.trialPlacementChoices([])[0].label, "첫 정차로");
});

// ── 소스 못박기(DB·화면 연결) ───────────────────────────────────────────────────

test("마이그레이션은 «추가»만 하고 상태 값 집합이 코드와 같다", async () => {
  const sql = await read("prisma/migrations/20261119100000_trial_shuttle/migration.sql");
  const body = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  // 기존 데이터를 바꾸거나 지우는 문장이 없다(«ON DELETE CASCADE»는 새 표의 FK 규칙이라 해당 없음)
  assert.doesNotMatch(body, /\b(DROP\s|TRUNCATE\s|DELETE\s+FROM|UPDATE\s+(public\.)?")/i);
  assert.match(body, /ADD COLUMN IF NOT EXISTS "shuttleNeeded" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(body, /ADD COLUMN IF NOT EXISTS "shuttleStatus" TEXT NOT NULL DEFAULT 'NONE'/);
  assert.match(body, /CREATE TABLE IF NOT EXISTS public\."TrialShuttleRide"/);
  // FK 는 TrialLead 하나뿐 — 학생·정규 명단·청구와 이어지지 않는다
  assert.equal((body.match(/REFERENCES/g) ?? []).length, 1);
  assert.match(body, /REFERENCES public\."TrialLead"\(id\) ON DELETE CASCADE/);
  const statuses = body.match(/"shuttleStatus" IN \(([^)]+)\)/)[1].replace(/'/g, "").split(",");
  assert.deepEqual(statuses, [...rules.TRIAL_SHUTTLE_STATUSES]);
  const directions = body.match(/"shuttleDirection" IN \(([^)]+)\)/)[1].replace(/'/g, "").split(",");
  assert.deepEqual(directions, [...rules.TRIAL_SHUTTLE_DIRECTIONS]);
  // 약속한 칸 이름 그대로(신청서·관리자 입력 쪽 코드와의 계약)
  for (const column of ["shuttleNeeded", "shuttleDirection", "shuttlePickupName", "shuttlePickupAddress", "shuttlePickupLat", "shuttlePickupLng",
    "shuttleDropoffName", "shuttleDropoffAddress", "shuttleDropoffLat", "shuttleDropoffLng", "shuttleStatus", "shuttleRequestedAt", "shuttleAdminNote"]) {
    assert.ok(body.includes(`ADD COLUMN IF NOT EXISTS "${column}"`), column);
  }
  const schema = await read("prisma/schema.prisma");
  assert.match(schema, /model TrialShuttleRide \{/);
  assert.match(body, /revision INTEGER NOT NULL DEFAULT 0,/);
  assert.match(schema, /revision\s+Int\s+@default\(0\)/);
  assert.match(schema, /shuttleStatus\s+String\s+@default\("NONE"\)/);
});

test("체험 셔틀은 정규 명단·청구에 쓰지 않는다(무료 · 하루만)", async () => {
  const server = await read("src/lib/shuttle/trialShuttle.ts");
  // 정규 명단·청구 표에 쓰는 문장이 없다(읽기는 명단 조회 함수가 따로 한다)
  assert.doesNotMatch(server, /(INSERT INTO|UPDATE|DELETE FROM)\s+"(RegularShuttleStop|Payment|Enrollment|Student)"/);
  assert.doesNotMatch(server, /addRosterStudentAs|regularRosterEdit/);
  // ORM 기본 메서드 금지(PgBouncer)
  assert.doesNotMatch(server, /\b(prisma|tx|db)\.[a-zA-Z]+\.(findMany|findFirst|findUnique|create|update|upsert|delete|deleteMany|updateMany)\(/);
  // timestamptz 는 KST 변환을 한 번만 건다
  assert.match(server, /l\."scheduledDate" AT TIME ZONE 'Asia\/Seoul'/);
  assert.doesNotMatch(server, /AT TIME ZONE 'UTC'/);
  // 운행표 조회·탑승 체크는 순수 판정(trialRideOnRunSheet) 한 곳으로 거른다 — SQL 에서 신청 상태로 미리 빼지 않는다
  //   (등록 전환한 날의 하원 줄이 사라지던 문제: 예전엔 SQL 이 CONVERTED 까지 뺐다)
  const loader = server.slice(server.indexOf("export async function loadTrialRidesForDate"), server.indexOf("const TRIAL_BOARDING_DIRECTION"));
  assert.match(loader, /rows\.filter\(\(r\) => trialRideOnRunSheet\(\{/);
  assert.doesNotMatch(loader, /NOT IN|CONVERTED/);
  assert.match(loader, /to_char\(l\."scheduledDate" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) AS "scheduledYmd"/);
  // 지난 날짜는 조회 전에 돌려보낸다(오늘은 공용 KST 함수)
  assert.match(loader, /todayYmd: string = todayKst\(\)/);
  assert.ok(loader.indexOf("if (date < todayYmd) return [];") > 0 && loader.indexOf("if (date < todayYmd) return [];") < loader.indexOf("$queryRawUnsafe"));
  // 탑승 체크도 같은 조회를 쓴다(화면에 나온 줄만 체크된다)
  const boarding = server.slice(server.indexOf("export async function setTrialBoarding"), server.indexOf("// ── 대기 건수"));
  assert.match(boarding, /const rides = await loadTrialRidesForDate\(input\.date\);/);
  // 일정 변경용 해제 함수는 약속한 이름이고 던지지 않는다 — 실패 여부를 돌려준다(표·칸 없음은 실패가 아니다)
  assert.match(server, /export async function releaseTrialShuttleOnLeadChange\(leadId: string, reason: TrialShuttleReleaseReason\): Promise<\{ released: number; failed: boolean \}>/);
  const release = server.slice(server.indexOf("export async function releaseTrialShuttleOnLeadChange"), server.indexOf("export async function reopenTrialShuttleRequest"));
  assert.match(release, /if \(isTrialShuttleSchemaMissing\(error\)\) return \{ released: 0, failed: false \};/);
  assert.match(release, /return \{ released: 0, failed: true \};/);
  assert.doesNotMatch(release, /throw /);
  // 기사님 알림 키 = 줄 id + 변경 차수 — X→Y→X 로 되돌려도 알림이 다시 가고, 내용이 그대로면 차수가 그대로다
  assert.match(server, /revision = CASE WHEN \("classTime","afterStopName","stopName","arriveTime"\) IS NOT DISTINCT FROM \(\$2::text,\$3::text,\$4::text,\$8::text\) THEN revision ELSE revision \+ 1 END/);
  assert.match(server, /trial-shuttle:assigned:\$\{leadId\}:\$\{shortHash\(rides\.map\(\(r\) => .\$\{r\.id\}#\$\{r\.revision\}.\)/);
  assert.doesNotMatch(server, /r\.stopName\}\|\$\{r\.arriveTime\}/);
  // 취소 알림은 기사님이 알고 있던 줄만, 줄 기준 키(같은 해제를 두 번 불러도 한 번)
  assert.match(server, /known\.map\(\(r\) => .\$\{r\.id\}#\$\{r\.revision\}.\)/);
  // 화면을 연 뒤 요청이 바뀌었으면 배정을 거절한다
  assert.match(server, /requestStamp !== lead\.requestStamp\) \{\s*throw new TrialShuttleError\([^)]*409, "REQUEST_CHANGED"\)/);
  // 휴무 판정은 기사님 운행표와 같은 함수
  assert.match(server, /regularRunHoliday\(lead\.scheduledYmd, plan\.monthlyDates, plan\.events\)/);
  // 탑승 기록은 기존 표에 direction='TRIAL'
  assert.match(server, /const TRIAL_BOARDING_DIRECTION = "TRIAL"/);
});

test("기사님 운행표·선생님 셔틀 명단이 같은 조립 함수에 체험 줄을 넣는다", async () => {
  const run = await read("src/lib/shuttle/unifiedDriverRun.ts");
  assert.match(run, /loadTrialRidesForDate\(viewDate\)/);
  assert.match(run, /buildUnifiedRun\(\{ seasonal: sections, regular: regular\.classes, trial: trialRides \}\)/);
  assert.match(run, /out\[`T:\$\{id\}`\] = st/);
  const staff = await read("src/app/staff/shuttle/page.tsx");
  assert.match(staff, /loadTrialRidesForDate\(date\)/);
  assert.match(staff, /buildUnifiedRun\(\{ regular: classes, trial: trialRides \}\)/);
  assert.match(staff, /\["T:" \+ id, status\]/);
  // 일반 선생님 «보기»에는 체험 줄도 연락처 없이 내려간다(같은 가림 함수)
  assert.match(staff, /stripRiderPrivate\(runRows\)/);
});

test("기사님 화면 — «체험» 글자 표시와 체험 전용 저장 주소, 정규·특강 저장 경로는 그대로", async () => {
  const client = await read("src/components/shuttle/UnifiedDriverClient.tsx");
  assert.match(client, /rider\.kind === "TRIAL" && \(\s*<span[^>]*>체험<\/span>/);
  assert.match(client, /rider\.kind === "TRIAL" \? \(accountRun \? "\/api\/staff\/shuttle\/trial-boarding" : "\/api\/shuttle\/trial-boarding"\)/);
  assert.match(client, /: accountRun \? "\/api\/staff\/shuttle\/regular-boarding"\s*: rider\.kind === "SEASONAL" \? "\/api\/shuttle\/boarding" : "\/api\/shuttle\/regular-boarding"/);
  assert.match(client, /\{ token, rideId: rider\.checkId, status: target, date \}/);
  const board = await read("src/components/shuttle/run/RunBoard.tsx");
  assert.match(board, /row\.kind === "TRIAL" \? "체험"/);
});

test("체험 탑승 저장 API — 정규와 같은 문지기(토큰+링크 스위치 / 직원 권한·선생님은 오늘만)", async () => {
  const token = await read("src/app/api/shuttle/trial-boarding/route.ts");
  assert.ok(token.indexOf("isAnyDriverRunToken(token)") < token.indexOf("setTrialBoarding("));
  assert.ok(token.indexOf("driverLinkBlocked()") < token.indexOf("setTrialBoarding("));
  assert.match(token, /readDriverBoarding\(date, "TRIAL"\)/);
  const staff = await read("src/app/api/staff/shuttle/trial-boarding/route.ts");
  assert.match(staff, /requireStaff\(\)/);
  assert.match(staff, /authorizeAssign\(staff\)/);
  assert.match(staff, /gate\.teacherOnly && date !== todayKst\(\)/);
  assert.match(staff, /sec-fetch-site/);
  assert.ok(staff.indexOf("const gate = await checkStaff();", staff.indexOf("export async function POST")) < staff.indexOf("setTrialBoarding("));
});

test("관리자 배정 API·패널 — 관리자 확인 뒤에만 쓰고, 학부모 문자는 관리자가 눌러야 나간다", async () => {
  const api = await read("src/app/api/admin/trial-shuttle/route.ts");
  assert.match(api, /requireAdmin\(\)/);
  const post = api.slice(api.indexOf("export async function POST"));
  assert.ok(post.indexOf("adminOrNull()") < post.indexOf("assignTrialShuttle("));
  // 서버에는 학부모 문자 발송이 없다(자동 발송 금지)
  assert.doesNotMatch(api, /sendManualSms|sendTrackedSms|sendSms/);
  assert.doesNotMatch(await read("src/lib/shuttle/trialShuttle.ts"), /sendManualSms|sendTrackedSms|sendSms\(/);
  const panel = await read("src/app/admin/trial/TrialShuttleAssignPanel.tsx");
  assert.match(panel, /export default function TrialShuttleAssignPanel\(\{ leadId, onChanged \}: Props\)/);
  assert.match(panel, /type Props = \{ leadId: string; onChanged: \(\) => void \}/);
  // 문자는 미리보기 창(ManualSmsModal)의 보내기에서만
  assert.match(panel, /<ManualSmsModal/);
  assert.match(panel, /onSubmit=\{handleSendSms\}/);
  assert.equal((panel.match(/sendManualSms\(/g) ?? []).length, 1);
  // 위치명 필수 지도 창 재사용 · 브라우저 기본 창·이중 뒤로 기록 없음
  assert.match(panel, /<LocationPickerModal[\s\S]*?requirePlaceName/);
  assert.doesNotMatch(panel, /window\.(alert|confirm|prompt)\(|[^.\w](alert|confirm|prompt)\(/);
  assert.doesNotMatch(panel, /import \{[^}]*useBackToClose/);
  // 굵기 4단계만
  assert.doesNotMatch(panel, /font-(extrabold|black|bold)\b/);
  // 상태 배지·요청 요약은 이 패널이 그리지 않는다(체험 상세의 셔틀 칸이 그린다 — 두 번 나오지 않게)
  assert.doesNotMatch(panel, /statusBadgeClass|trialShuttleStatusLabel|trialShuttleDirectionLabel|등원과 같은 곳/);
  // 취소·이탈·등록 전환된 신청에는 행동 버튼이 없다
  assert.match(panel, /const closed = lead\.closed;/);
  assert.match(panel, /\{!closed && <div className="flex flex-wrap gap-2 pt-1">/);
  assert.match(panel, /\{requested && !closed && status === "REQUESTED" && !showForm && \(/);
  assert.match(panel, /\{unavailableOpen && !closed && status !== "UNAVAILABLE" && \(/);
  assert.match(panel, /\{!closed && <button type="button" disabled=\{Boolean\(busy\)\} onClick=\{\(\) => void post\("reopen"/);
  // 요청 도장을 돌려보내고, 바뀌었다는 거절이면 새 내용으로 다시 읽는다
  assert.match(panel, /requestStamp: panel\?\.lead\?\.requestStamp \?\? null,/);
  assert.match(panel, /if \(data\?\.code === "REQUEST_CHANGED"\) \{ void load\(\); onChanged\(\); \}/);
  assert.match(api, /assignTrialShuttle\(admin\.appUserId \?\? null, leadId, body\.legs, typeof body\.requestStamp === "string" \? body\.requestStamp : null\)/);
  // 휴무일 경고 한 줄(막지는 않는다)
  assert.match(panel, /panel\.run\?\.holidayTitle && \(showForm \|\| showAssigned\)/);
});

test("대기 건수 — 정규 배차 머리줄과 아침 요약 알림(새 cron 없음)", async () => {
  const page = await read("src/app/admin/shuttle/regular-dispatch/page.tsx");
  assert.match(page, /trialShuttleWaitingLabel\(await countTrialShuttleWaiting\(\)\)/);
  assert.match(page, /\{trialWaiting && <Link href="\/admin\/trial"/);
  const service = await read("src/lib/admin-daily-digest-service.ts");
  assert.match(service, /countTrialShuttleWaiting\(\{ withinDays: 1 \}\)/);
  const digest = await loadTsModule("src/lib/admin-daily-digest.ts");
  const base = { todayYmd: "2026-11-19", unpaid: [], needsCheckCount: 0, pendingChangeCount: 0 };
  assert.equal(digest.buildAdminDailyDigest({ ...base, trialShuttleWaitingCount: 0 }), null);
  const one = digest.buildAdminDailyDigest({ ...base, trialShuttleWaitingCount: 2 });
  assert.equal(one.title, "오늘 확인할 일: 체험 셔틀 배정 대기 2건");
  assert.equal(one.linkUrl, "/admin/trial");
  // 다른 할 일이 있으면 링크 우선순위는 종전 그대로
  assert.equal(digest.buildAdminDailyDigest({ ...base, kakaoPendingCount: 1, trialShuttleWaitingCount: 2 }).linkUrl, "/admin/kakao-requests");
  const vercel = await read("vercel.json");
  assert.doesNotMatch(vercel, /trial-shuttle/);
});
