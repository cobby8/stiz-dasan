import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { todayKst } from "@/lib/datetime/kst";
import {
  MAX_DAYS_AHEAD,
  SHUTTLE_EXCEPTION_MESSAGE,
  addDays,
  validateShuttleException,
} from "@/lib/shuttle/dayExceptionRules";
import {
  notifyAdminsOfShuttleException,
  saveShuttleException,
  shuttleEventVersion,
} from "@/lib/shuttle/parent-shuttle-exception";

// ── 학원(원장·부원장)이 대신 넣는 «셔틀 당일 변경» (2026-11-15 원장 요청 «관리자용 셔틀 변경 입력도 만들어줘») ──
//
// 왜: 학부모는 마감(수업 시작 1시간 전) 뒤에는 사이트에서 바꿀 수 없고 «학원으로 연락»하게 돼 있는데,
//   그 전화를 받은 원장이 넣을 길이 없었다.
//
// 학부모 경로(parent-shuttle-exception.ts)와 같은 것 / 다른 것
//   · 같은 표(ShuttleDayException)·같은 저장 문장(saveShuttleException — 같은 날·같은 방향은 덮어쓰기, 같은 내용이면 그대로)
//     → 기사님 명단·배지는 기존 읽기 경로 그대로 반영된다(getShuttleExceptionsForDate).
//   · 같은 알림 함수·같은 대상(원장·기사). 문구 끝에 «학원 입력»만 붙는다.
//   · 다른 점: 마감·복귀일 검사를 하지 않는다. 지난 날짜와 14일 밖 날짜만 거절한다(날짜 규칙은 학부모와 같은 함수).
//   · 누가 넣었나: 표의 "requestedByUserId" 칸에 관리자 계정 id 를 넣는다(스키마 변경 없음).
//     목록은 그 계정의 역할로 «학원 입력»/«학부모»를 나눠 보인다.
//     취소한 사람을 적는 칸은 표에 없다 — 취소는 알림 문구(«취소 · 학원 입력»)로만 남는다.
//
// ★ 권한 검사는 이 파일이 하지 않는다. 서버 액션(src/app/actions/shuttle-exception-admin.ts)이 requireAdmin 으로 막고,
//   확인된 관리자 계정 id 만 넘긴다. 이 파일의 함수를 다른 곳에서 부르면 안 된다.

/** 학원 계정으로 보는 역할(이 계정이 넣은 변경은 «학원 입력») */
const ACADEMY_ROLES = ["ADMIN", "VICE_ADMIN"];

export type AdminShuttleStudent = { id: string; name: string; classNames: string };

export type AdminShuttleExceptionRow = {
  id: string;
  studentId: string;
  studentName: string;
  serviceDate: string;
  direction: string;
  kind: string;
  location: string | null;
  note: string | null;
  /** 학원(원장·부원장)이 넣었나 — 아니면 학부모 */
  byAcademy: boolean;
};

export type AdminShuttleExceptionBoard = { today: string; maxDate: string; rows: AdminShuttleExceptionRow[] };

/** 학생 찾기 — 이름으로, 수강(다니는 중·휴원) 기록이 있는 학생만. 최대 10명. 반 이름을 함께 줘 동명이인을 가린다. */
export async function searchStudentsForShuttleException(query: string): Promise<AdminShuttleStudent[]> {
  const q = typeof query === "string" ? query.trim().slice(0, 30) : "";
  if (q.length === 0) return [];
  // LIKE 특수문자는 글자 그대로 찾는다
  const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await prisma.$queryRawUnsafe<AdminShuttleStudent[]>(
    `SELECT s.id, s.name,
            COALESCE((SELECT string_agg(c.name, ', ' ORDER BY c.name)
                        FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId"
                       WHERE e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED')), '') AS "classNames"
       FROM "Student" s
      WHERE ${notMergedStudent("s")} AND s.name ILIKE $1
        AND EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED'))
      ORDER BY s.name ASC, s.id ASC
      LIMIT 10`,
    pattern,
  );
  return rows.map((row) => ({ id: row.id, name: row.name, classNames: row.classNames ?? "" }));
}

/** 오늘부터 들어와 있는 당일 변경(학부모 입력분 + 학원 입력분). 날짜 → 이름 순. */
export async function getShuttleExceptionBoardForAdmin(): Promise<AdminShuttleExceptionBoard> {
  const today = todayKst();
  const rows = await prisma.$queryRawUnsafe<(Omit<AdminShuttleExceptionRow, "byAcademy"> & { requesterRole: string | null })[]>(
    // "serviceDate" 는 date 열 — 변환 없이 그대로 비교·to_char 한다
    `SELECT x.id, x."studentId" AS "studentId", s.name AS "studentName",
            to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
            x.direction, x.kind, x.location, x.note, u.role::text AS "requesterRole"
       FROM "ShuttleDayException" x
       JOIN "Student" s ON s.id = x."studentId"
       LEFT JOIN "User" u ON u.id = x."requestedByUserId"
      WHERE x."canceledAt" IS NULL AND x."serviceDate" >= $1::date AND ${notMergedStudent("s")}
      ORDER BY x."serviceDate" ASC, s.name ASC, x.id ASC
      LIMIT 200`,
    today,
  );
  return {
    today,
    maxDate: addDays(today, MAX_DAYS_AHEAD),
    rows: rows.map((row) => ({
      id: row.id,
      studentId: row.studentId,
      studentName: row.studentName,
      serviceDate: row.serviceDate,
      direction: row.direction,
      kind: row.kind,
      location: row.location ?? null,
      note: row.note ?? null,
      byAcademy: ACADEMY_ROLES.includes(String(row.requesterRole ?? "")),
    })),
  };
}

