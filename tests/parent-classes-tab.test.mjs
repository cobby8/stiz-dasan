// 학부모 «수업» 탭(2026-11-10 원장 결정 d5·설계 B) — 반 카드 계산을 실제로 실행하고, 화면을 그려서 확인한다.
//  ① 상태 칩 = 홈 «반 상태 한 줄»과 같은 함수(buildClassStatusLine)
//  ② 다음 수업 = 오늘 포함 첫 수업일, 승인된 휴원·퇴원 적용일부터는 없음, 휴원 중이면 없음
//  ③ 최근 출결 4칸 = KST 날짜(서버 UTC 함정), 오래된 → 최근
//  ④ 셔틀 = 이 아이·이 반 것만, 시각 KST
//  ⑤ 버튼 = 기존 신청 화면 + ?studentId=&enrollmentId=(&kind=), 휴원 중이면 [복귀 신청]
//  ⑥ 미리 고르기 값은 힌트일 뿐(목록 안에서만 고른다)
//  ⑦ 조회 가드(childAccessSql + notMergedStudent + $queryRawUnsafe)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

const cards = await loadTsModule("src/lib/parent/classCards.ts");
const preset = await loadTsModule("src/lib/mypage/requestPreset.ts");

const base = { enrollmentStatus: "ACTIVE", scheduled: null, pending: null, pausedResumeOn: null, today: "2026-11-10" };

test("① 상태 칩: 그냥 다니면 «수강 중», 승인 예정·검토 중·휴원 중은 홈과 같은 말", () => {
  assert.deepEqual(cards.classStatusChip(base), { text: "수강 중", tone: "success" });
  assert.deepEqual(
    cards.classStatusChip({ ...base, scheduled: { kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn: null } }),
    { text: "휴원 예정 · 12/1부터", tone: "info" },
  );
  assert.deepEqual(
    cards.classStatusChip({ ...base, scheduled: { kind: "WITHDRAW", effectiveFrom: "2026-12-01", resumeOn: null } }),
    { text: "퇴원 예정 · 12/1부터", tone: "info" },
  );
  assert.deepEqual(cards.classStatusChip({ ...base, pending: { kind: "CLASS_CHANGE", effectiveFrom: "2026-12-01" } }), { text: "반 변경 신청 검토 중", tone: "warning" });
  assert.deepEqual(cards.classStatusChip({ ...base, enrollmentStatus: "PAUSED", pausedResumeOn: "2027-01-05" }), { text: "휴원 중 · 복귀 예정 1/5", tone: "neutral" });
});

test("② 다음 수업: 오늘 포함 첫 수업일 · 휴원 적용일부터는 없음 · 휴원 중이면 없음", () => {
  const dates = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-12-01"];
  assert.equal(cards.nextClassDate({ dates, today: "2026-11-10", paused: false }), "2026-11-10", "오늘 수업도 «다음 수업»");
  assert.equal(cards.nextClassDate({ dates, today: "2026-11-11", paused: false }), "2026-11-17");
  assert.equal(cards.nextClassDate({ dates, today: "2026-11-18", paused: false, stopFrom: "2026-12-01" }), null, "휴원 시작일부터는 수업 없음");
  assert.equal(cards.nextClassDate({ dates, today: "2026-11-11", paused: false, stopFrom: "2026-12-01" }), "2026-11-17", "적용일 전 수업은 남는다");
  assert.equal(cards.nextClassDate({ dates, today: "2026-11-10", paused: true }), null);
  assert.equal(cards.nextClassDate({ dates: [], today: "2026-11-10", paused: false }), null);
});

