/**
 * 수강 신청서 ↔ 체험 기록(TrialLead) 연결 판정 — 순수 모듈(DB·next 의존 0).
 *
 * ■ 왜 필요한가
 *   예전 규칙은 "아이 이름 글자 완전 일치 + 보호자 번호 일치"일 때만, 그것도 신청 제출 순간 1번만 연결했다.
 *   실제 사고: 체험 신청 때 아이 이름 오타 → 관리자가 나중에 체험 기록 이름을 고침 →
 *   부모는 안내 링크 없이 직접 수강 신청 → "체험 후 등록"으로 안 잡혔다.
 *   그래서 오타 1글자까지 허용하되, 애매하면 자동으로 붙이지 않고 관리자에게 "후보"로만 보여준다.
 *
 * ■ 판정 3단계
 *   · AUTO    : 자동으로 연결해도 되는 확실한 경우(관리자 확인 없이 연결)
 *   · SUGGEST : 같은 아이일 가능성이 높지만 사람이 확인해야 하는 경우(관리자 화면에 후보로 표시)
 *   · NONE    : 연결할 후보 없음
 *
 * ■ 날짜는 전부 "YYYY-MM-DD"(KST 달력) 문자열로 받는다. 서버 시계·getDate 류를 쓰지 않는다.
 */
import { isUsablePhoneKey, parentPhoneDigits } from "./parentIdentity";
import { diffDaysKst, isKstYmd } from "../datetime/kst";

/** 신청일 기준 이보다 오래된 체험 기록은 후보로 보지 않는다. */
export const TRIAL_MATCH_LOOKBACK_DAYS = 120;
/** 체험 기록이 신청서보다 늦게 만들어진 경우 허용 폭(관리자가 체험 기록을 뒤늦게 입력하는 경우). */
export const TRIAL_MATCH_CREATED_AFTER_APPLY_MAX_DAYS = 7;
/** 체험 수업일이 신청일보다 이만큼 넘게 뒤면(먼 미래 체험) 같은 흐름으로 보지 않는다. */
export const TRIAL_MATCH_TRIAL_AFTER_APPLY_MAX_DAYS = 30;

/** 연결 대상이 될 수 있는 체험 상태. CONVERTED·LOST·CANCELLED 같은 종료 상태는 제외한다. */
export const TRIAL_MATCH_OPEN_STATUSES = ["ATTENDED", "SCHEDULED", "CONTACTED", "NEW"] as const;

export type TrialLeadMatchApplication = {
    /** 이미 저장된 신청서를 다시 판정할 때의 id(체험 기록이 이 신청서를 가리키면 허용). */
    applicationId?: string | null;
    childName: string;
    parentPhone: string;
    childSchool?: string | null;
    childGrade?: string | null;
    /** 생년월일 "YYYY-MM-DD" */
    childBirthYmd?: string | null;
    /** 희망 반 slotKey 목록 — "Mon-4,Wed-6" 문자열 또는 배열 */
    preferredSlotKeys?: string | string[] | null;
    /** 신청일(KST) "YYYY-MM-DD" */
    appliedYmd: string;
};

export type TrialLeadMatchCandidate = {
    id: string;
    childName: string;
    parentPhone: string | null;
    status: string;
    childSchool?: string | null;
    childGrade?: string | null;
    childBirthYmd?: string | null;
    /** 확정 반의 slotKey 또는 희망 slotKey */
    slotKey?: string | null;
    /** 체험 기록 생성일(KST) */
    createdYmd: string;
    /** 체험 수업일(KST) — 출석일·확정일·희망일 중 있는 것 */
    trialYmd?: string | null;
    /** 이미 다른 신청서와 연결돼 있으면 그 신청서 id */
    enrollApplicationId?: string | null;
};

export type TrialLeadMatchStrength = "AUTO" | "SUGGEST";

export type TrialLeadMatchCandidateResult = {
    trialLeadId: string;
    strength: TrialLeadMatchStrength;
    reason: string;
};

export type TrialLeadMatchResult = {
    decision: "AUTO" | "SUGGEST" | "NONE";
    /** AUTO 일 때만 값이 있다. */
    trialLeadId: string | null;
    reason: string;
    /** 우선순위 순으로 정렬된 후보(AUTO·SUGGEST 모두). */
    candidates: TrialLeadMatchCandidateResult[];
};

/** 관리자 신청 목록에 보여줄 후보 1건(화면 전용 모양). */
export type TrialLinkSuggestion = {
    trialLeadId: string;
    childName: string;
    trialYmd: string | null;
    classLabel: string | null;
    strength: TrialLeadMatchStrength;
    reason: string;
};

// ── 정규화 ────────────────────────────────────────────────────────────────

