// 기사님 «그래도 탑승»(2026-11-15 원장 지시) — 자차·조퇴·지각으로 알린 아이가 실제로는 정류장에 나와 있을 때.
// 실제로 실행·렌더해서 확인한다.
//  ① 판정: skipLabel 잠금만 버튼 대상 — 휴원·휴무(blockedLabel)·결석 신고·방학특강 줄은 아님
//  ② 탑승 기록 뒤에는 보통 탑승한 아이와 같다(잠금 해제·진행률 분모 포함) · 되돌리면 다시 잠긴다
//  ③ 확인 문구(자차로·조퇴로·지각으로 / 탑승으로·하차로)
//  ④ 렌더: 버튼이 보이는 줄·안 보이는 줄, 탑승 기록 뒤 모양
//  ⑤ 서버·알림: 저장 거부는 blockedLabel 만 본다 · 탑승 알림은 탑승 표만 본다(안 탄다고 알린 아이도 실제 탑승이면 간다)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

// 순수 TS·TSX 를 CommonJS 로 올려 실행한다(필요한 화면 부품만 가짜로 바꿔 끼운다).
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: absolute,
  }).outputText;
  const mod = new Module(absolute);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(resolve("."));
  mod.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? `src/${name.slice(2)}` : resolve(absolute, "..", name);
      const file = [".ts", ".tsx", ""].map((ext) => base + ext).find((p) => existsSync(p));
      if (file) return load(file, mocks);
    }
    return require(name);
  };
  mod._compile(compiled, absolute);
  return mod.exports;
}

const unified = load("src/lib/shuttle/unifiedDriverRunLogic.ts");
const dayRules = load("src/lib/shuttle/regularRunDayRules.ts");
const notice = load("src/lib/shuttle/boardingNoticeRules.ts");

const regular = (extra = {}) => ({ kind: "REGULAR", absent: false, ...extra });

test("① 버튼 대상 — 자차·조퇴·지각으로 잠긴 줄만", () => {
  for (const reason of ["자차", "조퇴", "지각"]) {
    assert.deepEqual(unified.riderBoardAnyway(regular({ skipLabel: reason }), null), { canBoardAnyway: true, boardedAnyway: false, lockNoShow: false, label: reason });
  }
  const none = { canBoardAnyway: false, boardedAnyway: false, lockNoShow: false, label: null };
  // 휴원·퇴원·첫 수업 전·휴무 — 사유 글자가 같이 있어도 대상이 아니다
  for (const label of ["휴원", "퇴원", "첫 수업 전", "휴무"]) {
    assert.deepEqual(unified.riderBoardAnyway(regular({ blockedLabel: label }), null), none, label);
    assert.deepEqual(unified.riderBoardAnyway(regular({ blockedLabel: label, skipLabel: "자차" }), null), none, `${label}+자차`);
    assert.deepEqual(unified.riderBoardAnyway(regular({ blockedLabel: label, skipLabel: "자차" }), "BOARDED"), none, `${label}+자차+탑승`);
  }
  // 결석 신고 아이(종전 «결석» 표시·버튼 그대로) · 잠기지 않은 아이 · 방학특강 줄
  assert.deepEqual(unified.riderBoardAnyway(regular({ absent: true, skipLabel: "자차" }), null), none);
  assert.deepEqual(unified.riderBoardAnyway(regular({ absent: true }), null), none);
  assert.deepEqual(unified.riderBoardAnyway(regular(), null), none);
  assert.deepEqual(unified.riderBoardAnyway({ kind: "SEASONAL", absent: false, skipLabel: "자차" }, null), none);
});

