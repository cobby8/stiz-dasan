type ContactTx = {
    $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

type ContactDb = {
    $transaction<T>(callback: (tx: ContactTx) => Promise<T>): Promise<T>;
};

export type AtomicContactInput = {
    targetType: "TRIAL" | "ENROLL";
    targetId: string;
    action: string;
    note: string | null;
    nextFollowUpAt: string | null;
    actorUserId: string | null;
    actorUserName: string | null;
};

/** 연락 로그와 관련 상태 변경을 한 트랜잭션으로 저장한다. */
export async function recordApplicationContactAtomically(db: ContactDb, input: AtomicContactInput) {
    return db.$transaction(async (tx) => {
        const table = input.targetType === "TRIAL" ? '"TrialLead"' : '"EnrollmentApplication"';
        const exists = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${table} WHERE id = $1 LIMIT 1`,
            input.targetId,
        );
        if (exists.length === 0) return { found: false };

        if (input.action === "CONTACTED") {
            if (input.targetType === "TRIAL") {
                // NEW만 CONTACTED로 전진시키며 SCHEDULED 등 이후 상태는 절대 되돌리지 않는다.
                await tx.$executeRawUnsafe(
                    `UPDATE "TrialLead" SET status = 'CONTACTED', "updatedAt" = NOW()
                     WHERE id = $1 AND status = 'NEW'`,
                    input.targetId,
                );
            }
            const ownerColumn = input.targetType === "TRIAL" ? '"trialLeadId"' : '"enrollmentApplicationId"';
            await tx.$executeRawUnsafe(
                `UPDATE "ApplicationContactLog"
                 SET "followUpCompletedAt" = COALESCE("followUpCompletedAt", NOW()), "updatedAt" = NOW()
                 WHERE "targetType" = $1 AND ${ownerColumn} = $2
                   AND "nextFollowUpAt" IS NOT NULL AND "followUpCompletedAt" IS NULL`,
                input.targetType,
                input.targetId,
            );
        }

        await tx.$executeRawUnsafe(
            `INSERT INTO "ApplicationContactLog" (
                id, "targetType", "trialLeadId", "enrollmentApplicationId", action, note,
                "nextFollowUpAt", "createdByUserId", "createdByName", "createdAt", "updatedAt"
            ) VALUES (
                gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::timestamptz,
                $7, $8, NOW(), NOW()
            )`,
            input.targetType,
            input.targetType === "TRIAL" ? input.targetId : null,
            input.targetType === "ENROLL" ? input.targetId : null,
            input.action,
            input.note,
            input.nextFollowUpAt,
            input.actorUserId,
            input.actorUserName,
        );
        return { found: true };
    });
}
