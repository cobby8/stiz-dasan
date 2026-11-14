// 학부모 마이페이지 "오늘/이번주 우리 아이" 요약 카드용 순수 로직.
// ⚠️ 표시 전용 — 기존 데이터(enrollments/shuttleOverview)를 재조합만 한다. 새 쿼리 없음.
// 순수 함수로 분리한 이유: 다음 수업/오늘 셔틀 매칭은 "요일·시간 계산"이라 실수하기 쉬워
// 유닛 테스트로 고정해 두려는 것. UI(React)와 분리해 import 의존성 0으로 유지한다.

// 요일 문자열("Mon" 등) → 0=일 ~ 6=토 인덱스. enrollments.dayOfWeek 형식과 동일하게 맞춘다.
const DAY_INDEX: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

// 인덱스 → 한국어 요일 라벨(표시용).
export const DAY_KO: string[] = ["일", "월", "화", "수", "목", "금", "토"];

export type EnrollmentLite = {
    className: string;
    dayOfWeek: string;
    startTime: string; // "HH:MM"
    endTime: string;   // "HH:MM"
    startsOn?: string | null;
    displayStatus?: string;
};

export type NextClass = {
    className: string;
    dayIndex: number;
    dayKo: string;
    startTime: string;
    endTime: string;
    minutesUntil: number; // 지금으로부터 몇 분 뒤인지(정렬·"오늘" 판정용)
    serviceDate?: string;
};

export type KstNow = { dayIndex: number; minutes: number };

// "HH:MM" → 자정 기준 분. 형식이 이상하면 null.
function parseHHMM(v: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

// 실제 Date에서 KST 기준 "요일 인덱스 + 자정 기준 분"을 뽑는다.
// Intl로 계산해 기기 타임존과 무관하게 항상 한국시간 기준(마이페이지 다른 곳과 동일 정책).
export function getKstNow(now: Date): KstNow {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Seoul",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(now);
    const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
    // hour12:false는 자정에 "24"를 줄 수 있어 24로 나눈 나머지로 보정.
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return { dayIndex: DAY_INDEX[wd] ?? 0, minutes: hour * 60 + minute };
}

// KST 기준 오늘 날짜 문자열(YYYY-MM-DD). 오늘 셔틀 매칭용.
export function getKstDateStr(now: Date): string {
    // en-CA 로케일은 YYYY-MM-DD 형식을 준다.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
}

// 오늘(지금) 기준 가장 가까운 향후 수업 1건. 없으면 null.
// 오늘 이미 시작 시각이 지난 수업은 다음 주 같은 요일로 밀어 계산한다.
export function computeNextClass(enrollments: EnrollmentLite[], nowKst: KstNow, todayYmd?: string): NextClass | null {
    let best: NextClass | null = null;
    for (const e of enrollments) {
        const di = DAY_INDEX[e.dayOfWeek];
        if (di == null) continue;
        const start = parseHHMM(e.startTime);
        if (start == null) continue;
        // 오늘로부터 며칠 뒤 요일인지(0=오늘)
        const dayDelta = (di - nowKst.dayIndex + 7) % 7;
        let minutesUntil = dayDelta * 1440 + (start - nowKst.minutes);
        // 오늘이지만 시작 시각이 이미 지났으면 다음 주로.
        if (minutesUntil < 0) minutesUntil += 7 * 1440;
        // 개시일 전의 같은 요일은 아직 이 학생의 수업이 아니다. 첫 실제 주차로 옮긴다.
        let serviceDate: string | undefined;
        if (e.startsOn) {
            if (!todayYmd || !/^\d{4}-\d{2}-\d{2}$/.test(e.startsOn)) continue;
            const today = Date.parse(`${todayYmd}T00:00:00Z`);
            const starts = Date.parse(`${e.startsOn}T00:00:00Z`);
            if (!Number.isFinite(today) || !Number.isFinite(starts)) continue;
            const daysToStart = (starts - today) / 86_400_000;
            const firstDay = Math.floor((nowKst.minutes + minutesUntil) / 1440);
            if (firstDay < daysToStart) minutesUntil += Math.ceil((daysToStart - firstDay) / 7) * 7 * 1440;
            // 달력 날짜를 한국 날짜로 표시한다. 서버·기기의 현지 시간대에 기대지 않는다.
            serviceDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(today + Math.floor((nowKst.minutes + minutesUntil) / 1440) * 86_400_000));
        }
        if (best == null || minutesUntil < best.minutesUntil) {
            best = {
                className: e.className,
                dayIndex: di,
                dayKo: DAY_KO[di],
                startTime: e.startTime,
                endTime: e.endTime,
                minutesUntil,
                ...(serviceDate ? { serviceDate } : {}),
            };
        }
    }
    return best;
}

