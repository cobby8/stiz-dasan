// 관리자 수납 목록 «선택 항목 환불» — 외부 의존 없는 순수 규칙(테스트가 직접 실행한다).
//
// 왜 따로 두나: 고른 청구마다 돈이 돌아가는 길이 다르다.
//   - 토스 온라인 결제(paidProvider TOSS)  → 토스 결제 취소 API 후 재조회로 확인된 뒤에만 환불(payment-ledger)
//   - 토스 POS 현장 결제(TOSS_POS)        → POS 에 «결제 취소»만 보낸다. 환불은 POS 취소 → 토스 확인 뒤(chargeRequestService)
//   - 현금·계좌이체 등 사람 기록(MANUAL)  → 장부만 환불(돈은 원장이 직접 돌려준다)
// 어느 길로 갈지, 묶음 결제를 일부만 골랐는지 같은 판정은 여기 한 곳에서만 한다(화면·서버가 같은 함수).
// 묶음 결제는 «한 결제 = 여러 청구»라 일부만 취소할 수 없다 — 토스 부분 취소는 지금 코드에 없다(웹훅도 부분 취소는 사람 확인으로만 남긴다).

/** 한 번에 환불할 수 있는 최대 건수 — 토스·POS 를 차례로 부르므로 서버 시간 안에 끝나게 */
export const MAX_BULK_REFUND = 30;

/** 돈 길 갈래 */
export type BulkRefundKind = "TOSS_ONLINE" | "TOSS_POS" | "MANUAL";

/** 서버가 DB 에서 다시 읽은 청구 1건(화면이 보낸 값은 믿지 않는다) */
export type BulkRefundRow = {
    paymentId: string;
    status: string;
    paidProvider: string | null;
    /** 토스 온라인: 이 청구를 품은 «완료(DONE)» 토스 거래 id — 없으면 null */
    tossTxId: string | null;
    /** 그 거래에 묶인 청구 전부(단건이면 자기 하나) */
    tossTxPaymentIds: string[];
    /** 토스 POS: 이 청구를 납부시킨 현장 결제 요청 id — 없으면 null */
    posRequestId: string | null;
    /** 그 POS 결제에 묶인 청구 전부(단건이면 자기 하나) */
    posPaymentIds: string[];
};

export type BulkRefundGroup = {
    kind: BulkRefundKind;
    /** 토스 거래 id · POS 요청 id · MANUAL 은 청구 id */
    key: string;
    paymentIds: string[];
};

export type BulkRefundBlockCode =
    | "EMPTY"
    | "DUPLICATE"
    | "TOO_MANY"
    | "NOT_FOUND"
    | "NOT_PAID"
    | "BUNDLE_PARTIAL"
    | "NO_TOSS_RECORD"
    | "NO_POS_RECORD"
    | "OTHER_PROVIDER";

export type BulkRefundBlock = { code: BulkRefundBlockCode; paymentId?: string; message: string };

export type BulkRefundPlan =
    | { ok: true; groups: BulkRefundGroup[] }
    | { ok: false; blocks: BulkRefundBlock[] };

/** 원장이 읽는 문장(개발 용어 없이) */
export function bulkRefundBlockMessage(code: BulkRefundBlockCode, count?: number): string {
    switch (code) {
        case "EMPTY": return "고른 청구가 없어요.";
        case "DUPLICATE": return "같은 청구가 두 번 골라졌어요. 다시 골라 주세요.";
        case "TOO_MANY": return `한 번에 ${MAX_BULK_REFUND}건까지 환불할 수 있어요.`;
        case "NOT_FOUND": return "찾을 수 없는 청구가 있어요. 화면을 새로 고쳐 주세요.";
        case "NOT_PAID": return "납부완료가 아닌 청구가 섞여 있어요. 납부완료만 골라 주세요.";
        case "BUNDLE_PARTIAL": return `묶음으로 낸 결제는 함께 환불해야 해요(${count ?? 0}건).`;
        case "NO_TOSS_RECORD": return "토스 결제 기록을 찾지 못했어요. 토스 상점관리자에서 취소해 주세요.";
        case "NO_POS_RECORD": return "현장 결제 기록을 찾지 못했어요. ⚡ 메뉴의 «결제 취소»로 확인해 주세요.";
        case "OTHER_PROVIDER": return "카페24로 받은 결제는 카페24 관리자에서 취소해 주세요.";
    }
}

