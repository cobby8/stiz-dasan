"use server";

// «오늘 이 반 휴강» 표시·취소(2026-11-17) — 관리자 서버 액션.
// 원장·부원장만(requireAdmin). 이 표시는 그날 그 수업의 독촉만 멈춘다 —
// 학부모 화면·청구·보강권·셔틀·출결에는 아무 영향이 없다(저장·판정은 src/lib/class-nudge 에만 있다).

import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { todayKst } from "@/lib/datetime/kst";
import { CLASS_DAY_CACHE_TAG } from "@/lib/class-nudge/boardServer";
import { clearClassDayCancelInDb, setClassDayCancelInDb, type CancelStoreResult } from "@/lib/class-nudge/cancelStore";

type ActionResult = { ok: true } | { ok: false; message: string };

type CancelKind = "REGULAR" | "SEASONAL";

/** 관리자 확인 실패를 화면에 보일 결과로 바꾼다(예외를 던지면 화면이 오류 페이지로 넘어간다). */
async function adminGate(): Promise<{ ok: true; adminUserId: string } | { ok: false; message: string }> {
    try {
        const admin = await requireAdmin();
        return { ok: true, adminUserId: admin.appUserId };
    } catch {
        return { ok: false, message: "원장·부원장만 휴강을 표시할 수 있습니다." };
    }
}

function finish(result: CancelStoreResult): ActionResult {
    if (!result.ok) return result;
    // 대시보드 «오늘 수업 처리 현황»의 30초 캐시를 바로 비운다(누른 직후 화면이 다시 읽는다)
    if (result.changed) revalidateTag(CLASS_DAY_CACHE_TAG, { expire: 0 });
    return { ok: true };
}

/** 오늘 이 수업을 휴강으로 표시한다. 특강 회차는 시작 시각(startTime "HH:MM")을 같이 넘긴다. */
export async function setClassDayCancel(input: {
    date: string;
    classId: string;
    kind: CancelKind;
    startTime?: string;
    reason?: string;
}): Promise<ActionResult> {
    const gate = await adminGate();
    if (!gate.ok) return gate;
    const result = await setClassDayCancelInDb(
        prisma,
        {
            date: input?.date, today: todayKst(), classId: input?.classId, kind: input?.kind,
            startTime: input?.startTime, reason: input?.reason, actorUserId: gate.adminUserId,
        },
        // 표시와 감사 기록을 한 트랜잭션으로 — 한쪽만 남지 않게
        (run) => prisma.$transaction((tx) => run(tx)),
    );
    return finish(result);
}

/** 휴강 표시를 지운다(다시 독촉 대상이 된다). */
export async function clearClassDayCancel(input: {
    date: string;
    classId: string;
    kind: CancelKind;
    startTime?: string;
}): Promise<ActionResult> {
    const gate = await adminGate();
    if (!gate.ok) return gate;
    const result = await clearClassDayCancelInDb(
        prisma,
        {
            date: input?.date, today: todayKst(), classId: input?.classId, kind: input?.kind,
            startTime: input?.startTime, actorUserId: gate.adminUserId,
        },
        (run) => prisma.$transaction((tx) => run(tx)),
    );
    return finish(result);
}
