/**
 * 형제 간편 연결(2026-11-13 f8) — 본인인증 한 번으로 «학원에 같은 보호자 휴대폰 번호로 등록된 아이들»을 한꺼번에 제안하는 순수 규칙.
 *
 * ■ 왜 필요한가
 *   가족 승인 요청은 아이 1명당 본인인증 1번을 쓴다(인증 증명을 요청마다 소모). 형제가 셋이면 인증을 세 번 해야 했다.
 *
 * ■ 규칙(아이마다 하나로 정한다)
 *   - 대상: 학원이 등록한 번호 중 «주 보호자 계정 번호» 또는 «보호자(Guardian) 번호»가 본인인증한 번호와 같은 아이.
 *     번호 비교는 기존 정규화(normalizeGuardianPhone — 하이픈·+82 정리)로 숫자만 맞춘다. 다른 번호는 제외.
 *   - ALREADY_LINKED : 이미 내 아이(주 보호자이거나 승인된 연결) — 할 일 없음
 *   - PENDING        : 이미 가족 승인 요청을 보내 기다리는 중 — 또 보내지 않는다
 *   - LINK           : 주 보호자 계정이 학원이 만든 «빈 계정»(로그인 없음·합성 이메일)이고 그 번호가 내 번호 = 바로 연결
 *   - REQUEST_APPROVAL : 다른 사람이 쓰는 계정이 주 보호자 — 자동으로 권한을 넘기지 않고 기존 규칙대로 그 계정에 가족 승인 요청
 *   - ASK_ACADEMY    : 승인해 줄 수 있는 계정이 없다(빈 계정인데 번호가 다름·인증 안 된 계정 등) — 학원 문의 안내
 *   주 보호자(Student.parentId)는 어떤 경우에도 바꾸지 않는다.
 *
 * ■ 화면으로 내보내는 값은 이름 + 반 이름 + 처리 방법뿐 — 학생 id·번호·다른 보호자 정보는 내보내지 않는다.
 * ■ 이 파일은 prisma·next 를 import 하지 않는다(`node --test` 로 실행 검증).
 */
import { normalizeGuardianPhone } from "@/lib/guardians/guardianLogic";
import { isSyntheticParentEmail } from "@/lib/parent-synthetic-email";

/** DB 에서 읽은 후보 1줄(서버 안에서만 쓴다 — 화면으로 보내지 않는다) */
export type SiblingCandidateRow = {
    studentId: string;
    studentName: string;
    /** 지금 다니는 반 이름(여럿이면 «, »로 이은 것). 없으면 null */
    className: string | null;
    primaryId: string;
    primaryRole: string | null;
    primaryAuthUserId: string | null;
    primaryEmail: string | null;
    primaryPhone: string | null;
    /** 주 보호자 계정이 가족 승인을 할 수 있는가(로그인 수단 있음·휴대폰 인증·탈퇴 아님) */
    primaryCanApprove: boolean;
    /** 이 아이의 보호자(Guardian) 번호들(원본 형식) */
    guardianPhones: Array<string | null> | null;
    /** 이미 이 사용자와 연결(주 보호자 또는 ACTIVE 가족 연결) */
    alreadyLinked: boolean;
    /** 이 사용자가 보낸, 아직 유효한 가족 승인 요청이 있다 */
    pendingRequest: boolean;
    /** 예전 연결이 해제(REVOKED)된 적이 있다 — 학원·가족이 끊은 연결을 «바로 연결»로 되살리지 않는다 */
    revokedAccess?: boolean;
};

export type SiblingAction = "LINK" | "REQUEST_APPROVAL" | "ALREADY_LINKED" | "PENDING" | "ASK_ACADEMY";

/** 서버 안에서 쓰는 제안 1건(학생 id·승인자 id 포함) */
export type SiblingPlanItem = {
    studentId: string;
    approverId: string | null;
    name: string;
    className: string | null;
    action: SiblingAction;
};

/** 화면으로 내보내는 제안 1건 — 이름·반·처리 방법만 */
export type PublicSibling = { name: string; className: string | null; action: SiblingAction };

/** 본인인증한 번호인지 맞춰 보는 함수(서버: 해시 비교, 테스트: 숫자 비교) — 숫자만 정규화한 값을 받는다 */
export type PhoneMatcher = (digits: string) => boolean;