test("③ 최근 출결 4칸: KST 날짜 · 오래된 → 최근 · 같은 날은 한 칸", () => {
  const cells = cards.recentAttendanceCells([
    // UTC 15:30 = KST 다음 날 00:30 — 서버 시간대로 날짜를 자르면 하루 밀린다
    { status: "PRESENT", date: "2026-11-02T15:30:00.000Z" },
    { status: "ABSENT", date: "2026-10-27T07:00:00.000Z" },
    { status: "LATE", date: "2026-10-20T07:00:00.000Z" },
    { status: "EXCUSED", date: "2026-10-13T07:00:00.000Z" },
    { status: "PRESENT", date: "2026-10-06T07:00:00.000Z" },
    { status: "ABSENT", date: "2026-11-02T16:00:00.000Z" }, // 같은 KST 날(11/3)
  ]);
  assert.deepEqual(cells.map((c) => c.ymd), ["2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03"], "최근 4개, 10/6 은 빠진다");
  assert.deepEqual(cells.map((c) => c.label), ["10/13", "10/20", "10/27", "11/3"]);
  assert.equal(cells[3].status, "ABSENT", "같은 날 두 기록이면 더 늦은 기록 하나");
  assert.equal(cards.ATTENDANCE_CELL_LABEL.EXCUSED, "결석");
});

test("④ 셔틀: 이 아이·이 반 정규 셔틀만, 오늘 이후 가장 가까운 운행, 시각은 KST", () => {
  const item = (o) => ({ studentId: "a", sourceType: "REGULAR_CLASS", classId: "k1", title: "월요반", direction: "PICKUP", status: "CONFIRMED", serviceDate: "2026-11-16", stopName: "정문", plannedAt: "2026-11-16T07:40:00.000Z", ...o });
  const lines = cards.classShuttleLines([
    item({ serviceDate: "2026-11-09", stopName: "옛 정류장" }), // 지난 운행
    item({}),
    item({ serviceDate: "2026-11-23", stopName: "다음 주" }),
    item({ classId: "k2", stopName: "다른 반" }),
    item({ studentId: "b", stopName: "다른 아이" }),
    item({ sourceType: "SPECIAL_PROGRAM", stopName: "특강" }),
    item({ direction: "DROPOFF", stopName: null, plannedAt: null }), // 배차 준비 중
  ], { studentId: "a", classId: "k1", className: "월요반" }, "2026-11-10");
  assert.deepEqual(lines, [
    { direction: "PICKUP", text: "등원 · 정문 · 16:40" },
    { direction: "DROPOFF", text: "하원 배차 준비 중" },
  ]);
  // 확정 시각 라벨(«08:53 승차»)이 있으면 그 시각을 쓴다 · classId 없는 옛 자료는 반 이름으로 맞춘다
  const eta = cards.classShuttleLines([item({ classId: null, pickupEtaLabel: "08:53 승차" })], { studentId: "a", classId: "k1", className: "월요반" }, "2026-11-10");
  assert.deepEqual(eta, [{ direction: "PICKUP", text: "등원 · 정문 · 08:53" }]);
});

test("⑤ 버튼: 다니는 중 = [결석][보강][셔틀][변경 ▾](반 변경·휴원·퇴원) / 휴원 중 = 복귀 신청", () => {
  const active = cards.classCardActions({ studentId: "s1", enrollmentId: "e1", paused: false });
  assert.deepEqual(active.map((a) => a.label), ["결석", "보강", "셔틀", "변경"], "375px 한 줄에 들어가는 짧은 이름(2026-11-10)");
  assert.equal(active[0].href, "/mypage/regular-absence?studentId=s1&enrollmentId=e1");
  assert.equal(active[1].href, "/mypage/makeup?studentId=s1");
  assert.equal(active[2].href, "/mypage/shuttle?studentId=s1");
  assert.deepEqual(active[3].items.map((i) => [i.label, i.href]), [
    ["반 변경", "/mypage/enrollment-change?studentId=s1&enrollmentId=e1&kind=CLASS_CHANGE"],
    ["휴원", "/mypage/enrollment-change?studentId=s1&enrollmentId=e1&kind=PAUSE"],
    ["퇴원", "/mypage/enrollment-change?studentId=s1&enrollmentId=e1&kind=WITHDRAW"],
  ]);
  const paused = cards.classCardActions({ studentId: "s1", enrollmentId: "e1", paused: true });
  assert.deepEqual(paused, [{ key: "resume", label: "복귀 신청", href: "/mypage/enrollment-change?studentId=s1&enrollmentId=e1" }]);
});

