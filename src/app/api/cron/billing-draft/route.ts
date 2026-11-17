import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { WorkbenchError, shuttleRosterMissingMessage } from "@/lib/billing/workbench";
import { mutateWorkbench, readWorkbench } from "@/lib/billing/workbench-service";
import { loadWorkbenchCalendar } from "@/lib/billing/workbench-calendar";
import { createNotificationRecord } from "@/lib/notification";
import { withCronAlert } from "@/lib/cron/withCronAlert";
import {
    AUTO_DRAFT_ACTOR,
    autoDraftRequestId,
    billingMonthsToTry,
    planAutoDraft,
    undeterminedBillingMonth,
} from "@/lib/billing/billing-schedule";

export const dynamic = "force-dynamic";

/**
 * 청구일 자동 초안 — 매일 KST 00:25 (UTC 15:25, vercel.json).
 *
 * 왜 필요한가(원장 결정 2026-11-17): 원장이 매달 손으로 청구 초안을 만들지 않고 «보고 승인만» 하게.
 * 청구일 = 전달 «N월 개강» + 14일(src/lib/billing/billing-schedule.ts). 오늘이 어느 달의 청구일이면
 * 청구 준비(readWorkbench) 결과 중 «검토 사유가 없거나 일반 문구 하나뿐이고, 차단·보류·이월 차감·기간 조정이 없는 행»만
 * 제안값 그대로 초안(DRAFT) 저장한다(판정 isAutoDraftCandidate). 원장은 화면 «승인 대기»에서 보고 한꺼번에 발행한다.
 *
 * 절대 하지 않는 것: 확정(CONFIRM)·발행(ISSUE)·학부모 알림.
 * 구체 사유(셔틀 중복·고정 수강료 등)나 이월 차감·기간 조정(3회 달 차감·부상 결석 정산 포함)이 있는 행은 손대지 않는다
 * — 초안 저장이 곧 «관리자가 검토함» 표시라서, 자동 저장하면 사람이 안 본 경고·금액이 그냥 넘어간다(근거는 planAutoDraft 주석).
 * 그 달 셔틀 명단이 없으면 아무 행도 저장하지 않고 원장에게 알린다(셔틀비가 0원으로 제안되기 때문, 검수 B-1).
 * 청구일 당일에 못 만들었으면(실패·자료 변경) 청구일 +1~+3일에 «그 달 자동 초안이 아직 없을 때만» 다시 시도한다(검수 B-4).
 * 쓰기 스위치 STIZ_BILLING_WORKBENCH_WRITES_ENABLED 가 "true" 가 아니면 아무것도 쓰지 않고 로그만 남긴다(알림도 없음).
 * 여러 번 돌아도 결과가 같다: 이미 초안이 있는 행은 건너뛰고, 요청 번호도 같은 원본이면 같다. 알림은 같은 제목이면 한 번만.
 */

/** 원장에게 보낼 관리자 내부 알림 종류(앱 알림 + 웹 푸시, 문자 없음) */
const NOTICE_TYPE = "BILLING_DRAFT_READY";

type Calendar = Awaited<ReturnType<typeof loadWorkbenchCalendar>>;
type MonthResult = {
    month: string;
    billingDate: string;
    catchUp: boolean;
    writesEnabled: boolean;
    saved: number;
    review: number;
    hold: number;
    already: number;
    /** 그 달 셔틀 명단이 없어 멈췄다 */
    shuttleRosterMissing?: boolean;
    /** 따라잡기 날인데 이미 자동 초안이 있어 건너뛰었다 */
    skipped?: boolean;
    error?: string;
};

/** 그 달에 자동 초안을 저장한 적이 있는가(감사 기록 BillingWorkbenchRevision 의 저장자로 본다) */
async function autoDraftDone(month: string): Promise<boolean> {
    try {
        const rows = await prisma.$queryRawUnsafe<Array<{ found: number }>>(
            `SELECT 1 AS found FROM "BillingWorkbenchRevision" WHERE month=$1 AND "actorUserId"=$2 LIMIT 1`, month, AUTO_DRAFT_ACTOR);
        return rows.length > 0;
    } catch {
        return false; // 표가 없으면 아래 읽기에서 «저장 구조 없음»으로 걸린다
    }
}

