import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// 순수 판정 모듈은 import 가 없으므로 그대로 변환해 실제로 실행한다.
const rulesSource = readFileSync("src/lib/seasonal/auto-end-rules.ts", "utf8");
const transpiled = ts.transpileModule(rulesSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { decideSeasonalClassEnd } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const service = readFileSync("src/lib/seasonal/auto-end.ts", "utf8");
const route = readFileSync("src/app/api/cron/seasonal-enrollments/route.ts", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
const code = stripComments(service);

const TODAY = "2026-10-05";

/* ---------------- 순수 판정: decideSeasonalClassEnd ---------------- */

test("마지막 회차가 어제면 끝난 것으로 본다", () => {
  assert.deepEqual(decideSeasonalClassEnd(["2026-10-04"], TODAY), { ended: true, lastYmd: "2026-10-04" });
});

test("마지막 회차가 오늘이면 아직 수업이 있으므로 처리하지 않는다", () => {
  assert.equal(decideSeasonalClassEnd([TODAY], TODAY).ended, false);
});

test("마지막 회차가 내일이면 처리하지 않는다", () => {
  assert.equal(decideSeasonalClassEnd(["2026-10-06"], TODAY).ended, false);
});

test("같은 반을 쓰는 여러 특강 중 하나라도 미래 회차가 있으면 보호한다", () => {
  const d = decideSeasonalClassEnd(["2026-08-20", "2027-01-10"], TODAY);
  assert.equal(d.ended, false);
  assert.equal(d.lastYmd, "2027-01-10");
});

test("여러 특강이 모두 끝났으면 가장 늦은 날짜를 기준으로 끝난 것으로 본다", () => {
  assert.deepEqual(
    decideSeasonalClassEnd(["2026-01-30", "2026-08-21", "2026-07-31"], TODAY),
    { ended: true, lastYmd: "2026-08-21" },
  );
});

test("연결된 특강(회차·시즌 정보)이 없으면 건드리지 않는다", () => {
  assert.deepEqual(decideSeasonalClassEnd([], TODAY), { ended: false, lastYmd: null });
});

test("날짜를 모르는 특강이 하나라도 있으면 건드리지 않는다", () => {
  assert.equal(decideSeasonalClassEnd(["2026-08-01", null], TODAY).ended, false);
  assert.equal(decideSeasonalClassEnd(["2026-08-01", ""], TODAY).ended, false);
});

test("오늘 날짜가 잘못되면 판정하지 않는다", () => {
  assert.equal(decideSeasonalClassEnd(["2026-08-01"], "").ended, false);
});

test("연말 경계: 12-31 마지막 회차는 다음 해 1-1 에 처리된다", () => {
  assert.equal(decideSeasonalClassEnd(["2026-12-31"], "2026-12-31").ended, false);
  assert.equal(decideSeasonalClassEnd(["2026-12-31"], "2027-01-01").ended, true);
});

/* ---------------- 소스 검사: 안전장치 ---------------- */

test("특강 전용 반(dayOfWeek='Seasonal')만 대상으로 한다 — 정규반 보호", () => {
  assert.match(code, /c\."dayOfWeek"\s*=\s*'Seasonal'/);
});

test("UPDATE 는 기대 상태 조건으로 동시성을 보호하고, 성공한 건만 이력을 남긴다", () => {
  assert.match(code, /UPDATE "Enrollment" SET status = 'WITHDRAWN'[\s\S]*?WHERE id = \$1 AND status = \$2[\s\S]*?RETURNING id/);
  assert.match(code, /if \(updated\.length === 0\) return false;[\s\S]*INSERT INTO "EnrollmentChangeRequest"/);
  assert.match(code, /'WITHDRAW'[\s\S]*'APPLIED'/);
});

test("ACTIVE·PAUSED 만 대상이다", () => {
  assert.match(code, /e\.status IN \('ACTIVE','PAUSED'\)/);
});

test("timestamptz 회차 날짜는 AT TIME ZONE 을 한 번만 걸어 KST 날짜로 만든다", () => {
  assert.match(code, /to_char\(ol\."lastAt" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\)/);
  assert.doesNotMatch(code, /AT TIME ZONE 'UTC'\)\s*AT TIME ZONE/);
});

test("날짜는 공용 kst 모듈로만 구하고, ORM 기본 메서드를 쓰지 않는다", () => {
  assert.match(service, /from "@\/lib\/datetime\/kst"/);
  assert.doesNotMatch(code, /prisma\.\w+\.(findMany|findFirst|update|updateMany|create|upsert)\(/);
  assert.doesNotMatch(code, /tx\.\w+\.(findMany|findFirst|update|updateMany|create|upsert)\(/);
});

test("운영 원장(operations events) 적재는 하지 않는다", () => {
  assert.doesNotMatch(code, /OperationsEvent|operations-events|OperationsRequest/);
});

test("크론 라우트는 CRON_SECRET Bearer 로 보호되고 동적 실행이다", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /`Bearer \$\{secret\}`/);
  assert.match(route, /endFinishedSeasonalEnrollments\(\)/);
});

test("vercel.json 에 매일 KST 00:20(UTC 15:20) 으로 등록돼 있고 다른 크론과 시각이 겹치지 않는다", () => {
  const entry = vercel.crons.find((c) => c.path === "/api/cron/seasonal-enrollments");
  assert.ok(entry, "seasonal-enrollments 크론이 등록되지 않았다");
  assert.equal(entry.schedule, "20 15 * * *");
  const same = vercel.crons.filter((c) => c.schedule === "20 15 * * *");
  assert.equal(same.length, 1);
});
