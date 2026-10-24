import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";

// 관리자용 보강권 현황 — 읽기 전용.
//
// 원장이 알아야 하는 건 딱 두 가지다.
//   ① 누가 몇 장 갖고 있나 (전화가 오면 바로 답해야 한다)
//   ② 곧 사라질 게 있나 (미리 안내해 주면 분쟁이 안 생긴다)
// 그래서 학생 단위로 묶고, 임박한 순으로 정렬한다.

const KST = "Asia/Seoul";

function dayLabel(d: Date | string): string {
  const v = typeof d === "string" ? new Date(d) : d;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "numeric", day: "numeric", weekday: "short" })
      .formatToParts(v).map((x) => [x.type, x.value]),
  );
  return `${Number(p.month)}/${Number(p.day)}(${(p.weekday || "").replace("요일", "")})`;
}

export type AdminCreditRow = {
  id: string;
  absenceLabel: string;
  expiresLabel: string;
  /** 만료까지 남은 일수. 음수면 이미 지났다. */
  daysLeft: number;
  sourceLabel: string;       // "정규" | "방학특강"
  originClassName: string | null;
  status: string;            // AVAILABLE | RESERVED
  booking: string | null;    // "수요일 3교시 · 8/12(수)"
};

export type AdminCreditStudent = {
  studentId: string;
  studentName: string;
  studentGrade: string | null;
  parentName: string | null;
  parentPhone: string | null;
  available: number;
  reserved: number;
  /** 이 학생이 가진 것 중 가장 임박한 만료까지 남은 일수 */
  soonestDaysLeft: number;
  credits: AdminCreditRow[];
};

export type AdminCreditOverview = {
  totals: { students: number; available: number; reserved: number; expiringSoon: number };
  students: AdminCreditStudent[];
};

/**
 * 아직 살아 있는 보강권(AVAILABLE·RESERVED)만 학생별로 모은다.
 *
 * 이미 끝난 것(USED/NO_SHOW/EXPIRED/REVOKED)은 여기 넣지 않는다.
 * 지난 이력은 보강 예약 목록에서 이미 볼 수 있고, 여기 섞으면 "지금 챙길 것"이 묻힌다.
 */
export async function getMakeupCreditOverview(): Promise<AdminCreditOverview> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT mc.id, mc."studentId", mc."sourceType", mc."absenceDate", mc."expiresAt", mc.status,
            s.name AS "studentName", s.grade AS "studentGrade",
            u.name AS "parentName", u.phone AS "parentPhone",
            oc.name AS "originClassName",
            ms."makeupDate" AS "bookedDate", bc.name AS "bookedClassName"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
       LEFT JOIN "User" u ON u.id = s."parentId"
       LEFT JOIN "Class" oc ON oc.id = mc."originClassId"
       LEFT JOIN "MakeupSession" ms ON ms.id = mc."makeupSessionId"
       LEFT JOIN "Class" bc ON bc.id = ms."makeupClassId"
      WHERE mc.status IN ('AVAILABLE','RESERVED') AND ${notMergedStudent("s")}
      ORDER BY mc."expiresAt" ASC`,
  );

  const now = Date.now();
  const byStudent = new Map<string, AdminCreditStudent>();

  for (const r of rows) {
    const daysLeft = Math.floor((new Date(r.expiresAt).getTime() - now) / 86400000);
    let entry = byStudent.get(r.studentId);
    if (!entry) {
      entry = {
        studentId: r.studentId,
        studentName: r.studentName,
        studentGrade: r.studentGrade ?? null,
        parentName: r.parentName ?? null,
        parentPhone: r.parentPhone ?? null,
        available: 0, reserved: 0,
        soonestDaysLeft: daysLeft,   // 정렬이 만료 오름차순이라 첫 건이 가장 임박하다
        credits: [],
      };
      byStudent.set(r.studentId, entry);
    }
    if (r.status === "RESERVED") entry.reserved++;
    else entry.available++;

    entry.credits.push({
      id: r.id,
      absenceLabel: dayLabel(r.absenceDate),
      expiresLabel: dayLabel(r.expiresAt),
      daysLeft,
      sourceLabel: r.sourceType === "SEASONAL" ? "방학특강" : "정규",
      originClassName: r.originClassName ?? null,
      status: r.status,
      booking: r.bookedDate
        ? `${r.bookedClassName ?? "보강 반"} · ${dayLabel(r.bookedDate)}`
        : null,
    });
  }

  const students = [...byStudent.values()].sort(
    (a, b) => a.soonestDaysLeft - b.soonestDaysLeft || a.studentName.localeCompare(b.studentName),
  );

  return {
    totals: {
      students: students.length,
      available: students.reduce((n, s) => n + s.available, 0),
      reserved: students.reduce((n, s) => n + s.reserved, 0),
      // 2주 안에 사라질 "아직 예약 안 된" 보강권 — 원장이 먼저 연락해야 하는 대상.
      expiringSoon: rows.filter(
        (r) => r.status === "AVAILABLE" &&
          (new Date(r.expiresAt).getTime() - now) / 86400000 <= 14,
      ).length,
    },
    students,
  };
}