/** 휴대폰으로 볼 수 있는 숫자인가(빈 값·자리채움 번호로 엉뚱한 아이가 맞지 않게) */
function usableDigits(raw: string | null | undefined): string | null {
    const digits = normalizeGuardianPhone(raw);
    if (!/^01\d{8,9}$/.test(digits)) return null;
    if (/^0+$/.test(digits.slice(3))) return null;
    return digits;
}

/** 이 번호(원본)가 본인인증한 번호와 같은가 */
export function samePhone(raw: string | null | undefined, matches: PhoneMatcher): boolean {
    const digits = usableDigits(raw);
    return digits !== null && matches(digits);
}

/** 이 아이가 «같은 보호자 번호로 등록된» 아이인가 — 주 보호자 계정 번호 또는 보호자 번호 중 하나라도 같으면 */
export function siblingPhoneMatches(row: SiblingCandidateRow, matches: PhoneMatcher): boolean {
    if (samePhone(row.primaryPhone, matches)) return true;
    return (row.guardianPhones ?? []).some((phone) => samePhone(phone, matches));
}

/** 주 보호자 계정이 학원이 만든 빈 계정인가(로그인 없음 + 합성 이메일 + 학부모) */
export function isPlaceholderPrimary(row: Pick<SiblingCandidateRow, "primaryRole" | "primaryAuthUserId" | "primaryEmail">): boolean {
    return row.primaryRole === "PARENT" && !row.primaryAuthUserId && isSyntheticParentEmail(row.primaryEmail);
}

/** 아이 1명을 어떻게 처리할지(위 규칙). 같은 번호가 아니면 호출하지 않는다(buildSiblingPlan 이 거른다) */
export function decideSiblingAction(row: SiblingCandidateRow, actorId: string, matches: PhoneMatcher): SiblingAction {
    if (row.alreadyLinked || row.primaryId === actorId) return "ALREADY_LINKED";
    if (row.pendingRequest) return "PENDING";
    // 아무도 쓰지 않는 빈 계정이 주 보호자이고 그 번호가 내 번호 = 학원이 나를 주 보호자로 등록한 것 → 바로 연결
    // 단, 해제된 적 있는 연결은 되살리지 않는다(학원 문의)
    if (isPlaceholderPrimary(row) && samePhone(row.primaryPhone, matches)) return row.revokedAccess ? "ASK_ACADEMY" : "LINK";
    // 다른 사람이 쓰는 계정이 주 보호자 — 권한을 자동으로 넘기지 않고 그 계정의 승인을 받는다(기존 가족 승인 규칙)
    if (row.primaryCanApprove && !isPlaceholderPrimary(row)) return "REQUEST_APPROVAL";
    return "ASK_ACADEMY";
}

/** 후보 줄들 → 같은 번호인 아이만 골라 처리 방법을 붙인다(아이 1명당 1건, 이름순) */
export function buildSiblingPlan(rows: readonly SiblingCandidateRow[], actorId: string, matches: PhoneMatcher): SiblingPlanItem[] {
    const seen = new Set<string>();
    const plan: SiblingPlanItem[] = [];
    for (const row of rows) {
        if (!row?.studentId || seen.has(row.studentId)) continue;
        if (!siblingPhoneMatches(row, matches)) continue;
        seen.add(row.studentId);
        const action = decideSiblingAction(row, actorId, matches);
        plan.push({
            studentId: row.studentId,
            approverId: action === "REQUEST_APPROVAL" ? row.primaryId : null,
            name: String(row.studentName ?? "").trim() || "이름 확인 필요",
            className: row.className ? String(row.className).trim() || null : null,
            action,
        });
    }
    return plan.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

/** 화면으로 내보내는 모양 — 학생 id·승인자 id 를 뺀다 */
export function toPublicSiblings(plan: readonly SiblingPlanItem[]): PublicSibling[] {
    return plan.map(({ name, className, action }) => ({ name, className, action }));
}

/** «모두 연결»로 실제 처리할 것이 있는가 */
export function hasSiblingWork(plan: readonly Pick<SiblingPlanItem, "action">[]): boolean {
    return plan.some((item) => item.action === "LINK" || item.action === "REQUEST_APPROVAL");
}
