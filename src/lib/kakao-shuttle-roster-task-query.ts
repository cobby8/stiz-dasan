import "server-only";
import { prisma } from "@/lib/prisma";
import {
  isShuttleRosterTask,
  shuttleRosterTaskHref,
  shuttleRosterTaskSummary,
  SHUTTLE_ROSTER_TASK_OPEN_STATUSES,
} from "@/lib/kakaoShuttleRosterTask";

// 원장 할 일 «셔틀 명단에 넣어 주세요» 목록 조회(읽기 전용).
// 카카오 정규 셔틀 신청(START) 중 아직 명단 반영 표시가 없는 접수. 판정 규칙은 순수 함수(kakaoShuttleRosterTask)가 정한다.
// PgBouncer 트랜잭션 모드라 $queryRawUnsafe 만 쓴다.

export type KakaoShuttleRosterTaskItem = {
  intakeId: string;
  studentId: string;
  studentName: string;
  status: string;
  summary: string;
  /** 명단 화면 주소(병합된 학생이면 병합 후 학생 기준). 명단에 넣을 학생을 못 찾으면 null — «명단에 넣기» 버튼을 숨긴다. */
  href: string | null;
  createdAt: string; // ISO(화면에서 KST 로 표시)
  /** 시작 달(없으면 이번 달, KST) 명단에 이 학생 행이 이미 있는지 — 있으면 «완료»만 누르면 된다. */
  inRoster: boolean;
};

const OPEN_SQL = SHUTTLE_ROSTER_TASK_OPEN_STATUSES.map((s) => `'${s}'`).join(",");

export async function getOpenKakaoShuttleRosterTasks(): Promise<KakaoShuttleRosterTaskItem[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string; kind: string; status: string; studentId: string | null; rosterStudentId: string | null; structuredJson: unknown; createdAt: Date; studentName: string | null; inRoster: boolean;
  }>>(
    // 명단 대상 학생(rosterStudentId): 접수 학생이 그대로 살아 있으면 그 학생, 병합으로 흡수됐으면 병합 후 학생.
    // 병합 후 학생을 못 찾거나(또는 그 학생도 다시 흡수됨) 접수 학생 행이 없으면 NULL → 버튼 숨김.
    // 시작 달: 신청 시작일의 'YYYY-MM', 없으면 KST 이번 달(now() 는 timestamptz 라 AT TIME ZONE 한 번).
    `SELECT t.*,
            t."rosterStudentId" IS NOT NULL AND EXISTS (
              SELECT 1 FROM "RegularShuttleStop" x
               WHERE x."studentId"=t."rosterStudentId"
                 AND x."serviceMonth"=COALESCE(
                       NULLIF(substr(t."structuredJson"->'regularShuttle'->>'effectiveDate',1,7),''),
                       NULLIF(substr(t."structuredJson"->>'effectiveDate',1,7),''),
                       to_char(now() AT TIME ZONE 'Asia/Seoul','YYYY-MM'))
            ) AS "inRoster"
       FROM (
         SELECT r.id, r.kind, r.status, r."studentId", r."structuredJson", r."createdAt",
                COALESCE(s.name, m.name) AS "studentName",
                COALESCE(s.id, m.id) AS "rosterStudentId"
           FROM "KakaoParentIntake" r
           -- 살아 있는 접수 학생(흡수된 학생이면 붙지 않는다). 할 일은 사라지지 않게 LEFT JOIN.
           LEFT JOIN "Student" s ON s.id=r."studentId" AND s."mergedIntoStudentId" IS NULL
           -- 흡수된 접수 학생 → 병합 후 학생(그 학생도 살아 있을 때만).
           LEFT JOIN "Student" o ON o.id=r."studentId" AND o."mergedIntoStudentId" IS NOT NULL
           LEFT JOIN "Student" m ON m.id=o."mergedIntoStudentId" AND m."mergedIntoStudentId" IS NULL
          WHERE r.kind='SHUTTLE_START_STOP' AND r.status IN (${OPEN_SQL}) AND r."studentId" IS NOT NULL
            AND (r."structuredJson"->'rosterTask'->>'doneAt') IS NULL
          ORDER BY r."createdAt" ASC
          LIMIT 50
       ) t
      ORDER BY t."createdAt" ASC`,
  );
  return rows
    .filter((r) => isShuttleRosterTask(r)) // 신청(START)만 — 중단(STOP)은 이 할 일이 아니다
    .map((r) => ({
      intakeId: String(r.id),
      studentId: String(r.studentId),
      studentName: r.studentName ?? "학생 확인 필요",
      status: r.status,
      summary: shuttleRosterTaskSummary(r.structuredJson),
      // 명단 화면·명단 판정은 병합 후 학생 id 기준(흡수된 학생 id 로는 명단 추가가 막힌다)
      href: r.rosterStudentId ? shuttleRosterTaskHref(String(r.rosterStudentId), r.structuredJson) : null,
      createdAt: new Date(r.createdAt).toISOString(),
      inRoster: Boolean(r.inRoster),
    }));
}
