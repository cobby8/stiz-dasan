import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 원장 아침 요약 알림 — 문구는 실제 실행으로, 발송 범위·안전장치는 소스 검사로 못박는다.

const { buildAdminDailyDigest, formatWon, monthLabel } = await loadTsModule("src/lib/admin-daily-digest.ts");
// 주석(설명 글)에 나온 단어를 실제 사용으로 오인하지 않도록 // 주석은 걷어내고 검사한다
const service = (await readFile("src/lib/admin-daily-digest-service.ts", "utf8")).replace(/^\s*\/\/.*$/gm, "");
const route = await readFile("src/app/api/cron/admin-daily-digest/route.ts", "utf8");
const vercel = JSON.parse(await readFile("vercel.json", "utf8"));

const row = (year, month, count, amount, overdueCount = 0) => ({ year, month, count, amount, overdueCount });

test("금액은 콤마를 찍고 '원'을 붙인다", () => {
  assert.equal(formatWon(0), "0원");
  assert.equal(formatWon(999), "999원");
  assert.equal(formatWon(1000), "1,000원");
  assert.equal(formatWon(1234567), "1,234,567원");
});

test("월 라벨은 연·월 숫자 그대로 (시간대 무관)", () => {
  assert.equal(monthLabel(2026, 1), "2026년 1월");
  assert.equal(monthLabel(2025, 12), "2025년 12월");
});

test("확인할 일이 하나도 없으면 null — 보내지 않는다", () => {
  assert.equal(buildAdminDailyDigest({ todayYmd: "2026-10-06", unpaid: [], needsCheckCount: 0, pendingChangeCount: 0 }), null);
  // 0건 행만 있어도 마찬가지
  assert.equal(buildAdminDailyDigest({ todayYmd: "2026-10-06", unpaid: [row(2026, 10, 0, 0)], needsCheckCount: 0, pendingChangeCount: 0 }), null);
});

test("미납은 최근 3개월 월별 + 그 이전 합계, 기한 지남 건수", () => {
  const d = buildAdminDailyDigest({
    todayYmd: "2026-10-06",
    unpaid: [
      row(2026, 10, 3, 450000, 0),
      row(2026, 9, 2, 300000, 2),
      row(2026, 8, 1, 150000, 1),
      row(2026, 7, 1, 150000, 1), // 그 이전
      row(2026, 5, 2, 200000, 2), // 그 이전
    ],
    needsCheckCount: 0,
    pendingChangeCount: 0,
  });
  assert.equal(d.title, "오늘 확인할 일: 미납 9건");
  assert.equal(d.linkUrl, "/admin/finance");
  const lines = d.message.split("\n");
  assert.equal(lines[0], "[사이트 장부 미납] 9건 · 1,250,000원 (기한 지남 6건)");
  assert.deepEqual(lines.slice(1), [
    "- 2026년 10월: 3건 · 450,000원",
    "- 2026년 9월: 2건 · 300,000원",
    "- 2026년 8월: 1건 · 150,000원",
    "- 그 이전: 3건 · 350,000원",
  ]);
  // 수강 변경 0건은 문구에 나오지 않는다
  assert.doesNotMatch(d.message, /수강 변경/);
});

test("연초에는 지난해 11·12월까지가 최근 3개월이다", () => {
  const d = buildAdminDailyDigest({
    todayYmd: "2027-01-02",
    unpaid: [row(2026, 11, 1, 100000), row(2026, 10, 1, 100000)],
    needsCheckCount: 0,
    pendingChangeCount: 0,
  });
  assert.match(d.message, /- 2026년 11월: 1건 · 100,000원/);
  assert.match(d.message, /- 그 이전: 1건 · 100,000원/);
  assert.doesNotMatch(d.message, /기한 지남/); // 0건이면 괄호도 생략
});