/** 청구월 하나 처리 — 읽기 → 셔틀 명단 확인 → 저장할 행 고르기 → (스위치가 켜졌을 때만) 초안 저장 */
async function runMonth(month: string, billingDate: string, catchUp: boolean, today: string, writesEnabled: boolean, calendar: Calendar): Promise<MonthResult> {
    const empty: MonthResult = { month, billingDate, catchUp, writesEnabled, saved: 0, review: 0, hold: 0, already: 0 };
    // 따라잡기 날: 그 달 자동 초안이 이미 있으면 아무것도 하지 않는다(당일에 만들었거나 원장이 처리 중)
    if (catchUp && await autoDraftDone(month)) return { ...empty, skipped: true };
    // 청구 준비 화면과 같은 읽기(읽기 전용 거래)
    const view = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return readWorkbench(tx, month, writesEnabled, calendar);
    }, { isolationLevel: "RepeatableRead", timeout: 15_000 });
    const plan = planAutoDraft(view.rows, today);
    const base: MonthResult = { ...empty, review: plan.review, hold: plan.hold, already: plan.already };

    // 셔틀 명단이 없는 달은 셔틀비가 전부 0원으로 제안된다 — 한 행도 저장하지 않는다(검수 B-1)
    if (view.shuttleRosterMissing) {
        console.error(`[cron/billing-draft] ${month} 셔틀 명단 없음 — 자동 초안을 만들지 않음`);
        return { ...base, shuttleRosterMissing: true };
    }
    if (!writesEnabled) {
        console.log(`[cron/billing-draft] ${month} 청구일 — 쓰기 스위치 꺼짐, 저장 안 함(저장 후보 ${plan.saveRows.length}건 · 검토 필요 ${plan.review}건 · 보류 ${plan.hold}건 · 이미 있음 ${plan.already}건)`);
        return base;
    }
    if (!view.storageReady) {
        console.error(`[cron/billing-draft] ${month} 청구 준비 저장 구조가 없어 저장하지 않음`);
        return { ...base, error: "청구 준비 저장 구조를 확인해 주세요." };
    }
    if (!plan.saveRows.length) return base;

    // 한 요청은 최대 500행(validateWorkbenchCommand 한도). 넘치면 앞 500행만 저장하고 나머지는 원장이 화면에서 저장한다.
    const rows = plan.saveRows.slice(0, 500);
    if (plan.saveRows.length > 500) console.error(`[cron/billing-draft] ${month} 저장 후보 ${plan.saveRows.length}건 중 500건만 저장`);
    try {
        // 화면의 «선택 검토 저장»과 같은 경로(SAVE → DRAFT). 감사 기록의 저장한 사람 = 시스템 고정 글자
        const result = await mutateWorkbench(prisma, {
            action: "SAVE",
            month,
            sourceVersion: view.sourceVersion,
            requestId: autoDraftRequestId(month, view.sourceVersion),
            rows,
        }, AUTO_DRAFT_ACTOR, true, calendar);
        return { ...base, saved: result.operationResult.rowIds.length };
    } catch (error) {
        // 읽은 뒤 자료가 바뀌었거나(409) 금액 규칙에 걸리면 저장하지 않는다 — 다음 날 다시 시도하고, 원장도 화면에서 처리할 수 있다
        const message = error instanceof WorkbenchError ? error.message : "초안 저장에 실패했습니다.";
        console.error(`[cron/billing-draft] ${month} 초안 저장 실패:`, error instanceof Error ? error.message : error);
        return { ...base, error: message };
    }
}

/** 원장(ADMIN)에게만 앱 알림. 같은 제목을 이미 받았으면 다시 보내지 않는다(하루 여러 번·따라잡기 날에도 한 번). */
async function notifyOwner(month: string, title: string, message: string) {
    // 부원장은 청구 준비 화면을 못 연다(원장 전용) — ADMIN 만 받는다
    const owners = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "User" WHERE role='ADMIN'`);
    for (const owner of owners) {
        const sent = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM "Notification" WHERE "userId"=$1 AND type=$2 AND title=$3 LIMIT 1`, owner.id, NOTICE_TYPE, title);
        if (sent.length) continue;
        await createNotificationRecord({ userId: owner.id, type: NOTICE_TYPE, title, message, linkUrl: `/admin/finance/prepare?month=${month}` });
    }
}

