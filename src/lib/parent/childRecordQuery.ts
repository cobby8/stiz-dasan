// 학부모 «아이 기록»(/mypage/record) 조회 — 재료만 모으고 계산은 childRecordRules(순수)에 맡긴다.
//
// ★ 보안 가드(반드시 유지)
//   1) IDOR — 첫 SQL 에서 «이 학생이 로그인 보호자의 아이인가»(childAccessSql)와 «병합된 옛 학생이 아닌가»를
//      다시 확인한다. 0행이면 null — 나머지 조회는 아예 돌지 않는다(남의 아이 id 를 주소에 넣어도 아무것도 안 읽힌다).
//   2) 금액·영수증은 결제 권한자(payerAccess = 대표 보호자 + 승인된 가족)에게만. 권한이 없으면 금액·영수증 칸을 비운다.
//   3) 가상계좌 비밀값(depositSecretHash)·유니폼 무료 링크 토큰은 SELECT 하지 않는다.
//   4) 캐시 금지 — 화면은 force-dynamic, 여기서는 unstable_cache 를 쓰지 않는다(아이·보호자마다 다르다).
//
// 시간대: 시간대 없는 칸(Payment.dueDate/paidDate, Session.date, Enrollment.createdAt/updatedAt)은 «두 번» 바꾼다
//   ((col AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul') — 한 번만 걸면 9시간 밀린다(statsQueries 의 kstNaive 와 같은 식).
//   시간대 있는 칸(timestamptz)은 한 번, 날짜 칸(@db.Date)·Payment.year/month 는 변환 없이.
import { prisma } from "@/lib/prisma";
import { childAccessSql } from "@/lib/account/child-access";
import { payerAccessSql } from "@/lib/payments/payerAccess";
import { notMergedStudent } from "@/lib/studentVisibility";
import { getStudentTenure } from "@/lib/student-tenure-query";
import { todayKst } from "@/lib/datetime/kst";
import {
  homeRecordLine,
  yearAttendance,
  type AttendanceMonthCount,
  type RecordPaymentRow,
  type TimelineChange,
  type TimelineEnrollment,
} from "@/lib/parent/childRecordRules";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

/** 시간대 없는 칸 → KST 벽시계(두 번 변환) */
const kstNaive = (col: string) => `((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')`;

export type SeasonalRecord = { seasonId: string; title: string; startYmd: string | null; total: number; held: number; attended: number };
export type UniformRecord = {
  status: string | null;
  receivedYmd: string | null;
  /** 3년 무료 유니폼 링크(취소 안 된 최신 1개) — 상태만 */
  freeGrant: { status: string; expired: boolean } | null;
};
export type ReportRecord = { reports: number; feedbacks: number };

export type ChildRecord = {
  student: { id: string; name: string; canPay: boolean; hasBaseline: boolean };
  today: string;
  /** 섹션마다 따로 — 한 조회가 실패하면 그 섹션만 null(화면은 «불러오지 못했어요» 한 줄) */
  payments: RecordPaymentRow[] | null;
  attendance: AttendanceMonthCount[] | null;
  timeline: { enrollments: TimelineEnrollment[]; changes: TimelineChange[] } | null;
  seasonal: SeasonalRecord[] | null;
  uniform: UniformRecord | null;
  reports: ReportRecord | null;
  tenure: { label: string; firstMonth: string | null } | null;
};

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

async function section<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    // 개인정보·원문 SQL 은 남기지 않는다(섹션 이름만)
    console.error("[child-record] 조회 실패", label, error instanceof Error ? error.name : "");
    return null;
  }
}

/** 기록 화면의 아이 칩 — 로그인 보호자의 아이만(가족 연결 포함), 병합된 옛 학생 제외 */
export async function listRecordChildren(parentUserId: string, db: Reader = prisma): Promise<{ id: string; name: string }[]> {
  if (!parentUserId) return [];
  return db.$queryRawUnsafe<{ id: string; name: string }[]>(
    `SELECT s.id, s.name FROM "Student" s
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      ORDER BY s."createdAt" ASC`,
    parentUserId,
  );
}

