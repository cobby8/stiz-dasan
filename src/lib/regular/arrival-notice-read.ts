// 지각·조퇴 알림을 «읽기만» 하는 쪽(선생님 출석부·기사님 운행표) — 서버 전용.
// 쓰기(학부모 알리기·취소)는 parent-arrival-notice.ts. 여기는 권한을 확인하지 않는다:
//   호출부가 이미 «이 반을 볼 수 있는 선생님»·«유효한 운행 링크»를 확인한 뒤 반·날짜만 넘긴다.
// ★ 표(RegularArrivalNotice)가 아직 없거나 조회가 실패하면 빈 결과 — 출석부·운행표는 그대로 떠야 한다.
// ⚠️ PgBouncer → $queryRawUnsafe 만. 날짜 칸(@db.Date)은 변환 없이 비교한다.
import { prisma } from "@/lib/prisma";
import { arrivalNoticeLabel } from "@/lib/regular/arrivalNoticeRules";

// 표가 «있다»는 답만 기억한다(한 번 생긴 표는 사라지지 않는다). «없다»는 기억하지 않는다 — 마이그레이션을 적용하면 재배포 없이 바로 켜진다.
let tableReady = false;

/** 표가 있는가(마이그레이션 적용 여부). 확인 자체가 실패해도 false */
export async function arrivalNoticeReady(): Promise<boolean> {
  if (tableReady) return true;
  try {
    const rows = await prisma.$queryRawUnsafe<{ ready: boolean }[]>(
      `SELECT to_regclass('public."RegularArrivalNotice"') IS NOT NULL AS ready`,
    );
    tableReady = rows[0]?.ready === true;
    return tableReady;
  } catch {
    return false;
  }
}

/**
 * 그 반·그 날의 지각·조퇴 알림 — 학생 id → 표시 글자 목록(«지각 예정 17:20», «조퇴 예정 18:00»).
 * 같은 날 결석을 알린 아이는 뺀다(결석이 우선 — 출석부에는 «결석 신고»만 보인다).
 */
export async function getClassArrivalNoticeLabels(classId: string, ymd: string | null): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!classId || !ymd) return out;
  try {
    if (!(await arrivalNoticeReady())) return out;
    const rows = await prisma.$queryRawUnsafe<{ studentId: string; kind: string; expectedTime: string }[]>(
      `SELECT n."studentId" AS "studentId", n.kind, n."expectedTime" AS "expectedTime"
         FROM "RegularArrivalNotice" n
        WHERE n."classId" = $1 AND n.date = $2::date AND n.status = 'REPORTED'
          AND NOT EXISTS (
            SELECT 1 FROM "RegularAbsence" ra
             WHERE ra."studentId" = n."studentId" AND ra."classId" = n."classId" AND ra.date = n.date
               AND ra.status IN ('REPORTED','CONFIRMED'))
        -- 지각(LATE)이 조퇴(EARLY)보다 먼저 보이게
        ORDER BY n.kind DESC`,
      classId, ymd,
    );
    for (const row of rows) {
      const list = out.get(String(row.studentId)) ?? [];
      list.push(arrivalNoticeLabel(row.kind, row.expectedTime));
      out.set(String(row.studentId), list);
    }
  } catch (error) {
    console.error("[arrival-notice] 출석부 표시 조회 실패(명단은 그대로):", error instanceof Error ? error.name : "");
  }
  return out;
}

/**
 * 그 날 «셔틀 안 타요» 기록 중 지각·조퇴 알림과 함께 만든 것 — 셔틀 기록 id → 알림 종류(LATE·EARLY).
 * 기사님 화면이 안 타는 사유(«지각»·«조퇴»)를 글자로 보이는 데 쓴다. 여기 없는 기록은 «자차»다.
 */
export async function getArrivalSkipKinds(ymd: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    if (!(await arrivalNoticeReady())) return out;
    const rows = await prisma.$queryRawUnsafe<{ shuttleExceptionId: string; kind: string }[]>(
      `SELECT n."shuttleExceptionId" AS "shuttleExceptionId", n.kind
         FROM "RegularArrivalNotice" n
        WHERE n.date = $1::date AND n.status = 'REPORTED' AND n."shuttleExceptionId" IS NOT NULL`,
      ymd,
    );
    for (const row of rows) out.set(String(row.shuttleExceptionId), String(row.kind));
  } catch (error) {
    console.error("[arrival-notice] 셔틀 사유 조회 실패(«자차»로 표시):", error instanceof Error ? error.name : "");
  }
  return out;
}
