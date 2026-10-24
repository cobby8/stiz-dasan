type Attempt = { target: string; status: string; verifiedAt: Date | string | null };

/**
 * 한 칸(시도)이 "끝났다"고 볼 SQL 조건(별칭 a). 아래 TS 판정(isAttemptDone)과 **반드시 같은 규칙**이어야 한다.
 * - 보통 칸: 성공(SUCCEEDED) + 재조회 시각(verifiedAt) 있음
 * - SHEET 칸: 위에 더해, 시트 은퇴로 건너뜀(SKIPPED)도 통과(재조회 시각 불필요 — 확인할 시트가 없다)
 * tests/sheet-retirement.test.mjs 가 이 문자열을 실제로 실행해 TS 판정과 같은 결과인지 대조한다.
 */
export const VERIFIED_SYNC_TARGET_SQL =
  `((a.status='SUCCEEDED' AND a."verifiedAt" IS NOT NULL) OR (a.target='SHEET' AND a.status='SKIPPED'))`;

/**
 * 한 칸이 끝났는가(TS 판정). SKIPPED 는 SHEET 칸에서만 인정한다.
 * (이 파일은 테스트가 단독으로 불러오므로 import 없이 적는다 — 공용 isSheetTargetDone 과 같은 규칙.)
 */
function isAttemptDone(attempt: Attempt): boolean {
  if (attempt.target === "SHEET" && attempt.status === "SKIPPED") return true;
  return attempt.status === "SUCCEEDED"
    && attempt.verifiedAt !== null
    && Number.isFinite(new Date(attempt.verifiedAt).getTime());
}

/** 세 장부가 모두 끝나야 완료다(시트는 은퇴로 건너뜀도 끝난 것으로 본다). */
export function hasVerifiedSyncTargets(attempts: Attempt[]): boolean {
  return attempts.length === 3 && ["SHEET", "RALLYZ", "WEBSITE"].every(target => {
    const matching = attempts.filter(attempt => attempt.target === target);
    return matching.length === 1 && isAttemptDone(matching[0]);
  });
}

type Transaction = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/** 기존 동기화 거래 안에서만 실행한다. 불일치·미지원 반 변경은 완료로 만들지 않는다. */
export async function finalizeEnrollmentChangeSync(tx: Transaction, commandId: string) {
  const completed = await tx.$queryRawUnsafe<Array<{ id: string; requestId: string }>>(
    `WITH verified AS (
       SELECT r.id, c."requestId"
         FROM "OperationsCommand" c
         JOIN "OperationsRequest" o ON o.id=c."requestId"
         JOIN "EnrollmentChangeRequest" r ON r.id=c."afterJson"->>'enrollmentChangeRequestId'
         JOIN "Enrollment" e ON e.id=r."enrollmentId"
        WHERE c.id=$1 AND c.status='SYNCED' AND c."holdReason" IS NULL AND o."approvedAt" IS NOT NULL
          AND r.status='APPROVED' AND r."appliedAt" IS NULL
          AND c."idempotencyKey"='enrollment-change:' || r.id
          AND c."studentId"=r."studentId" AND e."studentId"=r."studentId"
          AND c.kind=r.kind AND c.kind IN ('PAUSE','WITHDRAW')
          AND c."afterJson"->>'parentConfirmed'='true'
          AND c."afterJson"->>'effectiveDate'=to_char(r."effectiveFrom",'YYYY-MM-DD')
          AND c."effectiveMonth"=to_char(r."effectiveFrom",'YYYY-MM')
          AND r."effectiveFrom" <= (now() AT TIME ZONE 'Asia/Seoul')::date
          AND c."afterJson"->>'fromClassId'=r."fromClassId"
          AND (c."afterJson"->>'toClassId') IS NOT DISTINCT FROM r."toClassId"
          AND e."classId"=r."fromClassId"
          AND e.status=CASE r.kind WHEN 'PAUSE' THEN 'PAUSED' ELSE 'WITHDRAWN' END
          AND (SELECT count(*) FROM "OperationsSyncAttempt" a WHERE a."commandId"=c.id)=3
          AND (SELECT count(DISTINCT a.target) FROM "OperationsSyncAttempt" a
                WHERE a."commandId"=c.id AND a.target IN ('SHEET','RALLYZ','WEBSITE')
                  AND ${VERIFIED_SYNC_TARGET_SQL}
                  AND a."processingToken" IS NULL AND a."processingStartedAt" IS NULL)=3
        FOR UPDATE OF r, e
     )
     UPDATE "EnrollmentChangeRequest" r SET "appliedAt"=now(),"updatedAt"=now()
       FROM verified v WHERE r.id=v.id AND r."appliedAt" IS NULL
       RETURNING r.id, v."requestId"`, commandId,
  );
  for (const row of completed) {
    // 완료 표시와 감사기록을 하나의 거래로 묶어 어느 한쪽만 남지 않게 한다.
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","detailsJson")
       VALUES (gen_random_uuid()::text,$1,'ENROLLMENT_CHANGE_SYNC_COMPLETED','SYSTEM',$2::jsonb)`,
      row.requestId, JSON.stringify({ enrollmentChangeRequestId: row.id, commandId, notificationsSent: false }),
    );
  }
  return completed.length;
}
