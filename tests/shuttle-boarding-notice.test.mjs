// 2026-11-14 원장 결정표(묶음 A) — 셔틀 «탔어요·내렸어요» 알림 · «수업 종료»를 «출결» 스위치로 ·
// 홈 «오늘 셔틀» 실제 시각 · 관리자 출결 저장 알림 = 선생님 화면과 같은 규칙.
// ① 규칙(순수 모듈)은 실제로 돌린다 — 1분 지연·30분 한도·자정 경계.
// ② 훑기(sweep)는 가짜 DB 로 «실제로 돌려» 확인한다 — 같은 날 두 번 안 나감·대표 보호자만·방학특강 같이.
// ③ 화면·경로 연결은 소스로 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) throw new Error(`대역 없는 의존: ${name}`);
    return require(name);
  };
  module._compile(compiled, absolute);
  return module.exports;
}

// 순수 규칙은 진짜를 쓴다
const kst = load("src/lib/datetime/kst.ts");
const rules = load("src/lib/shuttle/boardingNoticeRules.ts", { "@/lib/datetime/kst": kst });
const settings = load("src/lib/mypage/parentSettings.ts");
const summary = load("src/lib/mypage/summary.ts");
const sessionRules = load("src/lib/staff-session-rules.ts", { "@/lib/datetime/kst": kst, "@/lib/auth/moneyAccess": load("src/lib/auth/moneyAccess.ts") });
const attendanceRules = load("src/lib/attendance/attendanceNoticeRules.ts", { "@/lib/staff-session-rules": sessionRules, "@/lib/datetime/kst": kst });

const kstMs = (iso) => new Date(`${iso}+09:00`).getTime();
const epoch = (iso) => kstMs(iso) / 1000;
const regular = (over = {}) => ({ direction: "REGULAR", shuttleRequestId: "row-1", status: "BOARDED", rosterStudentId: "kid-1", stopDirection: "BOARD", checkedEpoch: epoch("2026-11-16T08:52:00"), ...over });
const NONE = new Map();

// ── 1. 셔틀 탑승 알림 규칙 ─────────────────────────────────────────

test("탑승을 찍고 1분이 지나야 나간다 — 그 전에는 고르지 않는다", () => {
  const checked = "2026-11-16T08:52:00";
  assert.equal(rules.BOARDING_NOTICE_DELAY_SECONDS, 60);
  assert.deepEqual(rules.pickBoardingNotices([regular()], NONE, kstMs("2026-11-16T08:52:30")), [], "30초 뒤는 아직");
  assert.deepEqual(rules.pickBoardingNotices([regular()], NONE, kstMs("2026-11-16T08:52:59")), [], "59초 뒤도 아직");
  const picked = rules.pickBoardingNotices([regular()], NONE, kstMs("2026-11-16T08:53:00"));
  assert.deepEqual(picked, [{ studentId: "kid-1", leg: "PICKUP", checkedAtMs: kstMs(checked) }], "정확히 1분 뒤부터");
});

