/** 새 접수는 공통 ID를 쓰고, 이전 일괄 입력은 운영 기록과 접수 정보가 일치하는 경우만 묶는다. */
export const PAUSE_GROUP_KEY_SQL = `CASE
  WHEN x.kind = 'PAUSE' AND to_jsonb(x)->>'submissionGroupId' IS NOT NULL
  THEN json_build_array(to_jsonb(x)->>'submissionGroupId', x."studentId", x."requestedByUserId",
    x."createdAt", x."effectiveFrom", x."resumeOn", x.reason)::text
  WHEN x.kind = 'PAUSE'
    AND x."enrollmentId" IS NOT NULL AND x."fromClassId" IS NOT NULL
    AND x."decidedByUserId" = x."requestedByUserId"
    AND x."decisionNote" LIKE '[nov-class-pause-20261029]%'
  THEN json_build_array(x."studentId", x."requestedByUserId", x."createdAt",
    x."effectiveFrom", x."resumeOn", x.reason, x."decisionNote")::text
  ELSE NULL END`;

/** 상태와 날짜 필터, 목록 최대 건수를 적용하기 전에 실제 신청을 한 줄로 만든다. */
export function groupEnrollmentChangeInboxSql(
  rowSql: string,
  actionStatusesSql: string,
  ongoingStatusesSql: string,
  settlementTableReady: boolean,
): string {
  const openSettlement = settlementTableReady
    ? `WHEN raw IN ('APPROVED', 'APPLIED') AND EXISTS (
         SELECT 1 FROM "EnrollmentChangeSettlement" settlement
          WHERE settlement."requestId" = changes.id AND settlement.status = 'OPEN'
       ) THEN 'SETTLEMENT_CHECK'`
    : "";
  return `WITH source AS (
      SELECT id, "studentName", "createdAt", "targetDate", extra,
             CASE WHEN raw = 'APPROVED' AND extra->>'operationStatus' = 'HELD' THEN 'APPLY_HELD'
                  WHEN raw = 'APPLIED' AND extra->>'syncPending' = 'true' THEN 'SYNC_CHECK'
                  ${openSettlement}
                  ELSE raw END AS raw
        FROM (${rowSql}) changes
    ),
    grouped AS (
      SELECT extra->>'pauseGroupKey' AS key,
             min(id) AS "groupId",
             (array_agg(id ORDER BY CASE
               WHEN raw = ANY(${actionStatusesSql}) THEN 0
               WHEN raw = ANY(${ongoingStatusesSql}) THEN 1
               ELSE 2 END, "createdAt", id))[1] AS "displayId",
             jsonb_agg(jsonb_build_object(
               'id', id, 'className', extra->>'fromClass', 'rawStatus', raw,
               'enrollmentStatus', extra->>'enrollmentStatus', 'holdReason', extra->>'holdReason'
             ) ORDER BY extra->>'fromClass', id) AS members
        FROM source
       WHERE extra->>'pauseGroupKey' IS NOT NULL
       GROUP BY extra->>'pauseGroupKey'
      HAVING count(*) > 1
         AND count(DISTINCT extra->>'enrollmentId') = count(*)
         AND count(DISTINCT extra->>'fromClassId') = count(*)
    )
    SELECT coalesce(g."groupId", s.id) AS id, s.raw, s."studentName", s."createdAt", s."targetDate",
           s.extra::jsonb || jsonb_build_object('members', g.members) AS extra
      FROM source s
      LEFT JOIN grouped g ON g.key = s.extra->>'pauseGroupKey'
     WHERE g.key IS NULL OR s.id = g."displayId"`;
}