/** 출결을 달(KST)·상태별로 센다. 보강으로 대체된 «미리 알린 결석»은 따로 센다(분모에서 뺀다) */
async function attendanceByMonth(db: Reader, studentId: string): Promise<AttendanceMonthCount[]> {
  const day = kstNaive("se.date");
  const base = (makeup: string) => `
    SELECT to_char(${day}, 'YYYY-MM') AS ym,
           COUNT(*) FILTER (WHERE a.status = 'PRESENT')::int AS present,
           COUNT(*) FILTER (WHERE a.status = 'LATE')::int AS late,
           COUNT(*) FILTER (WHERE a.status = 'ABSENT')::int AS absent,
           ${makeup} AS "makeupReplaced"
      FROM "Attendance" a
      JOIN "Session" se ON se.id = a."sessionId"
     WHERE a."studentId" = $1
     GROUP BY 1
     ORDER BY 1`;
  // 판정: 결석(ABSENT) + 그날 그 반에 학부모·학원이 미리 알린 결석(RegularAbsence, 취소 아님)이 있고
  //       + 그 결석으로 나온 보강권(sourceKey REGULAR:{반}:{KST 날짜})을 보강 수업에서 «사용 완료(USED)» 했다
  const replaced = `COUNT(*) FILTER (WHERE a.status = 'ABSENT'
      AND EXISTS (SELECT 1 FROM "RegularAbsence" ra
                   WHERE ra."studentId" = a."studentId" AND ra."classId" = se."classId"
                     AND ra.date = (${day})::date AND ra.status <> 'CANCELLED')
      AND EXISTS (SELECT 1 FROM "MakeupCredit" mc
                   WHERE mc."studentId" = a."studentId" AND mc.status = 'USED'
                     AND mc."sourceKey" = 'REGULAR:' || se."classId" || ':' || to_char(${day}, 'YYYY-MM-DD'))
    )::int`;
  let rows: any[];
  try {
    rows = await db.$queryRawUnsafe<any[]>(base(replaced), studentId);
  } catch {
    // 보강권 표가 아직 없는 환경 — 보강 대체 없이(분모 그대로) 센다
    rows = await db.$queryRawUnsafe<any[]>(base("0"), studentId);
  }
  return rows.map((r) => ({ ym: String(r.ym), present: num(r.present), late: num(r.late), absent: num(r.absent), makeupReplaced: num(r.makeupReplaced) }));
}

/**
 * 아이 한 명의 전체 기록. 내 아이가 아니면(또는 병합된 옛 학생이면) null.
 * db 는 시험용으로 바꿔 끼울 수 있다(기본 prisma).
 */
