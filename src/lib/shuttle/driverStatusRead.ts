import { prisma } from "@/lib/prisma";

/** 조회 오류는 '미체크'가 아니다. 호출자가 실패를 명시적으로 처리하도록 예외를 유지한다. */
export async function readDriverBoarding(date: string, direction: "REGULAR" | "PICKUP" | "DROPOFF") {
  const rows = await prisma.$queryRawUnsafe<{ shuttleRequestId: string; status: string; checkedAt: Date | string }[]>(
    `SELECT "shuttleRequestId", "status", "checkedAt" FROM "ShuttleBoarding" WHERE "serviceDate" = $1 AND "direction" = $2`,
    date, direction,
  );
  const boarding: Record<string, "BOARDED" | "NOSHOW" | "SELF"> = {};
  const checkedAt: Record<string, string> = {};
  for (const row of rows) {
    if (row.status === "BOARDED" || row.status === "NOSHOW" || row.status === "SELF") {
      boarding[row.shuttleRequestId] = row.status;
      checkedAt[row.shuttleRequestId] = new Date(row.checkedAt).toISOString();
    }
  }
  return { boarding, checkedAt };
}
