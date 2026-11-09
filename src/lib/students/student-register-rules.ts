/**
 * 관리자 «원생 등록»(창 하나 3단계) 입력 규칙 한 곳 — 2026-11-09 원장 승인 설계.
 *
 * ■ 왜 따로 두는가
 *   등록 창(StudentRegisterModal)과 서버 액션(registerStudent)이 같은 검증을 해야 한다.
 *   화면만 막으면 다른 경로로 들어온 값이 그대로 저장되고, 서버만 막으면 원장이 «등록»을 누른 뒤에야 안다.
 *   그래서 판정은 이 파일의 순수 함수 하나로 두고 양쪽이 같이 부른다.
 *
 * ■ 원장 결정(2026-11-09)
 *   - 반 선택 필수. «반은 나중에 배정» 체크로만 건너뛴다.
 *   - 주 보호자 휴대폰 필수(학부모 계정을 찾는 열쇠). 보호자는 최대 6명.
 *   - 지점은 반 장소에서 자동. 반을 나중에 배정하거나 장소로 알 수 없으면 직접 고른다.
 *   - 개인정보 수집 동의 확인은 필수, 확인한 사실·날짜를 agreementsJSON 에 남긴다.
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — `node --test` 로 실제 실행해 검증한다.
 */
import { isKstYmd, toKstYmd } from "@/lib/datetime/kst";
import {
    MAX_GUARDIANS_PER_STUDENT,
    normalizeGuardianPhone,
    validateGuardianInput,
} from "@/lib/guardians/guardianLogic";
import { validatePrimaryGuardian, type PrimaryGuardian } from "@/lib/students/parentAccountLink";
import { validateStudentMediaConsentScopes } from "@/lib/studentMediaConsentAdminPolicy";
import { SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE } from "@/lib/shuttle/placeNameRule";

/** 유니폼 상태 허용값 — 학생 상세 «유니폼» 저장(updateStudentUniform)과 같은 집합 */
export const UNIFORM_STATUS_VALUES = ["보유", "미보유", "신청", "주문", "수령완료", "미수령", "확인보류", "해당없음", "미신청"] as const;

/** 사진 동의 확인 방법 — 사진 동의 화면(recordStudentMediaConsent)과 같은 값 */
export const MEDIA_CONSENT_METHODS = [
    { value: "WRITTEN", label: "서면" },
    { value: "PHONE", label: "전화" },
    { value: "IN_PERSON", label: "대면" },
    { value: "DIGITAL", label: "온라인" },
] as const;

/**
 * 등록 창 사진 동의 체크박스의 «확인 방법» 기본값(2026-11-09 원장 지시: 선택칸 → 체크박스 하나).
 * 원생 등록은 상담·등록 자리에서 보호자에게 직접 묻는 일이 대부분이라 «대면»으로 남긴다.
 * 서버 검증은 그대로 MEDIA_CONSENT_METHODS 허용 목록을 본다(이 값도 그 안에 있다 — 테스트로 고정).
 */
export const REGISTER_MEDIA_CONSENT_METHOD = "IN_PERSON" as const;

/** 셔틀 장소명이 비었을 때 화면·서버가 같이 쓰는 안내 — 규칙 한 곳(placeNameRule)에서 다시 내보낸다 */
export { SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE };

/** 가입 경로 선택지(Student.referralSource 에 그대로 저장) */
export const REFERRAL_SOURCE_OPTIONS = ["지인소개", "네이버", "인스타그램", "전단지", "현수막·간판", "체험수업", "기타"] as const;

/**
 * 지점 선택지 — 저장값은 기존 DB 원본 문장 그대로다.
 * POS 대사(classifyBranch: startsWith("2호점"))·시트 이관(includes("2"))이 원본 문장에 의존하므로 짧게 바꾸지 않는다.
 * 다산1호점은 2026-02-28 폐점이라 새 등록 선택지에 없다.
 */
export const REGISTER_BRANCH_OPTIONS = [
    { value: "2호점 : 행정복지센터(다산아트홀) 앞", label: "다산2호점" },
    { value: "평내호평점", label: "평내호평점" },
] as const;

/** 보호자 관계 선택지(Guardian.relation 에 그대로 저장) */
export const GUARDIAN_RELATION_CHOICES = ["엄마", "아빠", "할머니", "할아버지", "기타 보호자"] as const;

const MAX_STUDENT_NAME = 40;
const MAX_TEXT = 200;
const MAX_MEMO = 2000;
const MAX_CLASSES = 7;

