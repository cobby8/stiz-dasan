import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";

// ── 정규 수업 보강 — 학부모 조회(읽기 전용) ────────────────────────────────
// 관리자가 결석(RegularAbsence)에 대해 지정한 보강(MakeupSession)을
// 학부모가 자기 자녀 것만 확인한다. 신청/변경은 하지 않는다(관리자 지정형 MVP).
//
// ★ IDOR 방어: MakeupSession.studentId 를 Student.parentId = 로그인 부모(appUserId)로
//   조인해, 남의 자녀 보강은 절대 조회되지 않는다. 클라이언트 입력을 신뢰하지 않는다.

// KST 기준 오늘(YYYY-MM-DD) — 마이페이지 다른 곳과 동일하게 Asia/Seoul 고정.
function kstTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

// "8/5(화)" 라벨.
function seoulLabel(value: Date | string | null): string | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  const f = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${Number(p.month)}/${Number(p.day)}(${(p.weekday || "").replace("요일", "")})`;
}

const MAKEUP_STATUS_LABEL: Record<string, string> = {
  BOOKED: "예약",
  ATTENDED: "출석",
  NO_SHOW: "노쇼",
};

export type RegularMakeupRow = {
  id: string;
  studentName: string;
  originalClassName: string | null;
  originalDateLabel: string | null;
  makeupClassName: string | null;
  makeupDateLabel: string | null;
  status: string;
  statusLabel: string;
};

// 부모 자녀의 예정/유효 보강 목록(오늘 이후, 취소 제외). MakeupSession 부재 시 빈 배열.
export async function getRegularMakeupsForParent(
  parentUserId: string,
): Promise<RegularMakeupRow[]> {
  const today = kstTodayYmd();
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT ms.id AS id,
              s.name AS "studentName",
              oc.name AS "originalClassName",
              ms."originalDate" AS "originalDate",
              mc.name AS "makeupClassName",
              ms."makeupDate" AS "makeupDate",
              ms.status AS status
         FROM "MakeupSession" ms
         JOIN "Student" s ON s.id = ms."studentId"
         LEFT JOIN "Class" oc ON oc.id = ms."originalClassId"
         LEFT JOIN "Class" mc ON mc.id = ms."makeupClassId"
        WHERE s."parentId" = $1 AND ${notMergedStudent("s")}
          AND ms.status <> 'CANCELLED'
          AND ms."makeupDate"::date >= $2::date
        ORDER BY ms."makeupDate" ASC`,
      parentUserId, today,
    );
    return rows.map((r) => ({
      id: r.id,
      studentName: r.studentName,
      originalClassName: r.originalClassName ?? null,
      originalDateLabel: seoulLabel(r.originalDate),
      makeupClassName: r.makeupClassName ?? null,
      makeupDateLabel: seoulLabel(r.makeupDate),
      status: r.status,
      statusLabel: MAKEUP_STATUS_LABEL[r.status] || r.status,
    }));
  } catch {
    // MakeupSession 테이블 부재 등 → 보강 없음으로 처리(안전)
    return [];
  }
}
