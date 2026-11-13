/**
 * 결제 권한 판정 — «이 로그인 사용자가 이 학생의 청구를 결제해도 되는가»를 정하는 한 곳(2026-11-13 f8).
 *
 * ■ 왜 따로 두는가
 *   예전엔 결제 경로마다 «청구서의 대표 보호자(Student.parentId) 본인인가»만 봤다. 그래서 가족 승인으로 연결된
 *   두 번째 보호자(아빠 등)는 청구를 보기만 하고 결제는 못 했다. 결제 시작(단건·묶음)·토스 승인 직전·화면의
 *   «결제하기» 버튼이 같은 기준을 써야 «버튼은 보이는데 서버가 거부»하거나 그 반대가 생기지 않는다.
 *
 * ■ 규칙
 *   결제 가능 = 학생이 이 사용자와 «연결»돼 있다 = 주 보호자(Student.parentId) 이거나, 승인된(ACTIVE) 가족 연결
 *   (ParentStudentAccess). 마이페이지 «내 자녀» 범위(childAccessSql)와 같은 기준이다.
 *   - 승인 대기(ChildLinkRequest PENDING)·거절·해제(REVOKED)된 연결은 ParentStudentAccess ACTIVE 가 아니라 불가.
 *   - 탈퇴한 계정은 불가.
 *   - 연결 안 된 학생의 청구 id 를 넣으면 null(IDOR 차단) — 화면이 아니라 서버가 막는다.
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — db 를 인자로 받아 `node --test` 에서 가짜 db 로 실행 검증한다.
 */
import { childAccessSql } from "@/lib/account/child-access";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

/** 결제하는 사람(앱 계정) — 토스 결제창 고객 정보·영수증 수신·«지난번 결제 방법» 기억에 쓴다 */
export type PayerAccount = { id: string; name: string | null; email: string | null; phone: string | null };

/** 조회 한 줄 = 계정 1개 × (연결된 학생 1명 또는 null) */
export type PayerLinkRow = PayerAccount & { studentId: string | null };

/**
 * 결제 권한 SQL 조각 — 학생(studentAlias)이 사용자(userExpression)와 연결돼 있는가.
 * 지금은 «내 자녀» 보기 범위와 같다(가족 연결 표가 없으면 주 보호자만). 결제 경로는 반드시 이 함수를 거친다.
 * 식별자 검사는 childAccessSql 이 한다(코드에 적힌 별칭·$n 만 받는다).
 */
export async function payerAccessSql(studentAlias: string, userExpression: string): Promise<string> {
    return childAccessSql(studentAlias, userExpression);
}

/**
 * [순수] 같은 로그인으로 찾은 계정 줄들 중에서, 요청한 학생 «전부»와 연결된 계정 하나를 고른다.
 * 한 명이라도 연결이 없으면 null — 묶음 결제에 남의 아이 청구를 섞어도 통째로 거부한다.
 */
export function pickLinkedPayer(rows: readonly PayerLinkRow[], studentIds: readonly string[]): PayerAccount | null {
    const needed = [...new Set(studentIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (needed.length === 0) return null;
    const byUser = new Map<string, { account: PayerAccount; linked: Set<string> }>();
    for (const row of rows) {
        if (!row?.id) continue;
        const entry = byUser.get(row.id) ?? {
            account: { id: row.id, name: row.name ?? null, email: row.email ?? null, phone: row.phone ?? null },
            linked: new Set<string>(),
        };
        if (row.studentId) entry.linked.add(row.studentId);
        byUser.set(row.id, entry);
    }
    // 계정 id 순으로 보아 결과가 매번 같게 한다
    for (const id of [...byUser.keys()].sort()) {
        const entry = byUser.get(id)!;
        if (needed.every((studentId) => entry.linked.has(studentId))) return entry.account;
    }
    return null;
}

/**
 * 로그인(authUserId — 옛 직접 로그인은 User.id) → 이 학생들의 청구를 결제할 수 있는 앱 계정. 없으면 null.
 * 결제 시작(단건·묶음)·토스 승인 직전이 모두 이 함수를 쓴다.
 */
export async function resolveLinkedPayer(
    db: Reader,
    authUserId: string,
    studentIds: readonly string[],
): Promise<PayerAccount | null> {
    const ids = [...new Set(studentIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (!authUserId || ids.length === 0) return null;
    const rows = await db.$queryRawUnsafe<PayerLinkRow[]>(
        `SELECT u.id, u.name, u.email, u.phone, s.id AS "studentId"
           FROM "User" u
           LEFT JOIN "Student" s ON s.id = ANY($2::text[]) AND ${await payerAccessSql("s", 'u."id"')}
          WHERE (u."authUserId" = $1 OR (u."authUserId" IS NULL AND u.id = $1))
            AND u."withdrawnAt" IS NULL
          ORDER BY u.id`,
        authUserId,
        ids,
    );
    return pickLinkedPayer(rows, ids);
}