test("⑥ 미리 고르기: 이상한 값은 버리고, 목록 안에서만 고른다(남의 id 는 무시)", () => {
  assert.deepEqual(preset.parseRequestPreset({ studentId: "abc-1", enrollmentId: "e_2", kind: "PAUSE" }), { studentId: "abc-1", enrollmentId: "e_2", kind: "PAUSE" });
  assert.deepEqual(preset.parseRequestPreset({ studentId: ["a", "b"], enrollmentId: "x' OR 1=1", kind: "pause" }), { studentId: null, enrollmentId: null, kind: null });
  assert.deepEqual(preset.parseRequestPreset(null), { studentId: null, enrollmentId: null, kind: null });
  const list = [{ studentId: "a", enrollmentId: "e1" }, { studentId: "b", enrollmentId: "e2" }, { studentId: "b", enrollmentId: "e3" }];
  assert.equal(preset.presetIndex(list, { studentId: "b", enrollmentId: "e3", kind: null }, (x) => x), 2);
  assert.equal(preset.presetIndex(list, { studentId: "b", enrollmentId: "nope", kind: null }, (x) => x), 1, "반이 없으면 그 아이 첫 반");
  assert.equal(preset.presetIndex(list, { studentId: "zzz", enrollmentId: null, kind: null }, (x) => x), 0, "남의 아이 id 면 처음 그대로");
  assert.deepEqual(preset.presetFirst(list, "b", (x) => x.studentId).map((x) => x.enrollmentId), ["e2", "e3", "e1"]);
  assert.deepEqual(preset.presetFirst(list, null, (x) => x.studentId).map((x) => x.enrollmentId), ["e1", "e2", "e3"]);
});

