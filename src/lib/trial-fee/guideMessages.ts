/* 체험비 결제 확인과 실제 수강 등록 완료 안내의 공통 문구. */

/** 학부모 문자 머리말 — parent-alimtalk-templates.ts 의 PARENT_MESSAGE_PREFIX 와 같은 글자(테스트로 비교) */
export const GUIDE_MESSAGE_PREFIX = "[스티즈농구교실]";

/** 원장 안내문의 고정 사실(바뀌면 여기만) */
export const ACADEMY_GUIDE_FACTS = {
    address: "남양주시 다산중앙로20번길 10-32, 1층",
    branch: "다산2호점",
    site: "https://www.stiz-dasan.kr",
    uniformOrderUrl: "https://stiz.kr/product/detail.html?product_no=4095&from=dasan",
    consultPhone: "070-8824-5712",
    trialSupplies: "실내용 운동화, 운동복장, 물",
} as const;

export type ContactPerson = { name: string; title: string; phone: string };

/** 전화번호 표시 — 숫자만 받아 010-1234-5678 / 070-1234-5678 모양으로(모양이 다르면 받은 그대로) */
export function formatGuidePhone(raw: string | null | undefined): string {
    const digits = String(raw ?? "").replace(/\D/g, "");
    if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    if (digits.length === 10 && digits.startsWith("02")) return `02-${digits.slice(2, 6)}-${digits.slice(6)}`;
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    return String(raw ?? "").trim();
}

/** 코치 직함 — Coach.role 이 «원장»을 품으면 원장, 그 밖은 코치(영문·긴 소개문이 문자에 들어가지 않게) */
export function coachGuideTitle(role: string | null | undefined): string {
    return String(role ?? "").includes("원장") ? "원장" : "코치";
}

/** «김영웅 코치 010-8824-2170» 한 줄. 번호가 없으면 이름만(빈 번호 «010-» 같은 칸을 만들지 않는다). */
export function formatContactLine(person: ContactPerson): string {
    const phone = formatGuidePhone(person.phone);
    return [person.name.trim(), person.title.trim(), phone].filter(Boolean).join(" ");
}

export type TrialGuideInput = {
    childName: string;
    /** 결제 금액 표시(예: 10,000원) */
    feeLabel: string;
    academyPhone?: string | null;
};

/** 체험비 결제 확인은 일정 확정 안내와 별도로 보낸다. */
export function buildTrialGuideMessage(input: TrialGuideInput): string {
    return [
        `${GUIDE_MESSAGE_PREFIX} ${input.childName.trim()} 학생의 체험수업비 ${input.feeLabel} 결제가 확인되었습니다.`,
        "체험 일시와 반은 확정되는 대로 별도 문자로 안내드리겠습니다. 일정 확정 문자를 받으신 뒤 방문해 주세요.",
        `문의 ${formatGuidePhone(input.academyPhone) || ACADEMY_GUIDE_FACTS.consultPhone}`,
    ].join("\n");
}

export type EnrollGuideInput = {
    childName: string;
    /** 다니는 반 표시(예: «월 4교시 16:00~17:00»). 여러 반이면 여러 줄 */
    classLabels: string[];
    /** 그 반 담당 코치(이름·직함·번호). 비면 «담당 코치는 따로 안내» 줄 */
    coaches: ContactPerson[];
    /** 셔틀 이용 시 기사님. 셔틀을 안 타면 빈 배열(줄 자체를 뺀다) */
    drivers: ContactPerson[];
    usesShuttle: boolean;
};

/** 실제 수강 등록이 완료된 원생에게 보내는 안내. */
export function buildEnrollGuideMessage(input: EnrollGuideInput): string {
    const { site, branch, address, consultPhone, uniformOrderUrl } = ACADEMY_GUIDE_FACTS;
    const lines = [
        `${GUIDE_MESSAGE_PREFIX} ${input.childName.trim()} 학생의 정규 수업 등록이 완료되었습니다.`,
        "",
    ];
    for (const label of input.classLabels.filter((item) => item.trim())) lines.push(`· 수업 ${label.trim()}`);
    lines.push(input.coaches.length > 0
        ? `· 담당 코치 ${input.coaches.map(formatContactLine).join(" / ")}`
        : "· 담당 코치는 수업 첫날 안내드립니다.");
    if (input.usesShuttle) {
        lines.push(input.drivers.length > 0
            ? `· 셔틀 ${input.drivers.map(formatContactLine).join(" / ")}`
            : "· 셔틀 배차 확정 후 안내드립니다.");
    }
    lines.push(
        "",
        "유니폼이 필요한 학생은 아래 STIZ 본사 주문 페이지에서 신청해 주세요.",
        uniformOrderUrl,
        "",
        "출결 확인, 수강료 결제, 반 변경·보강 신청은 STIZ 학부모 화면에서 이용하실 수 있습니다.",
        `${site}/mypage`,
        "",
        "수업은 연간일정표에 따라 운영됩니다.",
        `${site}/annual`,
        "",
        `· 수업 장소 스티즈농구교실 ${branch}, ${address}`,
        `· 상담 문의 ${consultPhone}`,
    );
    return lines.join("\n");
}

/** 미리보기·발송 대상 학부모 문자 트리거 이름(가드 테스트: SMS_ONLY_PARENT_TRIGGERS 에 등록) */
export const TRIAL_GUIDE_TRIGGER = "TRIAL_PAID_GUIDE_PARENT";
export const ENROLL_GUIDE_TRIGGER = "ENROLL_WELCOME_GUIDE_PARENT";
