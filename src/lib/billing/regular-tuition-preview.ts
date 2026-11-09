/**
 * 정규반 수강료 «미리보기» 한 곳 (2026-11-09 원생 등록 재설계).
 *
 * ■ 왜 따로 두는가
 *   «주 n회 가격 + 셔틀 자동 1만/1.5만/2만» 상수가 프로그램 화면 2곳(ProgramsAdminClient·ProgramFormPanel)에
 *   복사돼 있었고, 새 «원생 등록» 창도 같은 값을 써야 한다. 여러 군데가 따로 놀면 한쪽만 고쳐지는 사고가 난다.
 *
 * ■ 계산은 청구 모듈(workbench-pricing)에 맡긴다 — 검수 반영 2026-11-09
 *   등록 창 미리보기가 실제 청구 «제안값»과 달라지면 원장이 본 금액과 청구서 금액이 어긋난다.
 *   그래서 이 파일은 금액을 스스로 계산하지 않고 workbench-pricing 의 planWeeklyTuition·planShuttleFee 를
 *   그대로 부른다(반 4개·여러 프로그램·주말 판정(반 요일 기준)·일8 대표팀 면제·직접 입력 셔틀비 모두 청구와 같다).
 *   셔틀 자동 요금 상수도 workbench-pricing 의 AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT 하나에서 읽는다.
 *   ⚠️ workbench-pricing.ts 자체는 여기서 고치지 않는다(청구 쪽 작업 몫) — 호출만 한다.
 *
 * ■ 범위 — «표시만». 청구는 월 장부가 한다.
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — `node --test` 로 실제 실행해 검증한다.
 */
import {
    AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT,
    planShuttleFee,
    planWeeklyTuition,
    type TuitionEnrollment,
} from "@/lib/billing/workbench-pricing";

/** 프로그램 화면의 주 횟수별 가격 칸과 셔틀 자동 요금 — 금액은 청구 모듈 상수에서 읽는다(매일반 = 주3회 이상 값) */
export const REGULAR_FREQ_TIERS = [
    { key: "priceWeek1" as const, label: "주 1회", autoShuttle: AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[1] },
    { key: "priceWeek2" as const, label: "주 2회", autoShuttle: AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[2] },
    { key: "priceWeek3" as const, label: "주 3회", autoShuttle: AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[3] },
    { key: "priceDaily" as const, label: "매일반", autoShuttle: AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[3] },
];

export type RegularFreqTierKey = typeof REGULAR_FREQ_TIERS[number]["key"];

/** 셔틀이 운행하지 않는 주말 요일(프로그램 화면의 «주말반» 표시용) */
export const WEEKEND_DAYS: ReadonlySet<string> = new Set(["Sat", "Sun"]);

/** 요일 목록이 모두 주말인가(빈 목록은 주말 아님) — 프로그램 화면 표시용 */
export function isWeekendOnlyDays(days: string[]): boolean {
    if (days.length === 0) return false;
    return days.every((d) => WEEKEND_DAYS.has(d));
}

/**
 * 프로그램 화면 표의 «이 횟수일 때 셔틀비» 표시값(원). 운행 안 하면 null.
 * 주말반 → null · 직접 입력 0 → null · 직접 입력 양수 → 그 값 · 그 밖 → 주 횟수별 자동 요금(청구 모듈 상수).
 */
export function shuttleFeeAmount(
    shuttleFeeOverride: number | null | undefined,
    freqKey: RegularFreqTierKey,
    weekend: boolean,
): number | null {
    if (weekend) return null;
    if (shuttleFeeOverride === 0) return null;
    if (shuttleFeeOverride != null && shuttleFeeOverride > 0) return shuttleFeeOverride;
    const tier = REGULAR_FREQ_TIERS.find((t) => t.key === freqKey);
    return tier ? tier.autoShuttle : null;
}

