import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 원장 지시(2026-10-03): 「셔틀 명단 → 학생 추가」는 현재 운행표를 보면서 자리를 고른다.
// 실제 위치 계산·삽입은 src/lib/shuttle/regularRosterPlacementLogic.test.ts 가 실행으로 검증하고,
// 여기서는 화면·서버가 그 계산을 «한 벌만» 쓰는지와 안전 장치를 소스로 못박는다.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const panel = read("src/app/admin/shuttle/regular/AddRiderRoutePanel.tsx");
const client = read("src/app/admin/shuttle/regular/RegularShuttleClient.tsx");
const logic = read("src/lib/shuttle/regularRosterPlacementLogic.ts");
const lib = read("src/lib/shuttle/regularRosterEdit.ts");
const route = read("src/app/api/admin/shuttle/regular-roster/route.ts");

test("운행표는 기사님 화면과 같은 함수로 그리고, 화면·저장이 같은 계산(resolveCellPlacement)을 쓴다", () => {
  assert.match(logic, /buildFallbackClasses\(selectDriverDayRows\(stops, weekday\), NOT_ABSENT\)/);
  assert.match(logic, /import \{ distanceMeters \} from "\.\.\/seasonal\/stopMerge\.ts"/); // 거리 함수 새로 만들지 않음
  assert.match(panel, /resolveCellPlacement\(/);
  assert.match(client, /resolveCellPlacement\(/);
  assert.match(client, /<AddRiderRoutePanel/);
});

test("학생 추가 저장은 삽입 계획(planRosterInsert)으로 요일 전체를 함께 밀고, 이후 달은 대응 행 기준", () => {
  assert.match(lib, /planRosterInsert\(buildAddRows\(input, existing, studentName\), input\.placements, existing\)/);
  assert.match(lib, /mapPlacementsToMonth\(input\.placements, existing, laterRows\)/);
  // 밀기는 그 달·그 요일로만 한정
  assert.match(lib, /SET "sortOrder"="sortOrder"\+1 WHERE "serviceMonth"=\$1 AND "weekday"=\$2 AND "sortOrder">=\$3/);
  assert.match(lib, /endPlacedMonths/);
  // 칸 안 번호 겹침 벌리기(spread)는 행 id·그 달로만 한정, 겹친 행 순서는 명단 조회에서 id 바이트 순으로 고정
  assert.match(lib, /SET "sortOrder"=\$1 WHERE "id"=\$2 AND "serviceMonth"=\$3/);
  assert.match(read("src/lib/shuttle/regularImport.ts"), /ORDER BY "weekday" ASC, "sortOrder" ASC, "id" COLLATE "C" ASC/);
  // 합류는 시각을 보내지 않는다(서버가 대상 정차 시각 복사)
  assert.match(client, /res\.request\.mode === "JOIN" \? base : \{ \.\.\.base, arriveTime: res\.arriveTime \}/);
  assert.match(client, /endPlacedMonths/);
});

test("학생 정보 불러오기는 관리자 전용 조회 — 다니는·휴원 수강(퇴원 제외), 병합 학생 제외", () => {
  assert.match(route, /getRosterStudentContext\(params\.get\("studentId"\)/);
  assert.match(lib, /export async function getRosterStudentContext\(rawStudentId: unknown\): Promise<RosterStudentContext> \{\s+await requireAdmin\(\);/);
  // 복귀 직전 휴원생을 미리 배정할 수 있게 PAUSED 까지(2026-10-03 운영 실측), 화면은 휴원을 미리 체크하지 않는다.
  assert.match(lib, /e\."status" IN \('ACTIVE','PAUSED'\)/);
  assert.match(client, /filter\(\(o\) => !o\.paused\)/);
  assert.match(client, /휴원 중인 수업이 있습니다 — 복귀할 수업을 눌러 고르세요/);
  assert.match(lib, /WHERE s\."id"=\$1 AND s\."mergedIntoStudentId" IS NULL/);
});
