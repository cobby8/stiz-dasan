import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 2026-10-02 셔틀 명단 월 자동 생성 — "항상 한 달치가 먼저 생성되어 있어야 다음 달 수강 변경을 미리 반영할 수 있다"(원장).
// 크론·화면 진입·편집 적용 범위 연결이 빠져도 아무 신호가 없으므로 소스 수준에서 못박는다.
const lib = readFileSync("src/lib/shuttle/regularRosterEdit.ts", "utf8");
const cron = readFileSync("src/app/api/cron/regular-shuttle-months/route.ts", "utf8");
const rosterPage = readFileSync("src/app/admin/shuttle/regular/page.tsx", "utf8");
const dispatchPage = readFileSync("src/app/admin/shuttle/regular-dispatch/page.tsx", "utf8");
const client = readFileSync("src/app/admin/shuttle/regular/RegularShuttleClient.tsx", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));

test("크론은 CRON_SECRET 으로 인증하고 매일 KST 00:05(UTC 15:05)에 돈다", () => {
  assert.match(cron, /process\.env\.CRON_SECRET/);
  assert.match(cron, /authorization"\) !== `Bearer \$\{secret\}`/);
  assert.match(cron, /status: 401/);
  assert.match(cron, /ensureRegularRosterMonths\(\)/);
  const job = vercel.crons.find((c) => c.path === "/api/cron/regular-shuttle-months");
  assert.ok(job, "vercel.json 에 크론이 등록돼야 합니다.");
  assert.equal(job.schedule, "5 15 * * *");
});

test("셔틀 명단·정규 배차 화면은 진입 시 월을 보장하되 실패해도 화면을 띄운다", () => {
  for (const page of [rosterPage, dispatchPage]) {
    assert.match(page, /try \{ await ensureRegularRosterMonths\(\); \} catch/);
  }
});

test("자동 생성은 KST 이번 달 기준·멱등·잠금·변경 기록을 지킨다", () => {
  assert.match(lib, /koreaServiceMonth\(now\)/);
  assert.match(lib, /planEnsureMonths\(months, currentMonth\)/);
  assert.match(lib, /monthRowCount\(tx, step\.targetMonth\) > 0\) return null/);
  assert.match(lib, /"REGULAR_ROSTER_AUTO_MONTH"/);
  assert.match(lib, /audit\(tx, null, "REGULAR_ROSTER_AUTO_MONTH"/);
  assert.match(lib, /regular-roster:\*/);
  // ORM 기본 메서드 금지(PgBouncer)
  assert.doesNotMatch(lib, /prisma\.regularShuttleStop|tx\.regularShuttleStop|\.regularDispatchRoute\.|\.shuttleAuditLog\./);
});

test("월 복사는 저장 노선도 대상 달에 없을 때만 복사하고 이름만 등록 행 식별값을 새 id 로 바꾼다", () => {
  assert.match(lib, /INSERT INTO "RegularDispatchRoute"/);
  assert.match(lib, /ON CONFLICT \("serviceMonth","dayOfWeek","direction"\) DO NOTHING/);
  assert.match(lib, /remapStopRowIds\(r\.payload, idMap\)/);
});

test("편집 5종은 적용 범위(기본 이후 달까지)를 받고 결과에 반영 달을 돌려준다", () => {
  // 2026-10-02: 기사님 화면 순서·시각 편집(reorderRosterStops) 추가로 4종 → 5종.
  for (const fn of ["addRosterStudent", "removeRosterRows", "moveRosterRows", "editRosterStop", "reorderRosterStops"]) {
    assert.match(lib, new RegExp(`export async function ${fn}\\(raw: unknown\\): Promise<\\{ \\w+: number \\} & RosterScopeResult>`));
  }
  assert.equal((lib.match(/await lockForEdit\(tx, input\.serviceMonth, input\.scope\)/g) ?? []).length, 5);
  // 화면: 모달마다 범위 선택, 기본값 FROM_THIS_MONTH, 결과 문구에 반영 달
  assert.match(client, /이 달부터 계속 적용\(기본\)/);
  assert.match(client, /"이 달만"|label: "이 달만"/);
  assert.equal((client.match(/scope: defaultScope/g) ?? []).length, 4);
  // 지난 달을 고칠 때만 기본 「이 달만」
  assert.match(client, /defaultScope: RosterScope = serviceMonth < currentMonth \? "THIS_MONTH" : "FROM_THIS_MONTH"/);
  assert.equal((client.match(/\{scopeFields\(dialog\.scope\)\}/g) ?? []).length, 4);
  assert.match(client, /에 반영/);
});

test("자동 생성되므로 「다음 달 명단 만들기」 버튼은 없고, 빈 달의 직전 달 복사만 남는다", () => {
  assert.doesNotMatch(client, /다음 달 명단 만들기/);
  assert.match(client, /명단 복사해 오기/);
});

test("따라잡기 생성은 그 달 날짜의 정규 탑승체크·처리 전 제외 요청을 새 행 id 로 옮기고 건수를 기록한다", () => {
  assert.match(lib, /catchUpDateRange\(targetMonth, currentMonth\)/);
  assert.match(lib, /UPDATE "ShuttleBoarding" b SET "shuttleRequestId"=m\."newId"/);
  assert.match(lib, /b\."direction"='REGULAR'/);
  assert.match(lib, /UPDATE "DriverRequest" r SET "targetId"=m\."newId"/);
  assert.match(lib, /r\."status"='PENDING'/);
  assert.match(lib, /unnest\(\$1::text\[\], \$2::text\[\]\)/);
  assert.match(lib, /copyMonthInTx\(tx, step\.sourceMonth, step\.targetMonth, currentMonth\)/);
  // 반이동 감사 로그에 이후 달 행도 남긴다
  assert.match(lib, /laterRows: laterUpdates/);
});
