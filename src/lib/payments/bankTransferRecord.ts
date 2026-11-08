/**
 * 관리자 «납부 처리» 규칙 — 화면과 서버가 같이 쓰는 순수 모듈(2026-11-08 원장 결정)
 *
 * 왜 따로 두나:
 *   예전에는 «납부처리»를 누르면 결제 방법·근거 없이 곧바로 PAID 가 됐다. 실수로 눌러도 되돌릴 단서가 없고
 *   결제 이력도 남지 않았다. 이제 납부완료는 «계좌이체(입금일·입금자명 기록)» 또는 «현장 결제(토스 POS)»로만 만든다.
 *   이 파일은 그 판정(입력 검사·대상 상태·POS 가능 여부)만 담는다. DB·next 의존이 없어서 테스트로 실제 실행해 볼 수 있다.
 */
import { isKstYmd } from "@/lib/datetime/kst";

/** 저장하는 결제 수단 값 — 화면 «수단» 칸은 이 값을 «계좌이체»로 보여 준다(METHOD_LABELS·paymentMethodLabel). */
export const BANK_TRANSFER_METHOD = "BANK_TRANSFER";
/** 감사 기록(PaymentAuditLog.action) 이름 */
export const BANK_TRANSFER_AUDIT_ACTION = "PAYMENT_BANK_TRANSFER_RECORD";
/** 납부 처리할 수 있는 상태 — 미납·연체만. 이미 납부·환불·취소는 건너뛴다. */
export const RECORDABLE_STATUSES = ["PENDING", "OVERDUE"] as const;
/** 현장 결제(토스 POS)는 수강료·셔틀비·기타(모두 면세 — D2, 기타는 2026-11-08 원장 지시로 추가). 유니폼은 본사 직접 구매라 제외 */
export const POS_CHARGE_TYPES = ["MONTHLY", "SHUTTLE", "OTHER"] as const;

export const DEPOSITOR_NAME_MAX = 40;
export const MEMO_MAX = 200;
/** 한 번에 기록할 수 있는 최대 건수(실수로 월 전체를 넘기는 것 방지) */
export const MAX_PAYMENT_IDS = 100;

export type BankTransferInput = {
    paymentIds: unknown;
    depositDate: unknown;
    depositorName: unknown;
    memo?: unknown;
};

export type BankTransferValue = {
    paymentIds: string[];
    depositDate: string; // "YYYY-MM-DD" (KST 달력 날짜)
    depositorName: string;
    memo: string | null;
};

export type ValidationResult =
    | { ok: true; value: BankTransferValue }
    | { ok: false; error: string };

/**
 * 계좌이체 기록 입력을 검사·정리한다.
 * @param todayYmd 오늘(KST) — 서버는 todayKst() 를 넘긴다. 미래 입금일을 막는 기준.
 */
export function validateBankTransferInput(input: BankTransferInput, todayYmd: string): ValidationResult {
    // 1) 대상: 문자열 id 만, 공백 제거, 중복 제거
    if (!Array.isArray(input.paymentIds)) return { ok: false, error: "납부 처리할 청구를 선택해 주세요." };
    const ids = Array.from(new Set(
        input.paymentIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter(Boolean),
    ));
    if (ids.length === 0) return { ok: false, error: "납부 처리할 청구를 선택해 주세요." };
    if (ids.length > MAX_PAYMENT_IDS) return { ok: false, error: `한 번에 ${MAX_PAYMENT_IDS}건까지 기록할 수 있어요.` };

    // 2) 입금일: 실재하는 YYYY-MM-DD, 오늘(KST) 이후 금지. 문자열 비교로 충분하다(같은 형식).
    const depositDate = typeof input.depositDate === "string" ? input.depositDate.trim() : "";
    if (!isKstYmd(depositDate)) return { ok: false, error: "입금일을 올바르게 입력해 주세요." };
    if (depositDate > todayYmd) return { ok: false, error: "입금일은 오늘 이후로 정할 수 없어요." };

    // 3) 입금자명: 필수 1~40자
    const depositorName = typeof input.depositorName === "string" ? input.depositorName.trim() : "";
    if (!depositorName) return { ok: false, error: "입금자명을 입력해 주세요." };
    if (depositorName.length > DEPOSITOR_NAME_MAX) return { ok: false, error: `입금자명은 ${DEPOSITOR_NAME_MAX}자 이내로 입력해 주세요.` };

    // 4) 메모: 선택, 200자 이내
    const memoText = typeof input.memo === "string" ? input.memo.trim() : "";
    if (memoText.length > MEMO_MAX) return { ok: false, error: `메모는 ${MEMO_MAX}자 이내로 입력해 주세요.` };

    return { ok: true, value: { paymentIds: ids, depositDate, depositorName, memo: memoText || null } };
}

