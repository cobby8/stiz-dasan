/**
 * SMS 템플릿 유틸 — 트리거별 메시지 조회 + 변수 치환 + 초기 seed
 *
 * 왜 이 파일이 필요한가?
 * 기존에는 SMS 메시지가 코드에 하드코딩되어 관리자가 내용을 바꿀 수 없었다.
 * 이제 DB에 저장된 템플릿을 조회하고, {{변수}}를 실제 값으로 치환하여 발송한다.
 *
 * DDL ensure 패턴: 테이블이 없으면 자동 생성 + 기본 템플릿 10개 seed
 * $queryRawUnsafe 사용: PgBouncer 트랜잭션 모드 호환
 */

import { prisma } from "@/lib/prisma";

// ── DDL ensure: SmsTemplate 테이블이 없으면 생성 ──────────────────────────────
let _smsTemplateEnsured = false;
let _defaultSmsTemplatesEnsured = false;

export async function ensureSmsTemplateTable() {
    if (_smsTemplateEnsured) return;
    try {
        // 테이블 생성 (존재하면 무시)
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "SmsTemplate" (
                id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                trigger TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                target TEXT NOT NULL,
                body TEXT NOT NULL,
                "isActive" BOOLEAN DEFAULT true,
                description TEXT,
                variables TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    } catch (e) {
        console.warn("[DDL] SmsTemplate ensure failed:", (e as Error).message);
    }
    _smsTemplateEnsured = true;
}

// ── 기본 템플릿 10개 seed 데이터 ──────────────────────────────────────────────
// 각 항목: [trigger, name, target, body, description, variables(JSON)]
const DEFAULT_TEMPLATES: [string, string, string, string, string, string][] = [
    [
        "TRIAL_NEW_ADMIN",
        "체험 신청 접수 (관리자)",
        "ADMIN",
        "[STIZ] 새 체험수업 신청\n{{contactSaveName}}\n{{parentPhone}}",
        "학부모가 체험수업을 신청하면 관리자에게 발송 (둘째 줄 = 연락처 저장용 이름)",
        '["contactSaveName","childName","childGrade","parentName","parentPhone"]',
    ],
    [
        "TRIAL_NEW_COACH",
        "체험 신청 접수 (코치)",
        "COACH",
        "[STIZ] 새 체험수업 신청\n{{childName}} ({{childGrade}})",
        "학부모가 체험수업을 신청하면 코치에게 발송",
        '["childName","childGrade","parentName"]',
    ],
    [
        "TRIAL_COACH_NOTICE",
        "체험수업 담당 선생님 알림",
        "COACH",
        "[STIZ] 체험수업 알림\n학생: {{childName}} {{childGrade}} {{childSchool}}\n일정: {{trialDate}}\n수업: {{className}} {{scheduleLabel}}\n희망: {{preferredSlotKey}}\n학부모: {{parentName}} {{parentPhone}}\n메모: {{memo}}",
        "관리자가 체험 CRM에서 담당 선생님에게 체험수업 정보를 즉시 공유할 때 사용",
        '["childName","childGrade","childSchool","trialDate","className","scheduleLabel","preferredSlotKey","parentName","parentPhone","memo"]',
    ],
    [
        "ENROLL_NEW_ADMIN",
        "수강 신청 접수 (관리자)",
        "ADMIN",
        "[STIZ] 새 수강 신청\n{{contactSaveName}}\n{{parentPhone}}",
        "학부모가 수강 신청하면 관리자에게 발송 (둘째 줄 = 연락처 저장용 이름)",
        '["contactSaveName","childName","childGrade","parentName","parentPhone"]',
    ],
    [
        "ENROLL_NEW_COACH",
        "수강 신청 접수 (코치)",
        "COACH",
        "[STIZ] 새 수강 신청\n{{childName}} ({{childGrade}})",
        "학부모가 수강 신청하면 코치에게 발송",
        '["childName","childGrade","parentName"]',
    ],
    [
        "TRIAL_CONFIRM_PARENT",
        "체험 신청 확인 (학부모)",
        "PARENT",
        "[STIZ] {{childName}} 체험수업 신청이 접수되었습니다.\n일정 확정 시 다시 안내드리겠습니다.\n문의: {{academyPhone}}",
        "체험 신청 직후 학부모에게 접수 확인 발송",
        '["childName","parentName","academyPhone"]',
    ],
    [
        "TRIAL_SCHEDULED_PARENT",
        "체험 일정 확정 (학부모)",
        "PARENT",
        "[STIZ] {{childName}} 체험수업 일정이 확정되었습니다.\n일시: {{scheduledDate}}\n반: {{className}}\n문의: {{academyPhone}}",
        "관리자가 체험 일정을 SCHEDULED로 변경하면 학부모에게 발송",
        '["childName","scheduledDate","className","academyPhone"]',
    ],
    [
        "TRIAL_SCHEDULED_COACH",
        "체험 일정 확정 (담당 강사)",
        "COACH",
        "[STIZ] 체험수업 일정이 확정되었습니다.\n학생: {{childName}} ({{childGrade}})\n일시: {{scheduledDate}}\n반: {{className}}",
        "관리자가 체험 일정을 확정하면 담당 강사에게 확정 일시와 반을 안내",
        '["childName","childGrade","scheduledDate","className"]',
    ],
    [
        "TRIAL_ATTENDED_PARENT",
        "체험 완료 감사 안내 (학부모)",
        "PARENT",
        "[STIZ] {{childName}} 학생의 체험수업 참여 감사합니다.\n정규 수강신청을 원하시면 아래 링크에서 신청해주세요.\n{{enrollLink}}\n문의: {{academyPhone}}",
        "관리자가 체험 리드를 체험완료로 변경하면 학부모에게 자동 발송",
        '["childName","parentName","academyPhone","enrollLink"]',
    ],
    [
        "TRIAL_ENROLL_GUIDE_PARENT",
        "수강신청서 안내 (학부모)",
        "PARENT",
        "스티즈 수강신청서\n링크에서 작성해주세요 :)\n{{enrollLink}}",
        "체험완료 후 관리자가 등록전환하면 학부모에게 자동 발송",
        '["enrollLink"]',
    ],
    [
        "ENROLL_CONFIRM_PARENT",
        "수강 신청 확인 (학부모)",
        "PARENT",
        "[STIZ] {{childName}} 수강 신청이 접수되었습니다.\n승인 후 안내드리겠습니다.\n문의: {{academyPhone}}",
        "수강 신청 직후 학부모에게 접수 확인 발송",
        '["childName","parentName","academyPhone"]',
    ],
    [
        "ENROLL_APPROVED_PARENT",
        "수강 확정 (학부모)",
        "PARENT",
        "[STIZ] {{childName}} 수강이 확정되었습니다.\n배정 반: {{className}}\n상세 안내는 별도 연락드리겠습니다.",
        "관리자가 수강 신청을 승인하면 학부모에게 발송",
        '["childName","className","academyPhone"]',
    ],
    [
        "ENROLL_APPROVED_COACH",
        "수강 승인 (담당 강사)",
        "COACH",
        "[STIZ] 수강 신청이 승인되었습니다.\n학생: {{childName}} ({{childGrade}})\n배정 반: {{className}}",
        "관리자가 수강 신청을 승인하면 담당 강사에게 승인 사실과 배정 반을 안내",
        '["childName","childGrade","className"]',
    ],
    [
        "INVOICE_PARENT",
        "수납 안내 (학부모)",
        "PARENT",
        "[STIZ] {{month}}월 수강료 안내\n{{childName}}: {{amount}}원\n납부기한: {{dueDate}}",
        "월별 청구서 생성 시 학부모에게 발송",
        '["childName","month","amount","dueDate"]',
    ],
    [
        "UNPAID_PARENT",
        "미납 알림 (학부모)",
        "PARENT",
        "[STIZ] 미납 수납 안내\n{{childName}}: {{unpaidCount}}건 ({{totalAmount}}원)\n확인 부탁드립니다.",
        "미납 알림 일괄 발송 시 학부모에게 발송",
        '["childName","unpaidCount","totalAmount"]',
    ],
    ["SPECIAL_APPLICATION_RECEIVED_PARENT", "특강 신청 접수", "PARENT", "[STIZ] {{childName}} 학생의 {{seasonTitle}} 특강 신청이 접수되었습니다.\n신청: {{offeringTitle}}\n문의: {{academyPhone}}", "특강 신청 직후 접수 안내", '["childName","seasonTitle","offeringTitle","academyPhone"]'],
    ["SPECIAL_APPLICATION_NEW_ADMIN", "특강 최초 신청 접수 (관리자)", "ADMIN", "[STIZ] 새 특강 신청\n{{childName}} - {{parentName}}\n특강: {{seasonTitle}} / {{offeringTitle}}", "특강 최초 신청 시 관리자에게 한 번 알림", '["childName","seasonTitle","offeringTitle","parentName","parentPhone"]'],
    ["SPECIAL_APPLICATION_APPROVED_PARENT", "특강 신청 승인", "PARENT", "[STIZ] {{childName}} 학생의 {{offeringTitle}} 특강 신청이 승인되었습니다.\n결제 및 계정 안내를 확인해 주세요.\n문의: {{academyPhone}}", "특강 신청 승인 안내", '["childName","seasonTitle","offeringTitle","academyPhone"]'],
    ["SPECIAL_APPLICATION_WAITLISTED_PARENT", "특강 대기 접수", "PARENT", "[STIZ] {{childName}} 학생의 {{offeringTitle}} 특강은 대기 접수되었습니다.\n대기순번: {{waitlistOrder}}\n자리 발생 시 안내드리겠습니다.", "특강 대기 상태 안내", '["childName","offeringTitle","waitlistOrder","academyPhone"]'],
    ["SPECIAL_APPLICATION_REJECTED_PARENT", "특강 신청 반려", "PARENT", "[STIZ] {{childName}} 학생의 {{offeringTitle}} 특강 신청이 승인되지 않았습니다.\n문의: {{academyPhone}}", "특강 신청 반려 안내", '["childName","offeringTitle","academyPhone"]'],
    ["SPECIAL_APPLICATION_CANCELLED_PARENT", "특강 신청 취소", "PARENT", "[STIZ] {{childName}} 학생의 {{offeringTitle}} 특강 신청이 취소되었습니다.\n문의: {{academyPhone}}", "특강 신청 취소 안내", '["childName","offeringTitle","academyPhone"]'],
    ["SPECIAL_ACCOUNT_ACTIVATION_PARENT", "특강 입학 가입 안내", "PARENT", "[STIZ] {{childName}} 학생의 특강 신청이 확정되었습니다.\n수강 확인과 결제를 위해 아래 링크에서 보호자 가입을 완료해 주세요.\n{{activationUrl}}\n링크는 본인만 사용해 주세요.", "신규 보호자 입학(가입) 안내 링크", '["childName","activationUrl"]'],
    ["SPECIAL_PAYMENT_REQUEST_PARENT", "특강 결제 요청", "PARENT", "[STIZ] {{childName}} 학생의 {{offeringTitle}} 특강 결제를 확인해 주세요.\n금액: {{amount}}원\n납부기한: {{dueDate}}\n{{paymentUrl}}", "특강 청구서 결제 안내", '["childName","offeringTitle","amount","dueDate","paymentUrl"]'],
    [
        "SHUTTLE_ROUTE_CONFIRMED_PARENT",
        "셔틀 노선 배정 확정 (학부모)",
        "PARENT",
        "[STIZ] {{학생명}} 셔틀 {{운행방향}} 안내\n{{운행일}} {{예정시간}} / {{정류장}}",
        "셔틀 노선 배정이 확정되거나 확정 정보가 변경되면 학부모에게 안내",
        '["학생명","운행방향","운행일","예정시간","정류장"]',
    ],
    [
        "SHUTTLE_NO_SHOW_PARENT",
        "셔틀 미탑승 안내 (학부모)",
        "PARENT",
        "[STIZ] {{학생명}} 학생이 오늘 {{운행방향}} 셔틀에 미탑승 처리되었습니다. 확인 부탁드립니다.",
        "기사가 학생을 미탑승 처리하면 학부모에게 즉시 안내",
        '["학생명","운행방향"]',
    ],
];

// 신청 완료 화면과 겹치거나 배정 전 담당자가 불명확한 자동문자는 기본으로 끈다.
// 보안 OTP와 일정·배정 확정, 결제 등 사용자의 행동이 필요한 문자는 이 목록에 포함하지 않는다.
export const DEFAULT_DISABLED_SMS_TRIGGERS = new Set([
    "TRIAL_NEW_COACH",
    "TRIAL_CONFIRM_PARENT",
    "TRIAL_ATTENDED_PARENT",
    "ENROLL_NEW_COACH",
    "ENROLL_CONFIRM_PARENT",
    "SPECIAL_APPLICATION_RECEIVED_PARENT",
    "SPECIAL_APPLICATION_APPROVED_PARENT",
]);

/**
 * ensureSmsTemplates — 템플릿이 0개면 기본 10개를 INSERT
 *
 * DDL 패턴: 앱 시작 또는 첫 조회 시 1회만 실행
 * ON CONFLICT DO NOTHING: 이미 있는 trigger는 무시 (관리자가 수정한 내용 보존)
 */
export async function ensureSmsTemplates(): Promise<void> {
    await ensureSmsTemplateTable();
    if (_defaultSmsTemplatesEnsured) return;

    try {
        // 기본 템플릿 삽입 — ON CONFLICT 로 이미 있는 trigger는 무시
        for (const [trigger, name, target, body, description, variables] of DEFAULT_TEMPLATES) {
            const isActive = !DEFAULT_DISABLED_SMS_TRIGGERS.has(trigger);
            await prisma.$executeRawUnsafe(
                `INSERT INTO "SmsTemplate" (id, trigger, name, target, body, "isActive", description, variables, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
                 ON CONFLICT (trigger) DO NOTHING`,
                trigger, name, target, body, isActive, description, variables,
            );
        }
        // 기존 운영 DB에 남은 기본 장문만 새 단문으로 교체한다.
        // 관리자가 직접 수정한 문구는 덮어쓰지 않는다.
        await prisma.$executeRawUnsafe(
            `UPDATE "SmsTemplate"
                SET name = $1,
                    body = $2,
                    description = $3,
                    variables = $4,
                    "updatedAt" = NOW()
              WHERE trigger = 'TRIAL_ENROLL_GUIDE_PARENT'
                AND body = $5`,
            "수강신청서 안내 (학부모)",
            "스티즈 수강신청서\n링크에서 작성해주세요 :)\n{{enrollLink}}",
            "체험완료 후 관리자가 등록전환하면 학부모에게 자동 발송",
            '["enrollLink"]',
            "[STIZ] {{childName}} 학생 체험수업 상담 감사드립니다.\n정규 수강신청서는 아래 링크에서 작성해주세요.\n{{enrollLink}}\n작성 후 확인되는 대로 입학 안내를 도와드리겠습니다.\n문의: {{academyPhone}}",
        );
        // 신규·복원 DB에서도 템플릿과 자동 발송 규칙이 같은 시점에 준비되게 한다.
        await prisma.$executeRawUnsafe(
            `INSERT INTO "MessageAutomationRule" (
                id, trigger, name, "audienceScope", target, "isActive",
                "requestedChannel", "fallbackEnabled", "fallbackChannel",
                "templateId", description, "createdAt", "updatedAt"
             )
             SELECT gen_random_uuid()::text, t.trigger, t.name,
                    CASE WHEN t.target IN ('ADMIN', 'COACH', 'STAFF') THEN 'INTERNAL' ELSE 'EXTERNAL' END,
                    t.target, t."isActive", 'SMS', true, 'SMS', t.id, t.description, NOW(), NOW()
               FROM "SmsTemplate" t
             ON CONFLICT (trigger) DO UPDATE
               SET "templateId" = COALESCE("MessageAutomationRule"."templateId", EXCLUDED."templateId")`,
        ).catch(() => undefined);
        _defaultSmsTemplatesEnsured = true;
    } catch (e) {
        console.error("[ensureSmsTemplates] seed failed:", e);
    }
}

// ── 변수 치환 함수 ────────────────────────────────────────────────────────────
// body 문자열 안의 {{key}}를 variables 객체의 값으로 교체
// 매칭되지 않는 변수는 빈 문자열로 대체 (에러 방지)
export function renderTemplate(body: string, variables: Record<string, string>): string {
    // 한글 키도 영문 키와 동일하게 치환하고, 값이 없는 변수는 발송문에 남기지 않는다.
    return body.replace(/\{\{([\p{L}\p{N}_]+)\}\}/gu, (_, key) => variables[key] || "");
}

export type SmsTemplateRenderResult =
    | { ok: true; body: string }
    | { ok: false; reason: "TEMPLATE_DISABLED_OR_MISSING" | "TEMPLATE_LOOKUP_FAILED" };

export async function renderSmsTemplateResult(
    trigger: string,
    variables: Record<string, string>,
): Promise<SmsTemplateRenderResult> {
    await ensureSmsTemplates();
    try {
        const rows = await prisma.$queryRawUnsafe<Array<{ body: string; isActive?: boolean; isactive?: boolean }>>(
            `SELECT body, "isActive" FROM "SmsTemplate" WHERE trigger = $1 LIMIT 1`, trigger,
        );
        if (rows.length === 0) return { ok: false, reason: "TEMPLATE_DISABLED_OR_MISSING" };
        const template = rows[0];
        if (!(template.isActive ?? template.isactive)) return { ok: false, reason: "TEMPLATE_DISABLED_OR_MISSING" };
        return { ok: true, body: renderTemplate(template.body, variables) };
    } catch {
        return { ok: false, reason: "TEMPLATE_LOOKUP_FAILED" };
    }
}

/**
 * renderSmsTemplate — 트리거 코드로 템플릿을 조회하고 변수를 치환하여 최종 메시지 반환
 *
 * @param trigger    트리거 코드 (예: "TRIAL_NEW_ADMIN")
 * @param variables  치환할 변수 객체 (예: { childName: "홍길동", ... })
 * @returns          치환된 메시지 문자열. 비활성(isActive=false)이면 null 반환
 */
export async function renderSmsTemplate(
    trigger: string,
    variables: Record<string, string>,
): Promise<string | null> {
    // DDL + seed 보장
    await ensureSmsTemplates();

    try {
        const rows = await prisma.$queryRawUnsafe<Array<{ body: string; isActive?: boolean; isactive?: boolean }>>(
            `SELECT body, "isActive" FROM "SmsTemplate" WHERE trigger = $1 LIMIT 1`,
            trigger,
        );

        if (rows.length === 0) return null;

        const tpl = rows[0];
        // 비활성 템플릿이면 발송하지 않음
        const isActive = tpl.isActive ?? tpl.isactive;
        if (!isActive) return null;

        return renderTemplate(tpl.body, variables);
    } catch (e) {
        console.error(`[renderSmsTemplate] trigger=${trigger} failed:`, e);
        return null;
    }
}

// ── 자연어 키워드 → 변수 치환 매핑 ────────────────────────────────────────────
// 관리자가 한글로 입력한 키워드를 {{변수}}로 자동 변환하는 데 사용
export const KEYWORD_TO_VARIABLE: Record<string, string> = {
    // childName
    "아이이름": "{{childName}}", "학생이름": "{{childName}}", "수강생이름": "{{childName}}",
    // childGrade
    "학년": "{{childGrade}}",
    "저장용이름": "{{contactSaveName}}", "연락처저장이름": "{{contactSaveName}}",
    // parentName
    "학부모이름": "{{parentName}}", "보호자이름": "{{parentName}}", "부모이름": "{{parentName}}",
    // parentPhone
    "학부모연락처": "{{parentPhone}}", "보호자전화": "{{parentPhone}}", "부모전화": "{{parentPhone}}",
    // className
    "반이름": "{{className}}", "수강반": "{{className}}", "수업반": "{{className}}",
    // scheduledDate
    "체험일시": "{{scheduledDate}}", "체험날짜": "{{scheduledDate}}", "예정일": "{{scheduledDate}}",
    // amount
    "금액": "{{amount}}", "수강료": "{{amount}}", "납부금": "{{amount}}",
    // month
    "월": "{{month}}", "해당월": "{{month}}",
    // academyPhone
    "학원전화": "{{academyPhone}}", "문의전화": "{{academyPhone}}", "연락처": "{{academyPhone}}",
    // preferredSlot
    "희망시간": "{{preferredSlot}}", "희망교시": "{{preferredSlot}}",
};

/**
 * autoConvertKeywords — 본문에서 한글 키워드를 찾아 {{변수}}로 자동 치환
 *
 * @param body      원본 메시지 본문
 * @returns         { converted: 치환된 본문, changes: 변환된 키워드 목록 }
 */
export function autoConvertKeywords(body: string): { converted: string; changes: string[] } {
    let converted = body;
    const changes: string[] = [];

    // 긴 키워드부터 먼저 매칭 (예: "학부모연락처"가 "연락처"보다 먼저)
    const sortedKeywords = Object.keys(KEYWORD_TO_VARIABLE).sort((a, b) => b.length - a.length);

    for (const keyword of sortedKeywords) {
        if (converted.includes(keyword)) {
            const variable = KEYWORD_TO_VARIABLE[keyword];
            converted = converted.replaceAll(keyword, variable);
            changes.push(`"${keyword}" -> ${variable}`);
        }
    }

    return { converted, changes };
}

// ── 미리보기용 샘플 데이터 ────────────────────────────────────────────────────
export const SAMPLE_VARIABLES: Record<string, string> = {
    childName: "홍길동",
    childGrade: "초4",
    parentName: "김철수",
    parentPhone: "010-1234-5678",
    className: "초등 A반",
    scheduledDate: "2026-04-05 (토) 14:00",
    amount: "150,000",
    month: "4",
    dueDate: "4월 10일",
    academyPhone: "010-0000-0000",
    preferredSlot: "토 14:00",
    unpaidCount: "2",
    totalAmount: "300,000",
};
