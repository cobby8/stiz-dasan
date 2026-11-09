export type TrialFeeConfirmationResult = {
    found: boolean;
    changed: boolean;
    alreadyConfirmed: boolean;
};

type TrialFeeConfirmationDb = {
    $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
};

type TrialFeeConfirmationTransactionDb = {
    $transaction<T>(callback: (tx: TrialFeeConfirmationDb & {
        $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    }) => Promise<T>): Promise<T>;
};

export type TrialFeeAuditActor = {
    userId: string | null;
    userName: string | null;
};

/**
 * 체험비 확인은 false→true 한 번만 성공하도록 DB 조건부 갱신으로 처리한다.
 * 동시에 여러 요청이 들어와도 RETURNING을 받은 한 요청만 changed=true가 된다.
 */
export async function confirmTrialFeeOnce(
    db: TrialFeeConfirmationDb,
    trialLeadId: string,
): Promise<TrialFeeConfirmationResult> {
    const changedRows = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "TrialLead"
         SET "trialFeeConfirmed" = true,
             "updatedAt" = NOW()
         WHERE id = $1
           AND COALESCE("trialFeeConfirmed", false) = false
         RETURNING id`,
        trialLeadId,
    );

    if (changedRows.length > 0) {
        return { found: true, changed: true, alreadyConfirmed: false };
    }

    // 갱신되지 않았다면 이미 확인된 행인지, 존재하지 않는 행인지 구분한다.
    const existingRows = await db.$queryRawUnsafe<Array<{ trialFeeConfirmed: boolean | null }>>(
        `SELECT "trialFeeConfirmed"
         FROM "TrialLead"
         WHERE id = $1
         LIMIT 1`,
        trialLeadId,
    );
    if (existingRows.length === 0) {
        return { found: false, changed: false, alreadyConfirmed: false };
    }

    return {
        found: true,
        changed: false,
        alreadyConfirmed: Boolean(existingRows[0].trialFeeConfirmed),
    };
}

/**
 * 체험비 상태 문구 — 관리자 화면 모든 곳에서 이 함수 하나만 쓴다.
 * - trialFeeConfirmed: 학원이 실제 입금을 확인했을 때만 true(관리자 전용 버튼)
 * - trialFeeNoticeAgreedAt: 학부모가 신청서에서 「비용·계좌 확인」에 체크한 시각(입금 아님)
 * 학부모 체크만으로 「입금 완료」가 보이던 사고(2026-10-09)를 막으려고 두 값을 나눠 판단한다.
 */
export function trialFeeStatusLabel(lead: {
    trialFeeConfirmed?: boolean | null;
    trialFeeNoticeAgreedAt?: string | Date | null;
    /** 온라인 결제 요약(2026-11-10) — PAID·WAITING_FOR_DEPOSIT·REFUNDED·NEEDS_REFUND. 없으면 예전 문구 그대로 */
    trialFeePaymentStatus?: string | null;
}): "입금 완료" | "입금 대기(학부모 동의함)" | "입금 대기" | "결제 완료(온라인)" | "입금 대기(무통장 계좌 발급)" | "환불 완료" | "이중 결제(환불 필요)" {
    // 온라인 결제 흔적이 있으면 그 상태를 먼저 보인다(문구는 trialFeeRules 와 같은 글자)
    if (lead.trialFeePaymentStatus === "NEEDS_REFUND") return "이중 결제(환불 필요)";
    if (lead.trialFeePaymentStatus === "PAID" && lead.trialFeeConfirmed) return "결제 완료(온라인)";
    if (lead.trialFeePaymentStatus === "WAITING_FOR_DEPOSIT" && !lead.trialFeeConfirmed) return "입금 대기(무통장 계좌 발급)";
    if (lead.trialFeePaymentStatus === "REFUNDED" && !lead.trialFeeConfirmed) return "환불 완료";
    if (lead.trialFeeConfirmed) return "입금 완료";
    return lead.trialFeeNoticeAgreedAt ? "입금 대기(학부모 동의함)" : "입금 대기";
}

/** 입금 확인과 감사 이력을 같은 트랜잭션에 묶어 반쪽 저장을 방지한다. */
export async function confirmTrialFeeWithAudit(
    db: TrialFeeConfirmationTransactionDb,
    trialLeadId: string,
    actor: TrialFeeAuditActor,
): Promise<TrialFeeConfirmationResult> {
    return db.$transaction(async (tx) => {
        const result = await confirmTrialFeeOnce(tx, trialLeadId);
        if (!result.changed) return result;

        await tx.$executeRawUnsafe(
            `INSERT INTO "ApplicationContactLog" (
                id, "targetType", "trialLeadId", "enrollmentApplicationId", action, note,
                "createdByUserId", "createdByName", "createdAt", "updatedAt"
            ) VALUES (
                gen_random_uuid()::text, 'TRIAL', $1, NULL, 'UPDATED',
                '체험비 입금 확인', $2, $3, NOW(), NOW()
            )`,
            trialLeadId,
            actor.userId,
            actor.userName,
        );
        return result;
    });
}

// ───────────────────────── 체험비 온라인 결제(2026-11-10) ─────────────────────────
// trialFeeConfirmed 를 true 로 쓰는 곳은 이 파일 하나뿐이어야 한다(가드 테스트). 그래서 온라인 결제 완료·환불의
// 신청 행 반영도 여기 둔다. 결제 기록(TrialFeePayment) 쪽은 src/lib/trial-fee/trialFeeLedger.ts 가 맡는다.

type TrialFeeSqlDb = {
    $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/**
 * 온라인 결제 완료 → 신청을 «체험비 결제 완료(체험 확정)»로. 트랜잭션 안에서 부른다(결제 기록 반영과 한 묶음).
 * 이미 학원이 입금 확인한 신청이면 값은 그대로 두고 changed=false(부르는 쪽이 이중 납부로 처리).
 */
export async function markTrialFeePaidOnlineInTx(
    tx: TrialFeeSqlDb,
    trialLeadId: string,
    note: string,
): Promise<{ changed: boolean }> {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "TrialLead"
         SET "trialFeeConfirmed" = true,
             "trialFeePaidAt" = COALESCE("trialFeePaidAt", NOW()),
             "trialFeePaymentStatus" = 'PAID',
             "updatedAt" = NOW()
         WHERE id = $1
           AND COALESCE("trialFeeConfirmed", false) = false
         RETURNING id`,
        trialLeadId,
    );
    if (rows.length === 0) return { changed: false };
    await tx.$executeRawUnsafe(
        `INSERT INTO "ApplicationContactLog" (
            id, "targetType", "trialLeadId", "enrollmentApplicationId", action, note,
            "createdByUserId", "createdByName", "createdAt", "updatedAt"
        ) VALUES (
            gen_random_uuid()::text, 'TRIAL', $1, NULL, 'UPDATED',
            $2, NULL, '온라인 결제', NOW(), NOW()
        )`,
        trialLeadId,
        note,
    );
    return { changed: true };
}