test("1분 안에 되돌리거나 고치면 나가지 않는다", () => {
  const now = kstMs("2026-11-16T08:55:00");
  // 되돌리기(대기) = 줄이 지워진다 → 고를 줄이 없다
  assert.deepEqual(rules.pickBoardingNotices([], NONE, now), []);
  for (const file of ["src/lib/shuttle/regularRun.ts", "src/lib/seasonal/shuttleRun.ts"]) {
    assert.match(read(file), /if \(input\.status == null\) \{\s*await prisma\.\$executeRawUnsafe\(\s*`DELETE FROM "ShuttleBoarding"/, `${file}: 되돌리면 줄을 지운다`);
    // 다시 찍으면 시계가 새로 돈다(checkedAt = now())
    assert.match(read(file), /"checkedVia" = EXCLUDED\."checkedVia", "checkedAt" = now\(\)/);
  }
  // 미탑승·자차로 고친 줄은 알리지 않는다(미탑승 알림 없음)
  assert.deepEqual(rules.pickBoardingNotices([regular({ status: "NOSHOW" })], NONE, now), []);
  assert.deepEqual(rules.pickBoardingNotices([regular({ status: "SELF" })], NONE, now), []);
  // 고쳤다가 다시 «탑승» = 마지막으로 찍은 시각부터 다시 1분
  assert.deepEqual(rules.pickBoardingNotices([regular({ checkedEpoch: epoch("2026-11-16T08:54:40") })], NONE, now), []);
});

test("찍은 지 30분이 넘은 체크는 보내지 않는다 — 크론이 멈췄다 살아나도 아침 탑승이 오후에 나가지 않는다", () => {
  assert.equal(rules.pickBoardingNotices([regular()], NONE, kstMs("2026-11-16T09:22:00")).length, 1, "30분 정각까지는 보낸다");
  assert.deepEqual(rules.pickBoardingNotices([regular()], NONE, kstMs("2026-11-16T09:22:01")), []);
  assert.deepEqual(rules.pickBoardingNotices([regular()], NONE, kstMs("2026-11-16T15:00:00")), []);
});

test("등원 줄 = 탔어요, 하원 줄 = 내렸어요 — 회차·복귀 줄과 아이 없는 줄은 건너뛴다", () => {
  const now = kstMs("2026-11-16T09:00:00");
  const pick = (row) => rules.pickBoardingNotices([row], NONE, now);
  assert.equal(pick(regular())[0].leg, "PICKUP");
  assert.equal(pick(regular({ stopDirection: "ALIGHT" }))[0].leg, "DROPOFF");
  assert.deepEqual(pick(regular({ stopDirection: "PIVOT" })), []);
  assert.deepEqual(pick(regular({ stopDirection: "RETURN" })), []);
  assert.deepEqual(pick(regular({ rosterStudentId: null })), [], "명단 줄에 학생이 안 이어져 있으면 보낼 사람을 모른다");
  assert.deepEqual(pick(regular({ stopDirection: null, rosterStudentId: null })), [], "명단 줄이 지워진 체크");
  assert.deepEqual(pick(regular({ checkedEpoch: null })), []);
  // 문구는 두 가지뿐
  assert.equal(rules.boardingNoticeMessage("PICKUP", "김하늘", kstMs("2026-11-16T08:52:00")), "김하늘 학생이 셔틀에 탔어요. (08:52)");
  assert.equal(rules.boardingNoticeMessage("DROPOFF", "김하늘", kstMs("2026-11-16T18:40:00")), "김하늘 학생이 셔틀에서 내렸어요. (18:40)");
  assert.equal(rules.boardingNoticeTitle("PICKUP"), "셔틀 탑승 안내");
  assert.equal(rules.boardingNoticeTitle("DROPOFF"), "셔틀 하차 안내");
});

test("방학특강 셔틀도 같이 — 신청 id 를 확정 명단의 학생으로 풀고, 학생이 안 이어진 신청은 건너뛴다", () => {
  const now = kstMs("2026-11-16T09:00:00");
  const seasonal = (over = {}) => ({ direction: "PICKUP", shuttleRequestId: "req-1", status: "BOARDED", rosterStudentId: null, stopDirection: null, checkedEpoch: epoch("2026-11-16T08:50:00"), ...over });
  const map = new Map([["req-1", "kid-9"], ["req-2", null]]);
  assert.deepEqual(rules.pickBoardingNotices([seasonal()], map, now), [{ studentId: "kid-9", leg: "PICKUP", checkedAtMs: kstMs("2026-11-16T08:50:00") }]);
  assert.equal(rules.pickBoardingNotices([seasonal({ direction: "DROPOFF" })], map, now)[0].leg, "DROPOFF");
  assert.deepEqual(rules.pickBoardingNotices([seasonal({ shuttleRequestId: "req-2" })], map, now), [], "학생 전환 전 신청");
  assert.deepEqual(rules.pickBoardingNotices([seasonal({ shuttleRequestId: "req-x" })], map, now), [], "명단에 없는 신청");
  assert.deepEqual(rules.pickBoardingNotices([seasonal({ direction: "ALL" })], map, now), [], "모르는 방향 값");
});

test("같은 아이·같은 날·같은 방향은 한 번만 — 줄이 둘이어도 하나, 키는 줄 id 와 무관하다", () => {
  const now = kstMs("2026-11-16T09:00:00");
  const two = [regular({ shuttleRequestId: "row-1", checkedEpoch: epoch("2026-11-16T08:55:00") }), regular({ shuttleRequestId: "row-2", checkedEpoch: epoch("2026-11-16T08:52:00") })];
  const picked = rules.pickBoardingNotices(two, NONE, now);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].checkedAtMs, kstMs("2026-11-16T08:52:00"), "먼저 찍힌 것");
  // 등원·하원은 따로 한 번씩
  assert.equal(rules.pickBoardingNotices([regular(), regular({ shuttleRequestId: "row-3", stopDirection: "ALIGHT" })], NONE, now).length, 2);
  const key = rules.boardingNoticeDedupeKey({ dateYmd: "2026-11-16", leg: "PICKUP", studentId: "kid-1", userId: "p1" });
  assert.equal(key, "shuttle-boarding:2026-11-16:PICKUP:student:kid-1:user:p1");
  assert.notEqual(key, rules.boardingNoticeDedupeKey({ dateYmd: "2026-11-16", leg: "DROPOFF", studentId: "kid-1", userId: "p1" }));
  assert.notEqual(key, rules.boardingNoticeDedupeKey({ dateYmd: "2026-11-17", leg: "PICKUP", studentId: "kid-1", userId: "p1" }));
});

// ── 2. 훑기를 가짜 DB 로 돌린다 ─────────────────────────────────────

function sweepFixture({ rows, seasonalRoster = [], recipients, nowIso }) {
  const world = { ledger: new Set(), delivered: [], rosterReads: 0, boardingSql: "", boardingArgs: null };
  const prisma = {
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.includes('FROM "ShuttleBoarding" b')) {
        world.boardingSql = sql; world.boardingArgs = args;
        // SQL 의 조건(오늘·탑승·1~30분)을 가짜 DB 가 그대로 흉내 낸다
        const now = epoch(world.nowIso);
        return world.rows
          .filter((r) => r.serviceDate === args[0] && r.status === "BOARDED" && now - r.checkedEpoch >= args[1] && now - r.checkedEpoch <= args[2])
          .map((r) => ({ ...r, nowEpoch: now }));
      }
      if (sql.includes('FROM "NotificationDelivery"')) {
        assert.match(sql, /"dedupeKey" = ANY\(\$1::text\[\]\)/);
        return args[0].filter((key) => world.ledger.has(key)).map((dedupeKey) => ({ dedupeKey }));
      }
      throw new Error(`가짜 DB 가 모르는 조회: ${sql.slice(0, 80)}`);
    },
  };
  world.rows = rows;
  const sweep = load("src/lib/shuttle/boardingNoticeSweep.ts", {
    "@/lib/prisma": { prisma },
    "@/lib/datetime/kst": kst,
    "@/lib/shuttle/boardingNoticeRules": rules,
    "@/lib/seasonal/shuttleRoster": { getConfirmedShuttleRoster: async () => { world.rosterReads += 1; return seasonalRoster; } },
    "@/lib/staff-notifications": {
      // 대표 보호자(Student.parentId)만 돌려주는 기존 함수
      getStudentParentRecipients: async (ids) => recipients.filter((r) => ids.includes(r.studentId)),
      deliverParentNotification: async (input) => {
        // 진짜와 같은 장부 규칙: 앱 알림 키 + «:push» 키, 이미 있으면 중복
        const duplicate = world.ledger.has(`${input.dedupeKey}:push`);
        world.ledger.add(input.dedupeKey); world.ledger.add(`${input.dedupeKey}:push`);
        if (!duplicate) world.delivered.push(input);
        return { sent: !duplicate, duplicate, inAppCreated: !duplicate, push: null };
      },
    },
  });
  return { world, run: (iso) => { world.nowIso = iso ?? nowIso; return sweep.sweepShuttleBoardingNotices(50, kstMs(world.nowIso)); } };
}

test("훑기: 1분 지난 탑승만 대표 보호자에게 한 통 — 다음 분에 다시 돌아도 두 번 나가지 않는다", async () => {
  const nowIso = "2026-11-16T08:54:00";
  const rows = [
    { serviceDate: "2026-11-16", ...regular() },                                                              // 2분 전 탑승 → 보냄
    { serviceDate: "2026-11-16", ...regular({ shuttleRequestId: "row-2", rosterStudentId: "kid-2", checkedEpoch: epoch("2026-11-16T08:53:30") }) }, // 30초 전 → 아직
    { serviceDate: "2026-11-16", ...regular({ shuttleRequestId: "row-3", rosterStudentId: "kid-3", status: "NOSHOW" }) },                          // 미탑승 → 안 보냄
    { serviceDate: "2026-11-15", ...regular({ shuttleRequestId: "row-4", rosterStudentId: "kid-4", checkedEpoch: epoch("2026-11-16T08:52:00") }) }, // 어제 날짜 운행표 → 안 보냄
    { serviceDate: "2026-11-16", ...regular({ shuttleRequestId: "row-5", rosterStudentId: "kid-5" }) },                                            // 보호자 없는 아이
  ];
  const recipients = [1, 2, 3, 4].map((n) => ({ studentId: `kid-${n}`, studentName: `학생${n}`, userId: `p${n}` }));
  const { world, run } = sweepFixture({ rows, recipients, nowIso });

  const first = await run();
  assert.deepEqual(first, { candidates: 1, delivered: 1, duplicate: 0, failed: 0 });
  assert.equal(world.delivered.length, 1);
  const sent = world.delivered[0];
  assert.equal(sent.eventType, "SHUTTLE_BOARDED");
  assert.equal(sent.recipient.userId, "p1");
  assert.equal(sent.dedupeKey, "shuttle-boarding:2026-11-16:PICKUP:student:kid-1:user:p1");
  assert.equal(sent.message, "학생1 학생이 셔틀에 탔어요. (08:52)");
  assert.equal(sent.linkUrl, "/mypage");
  assert.deepEqual(world.boardingArgs, ["2026-11-16", 60, 1800], "오늘(KST)·1분·30분");
  assert.equal(world.rosterReads, 0, "정규만 도는 날은 방학특강 명단을 읽지 않는다");

  // 1분 뒤 다시: kid-1 은 이미 보냈고, kid-2 가 1분을 넘겨 새로 나간다
  const second = await run("2026-11-16T08:55:00");
  assert.equal(second.candidates, 1);
  assert.equal(second.delivered, 1);
  assert.deepEqual(world.delivered.map((d) => d.recipient.studentId), ["kid-1", "kid-2"]);
  // 또 돌아도 더는 없다(같은 아이·같은 날·같은 방향 한 번)
  const third = await run("2026-11-16T08:56:00");
  assert.deepEqual(third, { candidates: 0, delivered: 0, duplicate: 0, failed: 0 });
  assert.equal(world.delivered.length, 2);
});

test("훑기: 보낸 뒤 기사님이 미탑승으로 고쳤다 다시 탑승으로 바꿔도 정정 알림은 없다", async () => {
  const row = { serviceDate: "2026-11-16", ...regular() };
  const { world, run } = sweepFixture({ rows: [row], recipients: [{ studentId: "kid-1", studentName: "김하늘", userId: "p1" }], nowIso: "2026-11-16T08:54:00" });
  await run();
  assert.equal(world.delivered.length, 1);
  row.status = "NOSHOW";
  assert.equal((await run("2026-11-16T08:58:00")).candidates, 0, "미탑승은 알리지 않는다");
  row.status = "BOARDED"; row.checkedEpoch = epoch("2026-11-16T09:00:00");
  assert.equal((await run("2026-11-16T09:02:00")).candidates, 0, "같은 날 같은 방향은 이미 보냈다");
  assert.equal(world.delivered.length, 1);
});

test("훑기: 방학특강 셔틀 하원 = «내렸어요», 확정 명단 게이트웨이로 학생을 찾는다", async () => {
  const rows = [{ serviceDate: "2026-11-16", direction: "DROPOFF", shuttleRequestId: "req-1", status: "BOARDED", rosterStudentId: null, stopDirection: null, checkedEpoch: epoch("2026-11-16T18:40:00") }];
  const { world, run } = sweepFixture({
    rows, nowIso: "2026-11-16T18:42:00",
    seasonalRoster: [{ shuttleRequestId: "req-1", studentId: "kid-7" }, { shuttleRequestId: "req-2", studentId: null }],
    recipients: [{ studentId: "kid-7", studentName: "박바다", userId: "p7" }],
  });
  assert.deepEqual(await run(), { candidates: 1, delivered: 1, duplicate: 0, failed: 0 });
  assert.equal(world.rosterReads, 1);
  assert.equal(world.delivered[0].eventType, "SHUTTLE_ALIGHTED");
  assert.equal(world.delivered[0].message, "박바다 학생이 셔틀에서 내렸어요. (18:40)");
  assert.equal(world.delivered[0].title, "셔틀 하차 안내");
});

test("훑기 SQL·연결: 탑승 표 기준(어느 길로 찍혀도)·시각은 초로 비교·크론에 붙어 있다·문자는 없다", () => {
  const sweep = read("src/lib/shuttle/boardingNoticeSweep.ts");
  assert.match(sweep, /b\.status = 'BOARDED'/);
  assert.match(sweep, /b\."serviceDate" = \$1/);
  assert.match(sweep, /LEFT JOIN "RegularShuttleStop" r ON b\.direction = 'REGULAR' AND r\.id = b\."shuttleRequestId"/);
  // checkedAt 은 칼럼 타입(timestamp/timestamptz)과 무관하게 초로 비교한다 — AT TIME ZONE 을 쓰지 않는다
  assert.match(sweep, /EXTRACT\(EPOCH FROM NOW\(\)\) - EXTRACT\(EPOCH FROM b\."checkedAt"\) BETWEEN \$2::int AND \$3::int/);
  assert.doesNotMatch(sweep, /AT TIME ZONE/);
  assert.doesNotMatch(sweep, /sendTrackedSms|sendParentSms|alimtalk/i, "문자·알림톡은 만들지 않는다");
  assert.doesNotMatch(sweep, /findMany|findFirst|\.create\(|\.upsert\(/, "ORM 기본 메서드 금지");
  const cron = read("src/app/api/cron/push-outbox/route.ts");
  assert.match(cron, /try \{\s*shuttle = await sweepShuttleBoardingNotices\(50\);\s*\} catch/, "실패해도 밀린 푸시 보내기는 계속");
  assert.ok(cron.indexOf("sweepShuttleBoardingNotices(50)") < cron.indexOf("processPushOutbox(50)"));
});

// ── 3. 알림 스위치 ─────────────────────────────────────────────

test("셔틀 탑승 알림은 «셔틀» 스위치, «수업 종료»는 «출결» 스위치로 끈다", async () => {
  for (const event of rules.BOARDING_NOTICE_EVENTS) assert.equal(settings.pushCategoryOf(event), "shuttle", event);
  assert.deepEqual([...rules.BOARDING_NOTICE_EVENTS], ["SHUTTLE_BOARDED", "SHUTTLE_ALIGHTED"]);
  assert.equal(settings.pushCategoryOf("CLASS_COMPLETED"), "attendance");
  assert.equal(settings.pushCategoryOf("ATTENDANCE_PRESENT"), "attendance");
  assert.equal(settings.pushCategoryOf("ATTENDANCE_ABSENT"), "attendance");
  // 수업 공지·리포트는 그대로(끌 수 없는 종류)
  assert.equal(settings.pushCategoryOf("CLASS_NOTICE"), null);
  assert.equal(settings.pushCategoryOf("REPORT"), null);
  // 수업 종료 알림의 이벤트 이름이 그대로인지(이름이 바뀌면 스위치가 조용히 안 먹는다)
  assert.match(read("src/app/actions/staff-sessions.ts"), /eventType: "CLASS_COMPLETED",/);

  // 스위치를 끈 학부모에게는 휴대폰 알림이 나가지 않는다 — 판정 함수를 가짜 DB 로 실제로 돌린다
  const asked = [];
  const prefs = load("src/lib/parent-notification-preferences.ts", {
    "@/lib/mypage/parentSettings": settings,
    "@/lib/prisma": { prisma: { $queryRawUnsafe: async (sql, userId) => {
      const column = /SELECT p\."(\w+)" AS "on"/.exec(sql)[1];
      asked.push(column);
      const off = { "p-off": ["pushShuttle", "pushAttendance"] }[userId] ?? [];
      return userId === "p-none" ? [] : [{ on: !off.includes(column) }];
    } } },
  });
  assert.equal(await prefs.isPushAllowed("p-off", "SHUTTLE_BOARDED"), false);
  assert.equal(await prefs.isPushAllowed("p-off", "SHUTTLE_ALIGHTED"), false);
  assert.equal(await prefs.isPushAllowed("p-off", "CLASS_COMPLETED"), false);
  assert.equal(await prefs.isPushAllowed("p-on", "SHUTTLE_BOARDED"), true);
  assert.equal(await prefs.isPushAllowed("p-on", "CLASS_COMPLETED"), true);
  assert.equal(await prefs.isPushAllowed("p-none", "SHUTTLE_BOARDED"), true, "설정 줄이 없으면 전부 받기");
  assert.deepEqual([...new Set(asked)].sort(), ["pushAttendance", "pushShuttle"]);
  // 푸시는 알림 종류(tag = eventType)로 거른다 — 그 연결이 살아 있는지
  assert.match(read("src/lib/staff-notifications.ts"), /tag: input\.eventType/);
  assert.match(read("src/lib/pushNotification.ts"), /if \(payload\.tag && !\(await isPushAllowed\(userId, payload\.tag\)\)\)/);
});

// ── 4. 홈 «오늘 셔틀» 줄 ───────────────────────────────────────

test("홈 «오늘 셔틀»: 찍힌 시각이 있으면 «탑승 08:52»·«하차 18:40», 없으면 예정 시각 그대로", () => {
  const pickup = { id: "a", serviceDate: "2026-11-16", direction: "PICKUP", status: "CONFIRMED", pickupEtaLabel: "08:40 승차", dropoffEtaLabel: null };
  const dropoff = { id: "b", serviceDate: "2026-11-16", direction: "DROPOFF", status: "CONFIRMED", pickupEtaLabel: null, dropoffEtaLabel: "18:30 하차" };
  assert.deepEqual(summary.todayShuttleLineTexts([pickup, dropoff]), ["등원 08:40 승차", "하원 18:30 하차"], "아직 안 찍힘 = 종전 글자");
  assert.deepEqual(summary.todayShuttleLineTexts([{ ...pickup, actualTimeLabel: "08:52" }, dropoff]), ["탑승 08:52", "하원 18:30 하차"]);
  assert.deepEqual(summary.todayShuttleLineTexts([{ ...pickup, actualTimeLabel: "08:52" }, { ...dropoff, actualTimeLabel: "18:40" }]), ["탑승 08:52", "하차 18:40"]);
  // 예정 시각이 없던 아이도 찍히면 보인다
  assert.deepEqual(summary.todayShuttleLineTexts([{ ...pickup, pickupEtaLabel: null, actualTimeLabel: "08:52" }]), ["탑승 08:52"]);
  assert.deepEqual(summary.todayShuttleLineTexts([{ ...pickup, pickupEtaLabel: null }]), [], "둘 다 없으면 화면이 «운행 N건»");
  const client = read("src/app/mypage/MyPageClient.tsx");
  assert.match(client, /const todayShuttleLines = todayShuttleLineTexts\(todayShuttles\);/);
});

test("실제 시각은 KST «HH:MM» — 자정 경계, 등원은 먼저 탄 시각·하원은 마지막에 내린 시각, 미탑승은 표시 없음", () => {
  // UTC 23:52(전날) = KST 08:52
  const utc = (iso) => Date.parse(iso) / 1000;
  const labels = rules.boardingTimeLabels([
    regular({ checkedEpoch: utc("2026-11-15T23:52:00Z") }),
    regular({ shuttleRequestId: "row-2", checkedEpoch: utc("2026-11-15T23:59:00Z") }),
    regular({ shuttleRequestId: "row-3", stopDirection: "ALIGHT", checkedEpoch: utc("2026-11-16T09:40:00Z") }),
    regular({ shuttleRequestId: "row-4", stopDirection: "ALIGHT", checkedEpoch: utc("2026-11-16T09:10:00Z") }),
    regular({ shuttleRequestId: "row-5", rosterStudentId: "kid-2", status: "NOSHOW" }),
    { direction: "PICKUP", shuttleRequestId: "req-1", status: "BOARDED", rosterStudentId: null, stopDirection: null, checkedEpoch: utc("2026-11-16T15:00:00Z") },
  ], new Map([["req-1", "kid-3"]]));
  assert.equal(labels.get(rules.boardingTimeKey("kid-1", "PICKUP")), "08:52");
  assert.equal(labels.get(rules.boardingTimeKey("kid-1", "DROPOFF")), "18:40");
  assert.equal(labels.has(rules.boardingTimeKey("kid-2", "PICKUP")), false);
  assert.equal(labels.get(rules.boardingTimeKey("kid-3", "PICKUP")), "00:00", "UTC 15:00 = KST 자정(24:00 아님)");
  // 조회: 내 자녀 범위 안에서만, 시각은 초로 읽어 kst.ts 로 만든다, 실패해도 홈이 깨지지 않는다
  const parent = read("src/lib/shuttle/parent.ts");
  const fn = parent.slice(parent.indexOf("async function loadTodayBoardingTimes"), parent.indexOf("type RouteStatus"));
  assert.match(fn, /r\."studentId" = ANY\(\$2::text\[\]\)/);
  assert.match(fn, /b\."shuttleRequestId" = ANY\(\$3::text\[\]\)/);
  assert.match(fn, /EXTRACT\(EPOCH FROM b\."checkedAt"\)::float8 AS "checkedEpoch"/);
  assert.doesNotMatch(fn, /AT TIME ZONE|to_char/);
  assert.match(fn, /catch \(error\) \{[\s\S]*?return new Map\(\);/);
  assert.match(parent, /new Map\(seasonalEntries\.map\(\(entry\) => \[entry\.shuttleRequestId, entry\.studentId\]\)\)/, "방학특강은 내 자녀 신청만");
});

// ── 5. 관리자 출결 저장 알림 = 선생님 화면과 같은 규칙 ───────────────────

test("관리자 출결 저장: 바뀐 아이만·출석/지각만·오늘 수업만 고른다", () => {
  const now = kstMs("2026-11-16T17:00:00");
  const previous = new Map([["a", "PRESENT"], ["b", "ABSENT"], ["c", "PRESENT"], ["d", "LATE"]]);
  const records = [
    { studentId: "a", status: "PRESENT" }, // 그대로 → 안 보냄
    { studentId: "b", status: "PRESENT" }, // 결석 → 출석 → 보냄
    { studentId: "c", status: "ABSENT" },  // 결석으로 → 여기서는 안 보냄(3분 뒤 결석 알림 훑기)
    { studentId: "d", status: "LATE" },    // 그대로
    { studentId: "e", status: "LATE" },    // 처음 찍힘 → 보냄
  ];
  const pick = (over = {}) => attendanceRules.pickAttendanceNoticeTargets({ records, previousByStudent: previous, sessionYmd: "2026-11-16", todayOnly: true, nowMs: now, ...over });
  assert.deepEqual(pick(), [{ studentId: "b", status: "PRESENT" }, { studentId: "e", status: "LATE" }]);
  // 같은 내용을 한 번 더 저장 = 바뀐 아이 없음
  const after = new Map([...previous, ["b", "PRESENT"], ["c", "ABSENT"], ["e", "LATE"]]);
  assert.deepEqual(pick({ previousByStudent: after }), []);
  // 지난 날짜 정리·앞날 미리 입력은 조용히
  assert.deepEqual(pick({ sessionYmd: "2026-11-15" }), []);
  assert.deepEqual(pick({ sessionYmd: "2026-11-17" }), []);
  // 자정 경계: KST 00:10 에는 «오늘»이 16일이다(UTC 로는 아직 15일)
  assert.equal(pick({ nowMs: kstMs("2026-11-16T00:10:00") }).length, 2);
  assert.deepEqual(pick({ nowMs: kstMs("2026-11-17T00:10:00") }), []);
  // 선생님 화면이 쓰는 판정도 같은 함수
  assert.equal(attendanceRules.attendanceNoticeNeeded({ changed: true, status: "PRESENT", sessionYmd: "2026-11-16", nowMs: now }), true);
  assert.equal(attendanceRules.attendanceNoticeNeeded({ changed: false, status: "PRESENT", sessionYmd: "2026-11-16", nowMs: now }), false);
  assert.equal(attendanceRules.attendanceNoticeNeeded({ changed: true, status: "ABSENT", sessionYmd: "2026-11-16", nowMs: now }), false);
  assert.equal(attendanceRules.attendanceNoticeNeeded({ changed: true, status: "LATE", sessionYmd: "2026-11-15", nowMs: now }), false);
});

test("출석 알림 한 통의 문구·키는 한 곳 — 같은 출결·같은 상태·같은 학부모는 한 번만", () => {
  const recipient = { studentId: "st1", studentName: "김하늘", userId: "p1" };
  const payload = attendanceRules.attendanceNoticePayload({ recipient, status: "LATE", className: "초등 A반", sessionId: "s1", attendanceId: "a1" });
  assert.deepEqual(payload, {
    eventType: "ATTENDANCE_LATE", dedupeKey: "attendance:a1:status:LATE:user:p1", recipient,
    title: "초등 A반 출석 안내", message: "김하늘 학생이 지각 출석했습니다.", linkUrl: "/parent/attendance", sessionId: "s1", attendanceId: "a1",
  });
  const present = attendanceRules.attendanceNoticePayload({ recipient, status: "PRESENT", className: "초등 A반", sessionId: "s1", attendanceId: "a1" });
  assert.equal(present.eventType, "ATTENDANCE_PRESENT");
  assert.equal(present.dedupeKey, "attendance:a1:status:PRESENT:user:p1");
  assert.equal(present.message, "김하늘 학생이 출석했습니다.");
});

test("관리자·선생님 저장 경로가 같은 규칙 함수를 쓰고, «출결이 기록되었습니다» 전체 발송은 없다", () => {
  const admin = read("src/app/actions/admin.ts");
  const start = admin.indexOf("export async function saveAttendance(");
  const body = admin.slice(start, admin.indexOf("// ── 수납 관리", start));
  assert.doesNotMatch(body, /notifyParentsOfStudents\(/, "반 전원에게 매번 보내던 알림 제거");
  assert.doesNotMatch(admin, /출결이 기록되었습니다|방학특강 출석이 기록되었습니다/);
  assert.equal((body.match(/await notifyAttendanceChanges\(\{/g) ?? []).length, 2, "정규·방학특강 두 길 모두");
  assert.equal((body.match(/const previousByStudent = await readAttendanceStatuses\(sessionId\);/g) ?? []).length, 2);
  // 저장 «전» 상태를 읽은 뒤에 저장한다(순서가 바뀌면 전부 «안 바뀜»이 된다)
  assert.ok(body.indexOf("readAttendanceStatuses(sessionId)") < body.indexOf('INSERT INTO "Attendance"'));
  const helper = admin.slice(admin.indexOf("async function notifyAttendanceChanges"), start);
  assert.match(helper, /pickAttendanceNoticeTargets\(\{[\s\S]*?todayOnly: true,/);
  assert.match(helper, /await deliverParentNotification\(attendanceNoticePayload\(\{/);
  assert.match(helper, /catch \(error\) \{/, "알림 실패가 출결 저장을 실패로 만들지 않는다");
  const staff = read("src/app/actions/staff-sessions.ts");
  assert.equal((staff.match(/attendanceNoticeNeeded\(\{ changed, status: input\.status, sessionYmd \}\)/g) ?? []).length, 2);
  assert.equal((staff.match(/await deliverParentNotification\(attendanceNoticePayload\(\{/g) ?? []).length, 2);
  // 결석 알림은 출결 표를 훑어 보내므로 관리자 저장도 그대로 포함된다(따로 붙이지 않는다)
  assert.match(read("src/lib/regular/absence-parent-notice-sweep.ts"), /WHERE a\.status = 'ABSENT'/);
});

// ── 6. 발송 안내문 틀 ─────────────────────────────────────────

test("가입 안내문: «결석 신고» → «결석 알리기»", () => {
  const templates = load("src/lib/customer-notice/templates.ts", { "@/lib/datetime/kst": kst });
  const message = templates.buildParentSignupGuideMessage();
  assert.match(message, /▶ 결석은 가입 후 ‘결석 알리기’로 알려 주세요\./);
  assert.doesNotMatch(message, /결석 신고/);
});
