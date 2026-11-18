import { prisma } from "@/lib/prisma";

// 예약 발송 대기열 — "보낼 문자를 미리 얼려 두고" 시각이 되면 크론이 그대로 보낸다.
//
// ⚠️ 이 모듈이 지키는 두 가지 원칙
//   ① **문안은 값으로 얼린다.** 발송 시각에 노선을 다시 읽어 문안을 만들면, 그 사이 노선이
//      바뀐 경우 원장이 검토한 것과 다른 문자가 나간다. 회수가 불가능하므로 예약을 거는
//      순간의 본문·수신번호를 복제해 둔다.
//   ② **한 행은 한 번만 나간다.** 크론은 1분마다 돌고 실패·재시도가 겹칠 수 있다.
//      상태를 PENDING → SENDING 으로 **먼저 선점(claim)** 한 뒤 실제 발송을 시도한다.

export type ScheduledItem = {
  id: string; batchKey: string; sendAt: Date; recipient: string;
  body: string; label: string | null; status: string; requestId: string;
  purpose: string | null; attempts: number; lastError: string | null; sentAt: Date | null;
  createdBy: string | null;
};

// (2026-11-18) 예약을 거는 함수(scheduleMessages·listPending·cancelScheduled)는 지웠다 — 유일하게 쓰던
// 방학특강 셔틀 안내 «예약 발송» 서버 기능(화면 버튼 없음)을 원장 승인으로 없앴다. 이미 걸려 있던 예약은
// 아래 크론용 함수(claimDue·markSent·markFailed)가 그대로 내보낸다.

/**
 * 발송할 때가 된 행을 **선점**한다(PENDING → SENDING).
 *
 * 왜 선점이 필요한가: 크론이 1분마다 도는데 앞 실행이 아직 발송 중이면 같은 행을 두 번 집는다.
 * UPDATE ... WHERE status='PENDING' 으로 원자적으로 가져가야 한 번만 나간다.
 */
export async function claimDue(limit = 50): Promise<ScheduledItem[]> {
  return prisma.$queryRawUnsafe<ScheduledItem[]>(
    `UPDATE "ScheduledMessage" SET "status" = 'SENDING', "attempts" = "attempts" + 1, "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "ScheduledMessage"
         WHERE "status" = 'PENDING' AND "sendAt" <= now()
         ORDER BY "sendAt"
         LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
  );
}

export async function markSent(id: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "ScheduledMessage" SET "status" = 'SENT', "sentAt" = now(), "lastError" = NULL, "updatedAt" = now()
      WHERE "id" = $1`, id);
}

/**
 * 실패 처리. 3회까지는 PENDING으로 되돌려 다음 크론에서 다시 시도한다.
 * 그 이상은 FAILED로 남긴다 — 무한 재시도로 요금이 새는 것보다 안 나가는 편이 낫다.
 */
export async function markFailed(id: string, attempts: number, error: string): Promise<void> {
  const next = attempts >= 3 ? "FAILED" : "PENDING";
  await prisma.$executeRawUnsafe(
    `UPDATE "ScheduledMessage" SET "status" = $2, "lastError" = $3, "updatedAt" = now() WHERE "id" = $1`,
    id, next, error.slice(0, 500));
}