export type AdminShuttleExceptionInput = {
  studentId?: unknown;
  serviceDate?: unknown;
  direction?: unknown;
  kind?: unknown;
  location?: unknown;
  note?: unknown;
};

/**
 * 학원이 대신 넣기. adminUserId = 서버 액션이 requireAdmin 으로 확인한 관리자 계정 id.
 * 마감·복귀일은 보지 않는다 — 지난 날짜·14일 밖·형식 오류만 거절한다.
 */
export async function submitShuttleExceptionByAdmin(adminUserId: string, input: AdminShuttleExceptionInput) {
  if (!adminUserId) return { ok: false as const, message: "관리자 권한이 필요합니다." };
  const studentId = typeof input?.studentId === "string" ? input.studentId.trim() : "";
  if (!studentId) return { ok: false as const, message: "학생을 선택해 주세요." };

  // 날짜(오늘~14일)·방향·종류·장소 — 학부모와 같은 규칙 함수. «오늘»은 서버가 KST 로 만든다.
  const checked = validateShuttleException(input ?? {}, { today: todayKst() });
  if (!checked.ok) return { ok: false as const, message: SHUTTLE_EXCEPTION_MESSAGE[checked.error] };

  // 학생 확인(통합돼 사라진 학생·없는 id 는 거절)
  const students = await prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
    // 검색과 같은 범위(수강 중·휴원 학생)만 저장한다 — 퇴원생 id 를 직접 넣어도 받지 않는다(2026-11-15 검수)
    `SELECT s.id, s.name FROM "Student" s WHERE s.id = $1 AND ${notMergedStudent("s")}
        AND EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED')) LIMIT 1`,
    studentId,
  );
  if (!students[0]) return { ok: false as const, message: "학생을 찾을 수 없습니다." };

  const serviceDate = String(input.serviceDate);
  const { direction, kind } = checked;
  const location = kind === "LOCATION" ? String(input.location).trim().slice(0, 200) : null;
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) || null : null;

  // 저장 — 학부모와 같은 문장(같은 날·같은 방향은 덮어쓰기, 같은 내용이면 그대로). 입력한 사람 = 관리자 계정
  const saved = await saveShuttleException(prisma, { studentId, serviceDate, direction, kind, location, note }, adminUserId);
  if (!saved[0]) return { ok: false as const, message: "셔틀 변경을 저장하지 못했습니다." };
  if (!saved[0].changed) return { ok: true as const, id: saved[0].id, noOp: true as const };

  // 알림 — 학부모가 넣었을 때와 같은 함수·같은 대상(원장·기사). 문구 끝에 «학원 입력»
  await notifyAdminsOfShuttleException({
    studentName: students[0].name,
    studentId,
    serviceDate,
    direction,
    kind,
    location,
    recordId: saved[0].id,
    eventVersion: shuttleEventVersion({ direction, kind, location, note }),
    byAcademy: true,
  });
  return { ok: true as const, id: saved[0].id };
}

/** 학원이 취소 — 학부모 입력분·학원 입력분 모두. 지난 날짜의 변경은 손대지 않는다(이미 운행이 끝났다). */
export async function cancelShuttleExceptionByAdmin(adminUserId: string, exceptionId: string) {
  if (!adminUserId) return { ok: false as const, message: "관리자 권한이 필요합니다." };
  const id = typeof exceptionId === "string" ? exceptionId.trim() : "";
  if (!id) return { ok: false as const, message: "취소할 변경을 찾을 수 없습니다." };

  // 한 문장으로 취소 + 알림에 쓸 원본 확보. 지난 날짜는 조건에서 걸러진다("serviceDate" 는 date 열)
  const canceled = await prisma.$queryRawUnsafe<{
    id: string; studentId: string; studentName: string; serviceDate: string; direction: string; kind: string; location: string | null;
  }[]>(
    `UPDATE "ShuttleDayException" x
        SET "canceledAt" = now(), "updatedAt" = now()
       FROM "Student" s
      WHERE x."studentId" = s.id AND ${notMergedStudent("s")}
        AND x.id = $1 AND x."canceledAt" IS NULL AND x."serviceDate" >= $2::date
      RETURNING x.id, x."studentId" AS "studentId", s.name AS "studentName",
                to_char(x."serviceDate",'YYYY-MM-DD') AS "serviceDate",
                x.direction, x.kind, x.location`,
    id, todayKst(),
  );
  const row = canceled[0];
  if (!row) return { ok: false as const, message: "이미 취소됐거나 지난 날짜의 변경입니다. 새로고침해 주세요." };

  await notifyAdminsOfShuttleException({
    action: "CANCELED",
    studentName: row.studentName,
    studentId: row.studentId,
    serviceDate: row.serviceDate,
    direction: row.direction,
    kind: row.kind,
    location: row.location,
    recordId: row.id,
    eventVersion: "canceled",
    byAcademy: true,
  });
  return { ok: true as const, id: row.id };
}
