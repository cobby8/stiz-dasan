/**
 * 관리자가 원생을 «직접» 등록할 때 학생을 어느 학부모 계정(User)에 붙일지 정하는 한 곳.
 *
 * ■ 왜 따로 두는가 (2026-11-09 사고)
 *   목록 «원생 등록»·체험 «정규 전환»이 학부모 계정을 **이메일로만** 찾고, 찾으면 그 계정의
 *   이름·번호를 입력값으로 **덮어썼다**(역할 확인 없음). 원장이 자기 이메일을 넣자 학생이
 *   원장(ADMIN) 계정에 붙고 원장 계정 이름·번호가 학부모 값으로 바뀌었다.
 *   두 경로가 같은 코드를 복사해 갖고 있어서, 규칙을 이 파일 하나로 모았다.
 *
 * ■ 규칙
 *   1. 찾는 열쇠 = 주 보호자 휴대폰 숫자(이메일은 매칭에 쓰지 않는다).
 *   2. 후보는 PARENT 가 1순위. PARENT 가 0명이고 같은 번호 직원(ADMIN·VICE_ADMIN·INSTRUCTOR·DRIVER)이 딱 1명이면
 *      그 직원 계정에 붙인다(원장 결정 2026-11-09 «직원 자녀는 그냥 붙여»). 2명 이상이면 고르게 한다.
 *   3. 기존 계정의 이름·번호·이메일은 **UPDATE 하지 않는다.** 입력한 보호자 정보는 Guardian(주 보호자)에만 쓴다.
 *   4. PARENT·직원 후보 모두 0명 → 신청서 승인과 같은 형식의 빈 학부모 계정(`parent_<번호>@stiz.local`)을 만든다.
 *      학부모가 나중에 같은 번호로 가입하면 가입 흐름(parent-signup-verification)이 이 계정을 이어받는다.
 *      PARENT 1명 → 그 계정. 같은 등급 후보 2명 이상 → 오류(학생 상세에서 직접 고르게).
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — db 를 인자로 받아 `node --test` 에서 가짜 db 로 실행 검증한다.
 */
import { isUsablePhoneKey } from "@/lib/enrollment/parentIdentity";
import { isValidGuardianPhone, MAX_NAME_LENGTH, MAX_RELATION_LENGTH, normalizeGuardianPhone } from "@/lib/guardians/guardianLogic";
import { isSyntheticParentEmail } from "@/lib/parent-synthetic-email";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };
/** prisma 트랜잭션(tx)과 테스트용 가짜 db 가 둘 다 맞는 최소 모양 */
export type ParentLinkDb = Reader & { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> };
type Writer = ParentLinkDb;

/** 등록 화면에서 받은 주 보호자 입력 */
export type PrimaryGuardianInput = {
    relation?: string | null;
    name?: string | null;
    phone?: string | null;
};

/** 검증을 통과한 주 보호자 값 — phone 은 숫자만(저장 형식) */
export type PrimaryGuardian = { relation: string; name: string; phone: string };

/** 같은 번호로 찾은 계정 한 줄 */
export type PhoneAccountRow = { id: string; role: string };

/** 후보 판정 결과 */
export type ParentAccountDecision =
    | { kind: "USE_EXISTING"; parentId: string; staffAccount: boolean }
    | { kind: "CREATE_NEW" }
    | { kind: "AMBIGUOUS"; accountCount: number };

/** 학생을 붙여도 되는 직원 역할(PARENT 후보가 없을 때만). 그 밖의 역할은 후보로 쓰지 않는다 */
export const STAFF_ROLES: ReadonlySet<string> = new Set(["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER"]);

/** 화면에 그대로 보여 줄 수 있는 안내 문구를 담은 오류(서버 액션이 { ok:false, error } 로 바꿔 돌려준다) */
export class ParentAccountLinkError extends Error {}

export const AMBIGUOUS_PARENT_MESSAGE =
    "같은 번호의 학부모(또는 직원) 계정이 여러 개라 자동으로 연결하지 않았습니다. 기존 학생 상세에서 계정을 확인한 뒤 직접 골라 주세요.";

/**
 * 주 보호자 입력 검증. 관계·이름·휴대폰 셋 다 필수.
 * 휴대폰은 Guardian 저장 규칙(isValidGuardianPhone)과 계정 찾기 열쇠 규칙(isUsablePhoneKey)을 모두 통과해야 한다
 * — 빈 번호·자리채움 번호(00000000000)로 남의 계정에 붙는 일을 막는다.
 */
export function validatePrimaryGuardian(input: PrimaryGuardianInput | null | undefined):
    { ok: true; value: PrimaryGuardian } | { ok: false; error: string } {
    const relation = String(input?.relation ?? "").trim();
    const name = String(input?.name ?? "").trim();
    const phone = normalizeGuardianPhone(input?.phone);
    if (!relation) return { ok: false, error: "주 보호자 관계(예: 엄마, 아빠)를 입력해 주세요." };
    if (relation.length > MAX_RELATION_LENGTH) return { ok: false, error: `관계는 ${MAX_RELATION_LENGTH}자 이내로 입력해 주세요.` };
    if (!name) return { ok: false, error: "주 보호자 이름을 입력해 주세요." };
    if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `보호자 이름은 ${MAX_NAME_LENGTH}자 이내로 입력해 주세요.` };
    if (!phone) return { ok: false, error: "주 보호자 휴대폰 번호를 입력해 주세요." };
    if (!isValidGuardianPhone(phone) || !isUsablePhoneKey(phone)) {
        return { ok: false, error: "주 보호자 휴대폰 번호 형식이 올바르지 않습니다. (예: 010-1234-5678)" };
    }
    return { ok: true, value: { relation, name, phone } };
}

