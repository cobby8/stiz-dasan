/**
 * 체험 안내·등록 안내 문구 초안 — 순수 모듈(외부 import 없음: 테스트가 그대로 실행한다).
 *
 * ■ 상태: 원장 문구 승인 전 «초안». 자동 발송 스위치(AcademySettings.trialGuideAutoSend·enrollGuideAutoSend)는
 *   기본 꺼짐이고, 관리자 «신청 안내 설정» 화면에서 미리보기만 된다. 문구를 바꾸면 이 파일만 고친다.
 * ■ 근거: 원장이 손으로 보내던 안내문 2개(2026-11-10 결정표 m8)
 *   - 체험 안내: 위치·체험비·준비물(실내용 운동화/운동복장/물)·확정 조건 — 계좌 입금 대신 앱 결제로 바뀐 것만 반영
 *   - 등록 안내: «랠리즈» → «STIZ 앱(학부모 화면)», «반 변경·보강 신청: 카카오채널» → 앱 안 신청
 *   - 등록 안내의 담당 코치·셔틀 기사님 이름·연락처는 DB 에서 자동으로 넣는다(guideContacts.ts)
 * ■ 금지: 과장 문구(등록률·만족도 수치 등)를 새로 만들지 않는다. 원장 문구에 있던 사실만 쓴다.
 * ■ 문자(LMS)로도 나갈 수 있어 이모지는 쓰지 않는다(일부 휴대폰에서 깨짐).
 */

/** 학부모 문자 머리말 — parent-alimtalk-templates.ts 의 PARENT_MESSAGE_PREFIX 와 같은 글자(테스트로 비교) */
export const GUIDE_MESSAGE_PREFIX = "[스티즈농구교실]";

/** 원장 안내문의 고정 사실(바뀌면 여기만) */
export const ACADEMY_GUIDE_FACTS = {
    address: "남양주시 다산중앙로20번길 10-32, 1층",
    branch: "다산2호점",
    site: "https://www.stiz-dasan.kr",
    consultPhone: "070-8824-5712",
    ownerContact: "김수빈 원장 010-9167-8117",
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
    /** 학부모가 고른 희망 일정(예: 11월 12일(수) 4교시 16:00~17:00). 없으면 줄을 뺀다 */
    preferredSchedule?: string | null;
    academyPhone?: string | null;
};

/**
 * (a) 체험 확정 안내 — 체험비 결제 완료 직후(스위치 켜진 경우만) 학부모에게.
 * 원장 안내문 1의 «입금 후 성함 남겨주시면 확정»은 앱 결제로 바뀌어 «결제 확인 = 확정»으로 쓴다.
 */
export function buildTrialGuideMessage(input: TrialGuideInput): string {
    const lines = [
        `${GUIDE_MESSAGE_PREFIX} ${input.childName.trim()} 체험수업 신청이 확정되었습니다.`,
        `체험수업비 ${input.feeLabel} 결제가 확인되었습니다.`,
        "",
    ];
    if (input.preferredSchedule && input.preferredSchedule.trim()) lines.push(`■ 희망 일정: ${input.preferredSchedule.trim()}`);
    lines.push(
        `■ 위치: ${ACADEMY_GUIDE_FACTS.address}`,
        `■ 준비물: ${ACADEMY_GUIDE_FACTS.trialSupplies}`,
        "■ 수업 시간과 반은 담당자가 한 번 더 안내드립니다.",
        "",
        `문의: ${formatGuidePhone(input.academyPhone) || ACADEMY_GUIDE_FACTS.consultPhone}`,
    );
    return lines.join("\n");
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

/**
 * (b) 등록 안내 — 체험 완료 후 또는 실제 수강 등록 시(스위치 켜진 경우만) 학부모에게.
 * 원장 안내문 2를 그대로 옮기되 «랠리즈» → STIZ 앱, «카카오채널 반 변경·보강» → 앱 안 신청으로 바꿨다.
 */
export function buildEnrollGuideMessage(input: EnrollGuideInput): string {
    const site = ACADEMY_GUIDE_FACTS.site.replace(/^https:\/\//, "");
    const lines: string[] = [
        `${GUIDE_MESSAGE_PREFIX} ${input.childName.trim()} 등록 관련 안내드립니다.`,
        "아래 홈페이지에서 한 번에 확인하실 수 있어요.",
        "",
    ];
    for (const label of input.classLabels.filter((item) => item.trim())) lines.push(`■ 수업: ${label.trim()}`);
    if (input.coaches.length > 0) {
        lines.push(`■ 담당 코치: ${input.coaches.map(formatContactLine).join(" / ")}`);
    } else {
        lines.push("■ 담당 코치: 수업 첫날 안내드립니다.");
    }
    if (input.usesShuttle) {
        lines.push(input.drivers.length > 0
            ? `■ 셔틀 기사님: ${input.drivers.map(formatContactLine).join(" / ")}`
            : "■ 셔틀 기사님: 노선 확정 후 안내드립니다.");
    }
    lines.push(
        "",
        `▶ 프로그램·수강료: ${site}/programs (반별 수강료와 셔틀비, 4주 단위 운영)`,
        `▶ 수업시간표·수업찾기: ${site}/schedule`,
        `▶ 유니폼 신청: ${site}/apply (입학 시 유니폼 제작 필수, 형제·자매 것까지 한 번에 신청)`,
        `▶ 연간일정표: ${site}/annual (5주차 휴무가 아닌 연간일정표에 따라 운영)`,
        `▶ 이용약관: ${site}/terms (결석 시 이월·보강·환불 기준)`,
        `▶ STIZ 앱(학부모 화면): ${site}/mypage — 학원 공지, 출결, 수강료 결제, 반 변경·보강 신청`,
        "",
        `■ 위치: ${ACADEMY_GUIDE_FACTS.address} (2026년 3월부터 ${ACADEMY_GUIDE_FACTS.branch} 한 곳에서 운영, 예전 1호점 위치 주의)`,
        `■ 상담 문의: ${ACADEMY_GUIDE_FACTS.consultPhone}`,
        `■ 수업변경·수강료·셔틀노선: ${ACADEMY_GUIDE_FACTS.ownerContact}`,
        "■ 수업내용·학원생활·출결: 담당 코치",
    );
    return lines.join("\n");
}

/** 미리보기·발송 대상 학부모 문자 트리거 이름(가드 테스트: SMS_ONLY_PARENT_TRIGGERS 에 등록) */
export const TRIAL_GUIDE_TRIGGER = "TRIAL_PAID_GUIDE_PARENT";
export const ENROLL_GUIDE_TRIGGER = "ENROLL_WELCOME_GUIDE_PARENT";
