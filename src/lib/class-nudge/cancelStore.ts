// 수업 미처리 장치(2026-11-17) — «오늘 이 반 휴강» 표시 넣기·지우기.
//
// 이 표시는 그날 그 수업의 **독촉만 멈춘다.** 학부모 화면·청구·보강권·셔틀·출결에는 아무것도 쓰지 않고,
// 표 "ClassDayCancel" 을 읽는 곳도 src/lib/class-nudge 뿐이다(tests/class-nudge-dashboard.test.mjs 가 못박는다).
//
// - DB 는 인자로 받는다(테스트가 가짜 db 로 그대로 실행한다). prisma·next import 금지.
// - 취소 = 행 삭제 + 감사 기록. «누가 언제 눌렀나·풀었나»는 OperationsAuditLog 두 줄로 남는다.
// - 표가 아직 없으면(운영 적용 전, 42P01) 오류로 죽지 않고 «준비 중» 결과를 돌려준다.
import { sessionKstDateSql } from "@/lib/feed/rules";
import { isMissingCancelTable, type ClassNudgeDb } from "./boardQuery";
import { CANCEL_BUSY_MESSAGE, CANCEL_NOT_READY_MESSAGE, validateCancelInput } from "./rules";

export type CancelStoreResult = { ok: true; changed: boolean } | { ok: false; message: string };

/** 쓰기 두 문장(표시 + 감사 기록)을 한 트랜잭션으로 묶는 실행기. 넘기지 않으면 받은 db 로 그대로 실행한다(테스트). */
export type CancelTransact = <T>(run: (tx: ClassNudgeDb) => Promise<T>) => Promise<T>;

export type CancelStoreInput = {
  date: unknown;
  /** 오늘(KST) — 시계는 부르는 쪽이 읽어 넘긴다 */
  today: string;
  classId: unknown;
  kind: unknown;
  startTime?: unknown;
  reason?: unknown;
  /** 누른 원장·부원장 User.id */
  actorUserId: string;
};

const SEASONAL_OCCURRENCE_WHERE = `o."linkedClassId" = $1
        AND (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $2::date
        AND to_char(sd."startsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') = $3`;

async function findClass(db: ClassNudgeDb, classId: string): Promise<{ name: string; dayOfWeek: string } | null> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string; dayOfWeek: string }>>(
    `SELECT name, "dayOfWeek" FROM "Class" WHERE id = $1 LIMIT 1`,
    classId,
  );
  return rows[0] ?? null;
}

async function writeAudit(
  tx: ClassNudgeDb,
  action: "CLASS_DAY_CANCEL_SET" | "CLASS_DAY_CANCEL_CLEARED",
  actorUserId: string,
  details: { date: string; classId: string; kind: string; startTime: string; className: string; reason: string | null },
): Promise<void> {
  // 개인정보 없음 — 날짜·반·사유만 남긴다
  await tx.$executeRawUnsafe(
    `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
     VALUES (gen_random_uuid()::text, $1, 'ADMIN', $2, $3::jsonb)`,
    action,
    actorUserId,
    JSON.stringify(details),
  );
}

/**
 * 휴강 표시 넣기. 같은 표시가 이미 있으면 아무것도 하지 않고 성공(changed=false, 감사 기록도 남기지 않는다).
 * 거부하는 경우: 오늘이 아님 · 요일 불일치 · 그 시각의 특강 회차가 없음 · 이미 시작했거나 출결이 있는 수업.
 */
