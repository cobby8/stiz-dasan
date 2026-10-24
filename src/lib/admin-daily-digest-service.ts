import { prisma } from "@/lib/prisma";
import { createNotificationRecord } from "@/lib/notification";
import { todayKst } from "@/lib/datetime/kst";
import { countEnrollmentChangesNeedingCheck } from "@/lib/enrollment/admin-change-request";
import { buildAdminDailyDigest, type UnpaidMonthRow } from "@/lib/admin-daily-digest";

// ── 원장 아침 요약 알림 (매일 KST 08:30, 크론) ─────────────────────────────
//
// 받는 사람: User.role 이 ADMIN(원장)·VICE_ADMIN(부원장)인 계정만. 학부모·코치는 받지 않는다.
// 통로: 앱 알림 + 웹 푸시만(createNotificationRecord). 문자(SMS)는 보내지 않는다 —
//       notifyAdmins 는 설정에 따라 문자·코치 문자까지 나갈 수 있어 일부러 쓰지 않는다.
// 중복 방지: 같은 KST 날짜에 이 종류 알림을 이미 받은 관리자는 건너뛴다(크론이 두 번 돌아도 1번).

export const ADMIN_DIGEST_TYPE = "ADMIN_DAILY_DIGEST";

export type AdminDailyDigestResult = {
  sent: number; // 이번에 새로 알림을 만든 관리자 수
  skippedDuplicate: number; // 오늘 이미 받아서 건너뛴 관리자 수
  empty: boolean; // 확인할 일이 없어 보내지 않았는지
  failed?: number; // 처리 중 오류가 난 관리자 수(다른 관리자 발송은 계속됨)
};

/** 사이트 장부 미납(PENDING·OVERDUE)을 청구 월별로 묶는다. 날짜 판정은 전부 SQL(KST)에서. */
async function loadUnpaidByMonth(): Promise<UnpaidMonthRow[]> {
  // "dueDate" 는 시간대 없는 timestamp 컬럼 → UTC 로 한 번, KST 로 한 번 "두 번" 걸어야 KST 날짜가 된다.
  // 청구 월은 year/month 칸 우선, 비어 있으면 납부기한의 KST 월로 대신한다.
  const rows = await prisma.$queryRawUnsafe<Array<{
    y: number; m: number; n: number; total: bigint | number | null; overdue: number;
  }>>(
    `SELECT COALESCE(p.year, EXTRACT(YEAR FROM p.due_kst)::int) AS y,
            COALESCE(p.month, EXTRACT(MONTH FROM p.due_kst)::int) AS m,
            count(*)::int AS n,
            COALESCE(sum(p.amount), 0)::bigint AS total,
            (count(*) FILTER (WHERE p.due_kst::date < (NOW() AT TIME ZONE 'Asia/Seoul')::date))::int AS overdue
       FROM (SELECT year, month, amount,
                    (("dueDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul') AS due_kst
               FROM "Payment"
              WHERE status IN ('PENDING', 'OVERDUE')) p
      GROUP BY 1, 2`,
  );
  return rows.map((r) => ({
    year: Number(r.y),
    month: Number(r.m),
    count: Number(r.n),
    amount: Number(r.total ?? 0), // sum 은 bigint 로 오므로 숫자로 바꾼다
    overdueCount: Number(r.overdue),
  }));
}

/** 수강 변경 신청 중 승인 대기(PENDING) 건수 */
async function countPendingChangeRequests(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "EnrollmentChangeRequest" WHERE status = 'PENDING'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * 카카오 접수 중 원장 확인을 기다리는 건수.
 * SUBMITTED(학부모가 접수 확정) · HELD(자동 반영 못 해 검토 필요) · FAILED(처리 실패)만 센다.
 * NEEDS_DETAILS 는 학부모 쪽 답을 기다리는 중이라 원장 할 일이 아니다.
 */
async function countPendingKakaoIntakes(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "KakaoParentIntake" WHERE status IN ('SUBMITTED', 'HELD', 'FAILED')`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function runAdminDailyDigest(): Promise<AdminDailyDigestResult> {
  const [unpaid, needsCheckCount, pendingChangeCount, kakaoPendingCount] = await Promise.all([
    loadUnpaidByMonth(),
    countEnrollmentChangesNeedingCheck(), // 수강 변경 쪽 함수는 호출만 한다(수정 금지 영역)
    countPendingChangeRequests(),
    countPendingKakaoIntakes(),
  ]);

  const digest = buildAdminDailyDigest({ todayYmd: todayKst(), unpaid, needsCheckCount, pendingChangeCount, kakaoPendingCount });
  // 확인할 일이 하나도 없으면 아무것도 보내지 않는다
  if (!digest) return { sent: 0, skippedDuplicate: 0, empty: true };

  // 받는 사람 = 원장·부원장 계정만 (학부모 PARENT·코치 COACH 등은 대상 아님)
  const admins = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "User" WHERE role IN ('ADMIN', 'VICE_ADMIN')`,
  );

  let sent = 0;
  let skippedDuplicate = 0;
  let failed = 0;
  for (const admin of admins) {
    // 한 명 처리에서 오류가 나도 다음 관리자는 받도록 사람 단위로 격리한다.
    try {
    // 중복 방지: 오늘(KST) 이미 이 요약을 받았는지. "createdAt" 은 timestamptz 라 KST 변환은 한 번만.
    const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Notification"
        WHERE "userId" = $1
          AND type = $2
          AND ("createdAt" AT TIME ZONE 'Asia/Seoul')::date = (NOW() AT TIME ZONE 'Asia/Seoul')::date
        LIMIT 1`,
      admin.id,
      ADMIN_DIGEST_TYPE,
    );
    if (existing.length > 0) {
      skippedDuplicate += 1;
      continue;
    }
    // 앱 알림 저장 + 웹 푸시 (문자 없음)
    await createNotificationRecord({
      userId: admin.id,
      type: ADMIN_DIGEST_TYPE,
      title: digest.title,
      message: digest.message,
      linkUrl: digest.linkUrl,
    });
    sent += 1;
    } catch (error) {
      failed += 1;
      console.error("[admin-daily-digest] 관리자 요약 발송 실패", admin.id, error);
    }
  }

  return { sent, skippedDuplicate, failed, empty: false };
}