export type SkipReason = "NOT_FOUND" | "ALREADY_PAID" | "NOT_UNPAID";

/**
 * DB 에서 잠근 청구 행을 «기록할 것 / 건너뛸 것»으로 나눈다.
 * 요청 순서를 지키고, DB 에 없는 id 도 «찾을 수 없음»으로 알려 준다.
 */
export function splitRecordableTargets(
    rows: Array<{ id: string; status: string }>,
    requestedIds: string[],
): { recordable: string[]; skipped: Array<{ id: string; reason: SkipReason }> } {
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    const recordable: string[] = [];
    const skipped: Array<{ id: string; reason: SkipReason }> = [];
    for (const id of requestedIds) {
        const status = byId.get(id);
        if (status === undefined) skipped.push({ id, reason: "NOT_FOUND" });
        else if ((RECORDABLE_STATUSES as readonly string[]).includes(status)) recordable.push(id);
        else if (status === "PAID") skipped.push({ id, reason: "ALREADY_PAID" });
        else skipped.push({ id, reason: "NOT_UNPAID" });
    }
    return { recordable, skipped };
}

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
    NOT_FOUND: "청구를 찾을 수 없음",
    ALREADY_PAID: "이미 납부완료",
    NOT_UNPAID: "미납 상태가 아님(취소·환불 등)",
};

/** 처리 결과 안내 문구(한 줄) */
export function bankTransferResultMessage(recordedCount: number, skippedCount: number): string {
    if (recordedCount === 0) return "납부완료로 기록한 건이 없어요. 이미 처리됐거나 미납 상태가 아닌 청구예요.";
    return skippedCount > 0
        ? `${recordedCount}건을 계좌이체 납부완료로 기록했어요. ${skippedCount}건은 건너뛰었어요.`
        : `${recordedCount}건을 계좌이체 납부완료로 기록했어요.`;
}

/**
 * «현장 결제(POS)» 버튼을 켤지 판정한다.
 * - 여러 건 한 번에 결제는 다음 단계에서 추가(지금은 1건만)
 * - 수강료·셔틀비 미납만
 */
export function posChargeAvailability(targets: Array<{ type: string; status: string; studentId?: string | null }>):
    { enabled: true } | { enabled: false; reason: string } {
    if (targets.length === 0) return { enabled: false, reason: "납부 처리할 청구를 선택해 주세요." };
    // 여러 건(2026-11-08 원장 결정 «같은 학생이면 한 번에 결제»): 같은 학생 · 수강료·셔틀비 · 미납만, 최대 POS_CHARGE_MAX_ITEMS 건.
    // 화면 판단일 뿐이다 — 서버(createRow)가 DB 값으로 같은 규칙을 다시 확인한다.
    if (targets.length > POS_CHARGE_MAX_ITEMS) {
        return { enabled: false, reason: `현장 결제는 한 번에 ${POS_CHARGE_MAX_ITEMS}건까지 묶을 수 있어요.` };
    }
    if (targets.length > 1) {
        const students = new Set(targets.map((t) => String(t.studentId ?? "")));
        if (students.size !== 1 || students.has("")) {
            return { enabled: false, reason: "다른 학생이 섞여 있어요. 현장 결제는 같은 학생 청구만 한 번에 받을 수 있어요." };
        }
    }
    const multi = targets.length > 1;
    if (targets.some((t) => !(RECORDABLE_STATUSES as readonly string[]).includes(t.status))) {
        return { enabled: false, reason: multi ? "미납·연체가 아닌 청구가 섞여 있어요. 미납·연체 청구만 현장 결제할 수 있어요." : "미납·연체 청구만 현장 결제할 수 있어요." };
    }
    if (targets.some((t) => !(POS_CHARGE_TYPES as readonly string[]).includes(t.type))) {
        return { enabled: false, reason: multi ? "유니폼 청구가 섞여 있어요. 유니폼은 본사 직접 구매라 현장 결제할 수 없어요 — 유니폼을 빼고 골라 주세요." : "유니폼 청구는 현장 결제할 수 없어요(본사 직접 구매)." };
    }
    return { enabled: true };
}