export async function getChildRecord(parentUserId: string, studentId: string, db: Reader = prisma): Promise<ChildRecord | null> {
  if (!parentUserId || !studentId) return null;

  // ① 권한 재확인(IDOR) — 학생 id 와 로그인 보호자를 같은 SQL 에서 묶는다
  const owned = await db.$queryRawUnsafe<any[]>(
    `SELECT s.id, s.name,
            (s."tenureBaselineMonths" IS NOT NULL AND COALESCE(s."tenureBaselineThrough", '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') AS "hasBaseline",
            s."uniformStatus",
            to_char(s."uniformReceivedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "uniformReceivedYmd",
            (${await payerAccessSql("s", "$1")}) AS "canPay"
       FROM "Student" s
      WHERE s.id = $2 AND ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      LIMIT 1`,
    parentUserId,
    studentId,
  );
  const row = owned[0];
  if (!row) return null;
  const canPay = row.canPay === true;
  const sid = String(row.id);

  // ② 권한 확인 뒤에만 나머지(섹션별 실패는 그 섹션만 null)
  const [payments, attendance, timeline, seasonal, grant, reports, tenure] = await Promise.all([
    section("payments", async () => {
      const rows = await db.$queryRawUnsafe<any[]>(
        `SELECT p.id, p.type, p.status, p.amount, p.year, p.month,
                to_char(${kstNaive(`p."dueDate"`)}, 'YYYY-MM-DD') AS "dueYmd",
                to_char(${kstNaive(`p."paidDate"`)}, 'YYYY-MM-DD') AS "paidYmd",
                p.description, p."receiptUrl"
           FROM "Payment" p
          WHERE p."studentId" = $1 AND p.status NOT IN ('CANCELED', 'CANCELLED')
          ORDER BY p."dueDate" DESC NULLS LAST
          LIMIT 400`,
        sid,
      );
      return rows.map((p): RecordPaymentRow => ({
        id: String(p.id),
        type: p.type ?? "MONTHLY",
        status: String(p.status),
        amount: canPay ? num(p.amount) : null,
        year: p.year === null || p.year === undefined ? null : Number(p.year),
        month: p.month === null || p.month === undefined ? null : Number(p.month),
        dueYmd: p.dueYmd ?? null,
        paidYmd: p.paidYmd ?? null,
        description: p.description ?? null,
        receiptUrl: canPay ? (p.receiptUrl ?? null) : null,
      }));
    }),
    section("attendance", () => attendanceByMonth(db, sid)),
    section("timeline", async () => {
      const [enrollments, changes] = await Promise.all([
        db.$queryRawUnsafe<any[]>(
          `SELECT e.id, e."classId", c.name AS "className", e.status,
                  to_char(e."startsOn", 'YYYY-MM-DD') AS "startsOn",
                  to_char(${kstNaive(`e."createdAt"`)}, 'YYYY-MM-DD') AS "createdYmd",
                  to_char(${kstNaive(`e."updatedAt"`)}, 'YYYY-MM-DD') AS "updatedYmd"
             FROM "Enrollment" e
             JOIN "Class" c ON c.id = e."classId" AND c."dayOfWeek" <> 'Seasonal'
            WHERE e."studentId" = $1`,
          sid,
        ),
        db.$queryRawUnsafe<any[]>(
          `SELECT r.id, r."enrollmentId", r.kind, r.status,
                  to_char(r."effectiveFrom", 'YYYY-MM-DD') AS "effectiveFrom",
                  to_char(r."resumeOn", 'YYYY-MM-DD') AS "resumeOn",
                  r."fromClassId", r."toClassId", fc.name AS "fromClassName", tc.name AS "toClassName"
             FROM "EnrollmentChangeRequest" r
             LEFT JOIN "Class" fc ON fc.id = r."fromClassId"
             LEFT JOIN "Class" tc ON tc.id = r."toClassId"
            WHERE r."studentId" = $1 AND r.status IN ('APPLIED', 'APPROVED')`,
          sid,
        ),
      ]);
      return {
        enrollments: enrollments.map((e): TimelineEnrollment => ({
          id: String(e.id), classId: String(e.classId), className: e.className ?? "수강 반", status: String(e.status),
          startsOn: e.startsOn ?? null, createdYmd: e.createdYmd ?? null, updatedYmd: e.updatedYmd ?? null,
        })),
        changes: changes.map((c): TimelineChange => ({
          id: String(c.id), enrollmentId: c.enrollmentId ?? null, kind: String(c.kind), status: String(c.status),
          effectiveFrom: c.effectiveFrom ?? null, resumeOn: c.resumeOn ?? null,
          fromClassId: c.fromClassId ?? null, toClassId: c.toClassId ?? null,
          fromClassName: c.fromClassName ?? null, toClassName: c.toClassName ?? null,
        })),
      };
    }),
    section("seasonal", async () => {
      // 방학특강 — 시즌별 «n회 중 n회 출석». 취소·이동된 날짜는 빼고, 지난 회차(held)만 출석률 분모로 쓴다
      const rows = await db.$queryRawUnsafe<any[]>(
        `SELECT sea.id AS "seasonId", sea.title,
                to_char(sea."startsAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "startYmd",
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE sd."startsAt" <= now())::int AS held,
                COUNT(*) FILTER (WHERE d."attendanceStatus" IN ('PRESENT', 'LATE'))::int AS attended
           FROM "SpecialProgramEnrollmentDate" d
           JOIN "SpecialProgramSessionDate" sd ON sd.id = d."sessionDateId"
           JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
           JOIN "SpecialProgramSeason" sea ON sea.id = o."seasonId"
          WHERE d."studentId" = $1 AND d.status = 'SCHEDULED'
          GROUP BY sea.id, sea.title, sea."startsAt"
          ORDER BY sea."startsAt" DESC`,
        sid,
      );
      return rows.map((r): SeasonalRecord => ({
        seasonId: String(r.seasonId), title: r.title ?? "방학특강", startYmd: r.startYmd ?? null,
        total: num(r.total), held: num(r.held), attended: num(r.attended),
      }));
    }),
    // 3년 무료 유니폼 링크 — 토큰(링크 주소)은 고르지 않는다. 상태·만료 여부만
    section("uniform", () =>
      db.$queryRawUnsafe<any[]>(
        `SELECT g.status, (g."expiresAt" < now()) AS expired
           FROM "UniformFreeGrant" g
          WHERE g."studentId" = $1 AND g.status <> 'REVOKED'
          ORDER BY g."createdAt" DESC
          LIMIT 1`,
        sid,
      ),
    ),
    section("reports", async () => {
      const rows = await db.$queryRawUnsafe<any[]>(
        `SELECT
           (SELECT COUNT(DISTINCT se.id) FROM "Session" se JOIN "Attendance" a ON a."sessionId" = se.id
             WHERE a."studentId" = $1 AND se.published = true)::int AS reports,
           (SELECT COUNT(*) FROM "Feedback" f WHERE f."studentId" = $1 AND f."isPublic" = true)::int AS feedbacks`,
        sid,
      );
      return { reports: num(rows[0]?.reports), feedbacks: num(rows[0]?.feedbacks) };
    }),
    // 다닌 기간 — 권한 확인을 통과한 학생에게만 부른다(getStudentTenure 는 권한을 보지 않는다)
    section("tenure", () => getStudentTenure(sid)),
  ]);

  const g = grant?.[0];
  return {
    student: { id: sid, name: String(row.name ?? ""), canPay, hasBaseline: row.hasBaseline === true },
    today: todayKst(),
    payments,
    attendance,
    timeline,
    seasonal,
    uniform: {
      status: row.uniformStatus ?? null,
      receivedYmd: row.uniformReceivedYmd ?? null,
      freeGrant: g ? { status: String(g.status), expired: g.expired === true } : null,
    },
    reports,
    tenure: tenure ? { label: tenure.label, firstMonth: tenure.firstMonth } : null,
  };
}

