// 휴원 복귀 학생의 청구(2026-11-17)
// - 복귀 예약: 수강은 복귀일까지 PAUSED 라, 청구 조회가 예약을 ACTIVE + 개시일=복귀일로 바꿔 읽어야 다음 달 초안에 들어간다.
// - 이미 적용된 달 가운데 복귀: 크론은 Enrollment.startsOn 을 바꾸지 않으므로, 청구 조회에서만 그 달 안 복귀일로 개시일을 늦춘다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("src/lib/billing/workbench-service.ts", "utf8");
const model = await readFile("src/lib/billing/workbench.ts", "utf8");

test("청구 조회는 공용 복귀 규칙(resumeFromSql)을 쓴다 — 따로 만든 판정 금지", () => {
  assert.match(source, /import \{ resumeFromSql \} from "@\/lib\/enrollment\/resumeWindow";/);
  assert.match(source, /const resumeBooked = resumeFromSql\("e"\);/);
});

test("복귀 예약이 있으면 상태는 ACTIVE, 개시일은 복귀일과 원래 개시일 중 늦은 날", () => {
  assert.match(source, /CASE WHEN \$\{resumeBooked\} IS NOT NULL THEN 'ACTIVE' ELSE e\.status END AS status/);
  assert.match(source, /GREATEST\(e\."startsOn", \(\$\{resumeFrom\}\)::date\)::text AS "startsOn"/);
  assert.ok(source.includes("const resumeFrom = `COALESCE(${resumeBooked}, ${resumeApplied})`;"));
});

test("이미 적용된 복귀: 이 달 1일 뒤·다니는 중·같은 달 휴원 없음·그 달 청구 없음일 때만", () => {
  assert.ok(source.includes(`WHERE e.status = 'ACTIVE' AND ra."enrollmentId" = e.id AND ra.kind = 'RESUME' AND ra.status = 'APPLIED'`));
  assert.ok(source.includes(`ra."effectiveFrom" > \${monthStart} AND ra."effectiveFrom" < (\${monthStart} + interval '1 month')`));
  assert.ok(source.includes(`pz.kind = 'PAUSE' AND pz.status = 'APPLIED' AND pz."effectiveFrom" > \${monthStart} AND pz."effectiveFrom" < ra."effectiveFrom"`));
  assert.ok(source.includes(`py.year = \${year} AND py.month = \${monthNumber} AND py.status NOT IN ('CANCELED','CANCELLED') AND py.type <> 'UNIFORM'`));
});

test("복귀가 없는 행은 resumeFrom 칸을 지워 원본 지문을 예전과 같게 둔다", () => {
  assert.match(source, /for \(const e of enrollments\) if \(e\.resumeFrom == null\) delete e\.resumeFrom;/);
});

test("근거에 복귀일을 남기고, 첫 청구는 검토 사유로 일괄 발행에서 뺀다", () => {
  assert.match(source, /basis\.push\(`휴원 복귀 \$\{e\.resumeFrom\}`\)/);
  assert.match(source, /if \(!excluded\) reviewReasons\.push\(`휴원 복귀\(\$\{e\.resumeFrom\}\)/);
  // 일반 검토 사유가 아닌 사유가 있으면 자동 초안·일괄 발행 대상이 아니다(workbench.ts 판정)
  assert.match(model, /return row\.reviewReasons\.length > 0 && row\.reviewReasons\.every\(\(reason\) => reason === WORKBENCH_GENERIC_REVIEW_REASON\);/);
});
