import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { requireAdmin } from "@/lib/auth-guard";

// 정규 셔틀 기사님 링크(토큰) + 탑승/미탑승 기록. 방학특강(shuttleRun.ts)과 테이블은 공유하되,
// direction 값을 'REGULAR'로 구분해 섞이지 않게 한다. PgBouncer 때문에 $queryRawUnsafe 고정.

// SELF = 자차(부모 차)로 등·하원 — 셔틀 미탑승이지만 결석은 아님. 등원/하원 여부는 화면 맥락으로 판단.
export type BoardingStatus = "BOARDED" | "NOSHOW" | "SELF";

const ROLLING_DATE = "ROLLING";   // '오늘'을 따라가는 고정 링크
const REGULAR_DIR = "REGULAR";    // 정규 셔틀 표식(방학특강의 ALL/PICKUP/DROPOFF와 구분)

function normDate(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** 정규 셔틀 기사 고정 링크(매일 오늘 운행) 토큰을 만들거나 이미 있으면 그대로 돌려준다(원장 전용). */
export async function createOrGetRegularRunLink(): Promise<{ token: string }> {
  const admin = await requireAdmin();
  const token = randomBytes(16).toString("hex");
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `INSERT INTO "ShuttleRunLink" ("token","serviceDate","direction","createdByUserId")
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("serviceDate","direction") DO UPDATE SET "createdAt" = "ShuttleRunLink"."createdAt"
     RETURNING "token"`,
    token, ROLLING_DATE, REGULAR_DIR, admin.appUserId ?? null,
  );
  return { token: String(rows[0]?.token ?? token) };
}

/**
 * 이미 만들어 둔 고정 운행 링크(매일 오늘) 토큰을 찾는다. **만들지 않는다**(만드는 건 원장 전용).
 * 정규 셔틀(REGULAR)을 먼저, 없으면 방학특강 통합(ALL) 고정 링크를 쓴다.
 *
 * ⚠️ 이 함수는 열쇠(토큰)를 돌려주는데 안에서 권한을 확인하지 않는다.
 *    로그인한 기사님에게 문자 링크 없이 운행을 열어 주는 /staff/run 만 부른다 —
 *    그 화면이 requireStaff + 셔틀 권한(관리자·기사님)을 먼저 확인한다(테스트로 호출부를 고정).
 *    기사님은 원래 같은 링크를 문자로 받으므로, 로그인한 기사님에게 이 열쇠를 쓰게 하는 것은 권한을 넓히는 게 아니다.
 */
export async function findRollingDriverRunToken(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "token" FROM "ShuttleRunLink"
        WHERE "serviceDate" = $1 AND "direction" IN ($2, 'ALL')
        ORDER BY CASE "direction" WHEN $2 THEN 0 ELSE 1 END
        LIMIT 1`,
      ROLLING_DATE,
      REGULAR_DIR,
    );
    const token = typeof rows[0]?.token === "string" ? rows[0].token : "";
    return /^[a-f0-9]{16,64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** 토큰이 정규 셔틀 고정 링크인지 확인한다. 맞으면 true. 인증하지 않는다(토큰이 열쇠). */
export async function isRegularRunToken(token: string): Promise<boolean> {
  const t = typeof token === "string" ? token.trim() : "";
  if (!/^[a-f0-9]{16,64}$/.test(t)) return false;
  try {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "direction" FROM "ShuttleRunLink" WHERE "token" = $1 LIMIT 1`, t,
    );
    return rows[0]?.direction === REGULAR_DIR;
  } catch { return false; }
}

/** 그 날 정규 셔틀 탑승 상태 맵(정차행 id → 상태). 인증 없음(기사님 화면이 읽는다). */
export async function getRegularBoardingMap(date: string): Promise<Record<string, BoardingStatus>> {
  const d = normDate(date);
  if (!d) return {};
  try {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "shuttleRequestId", "status" FROM "ShuttleBoarding" WHERE "serviceDate" = $1 AND "direction" = $2`,
      d, REGULAR_DIR,
    );
    const out: Record<string, BoardingStatus> = {};
    for (const r of rows) {
      const id = r.shuttleRequestId as string;
      // 저장된 status 문자열을 그대로 3종으로 해석(그 외 값은 무시).
      const st = r.status === "NOSHOW" ? "NOSHOW" : r.status === "SELF" ? "SELF" : r.status === "BOARDED" ? "BOARDED" : null;
      if (id && st) out[id] = st;
    }
    return out;
  } catch { return {}; }
}

/** 그 날 결석 신고된 학생 목록(이름 + 학부모 전화). 셔틀 명단과 이름·전화로 근사 매칭하는 데 쓴다.
 *  status IN (REPORTED, CONFIRMED) 만 — CANCELLED 제외, REPORTED 도 즉시 제외(방학특강과 일관).
 *  인증 없음(기사님 화면이 읽는다). 테이블/조회 실패 시 빈 배열(안전). */
export async function getRegularAbsentPeople(date: string): Promise<{ name: string; phone: string | null }[]> {
  const d = normDate(date);
  if (!d) return [];
  try {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT s."name" AS "name", u."phone" AS "phone"
         FROM "RegularAbsence" ra
         JOIN "Student" s ON s."id" = ra."studentId"
         LEFT JOIN "User" u ON u."id" = s."parentId"
        WHERE ra."date" = $1::date AND ra."status" IN ('REPORTED','CONFIRMED') AND ${notMergedStudent("s")}`,
      d,
    );
    return rows
      .map((r) => ({ name: String(r.name ?? "").trim(), phone: (r.phone as string | null) ?? null }))
      .filter((r) => r.name.length > 0);
  } catch { return []; }
}

/** 정규 셔틀 탑승 상태 저장. status가 없으면(대기) 행을 지운다. 인증 없음 — 호출부가 유효 토큰을 먼저 확인한다. */
export async function setRegularBoarding(input: {
  date: string; rowId: string; status: BoardingStatus | null; studentName?: string | null;
}): Promise<{ ok: boolean }> {
  const d = normDate(input.date);
  const rowId = typeof input.rowId === "string" ? input.rowId.trim() : "";
  if (!d || !rowId) throw new Error("요청 형식이 올바르지 않습니다.");
  if (input.status == null) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ShuttleBoarding" WHERE "serviceDate" = $1 AND "direction" = $2 AND "shuttleRequestId" = $3`,
      d, REGULAR_DIR, rowId,
    );
    return { ok: true };
  }
  // 화이트리스트: NOSHOW/SELF/BOARDED 중 하나로만 저장(그 외 입력은 BOARDED로 수렴).
  const status = input.status === "NOSHOW" ? "NOSHOW" : input.status === "SELF" ? "SELF" : "BOARDED";
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ShuttleBoarding" ("serviceDate","direction","shuttleRequestId","studentName","status","checkedVia","checkedAt")
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT ("serviceDate","direction","shuttleRequestId") DO UPDATE SET
       "status" = EXCLUDED."status", "studentName" = COALESCE(EXCLUDED."studentName", "ShuttleBoarding"."studentName"),
       "checkedVia" = EXCLUDED."checkedVia", "checkedAt" = now()`,
    d, REGULAR_DIR, rowId, input.studentName ?? null, status, "driver",
  );
  return { ok: true };
}
