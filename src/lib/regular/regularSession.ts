// 정규 수업 기록(Session) «같은 반·같은 날 = 기록 하나» 판정 — 모든 입력 경로가 이 파일 하나를 쓴다.
//
// 왜 필요한가(2026-11-08):
//   코치 앱은 수업 기록을 sessionKey(`반id:YYYY-MM-DD`)로 찾고, 관리자 출결 저장은 키 없이
//   (반 + 날짜)로 찾은 뒤 없으면 **키 없는** 기록을 새로 만들었다. 그래서 관리자가 먼저 출결을
//   저장한 날 코치가 수업을 시작하면, 코치 쪽은 키로 못 찾고 기록을 하나 더 만든다 →
//   같은 반·같은 날 수업 기록이 둘로 갈라지고 출결이 반씩 나뉜다.
//   이제 모든 경로가 ① 키 없는 옛 기록이 있으면 그 기록에 키를 붙이고(입양) ② 그 키로 찾거나 만든다.
//
// DB 접근은 인자로 받은 db(트랜잭션) 하나로만 한다 — prisma 를 직접 import 하지 않아
// 테스트가 가짜 db 로 실제 실행해 볼 수 있다. (PgBouncer 때문에 $queryRawUnsafe/$executeRawUnsafe 만 쓴다)
import { isKstYmd } from "@/lib/datetime/kst";

/** 트랜잭션 안의 db. prisma.$transaction 콜백의 tx 를 그대로 넘긴다. */
export type RegularSessionDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** 정규 수업 기록의 자연키 — 같은 반·같은 날(KST 달력 날짜)이면 반드시 같은 키. */
export function regularSessionKey(classId: string, dateYmd: string): string {
  if (!classId) throw new Error("수업 정보가 없습니다.");
  if (!isKstYmd(dateYmd)) throw new Error("수업 날짜를 다시 확인해 주세요.");
  return `${classId}:${dateYmd}`;
}

/**
 * 같은 키를 동시에 다루는 요청을 줄 세운다(트랜잭션이 끝나면 자동으로 풀린다).
 * 관리자 저장과 코치 시작이 같은 순간에 들어와도 «입양 → 찾기/만들기» 가 섞이지 않게 한다.
 */
async function lockRegularSessionKey(db: RegularSessionDb, key: string) {
  // pg_advisory_xact_lock 은 void 를 돌려줘 $queryRawUnsafe 로 부르면 역직렬화에 실패한다 → execute 로 부른다.
  await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `regular-session:${key}`);
}

/**
 * 키 없이 만들어진 옛 기록(관리자가 먼저 저장한 날)을 찾아 키를 붙인다.
 * - 이미 그 키를 가진 기록이 있으면 아무것도 하지 않는다(키 기록이 정본).
 * - 방학특강 회차 기록(specialProgramSessionDateId 있음)은 건드리지 않는다.
 * - 같은 날 키 없는 기록이 여럿이면 가장 먼저 만든 것 하나만 입양한다.
 * ⚠️ 반드시 트랜잭션 안에서 부른다(위 잠금이 트랜잭션 단위다).
 */
export async function adoptRegularSessionKey(db: RegularSessionDb, classId: string, dateYmd: string): Promise<number> {
  const key = regularSessionKey(classId, dateYmd);
  await lockRegularSessionKey(db, key);
  const n = await db.$executeRawUnsafe(
    `UPDATE "Session" SET "sessionKey" = $3, "updatedAt" = NOW()
      WHERE id = (
        SELECT id FROM "Session"
         WHERE "classId" = $1 AND date::date = $2::date
           AND "specialProgramSessionDateId" IS NULL AND "sessionKey" IS NULL
         ORDER BY "createdAt", id
         LIMIT 1
      )
        AND NOT EXISTS (SELECT 1 FROM "Session" WHERE "sessionKey" = $3)`,
    classId, dateYmd, key,
  );
  return Number(n);
}

/**
 * 같은 반·같은 날 정규 수업 기록의 id — 있으면 그것, 없으면 새로 만든다(시작 전 PLANNED).
 * 관리자 출결 저장·수업일지·랠리즈 반영이 모두 이 함수를 쓴다. 코치 «수업 시작»은 상태 전이가
 * 따로 있어 adoptRegularSessionKey + regularSessionKey 로 같은 규칙을 탄다.
 * ⚠️ 반드시 트랜잭션 안에서 부른다.
 */
export async function findOrCreateRegularSession(
  db: RegularSessionDb,
  input: { classId: string; dateYmd: string },
): Promise<string> {
  const key = regularSessionKey(input.classId, input.dateYmd);
  await adoptRegularSessionKey(db, input.classId, input.dateYmd);
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "Session" (id, "classId", date, "sessionKey", status, "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2::date, $3, 'PLANNED', NOW(), NOW())
     ON CONFLICT ("sessionKey") DO UPDATE SET "updatedAt" = NOW()
     RETURNING id`,
    input.classId, input.dateYmd, key,
  );
  if (!rows[0]?.id) throw new Error("수업 기록을 만들지 못했습니다.");
  return rows[0].id;
}

/**
 * 수업일지(관리자 «수업 기록») 저장 대상 기록 id.
 * - 수정(sessionId 있음): 반 상세의 수업 목록은 이 반에 연결된 방학특강 회차 기록도 보여 준다.
 *   그래서 날짜로 다시 찾지 않고(= 정규 기록을 새로 만들지 않고) 화면이 고른 그 기록을 그대로 고친다.
 *   단, 그 기록이 정말 이 반의 기록인지 확인한다(다른 반 기록을 id 로 고치는 것을 막는다).
 * - 새로 작성(sessionId 없음): 같은 반·같은 날 정규 기록 하나 규칙(findOrCreateRegularSession).
 * ⚠️ 반드시 트랜잭션 안에서 부른다(수정 대상 행을 잠근다).
 */
export async function resolveSessionLogTarget(
  db: RegularSessionDb,
  input: { classId: string; dateYmd: string; sessionId?: string | null },
): Promise<string> {
  if (input.sessionId) {
    const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Session" WHERE id = $1 AND "classId" = $2 FOR UPDATE`,
      input.sessionId, input.classId,
    );
    if (!rows[0]?.id) throw new Error("수정할 수업 기록을 이 반에서 찾지 못했습니다. 화면을 새로고침해 주세요.");
    return rows[0].id;
  }
  return findOrCreateRegularSession(db, { classId: input.classId, dateYmd: input.dateYmd });
}