/** 미리보기에 필요한 프로그램 값(DB Program 의 일부) */
export type TuitionProgram = {
    id: string;
    name: string;
    price: number;
    priceWeek1: number | null;
    priceWeek2: number | null;
    priceWeek3: number | null;
    priceDaily: number | null;
    shuttleFeeOverride: number | null;
    runsShuttle: boolean;
};

/** 고른 반 하나(요일·슬롯은 셔틀 주말 판정·대표팀 면제에 쓴다) */
export type TuitionClass = { id: string; programId: string; dayOfWeek: string; slotKey: string | null };

/** 프로그램 하나의 미리보기 한 줄 */
export type TuitionPreviewLine = {
    programId: string;
    programName: string;
    weeklyCount: number;
    /** 청구 제안값과 같은 그 프로그램 월 수강료(반별 나눈 값의 합) */
    tuition: number;
    /** 청구 화면이 붙이는 경고(주N회 요금 빈 칸·여러 프로그램 등) */
    warning: string | null;
};

export type TuitionPreview = {
    lines: TuitionPreviewLine[];
    tuitionTotal: number;
    /** 학생 한 명의 월 셔틀비 제안값(셔틀 안 쓰면 0) */
    shuttleFee: number;
    shuttleWarning: string | null;
};

const NEW_STUDENT_KEY = "new-student";

/**
 * 고른 반들 → 청구 제안값과 같은 «월 수강료(프로그램별) + 월 셔틀비».
 * 청구 모듈 함수를 그대로 부르므로 금액 규칙은 그쪽 한 곳에만 있다.
 */
export function previewRegularTuition(
    programs: TuitionProgram[],
    selectedClasses: TuitionClass[],
    useShuttle: boolean,
): TuitionPreview {
    const programById = new Map(programs.map((p) => [p.id, p]));
    const picked = selectedClasses.filter((c) => programById.has(c.programId));

    // 수강료 — 청구 준비 화면과 같은 입력 모양(반마다 한 행)
    const enrollments: TuitionEnrollment[] = picked.map((c) => {
        const p = programById.get(c.programId)!;
        return {
            key: `${NEW_STUDENT_KEY}:${c.id}`,
            studentId: NEW_STUDENT_KEY,
            programId: p.id,
            programName: p.name,
            // 반 요일 — 대회준비반 주말 묶음(30만)과 평일만(15만)을 청구와 같게 가르려면 필요하다.
            dayOfWeek: c.dayOfWeek,
            price: p.price,
            priceWeek1: p.priceWeek1,
            priceWeek2: p.priceWeek2,
            priceWeek3: p.priceWeek3,
            priceDaily: p.priceDaily,
        };
    });
    const plans = planWeeklyTuition(enrollments);

    const lines: TuitionPreviewLine[] = [];
    for (const e of enrollments) {
        const plan = plans.get(e.key);
        let line = lines.find((l) => l.programId === e.programId);
        if (!line) {
            line = { programId: e.programId!, programName: e.programName ?? "", weeklyCount: 0, tuition: 0, warning: null };
            lines.push(line);
        }
        line.weeklyCount += 1;
        line.tuition += plan?.baseAmount ?? 0;
        line.warning = line.warning ?? plan?.warning ?? null;
    }

    // 셔틀비 — «셔틀 이용» = 청구 쪽 «셔틀 명단에 있음»
    const shuttle = planShuttleFee(useShuttle, picked.map((c) => {
        const p = programById.get(c.programId)!;
        return { dayOfWeek: c.dayOfWeek, slotKey: c.slotKey, runsShuttle: p.runsShuttle, shuttleFeeOverride: p.shuttleFeeOverride };
    }));

    return {
        lines,
        tuitionTotal: lines.reduce((sum, l) => sum + l.tuition, 0),
        shuttleFee: shuttle.amount,
        shuttleWarning: useShuttle && picked.length > 0 ? shuttle.warning : null,
    };
}