/** 지점 저장값 → 화면 이름 */
export function branchLabel(value: string | null | undefined): string {
    if (!value) return "";
    const option = REGISTER_BRANCH_OPTIONS.find((o) => o.value === value);
    if (option) return option.label;
    if (value.startsWith("2호점")) return "다산2호점";
    if (value.startsWith("1호점")) return "다산1호점";
    return value;
}

/**
 * 반 장소(Class.location) → 지점 저장값. 알 수 없으면 null(지어내지 않는다 — 직접 고르게 한다).
 * 평내·호평 → 평내호평점, 다산·2호점·아트홀·행정복지센터 → 다산2호점.
 */
export function branchFromClassLocation(location: string | null | undefined): string | null {
    const text = String(location ?? "").replace(/\s+/g, "");
    if (!text) return null;
    if (text.includes("평내") || text.includes("호평")) return REGISTER_BRANCH_OPTIONS[1].value;
    if (text.includes("다산") || text.includes("2호점") || text.includes("아트홀") || text.includes("행정복지")) {
        return REGISTER_BRANCH_OPTIONS[0].value;
    }
    return null;
}

/** 여러 반의 장소 → 지점(처음으로 알아낸 값). 모두 모르면 null */
export function branchFromClassLocations(locations: Array<string | null | undefined>): string | null {
    for (const location of locations) {
        const branch = branchFromClassLocation(location);
        if (branch) return branch;
    }
    return null;
}

/** 지도에서 고른 위치(LocationPickerModal 의 MapLocationData 와 같은 모양) */
export type RegisterLocationInput = {
    address?: string | null;
    roadAddress?: string | null;
    placeName?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    placeId?: string | null;
    source?: string | null;
    accuracyMeters?: number | null;
};

export type RegisterLocation = {
    name: string | null;
    address: string;
    roadAddress: string | null;
    latitude: number;
    longitude: number;
    placeId: string | null;
    source: "MAP_PIN" | "SEARCH" | "CURRENT_LOCATION";
    accuracyMeters: number | null;
};

const LOCATION_SOURCES = new Set(["MAP_PIN", "SEARCH", "CURRENT_LOCATION"]);

