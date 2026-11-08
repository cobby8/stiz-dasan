/**
 * 정규반 수강료 «미리보기» 한 곳 (2026-11-09 원생 등록 재설계).
 *
 * ■ 왜 따로 두는가
 *   «주 n회 가격 + 셔틀 자동 1만/1.5만/2만» 상수가 프로그램 화면 2곳(ProgramsAdminClient·ProgramFormPanel)에
 *   복사돼 있었고, 새 «원생 등록» 창도 같은 값을 써야 한다. 세 군데가 따로 놀면 한쪽만 고쳐지는 사고가 나서
 *   상수·셔틀비 판정을 이 파일 하나로 모았다(금액은 바꾸지 않았다 — 테스트로 고정).
 *
 * ■ 범위 — «표시만»
 *   실제 청구 금액은 월 장부·청구 모듈(src/lib/billing/* 의 다른 파일)이 정한다. 이 파일은 화면에 보여 줄
 *   참고 금액만 계산하며 청구 모듈을 import 하지도, 청구 모듈에서 쓰이지도 않는다.
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — `node --test` 로 실제 실행해 검증한다.
 */

/** 주 횟수별 가격 칸과 셔틀 자동 요금(프로그램 화면에서 «자동»일 때 쓰는 값) */
export const REGULAR_FREQ_TIERS = [
    { key: "priceWeek1" as const, label: "주 1회", autoShuttle: 10000 },
    { key: "priceWeek2" as const, label: "주 2회", autoShuttle: 15000 },
    { key: "priceWeek3" as const, label: "주 3회", autoShuttle: 20000 },
    { key: "priceDaily" as const, label: "매일반", autoShuttle: 20000 },
];

export type RegularFreqTierKey = typeof REGULAR_FREQ_TIERS[number]["key"];

/** 셔틀이 운행하지 않는 주말 요일 */
export const WEEKEND_DAYS: ReadonlySet<string> = new Set(["Sat", "Sun"]);

/** 요일 목록이 모두 주말인가(빈 목록은 주말 아님) — 주말반은 셔틀이 없다 */
export function isWeekendOnlyDays(days: string[]): boolean {
    if (days.length === 0) return false;
    return days.every((d) => WEEKEND_DAYS.has(d));
}

/**
 * 셔틀 요금(원). 운행 안 하면 null.
 * - 주말반 → null(운행 없음)
 * - shuttleFeeOverride === 0 → null(명시적으로 끔)
 * - shuttleFeeOverride > 0 → 그 값(직접 입력)
 * - 그 밖 → 주 횟수별 자동 요금
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
    days?: string | null;
    priceWeek1?: number | null;
    priceWeek2?: number | null;
    priceWeek3?: number | null;
    priceDaily?: number | null;
    shuttleFeeOverride?: number | null;
    runsShuttle?: boolean | null;
};

/** 고른 반 수(주 n회) → 가격 칸. 4회 이상은 «매일반» */
export function freqKeyForCount(count: number): RegularFreqTierKey | null {
    if (count <= 0) return null;
    if (count === 1) return "priceWeek1";
    if (count === 2) return "priceWeek2";
    if (count === 3) return "priceWeek3";
    return "priceDaily";
}

/** 프로그램 하나의 미리보기 한 줄 */
export type TuitionPreviewLine = {
    programId: string;
    programName: string;
    weeklyCount: number;
    freqLabel: string;
    /** 그 횟수 가격이 프로그램에 없으면 null(«요금 미설정») */
    tuition: number | null;
    /** 셔틀을 쓰지 않거나 운행 안 하면 null */
    shuttleFee: number | null;
};

export type TuitionPreview = {
    lines: TuitionPreviewLine[];
    /** 모든 줄의 수강료가 있을 때만 합계, 하나라도 미설정이면 null */
    tuitionTotal: number | null;
    shuttleTotal: number;
};

/**
 * 고른 반들 → 프로그램별로 묶어 «주 n회 · 월 수강료 (+셔틀)» 미리보기.
 * 프로그램에 저장된 주 1·2·3회/매일반 가격을 그대로 쓴다(할인·일할 계산 없음 — 청구는 월 장부 몫).
 * @param selectedProgramIds 고른 반마다 그 반의 programId 하나씩(같은 프로그램 두 반 = 주 2회)
 * @param useShuttle 셔틀 이용 여부
 */
export function previewRegularTuition(
    programs: TuitionProgram[],
    selectedProgramIds: string[],
    useShuttle: boolean,
): TuitionPreview {
    const counts = new Map<string, number>();
    for (const id of selectedProgramIds) counts.set(id, (counts.get(id) ?? 0) + 1);

    const lines: TuitionPreviewLine[] = [];
    for (const [programId, weeklyCount] of counts) {
        const program = programs.find((p) => p.id === programId);
        const key = freqKeyForCount(weeklyCount);
        if (!program || !key) continue;
        const tier = REGULAR_FREQ_TIERS.find((t) => t.key === key)!;
        const price = program[key];
        const days = program.days ? program.days.split(",").map((d) => d.trim()).filter(Boolean) : [];
        // 셔틀: 이용 체크 + 프로그램이 셔틀을 운행할 때만(runsShuttle=false 면 없음)
        const shuttleFee = useShuttle && program.runsShuttle !== false
            ? shuttleFeeAmount(program.shuttleFeeOverride, key, isWeekendOnlyDays(days))
            : null;
        lines.push({
            programId,
            programName: program.name,
            weeklyCount,
            freqLabel: tier.label,
            tuition: price != null && Number.isFinite(Number(price)) ? Number(price) : null,
            shuttleFee,
        });
    }
    const tuitionTotal = lines.length > 0 && lines.every((l) => l.tuition != null)
        ? lines.reduce((sum, l) => sum + (l.tuition ?? 0), 0)
        : null;
    const shuttleTotal = lines.reduce((sum, l) => sum + (l.shuttleFee ?? 0), 0);
    return { lines, tuitionTotal, shuttleTotal };
}
