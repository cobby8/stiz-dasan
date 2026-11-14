// 질병·부상 결석 «이월 검토» — 매일 한 번 도는 뒷정리(cron/makeup-credits, KST 00:30).
//
//   ① 기준일(알린 날·결석일 중 더 늦은 날)부터 7일이 지났는데 사진이 한 장도 없는 검토 → 보강권 1장으로 자동 전환(원장 결정 a2)
//   ② 증빙 사진 파일 지우기 — 처리 끝나고 90일 지난 것(a6) + 화면에서 뺀 것(학부모 삭제·검토 닫힘·업로드 중단)
//
// DB·저장소·알림은 인자로 받는다 — 테스트가 가짜로 실제 실행한다. 이 파일은 prisma 를 import 하지 않는다.
// 날짜 판정은 «DB 시계»의 KST 날짜로 한다(서버 시계를 믿지 않는다). requestedAt·decidedAt 은 timestamptz 라 변환은 한 번.
import { convertIllnessToMakeupInTx, illnessReviewReady, type IllnessTx } from "@/lib/regular/illness-carry-tx";
import { isEvidencePurgeDue, isValidEvidencePath, shouldAutoConvertToMakeup, EVIDENCE_BUCKET } from "@/lib/regular/illnessCarryRules";

export type IllnessCronDb = IllnessTx & {
  $transaction<T>(work: (tx: IllnessTx) => Promise<T>, options?: { isolationLevel: "Serializable" | "RepeatableRead"; timeout?: number }): Promise<T>;
};

type OverdueRow = { absenceId: string; status: string; source: string; photoCount: number; requestedYmd: string; absenceYmd: string; todayYmd: string };

/** ① 7일 지나 사진 없는 검토 → 보강권. 전환된 결석(학생·날짜)을 돌려준다 — 호출부가 학부모에게 앱 알림을 보낸다 */
export async function autoConvertOverdueIllnessReviews(
  db: IllnessCronDb,
  issuable: (absenceYmd: string) => boolean,
): Promise<{ checked: number; converted: Array<{ studentId: string; absenceYmd: string; creditIssued: boolean }>; failed: number }> {
  if (!(await illnessReviewReady(db))) return { checked: 0, converted: [], failed: 0 };
  // 후보: 검토 중 + 학부모가 알린 것. 사진 수·알린 날(KST)·오늘(KST)을 함께 읽어 규칙 함수(순수)가 판정한다
  const rows = await db.$queryRawUnsafe<OverdueRow[]>(
    `SELECT r."absenceId" AS "absenceId", r.status, r.source,
            (SELECT COUNT(*)::int FROM "RegularAbsenceEvidence" e WHERE e."absenceId" = r."absenceId" AND e."removedAt" IS NULL) AS "photoCount",
            to_char(r."requestedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "requestedYmd",
            -- 결석일(date 칼럼 — 이미 달력 값이라 변환 없음). 7일 기준점 = 알린 날과 결석일 중 더 늦은 날(규칙 함수가 판정)
            to_char(ra.date, 'YYYY-MM-DD') AS "absenceYmd",
            to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "todayYmd"
       FROM "RegularAbsenceCarryReview" r
       JOIN "RegularAbsence" ra ON ra.id = r."absenceId"
      WHERE r.status = 'PENDING' AND r.source IN ('PARENT', 'KAKAO')
      ORDER BY r."requestedAt" ASC
      LIMIT 500`,
  );
  const converted: Array<{ studentId: string; absenceYmd: string; creditIssued: boolean }> = [];
  let failed = 0;
  for (const row of rows) {
    if (!shouldAutoConvertToMakeup({ ...row, photoCount: Number(row.photoCount) })) continue;
    try {
      // 건마다 따로 — 한 건이 실패해도 나머지는 전환한다. 잠근 뒤 «검토 중 + 사진 0장»을 다시 본다
      const outcome = await db.$transaction(
        (tx) => convertIllnessToMakeupInTx(tx, { absenceId: row.absenceId, by: "AUTO", actorUserId: null, issuable }),
        { isolationLevel: "Serializable", timeout: 30_000 },
      );
      if (outcome.converted) converted.push({ studentId: outcome.studentId, absenceYmd: outcome.absenceYmd, creditIssued: outcome.creditIssued });
    } catch (error) {
      failed += 1;
      // 건강 정보(사유 글)는 로그에 싣지 않는다 — 결석 id 와 오류 이름만
      console.error("[illness-carry-cron] 자동 전환 실패:", row.absenceId, error instanceof Error ? error.name : "");
    }
  }
  return { checked: rows.length, converted, failed };
}

type PurgeRow = { id: string; storageBucket: string; storagePath: string; removed: boolean; orphan: boolean; decidedYmd: string | null; todayYmd: string };

/**
 * ② 증빙 사진 파일 지우기. remove 는 저장소에서 파일을 지우고 성공 여부를 돌려준다(없는 파일도 성공으로 본다).
 * 지운 사진은 purgedAt 을 찍는다 — 실패한 것은 다음 날 다시 시도한다.
 */
export async function purgeIllnessEvidence(
  db: IllnessTx,
  remove: (bucket: string, path: string) => Promise<boolean>,
): Promise<{ purged: number; failed: number }> {
  if (!(await illnessReviewReady(db))) return { purged: 0, failed: 0 };
  // 지울 후보:
  //   · 화면에서 뺀 사진(removedAt) — 방금 올리는 중인 예약 행과 겹치지 않게 10분 지난 것만
  //   · 결석 행이 사라진 사진(absenceId NULL)
  //   · 처리(승인·전환·닫힘)가 끝난 검토의 사진 — 90일 판정은 아래 규칙 함수가 한다(SQL 은 넉넉히 89일로 거른다)
  const rows = await db.$queryRawUnsafe<PurgeRow[]>(
    `SELECT e.id, e."storageBucket" AS "storageBucket", e."storagePath" AS "storagePath",
            (e."removedAt" IS NOT NULL) AS removed, (e."absenceId" IS NULL) AS orphan,
            to_char(r."decidedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "decidedYmd",
            to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "todayYmd"
       FROM "RegularAbsenceEvidence" e
       LEFT JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = e."absenceId"
      WHERE e."purgedAt" IS NULL
        AND ((e."removedAt" IS NOT NULL AND e."removedAt" < now() - interval '10 minutes')
          OR e."absenceId" IS NULL
          OR (r.status IN ('APPROVED', 'MAKEUP', 'CLOSED') AND r."decidedAt" < now() - interval '89 days'))
      ORDER BY e."createdAt" ASC
      LIMIT 200`,
  );
  let purged = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.removed && !row.orphan && !isEvidencePurgeDue(row.decidedYmd, row.todayYmd)) continue;
    // 우리가 만든 모양의 경로만 지운다(다른 버킷·경로가 섞여 들어와도 건드리지 않는다)
    const ok = row.storageBucket === EVIDENCE_BUCKET && isValidEvidencePath(row.storagePath)
      ? await remove(row.storageBucket, row.storagePath).catch(() => false)
      : false;
    if (!ok) { failed += 1; continue; }
    await db.$executeRawUnsafe(
      `UPDATE "RegularAbsenceEvidence" SET "purgedAt" = now(), "removedAt" = COALESCE("removedAt", now()) WHERE id = $1 AND "purgedAt" IS NULL`,
      row.id,
    );
    purged += 1;
  }
  return { purged, failed };
}