function cleanText(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 위치 하나 검증 — DB 제약(좌표 범위)과 신청서 승인 검증(출처·정확도)과 같은 기준. 틀리면 null */
export function normalizeRegisterLocation(input: RegisterLocationInput | null | undefined): RegisterLocation | null {
    if (!input) return null;
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    const address = cleanText(input.address, 300);
    const roadAddress = cleanText(input.roadAddress, 300) || null;
    const source = String(input.source ?? "");
    if (input.latitude == null || input.longitude == null) return null;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    if (!address && !roadAddress) return null;
    if (!LOCATION_SOURCES.has(source)) return null;
    const accuracy = input.accuracyMeters;
    if (accuracy != null && (!Number.isFinite(Number(accuracy)) || Number(accuracy) < 0 || Number(accuracy) > 1_000_000)) return null;
    return {
        name: cleanText(input.placeName, 150) || null,
        address: address || roadAddress || "",
        roadAddress,
        latitude,
        longitude,
        placeId: cleanText(input.placeId, 200) || null,
        source: source as RegisterLocation["source"],
        accuracyMeters: accuracy == null ? null : Number(accuracy),
    };
}

/** 등록 창이 서버로 보내는 값 전체 */
export type StudentRegisterInput = {
    /** 체험 → 원생 전환이면 그 체험 id(같은 트랜잭션에서 체험을 «등록전환»으로 바꾼다) */
    trialLeadId?: string | null;
    student: {
        name: string;
        birthDate: string;
        gender?: string | null;
        grade?: string | null;
        school?: string | null;
        phone?: string | null;
        address?: string | null;
        referralSource?: string | null;
    };
    /** [0] = 주 보호자(관계·이름·휴대폰 필수), 나머지는 보조 보호자 */
    guardians: Array<{ relation?: string | null; name?: string | null; phone?: string | null }>;
    classIds: string[];
    /** «반은 나중에 배정» — 이때만 classIds 가 비어도 된다 */
    assignLater: boolean;
    /** 반에서 지점을 알 수 없을 때(또는 반 나중 배정) 직접 고른 지점 저장값 */
    branch?: string | null;
    /** 수강 시작일(YYYY-MM-DD, KST 달력 값) */
    startOn: string;
    shuttle: { needed: boolean; pickup?: RegisterLocationInput | null; dropoff?: RegisterLocationInput | null };
    // 유니폼은 창에서 고르지 않는다 — 서버가 같은 보호자 번호·학생 이름의 주문 내역을 보고 채운다(2026-11-09)
    /** 사진·초상권 동의를 확인했으면 값, 확인 안 했으면 null(기록하지 않는다) */
    mediaConsent?: { internalAllowed: boolean; galleryAllowed: boolean; instagramAllowed: boolean; method: string } | null;
    memo?: string | null;
    /** 보호자 개인정보 수집·이용 동의를 받았음을 확인 — 필수 */
    privacyConfirmed: boolean;
    /** 정원 초과 경고를 확인하고 진행 */
    force?: boolean;
    /** 중복 의심 경고를 확인하고 새로 등록 */
    allowDuplicate?: boolean;
};

/** 검증을 통과해 저장에 바로 쓰는 값 */
export type NormalizedStudentRegister = {
    trialLeadId: string | null;
    student: {
        name: string; birthDate: string; gender: string | null; grade: string | null; school: string | null;
        phone: string | null; address: string | null; referralSource: string | null;
    };
    primaryGuardian: PrimaryGuardian;
    extraGuardians: PrimaryGuardian[];
    classIds: string[];
    assignLater: boolean;
    branch: string | null;
    startOn: string;
    shuttle: { needed: boolean; pickup: RegisterLocation | null; dropoff: RegisterLocation | null };
    mediaConsent: { internalAllowed: boolean; galleryAllowed: boolean; instagramAllowed: boolean; method: string } | null;
    memo: string | null;
    force: boolean;
    allowDuplicate: boolean;
};

export type RegisterValidation =
    | { ok: true; value: NormalizedStudentRegister }
    | { ok: false; error: string; step: 1 | 2 | 3 };

/** 생년월일: 실제로 있는 날짜(YYYY-MM-DD)이고 1950년 이후·미래 아님 */
export function isValidBirthDate(ymd: string, todayYmd: string): boolean {
    if (!isKstYmd(ymd)) return false;
    return ymd >= "1950-01-01" && ymd <= todayYmd;
}

/**
 * 1단계(학생·보호자)만 검증 — 창에서 «다음»을 누를 때 쓰고, 서버 전체 검증의 첫 부분이기도 하다.
 */
export function validateRegisterStep1(input: Pick<StudentRegisterInput, "student" | "guardians">, todayYmd: string):
    { ok: true; primary: PrimaryGuardian; extras: PrimaryGuardian[] } | { ok: false; error: string } {
    const name = String(input.student?.name ?? "").trim();
    const birthDate = String(input.student?.birthDate ?? "").trim();
    if (!name) return { ok: false, error: "학생 이름을 입력해 주세요." };
    if (name.length > MAX_STUDENT_NAME) return { ok: false, error: `학생 이름은 ${MAX_STUDENT_NAME}자 이내로 입력해 주세요.` };
    if (!birthDate) return { ok: false, error: "생년월일을 입력해 주세요." };
    if (!isValidBirthDate(birthDate, todayYmd)) return { ok: false, error: "생년월일을 2016-03-15 처럼 바르게 입력해 주세요." };
    const gender = input.student?.gender ?? null;
    if (gender && gender !== "남" && gender !== "여") return { ok: false, error: "성별 값이 올바르지 않습니다." };

    const list = Array.isArray(input.guardians) ? input.guardians : [];
    if (list.length === 0) return { ok: false, error: "주 보호자 관계·이름·휴대폰을 입력해 주세요." };
    if (list.length > MAX_GUARDIANS_PER_STUDENT) return { ok: false, error: `보호자는 최대 ${MAX_GUARDIANS_PER_STUDENT}명까지 넣을 수 있습니다.` };
    const primary = validatePrimaryGuardian(list[0]);
    if (!primary.ok) return { ok: false, error: primary.error };

    // 보조 보호자 — 학생 상세 «보호자» 카드와 같은 검증(같은 학생 안 같은 번호 금지). 완전히 빈 줄은 건너뛴다.
    const accepted: Array<{ id: string; phone: string }> = [{ id: "g0", phone: primary.value.phone }];
    const extras: PrimaryGuardian[] = [];
    for (let i = 1; i < list.length; i++) {
        const row = list[i] ?? {};
        const blank = !String(row.relation ?? "").trim() && !String(row.name ?? "").trim() && !normalizeGuardianPhone(row.phone);
        if (blank) continue;
        const checked = validateGuardianInput(
            { relation: String(row.relation ?? ""), name: String(row.name ?? ""), phone: String(row.phone ?? "") },
            accepted,
        );
        if (!checked.ok) return { ok: false, error: `보호자 ${i + 1}: ${checked.error}` };
        accepted.push({ id: `g${i}`, phone: checked.value.phone });
        extras.push(checked.value);
    }
    return { ok: true, primary: primary.value, extras };
}

/** 반 id 목록 정리 — 공백·중복 제거, 상한 */
export function normalizeRegisterClassIds(ids: unknown): string[] {
    if (!Array.isArray(ids)) return [];
    const out: string[] = [];
    for (const id of ids) {
        const value = typeof id === "string" ? id.trim() : "";
        if (value && !out.includes(value)) out.push(value);
    }
    return out;
}

/**
 * 등록 입력 전체 검증(순수 함수). 서버 액션이 저장 직전에 한 번 더 부른다.
 * @param todayYmd 오늘(KST 달력 값) — 생년월일 미래 여부 판단용(호출하는 쪽이 todayKst() 로 넘긴다)
 */
export function validateStudentRegisterInput(input: StudentRegisterInput, todayYmd: string): RegisterValidation {
    const step1 = validateRegisterStep1(input, todayYmd);
    if (!step1.ok) return { ok: false, error: step1.error, step: 1 };

    // 2단계 — 반 필수(«반은 나중에 배정» 체크로만 건너뜀)
    const classIds = normalizeRegisterClassIds(input.classIds);
    const assignLater = input.assignLater === true;
    if (!assignLater && classIds.length === 0) {
        return { ok: false, error: "수강할 반을 고르거나 «반은 나중에 배정»을 체크해 주세요.", step: 2 };
    }
    if (assignLater && classIds.length > 0) {
        return { ok: false, error: "반을 골랐으면 «반은 나중에 배정» 체크를 풀어 주세요.", step: 2 };
    }
    if (classIds.length > MAX_CLASSES) return { ok: false, error: `반은 최대 ${MAX_CLASSES}개까지 고를 수 있습니다.`, step: 2 };
    const startOn = String(input.startOn ?? "").trim();
    if (!isKstYmd(startOn) || startOn < "2000-01-01" || startOn > "2100-12-31") {
        return { ok: false, error: "수강 시작일을 바르게 입력해 주세요.", step: 2 };
    }
    const branch = input.branch ? String(input.branch) : null;
    if (branch && !REGISTER_BRANCH_OPTIONS.some((o) => o.value === branch)) {
        return { ok: false, error: "지점 값이 올바르지 않습니다.", step: 2 };
    }
    const shuttleNeeded = input.shuttle?.needed === true;
    const pickup = shuttleNeeded ? normalizeRegisterLocation(input.shuttle?.pickup) : null;
    const dropoff = shuttleNeeded ? normalizeRegisterLocation(input.shuttle?.dropoff) : null;
    if (shuttleNeeded && input.shuttle?.pickup && !pickup) return { ok: false, error: "탑승 위치를 지도에서 다시 골라 주세요.", step: 2 };
    if (shuttleNeeded && input.shuttle?.dropoff && !dropoff) return { ok: false, error: "하차 위치를 지도에서 다시 골라 주세요.", step: 2 };
    // 장소명 필수(2026-11-09) — 기사님 명단·배차 정류장 이름이 이 값이다. 주소만 있으면 어디서 태울지 모른다.
    // (저장 SQL 의 «장소명 없으면 도로명→지번» 대체는 옛 데이터·다른 경로 호환용으로 그대로 둔다)
    if (pickup && !pickup.name) return { ok: false, error: `탑승 위치: ${SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE}`, step: 2 };
    if (dropoff && !dropoff.name) return { ok: false, error: `하차 위치: ${SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE}`, step: 2 };

    // 3단계 — 사진 동의·메모·개인정보 동의 (유니폼은 서버가 주문 내역으로 채운다)
    let mediaConsent: NormalizedStudentRegister["mediaConsent"] = null;
    if (input.mediaConsent) {
        const m = input.mediaConsent;
        if (typeof m.internalAllowed !== "boolean" || typeof m.galleryAllowed !== "boolean" || typeof m.instagramAllowed !== "boolean") {
            return { ok: false, error: "사진 동의 값이 올바르지 않습니다.", step: 3 };
        }
        if (!MEDIA_CONSENT_METHODS.some((o) => o.value === m.method)) {
            return { ok: false, error: "사진 동의를 어떻게 확인했는지 골라 주세요.", step: 3 };
        }
        const scopeError = validateStudentMediaConsentScopes(m);
        if (scopeError) return { ok: false, error: scopeError, step: 3 };
        mediaConsent = { internalAllowed: m.internalAllowed, galleryAllowed: m.galleryAllowed, instagramAllowed: m.instagramAllowed, method: m.method };
    }
    if (input.privacyConfirmed !== true) {
        return { ok: false, error: "보호자 개인정보 수집·이용 동의를 받았는지 확인해 주세요.", step: 3 };
    }

    const s = input.student;
    const optional = (value: unknown, max = MAX_TEXT) => cleanText(value, max) || null;
    return {
        ok: true,
        value: {
            trialLeadId: optional(input.trialLeadId, 100),
            student: {
                name: String(s.name).trim(),
                birthDate: String(s.birthDate).trim(),
                gender: s.gender || null,
                grade: optional(s.grade, 30),
                school: optional(s.school, 60),
                phone: optional(s.phone, 30),
                address: optional(s.address, 300),
                referralSource: optional(s.referralSource, 60),
            },
            primaryGuardian: step1.primary,
            extraGuardians: step1.extras,
            classIds,
            assignLater,
            branch,
            startOn,
            shuttle: { needed: shuttleNeeded, pickup, dropoff },
            mediaConsent,
            memo: optional(input.memo, MAX_MEMO),
            force: input.force === true,
            allowDuplicate: input.allowDuplicate === true,
        },
    };
}

/**
 * 개인정보 동의 확인 기록 → Student.agreementsJSON (원장 결정 D6).
 * 기존 키(신청서·시트 이관 원본)와 섞이지 않게 adminRegister 아래에 둔다.
 * @param atIso 확인한 순간(서버 시각 ISO) · @param onYmd 그날(KST 달력 값)
 */
export function buildAdminRegisterAgreements(adminUserId: string, atIso: string, onYmd: string): string {
    return JSON.stringify({ adminRegister: { privacy: true, by: adminUserId, at: atIso, on: onYmd } });
}

/**
 * Student.birthDate → KST 달력 날짜(YYYY-MM-DD) SQL 조각.
 * 컬럼은 시간대 없는 timestamp(schema.prisma: `birthDate DateTime`, @db 지정 없음 = timestamp(3))라
 * 전역 규칙대로 «두 번» 건다: 먼저 UTC 로 «해석»하고 그다음 서울 시각으로 바꾼다. 한 번만 걸면 9시간 밀린다.
 * - 자정 저장 행(2016-03-15 00:00) → KST 09:00 → 2016-03-15 (같은 날)
 * - «한국 자정을 UTC 로 넣은» 행(2016-03-14 15:00) → KST 다음 날 00:00 → 2016-03-15 (원래 생일)
 * JS 쪽 같은 규칙은 birthDateKstYmd(두 경우를 테스트로 고정).
 */
export function STUDENT_BIRTH_KST_YMD_SQL(alias: string): string {
    return `to_char((${alias}."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
}

/** 시간대 없는 DB 값("YYYY-MM-DD HH:MM:SS" — UTC 로 본다) 또는 Date → KST 달력 날짜. SQL 조각과 같은 규칙 */
export function birthDateKstYmd(value: string | Date | null | undefined): string {
    if (value == null || value === "") return "";
    const instant = value instanceof Date ? value : new Date(`${String(value).trim().replace(" ", "T").replace(/Z$/, "")}Z`);
    if (Number.isNaN(instant.getTime())) return "";
    return toKstYmd(instant);
}

/** 중복 의심 후보 한 줄(SQL 결과) */
export type DuplicateCandidateRow = {
    id: string;
    name: string;
    birthDate: string | null;
    phoneDigits: string[];
    classNames: string[];
};

export type DuplicateSuspect = {
    id: string;
    name: string;
    birthDate: string | null;
    reason: "SAME_BIRTH" | "SAME_GUARDIAN_PHONE";
    classNames: string[];
};

/**
 * 같은 이름 학생들 중 «이미 있는 학생일 수 있는» 사람(순수 함수).
 * - 이름 + 생년월일이 같으면 SAME_BIRTH
 * - 이름이 같고 보호자 번호(주 보호자 계정·Guardian 번호 중 하나)가 같으면 SAME_GUARDIAN_PHONE
 */
export function findDuplicateSuspects(
    rows: DuplicateCandidateRow[],
    target: { name: string; birthDate: string; guardianPhones: string[] },
): DuplicateSuspect[] {
    const name = target.name.trim();
    const phones = new Set(target.guardianPhones.map((p) => normalizeGuardianPhone(p)).filter((p) => p.length >= 9));
    const out: DuplicateSuspect[] = [];
    for (const row of rows) {
        if (row.name.trim() !== name) continue;
        if (row.birthDate && row.birthDate === target.birthDate) {
            out.push({ id: row.id, name: row.name, birthDate: row.birthDate, reason: "SAME_BIRTH", classNames: row.classNames });
            continue;
        }
        if (row.phoneDigits.some((p) => phones.has(normalizeGuardianPhone(p)))) {
            out.push({ id: row.id, name: row.name, birthDate: row.birthDate, reason: "SAME_GUARDIAN_PHONE", classNames: row.classNames });
        }
    }
    return out;
}

// ── 유니폼: 기존 주문 내역 → 학생 유니폼 상태 (2026-11-09 원장 지시) ─────────────

/** 유니폼 주문 한 건(UniformOrder 읽기 결과 — 같은 보호자 번호 + 같은 학생 이름 품목이 있는 주문만) */
export type UniformOrderMatchRow = {
    orderStatus: string;
    stizSyncStatus: string;
    stizOrderNumber: string | null;
    /** 접수 시각(ISO) */
    createdAt: string;
    /** 업체 전송 시각(ISO) — 전송 전이면 null */
    lastSentAt: string | null;
};

/** 주문 내역에서 읽어 낸 유니폼 상태 — status 는 UNIFORM_STATUS_VALUES 안의 값만 */
export type UniformOrderSummary = {
    status: "신청" | "주문";
    /** 가장 처음 접수한 시각(ISO) → Student.uniformAppliedAt */
    appliedAt: string;
    /** 업체 주문이 처음 들어간 시각(ISO) → Student.uniformOrderedAt. 아직이면 null */
    orderedAt: string | null;
    /** 취소 안 된 주문 수 */
    orderCount: number;
};

/** Student.uniformSource 에 남길 출처(학생 상세 «유니폼» 칸 출처 값 «사이트주문»과 같음) */
export const UNIFORM_ORDER_SOURCE = "사이트주문";

/** 업체(STIZ)에 주문이 실제로 들어간 상태 — 전송 완료 또는 업체 쪽에 이미 있음(중복) */
const UNIFORM_ORDERED_SYNC = new Set(["SENT", "DUPLICATE"]);

/** 이름 비교용 — 띄어쓰기만 무시(유니폼 신청서에 «김 루빈»처럼 적는 경우). SQL 쪽은 regexp_replace(…, '\s', '', 'g') */
export function uniformNameKey(name: string | null | undefined): string {
    return String(name ?? "").replace(/\s+/g, "");
}

/**
 * 주문 내역 → 유니폼 상태(순수 함수). 취소된 주문은 뺀다. 남는 게 없으면 null(= 주문 내역 없음).
 * - 업체 주문이 들어간 주문(주문번호 있음·전송 완료·업체 중복)이 하나라도 있으면 «주문», 접수만 됐으면 «신청».
 * - «수령완료»는 주문 기록에 학원 도착 정보가 없어 여기서 정하지 않는다(학생 상세에서 직접 바꾼다).
 */
export function decideUniformFromOrders(rows: UniformOrderMatchRow[]): UniformOrderSummary | null {
    const live = rows.filter((r) => r.orderStatus !== "CANCELED");
    if (live.length === 0) return null;
    // ISO 문자열은 글자 순서 = 시간 순서
    const earliest = (values: string[]) => [...values].sort()[0];
    const ordered = live.filter((r) => Boolean(r.stizOrderNumber) || UNIFORM_ORDERED_SYNC.has(r.stizSyncStatus));
    return {
        status: ordered.length > 0 ? "주문" : "신청",
        appliedAt: earliest(live.map((r) => r.createdAt)),
        orderedAt: ordered.length > 0 ? earliest(ordered.map((r) => r.lastSentAt ?? r.createdAt)) : null,
        orderCount: live.length,
    };
}
