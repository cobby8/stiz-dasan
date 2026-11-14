// 질병·부상 결석 증빙 사진 — «누가 무엇을 할 수 있나»를 SQL 로 확인하는 곳(원장 결정 a6).
//
//   · 올리기·지우기: 그 아이의 보호자(childAccessSql) + 검토 중 + 결석일(더 늦게 알렸으면 알린 날)부터 7일 안 + 3장까지
//   · 열어 보기: 관리자, 그리고 «올린 학부모 본인»(같은 가정의 다른 보호자도 사진 자체는 열지 못한다 — 장수만 보인다)
//
// DB 는 인자(db)로만 받는다 — 테스트가 가짜 db 로 권한 조건을 실제 실행해 본다.
// accessSql 은 호출부가 childAccessSql("s", "$1") 로 만든 조각이다($1 = 로그인한 학부모 계정).
import { notMergedStudent } from "@/lib/studentVisibility";
import { ILLNESS_REASON, canAddEvidence, canEditEvidence, EVIDENCE_MAX_PHOTOS } from "@/lib/regular/illnessCarryRules";

export type EvidenceDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** 결석 한 건의 사진 올리기를 줄 세우는 잠금(검토 줄 한 행). 반드시 거래 안에서, 장수를 세기 «전»에 따로 실행한다 */
export const EVIDENCE_LOCK_SQL = `SELECT 1 AS locked FROM "RegularAbsenceCarryReview" WHERE "absenceId" = $1 FOR UPDATE`;

export type EvidenceTarget = { absenceId: string; status: string; requestedYmd: string; absenceYmd: string; todayYmd: string; photoCount: number };

/** 학부모가 사진을 올리려는 결석 — 내 아이의 살아 있는 질병·부상 결석이고 검토 줄이 있을 때만 */
export async function findEvidenceTargetForParent(
  db: EvidenceDb, accessSql: string, parentUserId: string, absenceId: string, lock = false,
): Promise<EvidenceTarget | null> {
  // 잠금은 «따로 한 문장»으로 먼저 잡는다(보안 검수 2026-11-14).
  // 잠금(FOR UPDATE)과 장수 세기(COUNT)가 한 문장이면, READ COMMITTED 에서 기다리던 쪽이 «기다리기 전»에 센 장수를
  // 그대로 써서 동시에 올린 사진이 3장 제한을 넘는다. 잠금을 얻은 «뒤»의 새 문장은 앞 거래가 확정한 사진까지 센다.
  if (lock) await db.$queryRawUnsafe(EVIDENCE_LOCK_SQL, absenceId);
  const rows = await db.$queryRawUnsafe<EvidenceTarget[]>(
    `SELECT ra.id AS "absenceId", r.status,
            to_char(r."requestedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "requestedYmd",
            to_char(ra.date, 'YYYY-MM-DD') AS "absenceYmd",
            to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "todayYmd",
            (SELECT COUNT(*)::int FROM "RegularAbsenceEvidence" e WHERE e."absenceId" = ra.id AND e."removedAt" IS NULL) AS "photoCount"
       FROM "RegularAbsence" ra
       JOIN "Student" s ON s.id = ra."studentId"
       JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = ra.id
      WHERE ${accessSql} AND ${notMergedStudent("s")}
        AND ra.id = $2 AND ra.status <> 'CANCELLED' AND ra.reason = '${ILLNESS_REASON}'
      LIMIT 1`,
    parentUserId, absenceId,
  );
  return rows[0] ? { ...rows[0], photoCount: Number(rows[0].photoCount) } : null;
}

/** 올릴 수 없으면 학부모에게 보일 이유(한국어). 올릴 수 있으면 null */
export function evidenceAddRefusal(target: EvidenceTarget): string | null {
  if (canAddEvidence(target)) return null;
  if (target.status !== "PENDING") return "이미 처리가 끝난 결석이라 사진을 올릴 수 없어요.";
  if (!canEditEvidence(target)) return "사진을 올릴 수 있는 기간(결석일부터 7일)이 지났어요.";
  return `사진은 ${EVIDENCE_MAX_PHOTOS}장까지 올릴 수 있어요. 바꾸려면 먼저 한 장을 지워 주세요.`;
}

export type EvidenceFile = { id: string; storageBucket: string; storagePath: string; absenceId: string };

/** 학부모가 열거나 지우려는 사진 — «내가 올린» 살아 있는 사진이고, 지금도 그 아이의 보호자일 때만 */
export async function findEvidenceForParent(
  db: EvidenceDb, accessSql: string, parentUserId: string, evidenceId: string,
): Promise<(EvidenceFile & { status: string; requestedYmd: string; absenceYmd: string; todayYmd: string }) | null> {
  const rows = await db.$queryRawUnsafe<Array<EvidenceFile & { status: string; requestedYmd: string; absenceYmd: string; todayYmd: string }>>(
    `SELECT e.id, e."storageBucket" AS "storageBucket", e."storagePath" AS "storagePath", e."absenceId" AS "absenceId",
            r.status,
            to_char(r."requestedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "requestedYmd",
            to_char(ra.date, 'YYYY-MM-DD') AS "absenceYmd",
            to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "todayYmd"
       FROM "RegularAbsenceEvidence" e
       JOIN "RegularAbsence" ra ON ra.id = e."absenceId"
       JOIN "Student" s ON s.id = ra."studentId"
       JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = ra.id
      WHERE ${accessSql} AND ${notMergedStudent("s")}
        AND e.id = $2 AND e."uploadedByUserId" = $1
        AND e."removedAt" IS NULL AND e."purgedAt" IS NULL
      LIMIT 1`,
    parentUserId, evidenceId,
  );
  return rows[0] ?? null;
}

/** 관리자가 여는 사진 — 살아 있는 사진이면 된다(호출부가 requireAdmin 으로 먼저 막는다) */
export async function findEvidenceForAdmin(db: EvidenceDb, evidenceId: string): Promise<EvidenceFile | null> {
  const rows = await db.$queryRawUnsafe<EvidenceFile[]>(
    `SELECT e.id, e."storageBucket" AS "storageBucket", e."storagePath" AS "storagePath", e."absenceId" AS "absenceId"
       FROM "RegularAbsenceEvidence" e
      WHERE e.id = $1 AND e."removedAt" IS NULL AND e."purgedAt" IS NULL AND e."absenceId" IS NOT NULL
      LIMIT 1`,
    evidenceId,
  );
  return rows[0] ?? null;
}