// minutesUntil을 "오늘/내일/N일 뒤" 사람이 읽는 라벨로. (오늘=1440분 미만이면서 dayDelta 0)
export function nextClassWhenLabel(next: NextClass, nowKst: KstNow): string {
    if (next.serviceDate && next.minutesUntil >= 7 * 1440) {
        const [, month, day] = next.serviceDate.split("-").map(Number);
        return `${month}월 ${day}일`;
    }
    const dayDelta = (next.dayIndex - nowKst.dayIndex + 7) % 7;
    // 오늘 요일이지만 이미 지나 다음 주로 밀린 경우(minutesUntil이 하루 이상)엔 "다음 주"로 표기.
    if (next.minutesUntil >= 6 * 1440 && dayDelta === 0) return "다음 주";
    if (dayDelta === 0) return "오늘";
    if (dayDelta === 1) return "내일";
    return `${next.dayKo}요일`;
}

export type ShuttleLite = {
    id: string;
    serviceDate: string | null; // ISO or YYYY-MM-DD
    direction: "PICKUP" | "DROPOFF" | null;
    status: string;
    pickupEtaLabel?: string | null;
    dropoffEtaLabel?: string | null;
    plannedAt?: string | null;
    /** 오늘 기사님이 «탑승»을 찍은 실제 시각 "HH:MM"(KST). 등원 줄이면 탄 시각, 하원 줄이면 내린 시각. 없으면 아직 안 찍힘 */
    actualTimeLabel?: string | null;
    /** 같은 날 «자차»로 신청해 타지 않는 방향 — 그 방향 줄은 시각 대신 «자차» */
    selfRideDirections?: readonly ("PICKUP" | "DROPOFF")[];
};

/**
 * 홈 «오늘 셔틀» 줄 글자(2026-11-14 원장 결정표) — 방향마다 한 줄.
 *   기사님이 찍었으면 실제 시각: «탑승 08:52» · «하차 18:40»
 *   아직이면 예정 시각(종전 그대로): «등원 08:40 승차» · «하원 17:30 하차»
 * 둘 다 없으면 빈 배열(화면은 «운행 N건»을 보인다).
 */
export function todayShuttleLineTexts(items: readonly ShuttleLite[]): string[] {
    const actual = (direction: "PICKUP" | "DROPOFF") =>
        items.find((i) => i.direction === direction && i.actualTimeLabel)?.actualTimeLabel ?? null;
    const pickupEta = items.map((i) => i.pickupEtaLabel).find(Boolean) ?? null;
    const dropoffEta = items.map((i) => i.dropoffEtaLabel).find(Boolean) ?? null;
    const boardedAt = actual("PICKUP");
    const alightedAt = actual("DROPOFF");
    // 자차로 신청한 방향(2026-11-14 묶음 B) — 예정·탑승 시각 대신 «등원 자차»·«하원 자차»
    const selfRide = (direction: "PICKUP" | "DROPOFF") => items.some((i) => i.selfRideDirections?.includes(direction));
    return [
        selfRide("PICKUP") ? "등원 자차" : boardedAt ? `탑승 ${boardedAt}` : pickupEta ? `등원 ${pickupEta}` : null,
        selfRide("DROPOFF") ? "하원 자차" : alightedAt ? `하차 ${alightedAt}` : dropoffEta ? `하원 ${dropoffEta}` : null,
    ].filter((v): v is string => Boolean(v));
}