test("② 탑승 기록 뒤 = 보통 탑승한 아이 모양, 되돌리면 다시 잠긴 줄", () => {
  const self = regular({ skipLabel: "자차" });
  const normal = regular();
  // 탑승 기록이 생기면 잠금이 풀리고, 보통 아이의 탑승과 같은 판정이 나온다
  assert.deepEqual(unified.riderBoardingView(self, "BOARDED"), unified.riderBoardingView(normal, "BOARDED"));
  assert.deepEqual(unified.riderBoardingView(self, "BOARDED"), { absentReported: false, status: "BOARDED", absentDefault: false, dimmed: false, blocked: false });
  assert.deepEqual(unified.riderBoardAnyway(self, "BOARDED"), { canBoardAnyway: false, boardedAnyway: true, lockNoShow: true, label: "자차" });
  // 되돌리면(기록 없음) 다시 잠긴 줄 + 버튼
  for (const stored of [null, undefined]) {
    assert.equal(unified.riderBoardingView(self, stored).blocked, true);
    assert.equal(unified.riderBoardingView(self, stored).dimmed, true);
    assert.equal(unified.riderBoardAnyway(self, stored).canBoardAnyway, true);
  }
  // 탑승이 아닌 기록(미탑승·자차)은 잠금을 풀지 않는다 — 버튼은 계속 보인다
  for (const stored of ["NOSHOW", "SELF"]) {
    assert.equal(unified.riderBoardingView(self, stored).blocked, true, stored);
    assert.equal(unified.riderBoardAnyway(self, stored).canBoardAnyway, true, stored);
  }
  // 휴원·휴무 줄은 탑승 기록이 남아 있어도 잠금 그대로(종전)
  assert.equal(unified.riderBoardingView(regular({ blockedLabel: "휴원", skipLabel: "자차" }), "BOARDED").blocked, true);

  // 진행률: 잠겨 있을 땐 분모에서 빠지고, 탑승으로 기록되면 분모·탑승 수에 들어간다
  const rows = [{ riders: [{ key: "R:1", ...self }, { key: "R:2", ...normal }] }];
  assert.deepEqual(unified.countProgress(rows, {}), { total: 1, boarded: 0, noshow: 0, self: 0 });
  assert.deepEqual(unified.countProgress(rows, { "R:1": "BOARDED" }), { total: 2, boarded: 1, noshow: 0, self: 0 });
  // 정차 요약: 탑승한 아이가 있으면 «정차 안 해도 됨»이 아니다
  assert.equal(unified.stopAbsenceSummary([rows[0].riders[0]], {}).allSkippable, true);
  assert.equal(unified.stopAbsenceSummary([rows[0].riders[0]], { "R:1": "BOARDED" }).allSkippable, false);
});

test("② «그래도 탑승»으로 탄 줄은 미탑승 버튼만 잠근다 — 되돌리기로만 고친다", () => {
  const self = regular({ skipLabel: "자차" });
  // 탑승 기록이 있는 동안만 잠근다(되돌리면 풀린다 — 그땐 줄 전체가 다시 잠긴 줄)
  assert.equal(unified.riderBoardAnyway(self, "BOARDED").lockNoShow, true);
  for (const stored of [null, undefined, "NOSHOW", "SELF"]) assert.equal(unified.riderBoardAnyway(self, stored).lockNoShow, false, String(stored));
  // 보통 아이·결석 신고 아이·휴원 줄·방학특강 줄의 탑승은 해당 없음(미탑승으로 고칠 수 있다)
  assert.equal(unified.riderBoardAnyway(regular(), "BOARDED").lockNoShow, false);
  assert.equal(unified.riderBoardAnyway(regular({ absent: true, skipLabel: "자차" }), "BOARDED").lockNoShow, false);
  assert.equal(unified.riderBoardAnyway(regular({ blockedLabel: "휴원", skipLabel: "자차" }), "BOARDED").lockNoShow, false);
  assert.equal(unified.riderBoardAnyway({ kind: "SEASONAL", absent: false, skipLabel: "자차" }, "BOARDED").lockNoShow, false);
  // 안내 한 줄(조사·방향)
  assert.equal(unified.boardedAnywayNote("자차", "PICKUP"), "자차로 알렸지만 탑승으로 기록했어요");
  assert.equal(unified.boardedAnywayNote("지각", "DROPOFF"), "지각으로 알렸지만 하차로 기록했어요");
  // 화면: 버튼·펼침 메뉴·저장 함수 세 곳이 같은 판정을 쓴다
  const source = read("src/components/shuttle/UnifiedDriverClient.tsx");
  assert.match(source, /disabled=\{isBusy \|\| locked \|\| anyway\.lockNoShow\}/);
  assert.match(source, /menuKey === rowKey && !locked && !anyway\.lockNoShow/);
  assert.match(source, /\(next === "NOSHOW" \|\| next === "SELF"\) && riderBoardAnyway\(rider, cur\)\.lockNoShow\) return;/);
});

