import { prisma } from "@/lib/prisma";
import {
    DEFAULT_PUSH_PREFS,
    PUSH_CATEGORIES,
    pushCategoryOf,
    type PushPrefs,
} from "@/lib/mypage/parentSettings";

// 학부모 앱 알림 «종류별 받기» 저장·조회 (2026-11-10 원장 결정 k7).
// 표: "ParentNotificationPreference" — 학부모 한 명당 한 줄, 칸 4개(출결·청구·공지·셔틀). 줄이 없으면 전부 받기.
//
// ★ 표가 아직 운영 DB 에 없을 수 있다(마이그레이션 파일만 만들고 운영 적용은 원장 확인 후).
//   그래서 «읽기 실패 = 전부 받기»로 둔다 — 설정 조회가 실패했다고 알림이 끊기면 안 된다.

// 칸 이름은 이 목록에서만 나온다(SQL 에 끼워 넣는 글자는 화면 값이 아니라 상수)
const COLUMNS = PUSH_CATEGORIES.map((c) => c.column);

type PrefRow = Record<(typeof COLUMNS)[number], boolean | null>;

function rowToPrefs(row: PrefRow | undefined): PushPrefs {
    const out = { ...DEFAULT_PUSH_PREFS };
    if (!row) return out;
    for (const c of PUSH_CATEGORIES) out[c.key] = row[c.column] !== false;
    return out;
}

/** 내 종류별 받기 설정. available=false 면 저장 표가 아직 없다(화면에서 종류별 칸을 숨긴다). */
export async function readPushPrefs(userId: string): Promise<{ prefs: PushPrefs; available: boolean }> {
    try {
        const rows = await prisma.$queryRawUnsafe<PrefRow[]>(
            `SELECT ${COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "ParentNotificationPreference" WHERE "userId" = $1 LIMIT 1`,
            userId,
        );
        return { prefs: rowToPrefs(rows[0]), available: true };
    } catch (e) {
        console.error("[readPushPrefs] failed:", e instanceof Error ? e.message : e);
        return { prefs: { ...DEFAULT_PUSH_PREFS }, available: false };
    }
}

/** 내 종류별 받기 설정 저장(한 줄 덮어쓰기). userId 는 반드시 서버가 확인한 로그인 사용자여야 한다. */
export async function writePushPrefs(userId: string, prefs: PushPrefs): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "ParentNotificationPreference" ("userId", "pushAttendance", "pushBilling", "pushNotice", "pushShuttle", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT ("userId") DO UPDATE SET
           "pushAttendance" = EXCLUDED."pushAttendance",
           "pushBilling" = EXCLUDED."pushBilling",
           "pushNotice" = EXCLUDED."pushNotice",
           "pushShuttle" = EXCLUDED."pushShuttle",
           "updatedAt" = NOW()`,
        userId, prefs.attendance, prefs.billing, prefs.notice, prefs.shuttle,
    );
}

/** 이 사람에게 이 종류(tag) 휴대폰 알림을 보내도 되나. 끌 수 없는 종류·조회 실패는 보낸다. */
export async function isPushAllowed(userId: string, tag: string | null | undefined): Promise<boolean> {
    const category = pushCategoryOf(tag);
    if (!category) return true;
    const column = PUSH_CATEGORIES.find((c) => c.key === category)!.column;
    try {
        const rows = await prisma.$queryRawUnsafe<{ on: boolean | null }[]>(
            `SELECT "${column}" AS "on" FROM "ParentNotificationPreference" WHERE "userId" = $1 LIMIT 1`,
            userId,
        );
        return rows[0]?.on !== false;
    } catch {
        return true;
    }
}

/** 이 종류(tag)를 끈 사람 목록(전체 학부모 발송에서 뺄 사람). 끌 수 없는 종류·조회 실패는 빈 목록. */
export async function optedOutUserIds(tag: string | null | undefined): Promise<Set<string>> {
    const category = pushCategoryOf(tag);
    if (!category) return new Set();
    const column = PUSH_CATEGORIES.find((c) => c.key === category)!.column;
    try {
        const rows = await prisma.$queryRawUnsafe<{ userId: string }[]>(
            `SELECT "userId" FROM "ParentNotificationPreference" WHERE "${column}" = false`,
        );
        return new Set(rows.map((r) => r.userId));
    } catch {
        return new Set();
    }
}