/** 현장 결제 한 번에 묶을 수 있는 청구 수 — 서버 MAX_CHARGE_ITEMS(src/lib/pos/charge-request.mjs)와 같은 값(테스트로 비교) */
export const POS_CHARGE_MAX_ITEMS = 10;

/**
 * 여러 건 납부 처리 창에 보일 «대상 학생» 한 줄.
 * 왜: «3건 · 합계»만 보이면 누구 청구를 처리하는지 창 안에서 확인할 길이 없다(잘못 고른 건을 못 알아챈다).
 * - 같은 학생의 여러 청구는 이름 한 번만(처음 나온 순서 유지)
 * - 이름이 maxNames 명을 넘으면 «홍길동, 김철수 외 N명»
 */
export function targetNamesSummary(targets: Array<{ studentName: string }>, maxNames = 2): string {
    const names: string[] = [];
    for (const t of targets) {
        const name = (t.studentName ?? "").trim() || "이름 없음";
        if (!names.includes(name)) names.push(name);
    }
    if (names.length <= maxNames) return names.join(", ");
    return `${names.slice(0, maxNames).join(", ")} 외 ${names.length - maxNames}명`;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * «안 되는 건만 빼고 나머지로 진행» 계획 (2026-11-08 원장 지시 «막다른 흐린 버튼 없애기»)
 *
 * 왜: 예전엔 고른 청구 중 하나라도 규칙에 어긋나면 POS 버튼이 통째로 흐려지고 작은 글씨만 나와
 *     원장이 어디서 막혔는지 몰랐다. 이제는 어긋난 건을 «사유와 함께 빼고», 나머지로 바로 진행할 버튼을 준다.
 *   - 계좌이체: 미납·연체만 기록(이미 납부·환불·취소는 뺀다)
 *   - 현장 결제: 위 + 유니폼(본사 직접 구매)·금액 0원 이하도 빼고, 학생별로 묶어 10건씩 나눈다
 * 화면 판단일 뿐이다 — 서버가 DB 값으로 같은 규칙을 다시 확인한다.
 * ──────────────────────────────────────────────────────────────────────────── */

export type PlanTarget = {
    id: string;
    studentId?: string | null;
    studentName: string;
    amount: number;
    type: string;
    status: string;
    month?: number | null;
    year?: number | null;
    label?: string;
};

/** 빼는 사유 — 상태(이미 납부·환불·취소·기타)·종류(유니폼)·금액(0원 이하) */
export type ExcludeReason = "ALREADY_PAID" | "REFUNDED" | "CANCELED" | "NOT_UNPAID" | "UNIFORM" | "ZERO_AMOUNT";

/** 사유 칩·안내 문구에 쓰는 짧은 이름 */
export const EXCLUDE_REASON_LABEL: Record<ExcludeReason, string> = {
    ALREADY_PAID: "이미 납부",
    REFUNDED: "환불",
    CANCELED: "취소",
    NOT_UNPAID: "미납 아님",
    UNIFORM: "유니폼(본사 구매)",
    ZERO_AMOUNT: "금액 0원",
};

export type Excluded<T> = { target: T; reason: ExcludeReason };

/** 상태만 보고 빼는 사유(미납·연체면 null) — 계좌이체·현장 결제 공통 */
function statusExcludeReason(status: string): ExcludeReason | null {
    if ((RECORDABLE_STATUSES as readonly string[]).includes(status)) return null;
    if (status === "PAID") return "ALREADY_PAID";
    if (status === "REFUNDED") return "REFUNDED";
    if (status === "CANCELED" || status === "CANCELLED") return "CANCELED";
    return "NOT_UNPAID";
}

/** 계좌이체 계획: 미납·연체만 기록하고 나머지는 사유와 함께 뺀다(고른 순서 유지) */
export function planBankTransfer<T extends PlanTarget>(targets: T[]): { recordable: T[]; excluded: Excluded<T>[] } {
    const recordable: T[] = [];
    const excluded: Excluded<T>[] = [];
    for (const t of targets) {
        const reason = statusExcludeReason(t.status);
        if (reason) excluded.push({ target: t, reason });
        else recordable.push(t);
    }
    return { recordable, excluded };
}

export type PosGroup<T> = {
    /** 같은 학생 묶음 키(학생 id 없는 옛 데이터는 청구 id 로 각자 1건) */
    key: string;
    studentName: string;
    targets: T[];
    total: number;
    /** 한 학생이 10건을 넘어 나뉘었을 때 몇 번째 묶음인지(1부터) · 전체 묶음 수 */
    part: number;
    parts: number;
};

/**
 * 현장 결제 계획: 결제 가능한 청구를 학생별로 묶고(각 POS_CHARGE_MAX_ITEMS 건 이하), 안 되는 건은 사유와 함께 뺀다.
 * - 사유 판정 순서: 상태 → 종류(유니폼) → 금액(0원 이하). 한 건에 사유 하나만 붙인다.
 * - 묶음 순서 = 학생이 처음 나온 순서, 묶음 안 순서 = 고른 순서.
 */
export function planPosCharge<T extends PlanTarget>(targets: T[]): { groups: PosGroup<T>[]; excluded: Excluded<T>[] } {
    const excluded: Excluded<T>[] = [];
    const byStudent = new Map<string, T[]>();
    for (const t of targets) {
        const reason = statusExcludeReason(t.status)
            ?? (!(POS_CHARGE_TYPES as readonly string[]).includes(t.type) ? "UNIFORM" : null)
            ?? (!(Number(t.amount) > 0) ? "ZERO_AMOUNT" : null);
        if (reason) { excluded.push({ target: t, reason }); continue; }
        // 학생 id 가 없으면 같은 학생인지 알 수 없다 → 청구마다 따로 묶는다
        const sid = String(t.studentId ?? "").trim();
        const key = sid ? `s:${sid}` : `p:${t.id}`;
        const list = byStudent.get(key);
        if (list) list.push(t);
        else byStudent.set(key, [t]);
    }
    const groups: PosGroup<T>[] = [];
    for (const [key, list] of byStudent) {
        // 10건 넘으면 10건씩 나눈다(서버 MAX_CHARGE_ITEMS 와 같은 한도)
        const parts = Math.ceil(list.length / POS_CHARGE_MAX_ITEMS);
        for (let i = 0; i < parts; i++) {
            const chunk = list.slice(i * POS_CHARGE_MAX_ITEMS, (i + 1) * POS_CHARGE_MAX_ITEMS);
            groups.push({
                key: parts > 1 ? `${key}#${i + 1}` : key,
                studentName: (chunk[0].studentName ?? "").trim() || "이름 없음",
                targets: chunk,
                total: chunk.reduce((sum, t) => sum + t.amount, 0),
                part: i + 1,
                parts,
            });
        }
    }
    return { groups, excluded };
}

const TYPE_NAME: Record<string, string> = { MONTHLY: "수강료", SHUTTLE: "셔틀비", UNIFORM: "유니폼", OTHER: "기타" };

/** 청구 한 줄 이름 — 부모가 넘긴 label 우선, 없으면 «11월 수강료»처럼 만든다 */
export function planTargetLabel(t: Pick<PlanTarget, "type" | "month" | "label">): string {
    const label = (t.label ?? "").trim();
    if (label) return label;
    const name = TYPE_NAME[t.type] ?? "청구";
    return t.month ? `${t.month}월 ${name}` : name;
}

/**
 * 뺀 건 안내 한 줄 — «이미 납부 1건(홍길동 11월 수강료)은 빼고, 미납 2건 합계 5,000원만 처리할까요?»
 * 사유별로 묶고, 사유마다 이름은 2건까지만 보이고 나머지는 «외 N건».
 */
export function excludedNotice<T extends PlanTarget>(excluded: Excluded<T>[], processCount: number, processTotal: number): string {
    const byReason = new Map<ExcludeReason, T[]>();
    for (const e of excluded) {
        const list = byReason.get(e.reason);
        if (list) list.push(e.target);
        else byReason.set(e.reason, [e.target]);
    }
    const parts: string[] = [];
    for (const [reason, list] of byReason) {
        const names = list.slice(0, 2).map((t) => `${(t.studentName ?? "").trim() || "이름 없음"} ${planTargetLabel(t)}`);
        const more = list.length > 2 ? ` 외 ${list.length - 2}건` : "";
        parts.push(`${EXCLUDE_REASON_LABEL[reason]} ${list.length}건(${names.join(", ")}${more})`);
    }
    if (processCount === 0) return `${parts.join(", ")}은 처리할 수 없어서 남는 청구가 없어요.`;
    return `${parts.join(", ")}은 빼고, 미납 ${processCount}건 합계 ${processTotal.toLocaleString("ko-KR")}원만 처리할까요?`;
}