test("미납이 없으면 수강 변경 확인 화면으로 연결한다", () => {
  const d = buildAdminDailyDigest({ todayYmd: "2026-10-06", unpaid: [], needsCheckCount: 2, pendingChangeCount: 1 });
  assert.equal(d.title, "오늘 확인할 일: 수강 변경 확인 2건 · 변경 승인 대기 1건");
  assert.equal(d.linkUrl, "/admin/enrollment-changes?status=NEEDS_CHECK");
  assert.doesNotMatch(d.message, /미납/);
  const onlyPending = buildAdminDailyDigest({ todayYmd: "2026-10-06", unpaid: [], needsCheckCount: 0, pendingChangeCount: 4 });
  assert.equal(onlyPending.linkUrl, "/admin/enrollment-changes");
});

test("카카오 접수 대기는 건수가 있을 때만 넣고, 다른 할 일이 없으면 카카오 접수함으로 연결한다", () => {
  const only = buildAdminDailyDigest({ todayYmd: "2026-10-08", unpaid: [], needsCheckCount: 0, pendingChangeCount: 0, kakaoPendingCount: 3 });
  assert.equal(only.title, "오늘 확인할 일: 카카오 접수 대기 3건");
  assert.equal(only.message, "[카카오 접수 대기] 3건");
  assert.equal(only.linkUrl, "/admin/kakao-requests");
  // 0건이면 줄을 만들지 않고, 그것만 있으면 알림 자체가 없다
  assert.equal(buildAdminDailyDigest({ todayYmd: "2026-10-08", unpaid: [], needsCheckCount: 0, pendingChangeCount: 0, kakaoPendingCount: 0 }), null);
  const mixed = buildAdminDailyDigest({ todayYmd: "2026-10-08", unpaid: [], needsCheckCount: 0, pendingChangeCount: 2, kakaoPendingCount: 0 });
  assert.doesNotMatch(mixed.message, /카카오/);
  // 더 급한 할 일이 있으면 링크는 그쪽(변경 승인 대기)
  const both = buildAdminDailyDigest({ todayYmd: "2026-10-08", unpaid: [], needsCheckCount: 0, pendingChangeCount: 1, kakaoPendingCount: 2 });
  assert.equal(both.title, "오늘 확인할 일: 변경 승인 대기 1건 · 카카오 접수 대기 2건");
  assert.equal(both.linkUrl, "/admin/enrollment-changes");
  // 예전 호출(카카오 값 없음)도 그대로 동작
  assert.equal(buildAdminDailyDigest({ todayYmd: "2026-10-08", unpaid: [], needsCheckCount: 0, pendingChangeCount: 0 }), null);
});

test("카카오 접수 대기는 원장 확인이 필요한 상태만 센다", () => {
  assert.match(service, /FROM "KakaoParentIntake" WHERE status IN \('SUBMITTED', 'HELD', 'FAILED'\)/);
  assert.match(service, /kakaoPendingCount \}\)/);
});

test("받는 사람은 원장·부원장 계정뿐 — 학부모·코치 대상 조회가 없다", () => {
  assert.match(service, /role IN \('ADMIN', 'VICE_ADMIN'\)/);
  assert.doesNotMatch(service, /PARENT|parentPhone|"Coach"|sendParentSms/);
});

test("문자(SMS)를 쓰지 않는다 — 앱 알림+푸시 통로만", () => {
  assert.match(service, /createNotificationRecord\(/);
  assert.doesNotMatch(service, /notifyAdmins|sendSms|renderSmsTemplate|smsOptions|solapi/i);
});

test("같은 KST 날짜에 두 번 보내지 않는다", () => {
  assert.match(service, /\("createdAt" AT TIME ZONE 'Asia\/Seoul'\)::date = \(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/);
  assert.match(service, /skippedDuplicate \+= 1;\s*continue;/);
});

test("미납 납부기한(시간대 없는 컬럼)은 UTC→KST 두 번 변환한다", () => {
  assert.match(service, /\(\("dueDate" AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Seoul'\)/);
  assert.match(service, /status IN \('PENDING', 'OVERDUE'\)/);
});

test("크론은 CRON_SECRET 으로 막고, 매일 KST 08:30 에 등록돼 있다", () => {
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /`Bearer \$\{secret\}`/);
  assert.match(route, /dynamic = "force-dynamic"/);
  const cron = vercel.crons.find((c) => c.path === "/api/cron/admin-daily-digest");
  assert.ok(cron, "vercel.json 에 크론이 없습니다");
  assert.equal(cron.schedule, "30 23 * * *");
});