/** 이름 비교용: 공백 제거·유니코드 정규화(NFC)·영문 소문자. */
export function normalizeChildName(raw: unknown): string {
    return String(raw ?? "").normalize("NFC").replace(/\s+/g, "").toLowerCase();
}

/**
 * 편집거리(레벤슈타인). 한글은 "음절" 단위로 센다 — Array.from 이 글자 하나(완성형 음절)를 한 칸으로 자른다.
 * 예: "김민수" vs "김민서" = 1, "김민수" vs "김수" = 1, "김민수" vs "이민서" = 2
 */
export function syllableEditDistance(a: string, b: string): number {
    const left = Array.from(a);
    const right = Array.from(b);
    if (left.length === 0) return right.length;
    if (right.length === 0) return left.length;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= right.length; j += 1) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
        }
        previous = current;
    }
    return previous[right.length];
}

/** 학교 비교용: "다산초등학교" / "다산초" / "다산 초" → "다산". 너무 짧으면 비교하지 않는다(빈 문자열). */
export function normalizeSchool(raw: unknown): string {
    const compact = String(raw ?? "").normalize("NFC").replace(/\s+/g, "");
    const core = compact.replace(/(초등학교|중학교|고등학교|유치원|어린이집|초교|초|중|고)$/, "");
    return Array.from(core).length >= 2 ? core : "";
}

/** 학년 비교용: "초등 3학년" / "초3" → "초3". */
export function normalizeGrade(raw: unknown): string {
    return String(raw ?? "")
        .normalize("NFC")
        .replace(/\s+/g, "")
        .replace(/^초등학교|^초등/, "초")
        .replace(/^중학교/, "중")
        .replace(/학년$/, "");
}

function splitSlotKeys(raw: string | string[] | null | undefined): string[] {
    const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
    return list.map((value) => value.trim()).filter(Boolean);
}

const STATUS_RANK: Record<string, number> = { ATTENDED: 1, SCHEDULED: 2, CONTACTED: 3, NEW: 4 };

// ── 후보 자격 ─────────────────────────────────────────────────────────────

/**
 * 기본 자격 — 모든 판정에 적용(이름 완전 일치 + 번호 일치 AUTO 포함).
 * 종료 상태와 "다른" 신청서에 이미 연결된 체험은 제외한다.
 */
export function isOpenUnlinkedTrialCandidate(
    application: Pick<TrialLeadMatchApplication, "applicationId">,
    candidate: TrialLeadMatchCandidate,
): boolean {
    // 종료 상태(CONVERTED·LOST·CANCELLED 등)는 제외
    if (!(TRIAL_MATCH_OPEN_STATUSES as readonly string[]).includes(candidate.status)) return false;
    // 이미 "다른" 신청서와 연결된 체험은 제외(같은 신청서를 가리키는 건 허용)
    const linkedTo = candidate.enrollApplicationId?.trim();
    if (linkedTo && linkedTo !== (application.applicationId ?? "")) return false;
    return true;
}

/**
 * 기간 제한 — 오타(1음절)·SUGGEST 판정에만 적용한다.
 * 이름 완전 일치 + 번호 일치는 예전 규칙처럼 기간 제한 없이 연결한다.
 */
export function isWithinTrialMatchWindow(
    application: Pick<TrialLeadMatchApplication, "appliedYmd">,
    candidate: Pick<TrialLeadMatchCandidate, "createdYmd" | "trialYmd">,
): boolean {
    // 날짜 판정이 불가능하면 안전하게 제외
    if (!isKstYmd(application.appliedYmd) || !isKstYmd(candidate.createdYmd)) return false;
    // 생성일: 신청일 기준 120일 전 ~ 7일 후
    const createdOffset = diffDaysKst(application.appliedYmd, candidate.createdYmd);
    if (createdOffset < -TRIAL_MATCH_LOOKBACK_DAYS) return false;
    if (createdOffset > TRIAL_MATCH_CREATED_AFTER_APPLY_MAX_DAYS) return false;
    // 체험 수업일이 신청일보다 30일 넘게 뒤면 제외
    if (candidate.trialYmd && isKstYmd(candidate.trialYmd)) {
        if (diffDaysKst(application.appliedYmd, candidate.trialYmd) > TRIAL_MATCH_TRIAL_AFTER_APPLY_MAX_DAYS) return false;
    }
    return true;
}

/** 기본 자격 + 기간 제한 둘 다(오타·SUGGEST 판정 기준). */
export function isEligibleTrialCandidate(
    application: Pick<TrialLeadMatchApplication, "applicationId" | "appliedYmd">,
    candidate: TrialLeadMatchCandidate,
): boolean {
    return isOpenUnlinkedTrialCandidate(application, candidate) && isWithinTrialMatchWindow(application, candidate);
}