/**
 * 온라인 결제 전액 취소(환불) → 신청의 체험비 상태를 «환불 완료»로 되돌린다(입금 확인 해제).
 * 온라인 결제 완료(PAID)였던 신청만 바꾼다 — 계좌 입금으로 확인한 신청은 건드리지 않는다.
 */
export async function markTrialFeeRefundedInTx(
    tx: TrialFeeSqlDb,
    trialLeadId: string,
    actor: TrialFeeAuditActor,
): Promise<{ changed: boolean }> {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "TrialLead"
         SET "trialFeeConfirmed" = false,
             "trialFeePaymentStatus" = 'REFUNDED',
             "updatedAt" = NOW()
         WHERE id = $1
           AND "trialFeePaymentStatus" = 'PAID'
         RETURNING id`,
        trialLeadId,
    );
    if (rows.length === 0) return { changed: false };
    await tx.$executeRawUnsafe(
        `INSERT INTO "ApplicationContactLog" (
            id, "targetType", "trialLeadId", "enrollmentApplicationId", action, note,
            "createdByUserId", "createdByName", "createdAt", "updatedAt"
        ) VALUES (
            gen_random_uuid()::text, 'TRIAL', $1, NULL, 'UPDATED',
            '체험비 온라인 결제 환불(전액 취소)', $2, $3, NOW(), NOW()
        )`,
        trialLeadId,
        actor.userId,
        actor.userName,
    );
    return { changed: true };
}
