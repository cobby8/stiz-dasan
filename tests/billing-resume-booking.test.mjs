// 휴원 «복귀 예약» 학생이 다음 달 청구 초안에 들어가는지(2026-11-17)
// 수강은 복귀일까지 PAUSED 라, 청구 조회가 복귀 예약을 ACTIVE + 개시일=복귀일로 바꿔 읽어야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("src/lib/billing/workbench-service.ts", "utf8");

test("청구 조회는 공용 복귀 규칙(resumeFromSql)을 쓴다 — 따로 만든 판정 금지", () => {
  assert.match(source, /import \{ resumeFromSql \} from "@\/lib\/enrollment\/resumeWindow";/);
  assert.match(source, /const resumeFrom = resumeFromSql\("e"\);/);
});

test("복귀 예약이 있으면 상태는 ACTIVE, 개시일은 복귀일과 원래 개시일 중 늦은 날", () => {
  assert.match(source, /CASE WHEN \$\{resumeFrom\} IS NOT NULL THEN 'ACTIVE' ELSE e\.status END AS status/);
  assert.match(source, /GREATEST\(e\."startsOn", \(\$\{resumeFrom\}\)::date\)::text AS "startsOn"/);
});

test("복귀 예약이 없는 행은 resumeFrom 칸을 지워 원본 지문을 예전과 같게 둔다", () => {
  assert.match(source, /for \(const e of enrollments\) if \(e\.resumeFrom == null\) delete e\.resumeFrom;/);
});

test("근거에 복귀 예약일을 남기고, 첫 청구는 검토 사유로 일괄 발행에서 뺀다", async () => {
  assert.match(source, /basis\.push\(`휴원 복귀 예약 \$\{e\.resumeFrom\}`\)/);
  assert.match(source, /if \(!excluded\) reviewReasons\.push\(`휴원 복귀 예약\(\$\{e\.resumeFrom\}\)/);
  // 일반 검토 사유가 아닌 사유가 있으면 자동 초안·일괄 발행 대상이 아니다(workbench.ts 판정)
  const model = await readFile("src/lib/billing/workbench.ts", "utf8");
  assert.match(model, /return row\.reviewReasons\.length > 0 && row\.reviewReasons\.every\(\(reason\) => reason === WORKBENCH_GENERIC_REVIEW_REASON\);/);
});