// ── 화면 그리기 ──
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : require(name);
  module._compile(compiled, absolute);
  return module.exports;
}
const link = { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
const kst = load("src/lib/datetime/kst.ts");
const statusTones = load("src/lib/ui/statusTones.ts");
const classCardsCjs = load("src/lib/parent/classCards.ts", { "@/lib/datetime/kst": kst, "@/lib/enrollment/parentChangeStatus": load("src/lib/enrollment/parentChangeStatus.ts") });

function card(over = {}) {
  return {
    studentId: "a", enrollmentId: "e1", classId: "k1", className: "초등 저학년반", programName: "정규", coachName: "김코치", location: "다산2호점",
    dayOfWeek: "Mon", startTime: "16:00", endTime: "17:00", paused: false,
    chip: { text: "수강 중", tone: "success" }, nextClass: "2026-11-16", planMissing: false, startsOn: null,
    attendance: [{ ymd: "2026-11-02", label: "11/2", status: "PRESENT" }, { ymd: "2026-11-09", label: "11/9", status: "ABSENT" }],
    shuttle: [{ direction: "PICKUP", text: "등원 · 정문 · 15:40" }],
    actions: classCardsCjs.classCardActions({ studentId: "a", enrollmentId: "e1", paused: false }),
    ...over,
  };
}
const parentSchedule = load("src/lib/mypage/parentSchedule.ts", { "@/lib/datetime/kst": kst, "@/lib/classSchedule": load("src/lib/classSchedule.ts") });
const scheduleHub = load("src/app/mypage/history/ScheduleHub.tsx", {
  "next/link": link, "@/lib/datetime/kst": kst, "@/lib/mypage/parentSchedule": parentSchedule,
  "../ParentShuttleDetail": { __esModule: true, default: () => null },
});
function renderClasses(props, timelineMock) {
  const Client = load("src/app/mypage/classes/ClassesClient.tsx", {
    "next/link": link, "@/lib/datetime/kst": kst, "@/lib/ui/statusTones": statusTones, "@/lib/parent/classCards": classCardsCjs,
    "./RequestTimeline": timelineMock ?? { __esModule: true, default: () => React.createElement("p", null, "신청내역자리") },
    "../history/ScheduleHub": scheduleHub, "@/lib/mypage/parentSchedule": parentSchedule,
    // 아이 기억(주소·localStorage)은 브라우저에서만 — 서버 그리기는 서버가 고른 아이(initialChildId) 그대로
    "../useRememberedChild": { useRememberedChild: (_ids, init) => [init, () => {}] },
  }).default;
  return renderToStaticMarkup(React.createElement(Client, props));
}

test("화면: 아이 한 명이면 칩 없음 · 반 카드 = 이름·상태·시간·코치·지점·다음 수업·출결·셔틀·버튼 4개", () => {
  const paused = card({ enrollmentId: "e2", classId: "k2", className: "주말반", paused: true, chip: { text: "휴원 중 · 복귀 예정 1/5", tone: "neutral" }, nextClass: null, attendance: [], shuttle: [],
    actions: classCardsCjs.classCardActions({ studentId: "a", enrollmentId: "e2", paused: true }) });
  const html = renderClasses({ overview: { today: "2026-11-10", children: [{ id: "a", name: "합성 첫째", classes: [card(), paused] }] }, initialChildId: "a" });
  assert.doesNotMatch(html, /aria-label="자녀 선택"/);
  assert.doesNotMatch(html, /href="\/mypage\/history/, "«달력 ▸» 이동 대신 같은 화면에 달력(2026-11-10)");
  assert.match(html, /초등 저학년반/);
  assert.match(html, /월 16:00~17:00 · 정규 · 김코치 코치 · 다산2호점/);
  assert.match(html, /bg-\[var\(--color-academy-success-soft\)\][^"]*">수강 중</, "상태 칩 색은 statusTones 토큰");
  assert.match(html, /11\/16\(월\) 16:00/, "다음 수업(KST 요일)");
  assert.match(html, /11\/2<\/span><span class="sr-only">출석/);
  assert.match(html, /등원 · 정문 · 15:40/);
  assert.match(html, /href="\/mypage\/regular-absence\?studentId=a&amp;enrollmentId=e1"/);
  assert.match(html, /aria-haspopup="menu"/, "변경 ▾ 는 펼침 메뉴");
  assert.match(html, /grid-cols-4/, "버튼 4개 한 줄");
  assert.match(html, /<span class="whitespace-nowrap">셔틀<\/span>/, "버튼 글자는 줄바꿈 없이");
  // 휴원 중인 반 = 복귀 신청 하나(주 버튼)
  assert.match(html, /휴원 중 · 복귀 예정 1\/5/);
  assert.match(html, /href="\/mypage\/enrollment-change\?studentId=a&amp;enrollmentId=e2" class="academy-button-primary[^"]*"><span class="whitespace-nowrap">복귀 신청/);
  // 터치 44px: 버튼은 academy-button-*(min-height 2.75rem) · 글자 12px 미만 클래스 없음
  assert.doesNotMatch(html, /text-\[(?:10|11)px\]/);
});

test("화면: 아이 둘이면 칩(누름 상태) · 고른 아이 반만", () => {
  const html = renderClasses({
    overview: { today: "2026-11-10", children: [{ id: "a", name: "합성 첫째", classes: [card()] }, { id: "b", name: "합성 둘째", classes: [] }] },
    initialChildId: "b",
  });
  assert.match(html, /aria-label="자녀 선택"/);
  assert.match(html, /aria-pressed="true" class="academy-choice">합성 둘째/);
  assert.doesNotMatch(html, /초등 저학년반/);
  assert.match(html, /다니는 정규 반이 없어요/);
});

test("⑦ 조회 가드: 수업 탭 조회는 childAccessSql + notMergedStudent + $queryRawUnsafe, ORM 기본 메서드 없음", () => {
  const src = read("src/lib/parent/classes-overview.ts");
  assert.equal((src.match(/prisma\.\$queryRawUnsafe/g) || []).length, 3);
  assert.ok((src.match(/\$\{access\}/g) || []).length >= 3, "세 조회 모두 자녀 접근 조건");
  assert.ok((src.match(/notMergedStudent\("s"\)/g) || []).length >= 4);
  assert.doesNotMatch(src, /prisma\.\w+\.(findMany|findFirst|create|update|upsert)/);
  assert.doesNotMatch(src, /getFullYear|getMonth\(\)|getDay\(\)|toISOString\(\)\.slice/);
  // 휴원 중 반도 읽는다(복귀 신청) — 홈 getMyPageData 의 ACTIVE 기준은 건드리지 않았다
  assert.match(src, /e\.status IN \('ACTIVE','PAUSED'\)/);
  assert.match(read("src/lib/queries.ts"), /WHERE e\."studentId" = \$1 AND e\.status = 'ACTIVE'`/);
});

test("화면: 반 카드 → 한 달 달력 → 신청 내역 순서, 달 이동은 수업 탭 주소(아이 유지)", () => {
  const view = parentSchedule.buildParentMonth({ month: "2026-11", todayYmd: "2026-11-10", events: [], classDates: ["2026-11-16"], attendance: [{ status: "PRESENT", date: "2026-11-09T07:00:00.000Z" }] });
  const html = renderClasses({
    overview: { today: "2026-11-10", children: [{ id: "a", name: "합성 첫째", classes: [card()] }, { id: "b", name: "합성 둘째", classes: [] }] },
    initialChildId: "a",
    calendar: { month: "2026-11", byChild: { a: { view, planReady: true, hasEnrollments: true } } },
  });
  const cardAt = html.indexOf("초등 저학년반");
  const calAt = html.indexOf('id="schedule-records-heading"');
  const timelineAt = html.indexOf("신청내역자리");
  assert.ok(cardAt > 0 && calAt > cardAt && timelineAt > calAt, "반 카드 → 달력 → 신청 내역");
  assert.match(html, /2026년 11월/);
  assert.match(html, /href="\/mypage\/classes\?child=a&amp;month=2026-10"[^>]*aria-label="이전 달"/);
  assert.match(html, /href="\/mypage\/classes\?child=a&amp;month=2026-12"[^>]*aria-label="다음 달"/);
  assert.match(html, /16일 수업/);
  assert.match(html, /9일 출석/);
  // 고른 아이의 달력이 없으면(조회 실패·다른 아이) 달력 칸만 빠진다
  const none = renderClasses({ overview: { today: "2026-11-10", children: [{ id: "a", name: "합성 첫째", classes: [card()] }] }, initialChildId: "a", calendar: null });
  assert.doesNotMatch(none, /schedule-records-heading/);
  assert.match(none, /초등 저학년반/);
});

test("아이 선택 기억: 주소 > 기기 기억 > 기본값, 내 자녀 목록 밖 id 는 무시 · 수업/홈/일정이 같은 칸을 쓴다", () => {
  const nav = load("src/lib/mypage/parentNav.ts");
  assert.equal(nav.pickChildId(["a", "b"], "b", "a", "a"), "b", "주소가 먼저");
  assert.equal(nav.pickChildId(["a", "b"], null, "b", "a"), "b", "주소가 없으면 기기 기억");
  assert.equal(nav.pickChildId(["a", "b"], "남의아이", "남의아이2", "a"), "a", "목록 밖 id 는 무시");
  assert.equal(nav.pickChildId(["a", "b"], null, null, "zzz"), "a");
  const hook = read("src/app/mypage/useRememberedChild.ts");
  assert.match(hook, /try \{\s*return window\.localStorage\.getItem/, "localStorage 는 try/catch 안에서");
  assert.match(hook, /window\.history\.replaceState/, "주소 ?child= 를 기록을 쌓지 않고 고친다(뒤로 가기가 그 아이로)");
  assert.match(read("src/app/mypage/classes/ClassesClient.tsx"), /useRememberedChild\(/);
  assert.match(read("src/app/mypage/MyPageClient.tsx"), /useRememberedChild\(/);
  assert.match(read("src/app/mypage/history/page.tsx"), /<RememberChildSync /);
  // 서버는 주소의 child 를 «내 자녀 목록 안에서만» 고른다(classes 는 childAccessSql 을 거친 overview)
  assert.match(read("src/app/mypage/classes/page.tsx"), /overview\.children\.find\(\(c\) => c\.id === child\)/);
  assert.match(read("src/app/mypage/page.tsx"), /data\.children\.find\(\(c\) => c\.id === childParam\)/);
});