/**
 * 홈 히어로 아래 한 줄 «다닌 지 n년 n개월 · 올해 출석 n%» — 아이마다.
 * 아이 목록은 이 함수가 다시 권한 확인한다(넘겨받은 id 를 믿지 않는다). 실패하면 빈 객체(줄은 «전체 기록»).
 */
export async function getChildRecordHomeLines(parentUserId: string, db: Reader = prisma): Promise<Record<string, string>> {
  if (!parentUserId) return {};
  const today = todayKst();
  const year = Number(today.slice(0, 4));
  const kids = await db.$queryRawUnsafe<any[]>(
    `SELECT s.id,
            (s."tenureBaselineMonths" IS NOT NULL AND COALESCE(s."tenureBaselineThrough", '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') AS "hasBaseline"
       FROM "Student" s
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}`,
    parentUserId,
  );
  const out: Record<string, string> = {};
  await Promise.all(
    kids.map(async (k) => {
      const sid = String(k.id);
      const [tenure, months] = await Promise.all([
        getStudentTenure(sid).catch(() => null),
        attendanceByMonth(db, sid).catch(() => [] as AttendanceMonthCount[]),
      ]);
      out[sid] = homeRecordLine({ tenureLabel: tenure?.label ?? null, hasBaseline: k.hasBaseline === true, yearRate: yearAttendance(months, year).rate });
    }),
  );
  return out;
}