// 오늘(KST) 운행에 해당하는 셔틀 항목만 추린다. serviceDate 앞 10자리(YYYY-MM-DD)로 매칭.
export function filterTodayShuttle<T extends ShuttleLite>(items: T[], todayStr: string): T[] {
    return items.filter((i) => i.serviceDate != null && i.serviceDate.slice(0, 10) === todayStr);
}

// ── 홈 «오늘 할 일» 판 집계 (2026-11-09 학부모 화면 재구성 안 A) ──────────────
// 표시 전용 순수 함수. 홈이 이미 받은 데이터(자녀별 청구·보낸 메시지·공지)를 세기만 한다.

export type PaymentLite = { id: string; amount: number; status: string; canCheckout?: boolean };

export type PendingPaymentSummary = {
    count: number;           // 납부할 청구 건수(형제 포함, 같은 청구는 한 번만)
    total: number;           // 합계 금액(원)
    canCheckoutAny: boolean; // 이 계정이 대표 보호자라 온라인 결제할 수 있는 청구가 하나라도 있는지
};

/** 미납(PENDING)·연체(OVERDUE) 청구를 자녀 전체에서 모아 건수·합계를 낸다. 금액 0 이하는 뺀다. */
export function summarizePendingPayments(children: { payments: PaymentLite[] }[]): PendingPaymentSummary {
    const seen = new Set<string>();
    let total = 0;
    let canCheckoutAny = false;
    for (const child of children) {
        for (const p of child.payments) {
            if (p.status !== "PENDING" && p.status !== "OVERDUE") continue;
            if (seen.has(p.id)) continue; // 같은 청구가 두 자녀 목록에 겹쳐 와도 한 번만 센다
            const amount = Number(p.amount);
            if (!Number.isFinite(amount) || amount <= 0) continue;
            seen.add(p.id);
            total += amount;
            if (p.canCheckout !== false) canCheckoutAny = true;
        }
    }
    return { count: seen.size, total, canCheckoutAny };
}

/** 최근 days 일 안에 올라온 공지 수(«새 공지 N건» 줄). */
export function countRecentNotices(notices: { createdAt: Date | string }[], nowMs: number, days = 7): number {
    const since = nowMs - days * 86_400_000;
    return notices.filter((n) => {
        const at = new Date(n.createdAt).getTime();
        return Number.isFinite(at) && at >= since;
    }).length;
}

/**
 * 옛 홈 해시 → 새 탭 주소(2026-11-09 학부모 화면 구조 개편).
 * 예전 홈 접힌 칸(셔틀·수강·기록·결석·피드백)은 «일정»·«소식» 탭으로 옮겼다.
 * 문자·즐겨찾기로 남은 /mypage#mypage-shuttle 같은 주소가 빈 홈에 멈추지 않게 그 칸으로 넘긴다. 모르는 해시면 null.
 */
export function legacyHomeHashTarget(hash: string): string | null {
    const id = String(hash ?? "").replace(/^#/, "");
    const map: Record<string, string> = {
        "mypage-enrollments": "/mypage/history#mypage-enrollments",
        "mypage-shuttle": "/mypage/history#mypage-shuttle",
        "parent-absence-hub": "/mypage/regular-absence",
        "mypage-records": "/mypage/history#schedule-records-heading",
        "mypage-feedback": "/mypage/reports#news-feedback",
        "mypage-notices": "/mypage/reports#news-notices",
        "mypage-gallery": "/mypage/reports#news-photos",
    };
    return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
}