// ── 판정 ──────────────────────────────────────────────────────────────────

type Scored = TrialLeadMatchCandidateResult & {
    exactName: boolean;
    candidate: TrialLeadMatchCandidate;
};

function compareScored(a: Scored, b: Scored): number {
    if (a.strength !== b.strength) return a.strength === "AUTO" ? -1 : 1;
    if (a.exactName !== b.exactName) return a.exactName ? -1 : 1;
    const rankDiff = (STATUS_RANK[a.candidate.status] ?? 9) - (STATUS_RANK[b.candidate.status] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    // 최근 체험이 먼저
    const aDate = a.candidate.trialYmd || a.candidate.createdYmd;
    const bDate = b.candidate.trialYmd || b.candidate.createdYmd;
    if (aDate !== bDate) return aDate < bDate ? 1 : -1;
    return a.trialLeadId.localeCompare(b.trialLeadId);
}

/**
 * 신청서 1건과 체험 후보 목록을 비교해 AUTO / SUGGEST / NONE 을 돌려준다.
 */
export function decideTrialLeadMatch(
    application: TrialLeadMatchApplication,
    candidates: readonly TrialLeadMatchCandidate[],
): TrialLeadMatchResult {
    const appName = normalizeChildName(application.childName);
    const appPhone = parentPhoneDigits(application.parentPhone);
    const appPhoneUsable = isUsablePhoneKey(appPhone);
    const appSchool = normalizeSchool(application.childSchool);
    const appGrade = normalizeGrade(application.childGrade);
    const appBirth = isKstYmd(application.childBirthYmd) ? String(application.childBirthYmd) : "";
    const appSlots = new Set(splitSlotKeys(application.preferredSlotKeys));

    if (!appName) {
        return { decision: "NONE", trialLeadId: null, reason: "아이 이름이 비어 있음", candidates: [] };
    }

    const scored: Scored[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
        if (!candidate?.id || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        if (!isOpenUnlinkedTrialCandidate(application, candidate)) continue;
        const inWindow = isWithinTrialMatchWindow(application, candidate);

        const trialName = normalizeChildName(candidate.childName);
        if (!trialName) continue;

        const exactName = trialName === appName;
        const bothLongEnough = Array.from(trialName).length >= 2 && Array.from(appName).length >= 2;
        const nearName = !exactName && bothLongEnough && syllableEditDistance(trialName, appName) === 1;
        if (!exactName && !nearName) continue; // 이름이 2글자 이상 다르면 같은 아이로 보지 않는다

        const sameSurname = Array.from(trialName)[0] === Array.from(appName)[0];
        const phoneSame = appPhoneUsable && parentPhoneDigits(candidate.parentPhone) === appPhone;

        // 추가 근거(학교·학년/생년·체험 반)
        const evidence: string[] = [];
        const trialSchool = normalizeSchool(candidate.childSchool);
        const schoolSame = Boolean(appSchool && trialSchool && appSchool === trialSchool);
        if (schoolSame) evidence.push("학교 같음");
        const trialBirth = isKstYmd(candidate.childBirthYmd) ? String(candidate.childBirthYmd) : "";
        const trialGrade = normalizeGrade(candidate.childGrade);
        const birthSame = Boolean(appBirth && trialBirth && appBirth === trialBirth);
        const gradeSame = Boolean(appGrade && trialGrade && appGrade === trialGrade);
        if (birthSame) evidence.push("생년월일 같음");
        else if (gradeSame) evidence.push("학년 같음");
        const trialSlot = candidate.slotKey?.trim();
        const slotSame = Boolean(trialSlot && appSlots.has(trialSlot));
        if (slotSame) evidence.push("체험 반 같음");
        // 오타(1음절) AUTO 에 필요한 "같은 아이" 긍정 근거 — 형(민수) 체험 + 동생(민서) 신청 오연결 방지.
        // 반이 같은 것만으로는 부족하다(나이 비슷한 형제는 같은 반을 지망한다) → 학년도 같아야 인정.
        const strongEvidence = birthSame || (schoolSame && gradeSame) || (slotSame && gradeSame);

        // 서로 다르다는 증거(생년월일·학년이 둘 다 있는데 다름) — 형제자매일 수 있다
        const conflict =
            (appBirth && trialBirth && appBirth !== trialBirth) ||
            (!(appBirth && trialBirth) && appGrade && trialGrade && appGrade !== trialGrade);

        const nameLabel = exactName ? "이름 같음" : "이름 1글자 다름";
        const evidenceLabel = evidence.length > 0 ? ` · ${evidence.join(" · ")}` : "";

        if (phoneSame && exactName) {
            // 이름·번호 완전 일치는 기간 제한 없이 AUTO(예전 규칙 유지)
            scored.push({ trialLeadId: candidate.id, strength: "AUTO", reason: `보호자 번호 같음 · ${nameLabel}${evidenceLabel}`, exactName, candidate });
            continue;
        }
        if (!inWindow) continue; // 이하(오타·SUGGEST)는 기간 제한 적용

        if (phoneSame && nearName && sameSurname && !conflict && strongEvidence) {
            scored.push({ trialLeadId: candidate.id, strength: "AUTO", reason: `보호자 번호 같음 · ${nameLabel}(오타 가능)${evidenceLabel}`, exactName, candidate });
        } else if (phoneSame) {
            // 번호는 같지만 성이 다르거나 생년/학년이 달라 형제자매일 수 있다 → 사람이 확인
            const why = conflict
                ? " · 생년/학년 다름(형제자매 확인)"
                : !sameSurname
                ? " · 성 다름"
                : " · 같은 아이 근거 없음(형제자매 확인)";
            scored.push({ trialLeadId: candidate.id, strength: "SUGGEST", reason: `보호자 번호 같음 · ${nameLabel}${why}${evidenceLabel}`, exactName, candidate });
        } else if (evidence.length > 0) {
            scored.push({ trialLeadId: candidate.id, strength: "SUGGEST", reason: `보호자 번호 다름 · ${nameLabel}${evidenceLabel}`, exactName, candidate });
        }
    }

    scored.sort(compareScored);
    const results = scored.map(({ trialLeadId, strength, reason }) => ({ trialLeadId, strength, reason }));
    const autos = scored.filter((item) => item.strength === "AUTO");

    // 이름 "완전 일치" + 번호 일치가 있으면 그 중 가장 진행된 기록에 자동 연결한다.
    // (같은 아이가 체험 신청을 두 번 낸 중복 기록 — 예전 규칙도 이 경우 가장 진행된 기록 1건에 연결했다)
    const exactAutos = autos.filter((item) => item.exactName);
    if (exactAutos.length >= 1) {
        const pick = exactAutos[0];
        const dupNote = exactAutos.length > 1 ? ` (같은 아이 체험 기록 ${exactAutos.length}건 중 가장 진행된 기록)` : "";
        return { decision: "AUTO", trialLeadId: pick.trialLeadId, reason: `${pick.reason}${dupNote}`, candidates: results };
    }

    // 오타(1글자 다름) 후보는 정확히 1명일 때만 자동 연결한다.
    if (autos.length === 1) {
        return { decision: "AUTO", trialLeadId: autos[0].trialLeadId, reason: autos[0].reason, candidates: results };
    }
    if (autos.length >= 2) {
        // 쌍둥이·형제처럼 비슷한 이름 후보가 여럿 → 자동 연결 금지, 전부 후보로 표시
        const downgraded = results.map((item) =>
            item.strength === "AUTO" ? { ...item, strength: "SUGGEST" as const, reason: `${item.reason} · 비슷한 후보 여러 명` } : item,
        );
        return { decision: "SUGGEST", trialLeadId: null, reason: `비슷한 체험 기록 ${autos.length}건 — 확인 필요`, candidates: downgraded };
    }
    if (results.length > 0) {
        return { decision: "SUGGEST", trialLeadId: null, reason: results[0].reason, candidates: results };
    }
    return { decision: "NONE", trialLeadId: null, reason: "연결할 체험 기록 없음", candidates: [] };
}

// ── 체험 기록 수정 후 재비교: 어느 신청서에 붙일지 ─────────────────────────

/**
 * 체험 기록 1건을 AUTO 로 가리키는 신청서가 여러 건일 때 고르는 규칙.
 *  · 1건이면 그 신청서
 *  · 2건 이상이면 체험 기록과 이름이 "완전히 같은" 신청서가 정확히 1건일 때만 그것
 *  · 그 밖에는 자동 연결하지 않는다(null — 관리자 화면 후보로 남는다)
 */
export function selectApplicationForTrialAutoLink(
    trialLeadId: string,
    trialChildName: string,
    applications: ReadonlyArray<{ applicationId: string; childName: string; decision: TrialLeadMatchResult }>,
): string | null {
    const pointing = applications.filter(
        (item) => item.decision.decision === "AUTO" && item.decision.trialLeadId === trialLeadId,
    );
    if (pointing.length === 1) return pointing[0].applicationId;
    if (pointing.length === 0) return null;
    const trialName = normalizeChildName(trialChildName);
    const exact = pointing.filter((item) => Boolean(trialName) && normalizeChildName(item.childName) === trialName);
    return exact.length === 1 ? exact[0].applicationId : null;
}