/** 장부만 환불하는 «사람 기록» 결제인가 — 온라인·POS·카페24 가 아니면 전부(현금·계좌이체·옛 기록) */
function isManualProvider(provider: string | null): boolean {
    return provider !== "TOSS" && provider !== "TOSS_POS" && provider !== "CAFE24_BRIDGE";
}

/**
 * 고른 청구 id + DB 행 → 갈래별 묶음(실행 계획). 막을 것이 하나라도 있으면 아무것도 실행하지 않는다(전부 아니면 전무).
 * 묶음 결제(토스 주문·POS 결제 하나에 청구 여러 건)는 그 묶음의 청구를 «전부» 골라야 한 번 취소한다.
 */
export function planBulkRefund(selectedIds: readonly string[], rows: readonly BulkRefundRow[]): BulkRefundPlan {
    if (selectedIds.length === 0 || selectedIds.some((id) => typeof id !== "string" || id.trim() === "")) {
        return { ok: false, blocks: [{ code: "EMPTY", message: bulkRefundBlockMessage("EMPTY") }] };
    }
    if (new Set(selectedIds).size !== selectedIds.length) {
        return { ok: false, blocks: [{ code: "DUPLICATE", message: bulkRefundBlockMessage("DUPLICATE") }] };
    }
    if (selectedIds.length > MAX_BULK_REFUND) {
        return { ok: false, blocks: [{ code: "TOO_MANY", message: bulkRefundBlockMessage("TOO_MANY") }] };
    }

    const byId = new Map(rows.map((row) => [row.paymentId, row]));
    const selected = new Set(selectedIds);
    const blocks: BulkRefundBlock[] = [];
    const groups = new Map<string, BulkRefundGroup>();
    // 같은 묶음을 두 번 막지 않게(묶음 안 여러 청구를 골랐을 때 안내는 1줄)
    const blockedBundles = new Set<string>();

    const addTo = (kind: BulkRefundKind, key: string, paymentId: string) => {
        const groupKey = `${kind}:${key}`;
        const group = groups.get(groupKey) ?? { kind, key, paymentIds: [] };
        group.paymentIds.push(paymentId);
        groups.set(groupKey, group);
    };
    // 묶음의 청구를 전부 골랐나 — 아니면 «함께 환불해야 해요(N건)»
    const bundleComplete = (bundleKey: string, ids: readonly string[], paymentId: string): boolean => {
        const all = ids.length > 0 ? ids : [paymentId];
        if (all.every((id) => selected.has(id))) return true;
        if (!blockedBundles.has(bundleKey)) {
            blockedBundles.add(bundleKey);
            blocks.push({ code: "BUNDLE_PARTIAL", paymentId, message: bulkRefundBlockMessage("BUNDLE_PARTIAL", all.length) });
        }
        return false;
    };

    for (const id of selectedIds) {
        const row = byId.get(id);
        if (!row) { blocks.push({ code: "NOT_FOUND", paymentId: id, message: bulkRefundBlockMessage("NOT_FOUND") }); continue; }
        if (row.status !== "PAID") { blocks.push({ code: "NOT_PAID", paymentId: id, message: bulkRefundBlockMessage("NOT_PAID") }); continue; }

        if (row.paidProvider === "TOSS_POS") {
            if (!row.posRequestId) { blocks.push({ code: "NO_POS_RECORD", paymentId: id, message: bulkRefundBlockMessage("NO_POS_RECORD") }); continue; }
            if (bundleComplete(`POS:${row.posRequestId}`, row.posPaymentIds, id)) addTo("TOSS_POS", row.posRequestId, id);
            continue;
        }
        if (row.paidProvider === "TOSS") {
            if (!row.tossTxId) { blocks.push({ code: "NO_TOSS_RECORD", paymentId: id, message: bulkRefundBlockMessage("NO_TOSS_RECORD") }); continue; }
            if (bundleComplete(`TOSS:${row.tossTxId}`, row.tossTxPaymentIds, id)) addTo("TOSS_ONLINE", row.tossTxId, id);
            continue;
        }
        if (!isManualProvider(row.paidProvider)) {
            blocks.push({ code: "OTHER_PROVIDER", paymentId: id, message: bulkRefundBlockMessage("OTHER_PROVIDER") });
            continue;
        }
        // 사람 기록 결제는 청구마다 따로(서로 묶일 일이 없다)
        addTo("MANUAL", id, id);
    }

    if (blocks.length > 0) {
        // NOT_PAID·NOT_FOUND 처럼 같은 문장이 여러 줄이면 한 줄로(원장이 읽기 쉽게)
        const seen = new Set<string>();
        return { ok: false, blocks: blocks.filter((block) => (seen.has(block.message) ? false : (seen.add(block.message), true))) };
    }
    return { ok: true, groups: Array.from(groups.values()) };
}