/** 처리 결과 → 알림 제목·내용(보낼 것이 없으면 null) */
async function noticeFor(result: MonthResult): Promise<{ title: string; message: string } | null> {
    const [year, monthNumber] = result.month.split("-").map(Number);
    const head = `${year}년 ${monthNumber}월`;
    if (result.skipped) return null;
    if (result.shuttleRosterMissing) return { title: `${head} 셔틀 명단이 없어 자동 초안을 만들지 않았습니다`, message: `${shuttleRosterMissingMessage(result.month, "AUTO_DRAFT")} 학부모에게는 아무것도 나가지 않았습니다.` };
    if (result.error) {
        // 같은 시각에 두 번 돈 경우 등 — 이미 다른 실행이 자동 초안을 만들었으면 실패를 알리지 않는다(검수 B-4)
        if (await autoDraftDone(result.month)) return null;
        return { title: `${head} 청구 초안을 자동으로 만들지 못했습니다`, message: `${monthNumber}월 청구일(${result.billingDate})에 자동 초안을 저장하지 못했습니다(${result.error}). 청구일 뒤 사흘 동안 매일 새벽에 다시 시도합니다. 급하면 청구 준비 화면에서 직접 저장해 주세요. 학부모에게는 아무것도 나가지 않았습니다.` };
    }
    return { title: `${head} 청구 초안이 준비됐습니다`, message: `자동 초안 ${result.saved}건 · 확인 필요 ${result.review}건${result.hold ? ` · 발행 보류 ${result.hold}건` : ""}. 청구 준비 화면 «승인 대기»에서 확인한 뒤 발행해 주세요. 학부모에게는 아직 아무것도 나가지 않았습니다.` };
}

async function handleGet(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (
        process.env.NODE_ENV !== "development" &&
        (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
    ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const writesEnabled = process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true";
    const today = todayKst();
    const notify = (month: string, notice: { title: string; message: string } | null) =>
        writesEnabled && notice ? notifyOwner(month, notice.title, notice.message).catch((error) => console.error("[cron/billing-draft] 원장 알림 실패:", error instanceof Error ? error.message : error)) : Promise.resolve();
    try {
        // 공식 일정(구글 캘린더 + AnnualEvent)을 새로 읽는다 — 청구 준비 저장과 같은 달력 스냅샷
        const calendar = await loadWorkbenchCalendar(true);

        // 다음 달 청구일을 정할 수 없으면(이번 달 개강 일정 없음·중복) 15일 이후 한 번 알린다(같은 제목 한 번, 검수 B-4)
        const undetermined = undeterminedBillingMonth(calendar.events, today);
        if (undetermined) {
            const [y, m] = undetermined.month.split("-").map(Number);
            const source = calendar.kind === "DB" ? "구글 캘린더 주소가 없어 학원 연간 일정 표만 읽었습니다." : "구글 캘린더와 학원 연간 일정 표를 함께 읽었습니다.";
            await notify(undetermined.month, { title: `${y}년 ${m}월 청구일을 정하지 못했습니다`, message: `${undetermined.reason} ${source} 연간계획표에 개강 일정을 넣으면 그다음 새벽부터 자동 초안이 만들어집니다.` });
        }

        const targets = billingMonthsToTry(calendar.events, today);
        if (!targets.length) return NextResponse.json({ ok: true, today, due: [] });

        const results: MonthResult[] = [];
        for (const target of targets) {
            const result = await runMonth(target.month, target.billingDate, target.catchUp, today, writesEnabled, calendar);
            results.push(result);
            console.log(`[cron/billing-draft] ${target.month} ${target.catchUp ? "따라잡기" : "청구일"} 처리: ${result.skipped ? "이미 자동 초안 있음 — 건너뜀" : `초안 ${result.saved}건 · 확인 필요 ${result.review}건 · 보류 ${result.hold}건 · 이미 있음 ${result.already}건${result.shuttleRosterMissing ? " · 셔틀 명단 없음" : ""}${result.error ? ` · 오류 ${result.error}` : ""}`}`);
            // 스위치가 꺼져 있으면 알림도 보내지 않는다(초안이 없는데 «준비됐다»고 하지 않게)
            await notify(target.month, await noticeFor(result));
        }
        return NextResponse.json({ ok: true, today, due: targets.map((t) => t.month), results });
    } catch (error) {
        console.error("[cron/billing-draft] failed:", error instanceof Error ? error.message : error);
        return NextResponse.json({ ok: false, error: "청구일 자동 초안을 처리하지 못했습니다." }, { status: 500 });
    }
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4, 다른 cron 과 같은 래퍼)
export const GET = withCronAlert("billing-draft", handleGet);