export async function setClassDayCancelInDb(
  db: ClassNudgeDb,
  input: CancelStoreInput,
  transact: CancelTransact = (run) => run(db),
): Promise<CancelStoreResult> {
  const classId = String(input.classId ?? "").trim();
  if (!classId) return { ok: false, message: "반 정보를 찾을 수 없습니다." };
  const klass = await findClass(db, classId);
  if (!klass) return { ok: false, message: "반 정보를 찾을 수 없습니다." };

  const checked = validateCancelInput({
    date: input.date, today: input.today, kind: input.kind,
    classDayOfWeek: klass.dayOfWeek, startTime: input.startTime, reason: input.reason,
  });
  if (!checked.ok) return checked;
  const date = String(input.date).trim();
  const kind = input.kind === "SEASONAL" ? "SEASONAL" : "REGULAR";

  if (kind === "SEASONAL") {
    // 그 반·그 날짜·그 시작 시각의 회차가 실제로 있어야 한다(요청 값 조작·낡은 화면 방지)
    const occurrence = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT sd.id
         FROM "SpecialProgramSessionDate" sd
         JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId" AND o.status <> 'CANCELLED'
        WHERE ${SEASONAL_OCCURRENCE_WHERE}
        LIMIT 1`,
      classId, date, checked.startTime,
    );
    if (!occurrence[0]) return { ok: false, message: "그 시각의 특강 회차를 찾을 수 없습니다. 화면을 새로 불러와 주세요." };

    // 이미 시작했거나 출결이 있는 회차는 거부 — 실제 수업이 있었는데 독촉만 꺼지는 것을 막는다.
    // 학부모가 미리 낸 결석 신고(좌석 EXCUSED)는 «수업이 있었다»는 뜻이 아니라 막지 않는다.
    const busy = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT sd.id
         FROM "SpecialProgramSessionDate" sd
         JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
        WHERE ${SEASONAL_OCCURRENCE_WHERE}
          AND (
            EXISTS (
              SELECT 1 FROM "Session" se
               WHERE se."specialProgramSessionDateId" = sd.id
                 AND (se.status IN ('IN_PROGRESS', 'COMPLETED')
                      OR EXISTS (SELECT 1 FROM "Attendance" a WHERE a."sessionId" = se.id))
            )
            OR EXISTS (
              SELECT 1 FROM "SpecialProgramEnrollmentDate" ed
               WHERE ed."sessionDateId" = sd.id AND ed.status = 'SCHEDULED'
                 AND ed."attendanceStatus" IN ('PRESENT', 'LATE', 'ABSENT')
            )
          )
        LIMIT 1`,
      classId, date, checked.startTime,
    );
    if (busy[0]) return { ok: false, message: CANCEL_BUSY_MESSAGE };
  } else {
    const busy = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT se.id
         FROM "Session" se
        WHERE se."classId" = $1
          AND se."specialProgramSessionDateId" IS NULL
          AND ${sessionKstDateSql("se")} = $2::date
          AND (se.status IN ('IN_PROGRESS', 'COMPLETED')
               OR EXISTS (SELECT 1 FROM "Attendance" a WHERE a."sessionId" = se.id))
        LIMIT 1`,
      classId, date,
    );
    if (busy[0]) return { ok: false, message: CANCEL_BUSY_MESSAGE };
  }

  try {
    const changed = await transact(async (tx) => {
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "ClassDayCancel" (id, date, "classId", kind, "startTime", reason, "createdBy", "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (date, "classId", kind, "startTime") DO NOTHING
         RETURNING id`,
        date, classId, kind, checked.startTime, checked.reason, input.actorUserId,
      );
      // 새로 들어갔을 때만 감사 기록(같은 버튼을 두 번 눌러도 기록은 한 줄)
      if (!inserted[0]) return false;
      await writeAudit(tx, "CLASS_DAY_CANCEL_SET", input.actorUserId, {
        date, classId, kind, startTime: checked.startTime, className: klass.name, reason: checked.reason,
      });
      return true;
    });
    return { ok: true, changed };
  } catch (error) {
    if (isMissingCancelTable(error)) return { ok: false, message: CANCEL_NOT_READY_MESSAGE };
    throw error;
  }
}

/** 휴강 표시 지우기. 지울 것이 없으면 아무것도 하지 않고 성공(changed=false). */
export async function clearClassDayCancelInDb(
  db: ClassNudgeDb,
  input: Omit<CancelStoreInput, "reason">,
  transact: CancelTransact = (run) => run(db),
): Promise<CancelStoreResult> {
  const classId = String(input.classId ?? "").trim();
  if (!classId) return { ok: false, message: "반 정보를 찾을 수 없습니다." };
  const klass = await findClass(db, classId);
  if (!klass) return { ok: false, message: "반 정보를 찾을 수 없습니다." };

  const checked = validateCancelInput({
    date: input.date, today: input.today, kind: input.kind,
    classDayOfWeek: klass.dayOfWeek, startTime: input.startTime,
  });
  if (!checked.ok) return checked;
  const date = String(input.date).trim();
  const kind = input.kind === "SEASONAL" ? "SEASONAL" : "REGULAR";

  try {
    const changed = await transact(async (tx) => {
      const deleted = await tx.$queryRawUnsafe<Array<{ id: string; reason: string | null }>>(
        `DELETE FROM "ClassDayCancel"
          WHERE date = $1 AND "classId" = $2 AND kind = $3 AND "startTime" = $4
          RETURNING id, reason`,
        date, classId, kind, checked.startTime,
      );
      if (!deleted[0]) return false;
      await writeAudit(tx, "CLASS_DAY_CANCEL_CLEARED", input.actorUserId, {
        date, classId, kind, startTime: checked.startTime, className: klass.name, reason: deleted[0].reason ?? null,
      });
      return true;
    });
    return { ok: true, changed };
  } catch (error) {
    if (isMissingCancelTable(error)) return { ok: false, message: CANCEL_NOT_READY_MESSAGE };
    throw error;
  }
}