/** 선택 막대의 버튼 모드 — 화면이 쓴다(서버는 planBulkRefund 로 다시 막는다) */
export type BulkSelectionMode =
    | { mode: "NONE" }
    | { mode: "PAY" }
    | { mode: "REFUND" }
    | { mode: "MIXED"; message: string };

/**
 * 고른 청구들의 상태 → 막대 버튼.
 *  - 납부완료(PAID)가 하나도 없음 → 기존 «선택 항목 납부 처리»(이미 취소·환불 건은 납부 창이 건너뛴다고 알려 준다)
 *  - 전부 납부완료 → «선택 항목 환불»
 *  - 섞임 → 버튼 끔 + 안내
 */
export function bulkSelectionMode(statuses: readonly string[]): BulkSelectionMode {
    if (statuses.length === 0) return { mode: "NONE" };
    const paid = statuses.filter((status) => status === "PAID").length;
    if (paid === 0) return { mode: "PAY" };
    if (paid === statuses.length) return { mode: "REFUND" };
    const hasUnpaid = statuses.some((status) => status === "PENDING" || status === "OVERDUE");
    return {
        mode: "MIXED",
        message: hasUnpaid ? "미납과 납부완료를 함께 고를 수 없어요" : "납부완료만 골라야 환불할 수 있어요",
    };
}

/** 한 갈래 실행 결과 */
export type BulkRefundOutcome = {
    kind: BulkRefundKind;
    paymentIds: string[];
    /** DONE = 환불 완료 · REQUESTED = POS 에 취소 보냄(POS 취소 뒤 환불) · FAILED = 실패 */
    result: "DONE" | "REQUESTED" | "FAILED";
    message?: string;
};

/** 결과 요약 한 줄 — «2건 환불 완료 · 현장 결제 1건 POS 취소 요청 · 1건 실패» */
export function summarizeBulkRefund(outcomes: readonly BulkRefundOutcome[]): string {
    const count = (result: BulkRefundOutcome["result"]) =>
        outcomes.filter((o) => o.result === result).reduce((sum, o) => sum + o.paymentIds.length, 0);
    const done = count("DONE");
    const requested = count("REQUESTED");
    const failed = count("FAILED");
    const parts: string[] = [];
    if (done > 0) parts.push(`${done}건 환불 완료`);
    if (requested > 0) parts.push(`${requested}건 POS 결제 취소 요청(POS에서 취소되면 환불로 바뀌어요)`);
    if (failed > 0) parts.push(`${failed}건 실패`);
    return parts.length > 0 ? parts.join(" · ") : "환불한 청구가 없어요.";
}
