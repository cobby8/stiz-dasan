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
  href: string;
  createdAt: string; // ISO(화면에서 KST 로 표시)
  /** 시작 달(없으면 이번 달, KST) 명단에 이 학생 행이 이미 있는지 — 있으면 «완료»만 누르면 된다. */
  inRoster: boolean;
};

const OPEN_SQL = SHUTTLE_ROSTER_TASK_OPEN_STATUSES.map((s) => `'${s}'`).join(",");

export async function getOpenKakaoShuttleRosterTasks(): Promise<KakaoShuttleRosterTaskItem[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string; kind: string; status: string; studentId: string | null; structuredJson: unknown; createdAt: Date; studentName: string | null; inRoster: boolean;
  }>>(
    // 시작 달: 신청 시작일의 'YYYY-MM', 없으면 KST 이번 달(now() 는 timestamptz 라 AT TIME ZONE 한 번).
    `SELECT r.id, r.kind, r.status, r."studentId", r."structuredJson", r."createdAt", s.name AS "studentName",
            EXISTS (
              SELECT 1 FROM "RegularShuttleStop" x
               WHERE x."studentId"=r."studentId"
                 AND x."serviceMonth"=COALESCE(
                       NULLIF(substr(r."structuredJson"->'regularShuttle'->>'effectiveDate',1,7),''),
                       NULLIF(substr(r."structuredJson"->>'effectiveDate',1,7),''),
                       to_char(now() AT TIME ZONE 'Asia/Seoul','YYYY-MM'))
            ) AS "inRoster"
       FROM "KakaoParentIntake" r
       -- 병합으로 흡수된 학생이면 이름이 비어 «학생 확인 필요»로 보인다(할 일은 사라지지 않게 LEFT JOIN).
       LEFT JOIN "Student" s ON s.id=r."studentId" AND s."mergedIntoStudentId" IS NULL
      WHERE r.kind='SHUTTLE_START_STOP' AND r.status IN (${OPEN_SQL}) AND r."studentId" IS NOT NULL
        AND (r."structuredJson"->'rosterTask'->>'doneAt') IS NULL
      ORDER BY r."createdAt" ASC
      LIMIT 50`,
  );
  return rows
    .filter((r) => isShuttleRosterTask(r)) // 신청(START)만 — 중단(STOP)은 이 할 일이 아니다
    .map((r) => ({
      intakeId: String(r.id),
      studentId: String(r.studentId),
      studentName: r.studentName ?? "학생 확인 필요",
      status: r.status,
      summary: shuttleRosterTaskSummary(r.structuredJson),
      href: shuttleRosterTaskHref(String(r.studentId), r.structuredJson),
      createdAt: new Date(r.createdAt).toISOString(),
      inRoster: Boolean(r.inRoster),
    }));
}