test("⑥ 학부모 홈 «오늘 셔틀»: 자차로 알린 방향도 실제 탑승 시각이 있으면 그 시각을 보인다", () => {
  const summary = load("src/lib/mypage/summary.ts");
  const childRules = load("src/lib/shuttle/childShuttleRules.ts");
  const DAY = "2026-11-19";
  const item = (extra) => ({ id: "x", serviceDate: DAY, direction: "PICKUP", status: "CONFIRMED", sourceType: "REGULAR_CLASS", pickupEtaLabel: "16:40 승차", dropoffEtaLabel: null, ...extra });
  // 등원·하원 모두 자차로 알렸고 둘 다 탔다
  assert.deepEqual(summary.todayShuttleLineTexts([], ["PICKUP", "DROPOFF"], { PICKUP: "08:52", DROPOFF: "18:40" }), ["탑승 08:52", "하차 18:40"]);
  // 한쪽만 탄 경우 — 안 탄 방향은 «자차» 그대로(합쳐 쓰지 않는다)
  assert.deepEqual(summary.todayShuttleLineTexts([], ["PICKUP", "DROPOFF"], { PICKUP: "08:52" }), ["탑승 08:52", "하원 자차"]);
  assert.deepEqual(summary.todayShuttleLineTexts([], ["PICKUP", "DROPOFF"], { DROPOFF: "18:40" }), ["등원 자차", "하차 18:40"]);
  // 하원만 자차로 알렸는데 탔다 — 등원 줄은 예정 시각 그대로
  assert.deepEqual(summary.todayShuttleLineTexts([item({})], ["DROPOFF"], { DROPOFF: "18:40" }), ["등원 16:40 승차", "하차 18:40"]);
  // 시각이 없으면 예전 그대로
  assert.deepEqual(summary.todayShuttleLineTexts([], ["PICKUP", "DROPOFF"], {}), ["등원·하원 자차"]);
  assert.deepEqual(summary.todayShuttleLineTexts([], ["PICKUP", "DROPOFF"]), ["등원·하원 자차"]);
  assert.deepEqual(summary.todayShuttleLineTexts([item({})], ["DROPOFF"], { DROPOFF: null }), ["등원 16:40 승차", "하원 자차"]);
  // 자차로 알리지 않은 방향의 값은 쓰지 않는다(표시 전용 값이 다른 줄을 덮지 않는다)
  assert.deepEqual(summary.todayShuttleLineTexts([item({})], [], { PICKUP: "08:52" }), ["등원 16:40 승차"]);

  // 자차 방향 × 탑승 시각 → 실제로 탄 방향만
  const times = new Map([["s1:PICKUP", "08:52"], ["s2:DROPOFF", "18:40"], ["s3:PICKUP", "09:00"]]);
  const timeOf = (studentId, direction) => times.get(`${studentId}:${direction}`) ?? null;
  assert.deepEqual(
    childRules.selfRideActualTimes({ s1: ["PICKUP", "DROPOFF"], s2: ["DROPOFF"], s4: ["PICKUP"] }, timeOf),
    { s1: { PICKUP: "08:52" }, s2: { DROPOFF: "18:40" } },
    "자차로 알리지 않은 아이(s3)·탄 기록이 없는 아이(s4)는 넣지 않는다",
  );
  assert.deepEqual(childRules.selfRideActualTimes({}, timeOf), {});

  // 홈까지 가는 길: 항목이 없어도(전부 자차) 탑승 시각을 읽고, 표시 전용 값으로 따로 내보낸다
  const parent = read("src/lib/shuttle/parent.ts");
  assert.match(parent, /const boardingTimes = hasToday \|\| hasSelfRideToday/);
  assert.match(parent, /SELF_RIDE_ACTUAL_BY_RESULT\.set\(sorted, selfRideActualTimes\(todaySelfRide,/);
  assert.match(read("src/app/mypage/page.tsx"), /todaySelfRideActual=\{todaySelfRideActualOf\(shuttleOverview\)\}/);
  // 자차 방향은 여전히 항목을 만들지 않는다(«운행 N건» 셈 그대로)
  const leg = (state, time) => ({ stopName: "푸르지오", time, state, note: null, changedTo: null });
  const days = [{ ymd: DAY, weekday: 4, dayLabel: "목", classId: "c1", className: "목 5시", classTime: "17:00", status: "RUN", statusText: "운행", board: leg("SKIP", "16:40"), alight: leg("SKIP", "18:40") }];
  assert.equal(childRules.rosterOverviewItems("s1", "합성", days).length, 0);
});

test("③ 확인 문구 — 조사와 방향 글자", () => {
  assert.equal(unified.boardAnywayConfirmText("김하늘", "자차", "PICKUP"), "김하늘 학생은 자차로 알렸어요. 그래도 탑승으로 기록할까요?");
  assert.equal(unified.boardAnywayConfirmText("김하늘", "조퇴", "DROPOFF"), "김하늘 학생은 조퇴로 알렸어요. 그래도 하차로 기록할까요?");
  assert.equal(unified.boardAnywayConfirmText("김하늘", "지각", "PICKUP"), "김하늘 학생은 지각으로 알렸어요. 그래도 탑승으로 기록할까요?");
});

// ── ④ 렌더 — 기사님 화면. 카드 틀(RunBoard)은 학생 줄만 그리는 가짜로 바꾼다 ──
function renderDriver(props) {
  const esm = (value) => ({ __esModule: true, default: value });
  const mocks = {
    "next/navigation": { useRouter: () => ({ refresh() {}, push() {} }) },
    "next/image": esm(() => null),
    "./DriverWorkspace.module.css": esm(new Proxy({}, { get: (_t, k) => String(k) })),
    "@/components/shuttle/run/RunBoard": esm(({ rows, renderRider }) =>
      React.createElement("div", null, rows.map((row) => React.createElement("section", { key: row.key }, row.riders.map((rider) => renderRider(row, rider)))))),
    "@/components/shuttle/run/useRouteRetime": { useRouteRetime: () => ({ retime() {}, notes: {}, cancelPending() {}, clearNote() {} }) },
    "@/components/shuttle/DriverDateNav": esm(() => null),
    "@/components/shuttle/DriverGpsIndicator": esm(() => null),
    "@/hooks/useGpsShare": { useGpsShare: () => ({ state: "idle", transmission: "idle", lastSentAt: null, accuracy: null, mode: "web", nativeRunning: false, nativeMessage: null, start() {}, stop: async () => {} }) },
  };
  const Client = load("src/components/shuttle/UnifiedDriverClient.tsx", mocks).default;
  return renderToStaticMarkup(React.createElement(Client, {
    token: "t", date: "2026-11-19", today: "2026-11-19", prevDate: "2026-11-18", nextDate: "2026-11-20",
    initialBoarding: {}, driverLabel: "정규 셔틀 기사님", ...props,
  }));
}
function riderHtml(html, name) {
  const at = html.indexOf(`>${name}<`);
  assert.ok(at >= 0, `${name} 줄이 없다`);
  const start = html.lastIndexOf("<div", html.lastIndexOf("academy-driver-rider", at));
  const next = html.indexOf("academy-driver-rider", at);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf("<div", next));
}
const rider = (id, name, extra = {}) => ({
  key: `R:${id}`, checkId: id, kind: "REGULAR", direction: "PICKUP", name, grade: null, parentPhone: null, studentPhone: null, absent: false, ...extra,
});
const ROWS = [{
  key: "R:15:00:board:0", kind: "REGULAR", direction: "PICKUP", groupKey: "R:15:00:board", groupLabel: null, label: "다산초", subLabel: null,
  time: "14:40", minutes: 880, seq: 0, lat: null, lng: null, isHub: false, isTerminal: false, pending: false, warn: false,
  riders: [
    rider("a", "자차생", { skipLabel: "자차", shuttleNote: "오늘 셔틀 안 탐" }),
    rider("b", "휴원생", { blockedLabel: "휴원" }),
    rider("c", "결석생", { absent: true, skipLabel: "자차" }),
    rider("d", "보통생"),
  ],
}];

test("④ 렌더: «그래도 탑승»은 자차·조퇴·지각으로 잠긴 줄에만 보인다", () => {
  const html = renderDriver({ rows: ROWS });
  const self = riderHtml(html, "자차생");
  assert.match(self, /data-blocked="true"/);
  assert.match(self, />자차</);
  assert.match(self, /<button[^>]*aria-label="자차생 그래도 탑승"[^>]*class="academy-button-secondary[^"]*"[^>]*>그래도 탑승<\/button>/);
  assert.equal((self.match(/<button[^>]*disabled=""/g) ?? []).length, 2, "탑승·미탑승은 여전히 잠금 — 그래도 탑승만 눌린다");
  // 누르기 전에는 확인 상자가 없다(확인을 거쳐야 기록)
  assert.doesNotMatch(self, /그래도 탑승으로 기록할까요/);
  for (const name of ["휴원생", "결석생", "보통생"]) assert.doesNotMatch(riderHtml(html, name), /그래도/, name);
  // 하원 줄은 «그래도 하차»
  const drop = renderDriver({ rows: [{ ...ROWS[0], direction: "DROPOFF", riders: [rider("a", "자차생", { direction: "DROPOFF", skipLabel: "조퇴" })] }] });
  assert.match(riderHtml(drop, "자차생"), />그래도 하차<\/button>/);
});

test("④ 렌더: 탑승으로 기록된 뒤에는 보통 탑승한 아이와 같고 되돌리기가 있다", () => {
  const html = renderDriver({ rows: ROWS, initialBoarding: { "R:a": "BOARDED", "R:d": "BOARDED" } });
  const self = riderHtml(html, "자차생");
  assert.doesNotMatch(self, /data-blocked/);
  assert.doesNotMatch(self, /그래도/);
  // 탑승 버튼은 풀리고, 미탑승 버튼만 잠근다(잘못 눌렀으면 되돌리기)
  assert.equal((self.match(/<button[^>]*disabled=""/g) ?? []).length, 1, "미탑승만 잠금");
  assert.match(self, /<button[^>]*disabled=""[^>]*>미탑승</);
  assert.match(self, /자차로 알렸지만 탑승으로 기록했어요/);
  assert.match(self, /aria-pressed="true"[^>]*>탑승</);
  assert.match(self, /aria-label="자차생 대기로 되돌리기"/);
  // 학부모가 안 탄다고 알린 사실은 메모로 남아 보인다
  assert.match(self, /오늘 셔틀 안 탐/);
  // 보통 탑승한 아이와 같은 버튼 상태
  const normal = riderHtml(html, "보통생");
  assert.match(normal, /aria-pressed="true"[^>]*>탑승</);
  assert.match(normal, /aria-label="보통생 대기로 되돌리기"/);
});

test("④ 화면 소스: 확인을 거쳐 탑승으로만 기록하고, 잠금 우회는 순수 판정을 다시 거친다", () => {
  const source = read("src/components/shuttle/UnifiedDriverClient.tsx");
  assert.match(source, /const anywayAllowed = boardAnyway && next === "BOARDED" && riderBoardAnyway\(rider, cur\)\.canBoardAnyway;/);
  assert.match(source, /riderBoardingView\(rider, cur\)\.blocked && !anywayAllowed\) return;/);
  assert.match(source, /const showAnyway = !readOnly && locked && anyway\.canBoardAnyway;/);
  // 버튼은 확인 상자만 열고, 저장은 확인 상자의 버튼만 한다
  assert.equal((source.match(/setStatus\(rider, "BOARDED", false, true\)/g) ?? []).length, 1);
  assert.match(source, /role="alertdialog" aria-label=\{`\$\{rider\.name\} 그래도 \$\{boardWord\} 확인`\}/);
  // 앱 웹뷰에서 조용히 «취소»가 되는 브라우저 확인 창은 쓰지 않는다(화면 안 확인)
  assert.doesNotMatch(source, /[^.\w]confirm\(/);
});

test("⑤ 서버 저장: 거부는 휴원·휴무 글자만 본다 — 자차·조퇴·지각 줄의 탑승은 원래 저장된다", () => {
  assert.equal(dayRules.boardingRejectedForBlock(null, "BOARDED"), false);
  assert.equal(dayRules.boardingRejectedForBlock(undefined, "BOARDED"), false);
  assert.equal(dayRules.boardingRejectedForBlock("휴원", "BOARDED"), true);
  for (const file of ["src/app/api/shuttle/regular-boarding/route.ts", "src/app/api/staff/shuttle/regular-boarding/route.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /skipLabel|shuttleNote/, file);
    assert.match(source, /boardingRejectedForBlock\((rider\.)?blockedLabel, status\)/, file);
  }
});

test("⑤ 탑승 알림: 탑승 표만 보고 고른다 — 안 탄다고 알린 아이도 실제 탑승 기록이 있으면 간다", () => {
  const now = 1_800_000_000_000;
  const row = { direction: "REGULAR", shuttleRequestId: "a", status: "BOARDED", rosterStudentId: "stu1", stopDirection: "BOARD", checkedEpoch: (now - 90_000) / 1000 };
  assert.deepEqual(notice.pickBoardingNotices([row], new Map(), now), [{ studentId: "stu1", leg: "PICKUP", checkedAtMs: now - 90_000 }]);
  // 되돌린 줄은 표에서 지워져 후보에 없고, 미탑승으로 고친 줄은 걸러진다
  assert.deepEqual(notice.pickBoardingNotices([{ ...row, status: "NOSHOW" }], new Map(), now), []);
  // 고르는 조회·규칙에 «오늘만 셔틀 변경»(안 타요) 조건이 없다
  for (const file of ["src/lib/shuttle/boardingNoticeSweep.ts", "src/lib/shuttle/boardingNoticeRules.ts"]) {
    assert.doesNotMatch(read(file), /skipLabel|ShuttleDayException|ShuttleException|SKIP/, file);
  }
});