/**
 * 같은 번호 계정 목록 → 어떻게 연결할지 판정(순수 함수).
 * PARENT 가 1순위, PARENT 가 없을 때만 같은 번호 직원 계정(1명일 때)을 쓴다. 2명 이상이면 고르게 한다.
 */
export function decideParentAccount(rows: PhoneAccountRow[]): ParentAccountDecision {
    const parents = rows.filter((row) => row.role === "PARENT");
    const staff = rows.filter((row) => STAFF_ROLES.has(row.role));
    // 1순위 PARENT — 1명이면 그 계정, 2명 이상이면 고르게 한다
    if (parents.length === 1) return { kind: "USE_EXISTING", parentId: parents[0].id, staffAccount: false };
    if (parents.length > 1) return { kind: "AMBIGUOUS", accountCount: parents.length };
    // 2순위 직원(원장 결정 2026-11-09 «직원 자녀는 그냥 붙여») — PARENT 가 없고 같은 번호 직원이 딱 1명이면 그 계정에 붙인다
    if (staff.length === 1) return { kind: "USE_EXISTING", parentId: staff[0].id, staffAccount: true };
    if (staff.length > 1) return { kind: "AMBIGUOUS", accountCount: staff.length };
    return { kind: "CREATE_NEW" };
}

/** 빈 학부모 계정의 합성 이메일 — 신청서 승인(approveEnrollApplication)과 같은 형식 */
export function placeholderParentEmail(digits: string): string {
    return `parent_${digits}@stiz.local`;
}

/** 같은 번호 동시 등록을 한 줄로 세우는 잠금 열쇠 — 승인 경로(resolveApprovalParent)와 같은 열쇠라 서로도 줄을 선다 */
export function parentPhoneLockKey(digits: string): string {
    return `enrollment-parent:${digits}`;
}

/**
 * 학생 정보 수정 화면이 학부모 계정(User)의 이름·번호를 고쳐도 되는가.
 * 학원이 만든 «빈 계정»(PARENT + 로그인 미연결 + 합성 이메일)만 허용한다.
 * 로그인하는 학부모 본인 계정·직원 계정은 관리자가 고치지 않는다. 이메일은 어떤 경우에도 고치지 않는다.
 */
export function canAdminEditParentAccount(account: { role?: string | null; authUserId?: string | null; email?: string | null } | null | undefined): boolean {
    if (!account) return false;
    return account.role === "PARENT" && !account.authUserId && isSyntheticParentEmail(account.email);
}

/**
 * [트랜잭션 안에서] 주 보호자 번호로 학부모 계정을 확정한다. 기존 계정은 읽기만 한다.
 * @returns parentId · created(빈 계정을 새로 만들었는지) · staffAccount(PARENT 가 없어 같은 번호 직원 계정에 붙였는지)
 */
export async function linkParentAccountForNewStudent(tx: Writer, guardian: PrimaryGuardian) {
    const digits = guardian.phone;
    if (!isUsablePhoneKey(digits)) throw new ParentAccountLinkError("주 보호자 휴대폰 번호 형식이 올바르지 않습니다.");

    // 같은 번호를 두 화면에서 동시에 등록해도 빈 계정이 두 개 생기지 않게 줄을 세운다(트랜잭션 끝에 자동 해제).
    await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))`, parentPhoneLockKey(digits));

    // 저장 형식이 '010-…'·'010…' 으로 섞여 있어 숫자만 남겨 비교한다. 탈퇴(익명화) 계정은 제외.
    const rows = await tx.$queryRawUnsafe<PhoneAccountRow[]>(
        `SELECT id, role::text AS role FROM "User"
          WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
            AND "withdrawnAt" IS NULL
          ORDER BY id FOR UPDATE`,
        digits,
    );

    const decision = decideParentAccount(rows);
    if (decision.kind === "AMBIGUOUS") throw new ParentAccountLinkError(AMBIGUOUS_PARENT_MESSAGE);
    if (decision.kind === "USE_EXISTING") {
        // 기존 계정(학부모든 직원이든)의 이름·번호·이메일은 건드리지 않는다(입력값은 Guardian 에만 쓴다).
        return { parentId: decision.parentId, created: false, staffAccount: decision.staffAccount };
    }

    // 0명 → 빈 학부모 계정 생성. 같은 합성 이메일이 이미 있으면(번호가 바뀐 옛 빈 계정) 충돌 없이 넘기고 uuid 형식으로 다시 만든다.
    // (트랜잭션 안에서 unique 오류가 나면 트랜잭션 전체가 깨지므로 ON CONFLICT 로 피한다)
    const inserted = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'PARENT', NOW(), NOW())
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        placeholderParentEmail(digits), guardian.name, digits,
    );
    if (inserted[0]?.id) return { parentId: inserted[0].id, created: true, staffAccount: false };

    const fallback = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, 'parent_' || gen_random_uuid()::text || '@stiz.local', $1, $2, 'PARENT', NOW(), NOW())
         RETURNING id`,
        guardian.name, digits,
    );
    return { parentId: fallback[0].id, created: true, staffAccount: false };
}

/** [트랜잭션 안에서] 방금 만든 학생에게 주 보호자 Guardian 1건을 넣는다(새 학생이라 다른 주 보호자는 없다). */
export async function insertPrimaryGuardian(tx: Writer, studentId: string, guardian: PrimaryGuardian) {
    await tx.$executeRawUnsafe(
        `INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, true, NOW(), NOW())`,
        studentId, guardian.relation, guardian.name, guardian.phone,
    );
}
