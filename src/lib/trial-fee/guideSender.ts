// 체험비 결제 확인·수강 등록 완료의 미리보기와 자동 발송. 서버 전용.

import { prisma } from "@/lib/prisma";
import { sendTrackedSms } from "@/lib/notification";
import { todayKst } from "@/lib/datetime/kst";
import { getTrialFeeSettings } from "@/lib/trial-fee/trialFeeSettings";
import { notMergedStudent } from "@/lib/studentVisibility";
import { formatTrialFeeAmount } from "@/lib/trial-fee/trialFeeRules";
import {
    ENROLL_GUIDE_TRIGGER,
    TRIAL_GUIDE_TRIGGER,
    buildEnrollGuideMessage,
    buildTrialGuideMessage,
    coachGuideTitle,
    type ContactPerson,
} from "@/lib/trial-fee/guideMessages";

const DAY_LABEL: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };

export type GuidePreview = {
    /** 받는 번호(가려서 보인다 — 미리보기 화면용) */
    recipientMasked: string;
    body: string;
    /** 미리보기에 쓴 대상 설명(예: «홍길동 · 체험 신청 11/10») */
    subject: string;
};

function maskPhone(phone: string | null | undefined): string {
    const digits = String(phone ?? "").replace(/\D/g, "");
    if (digits.length < 8) return "번호 없음";
    return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

/** 슬롯 키들의 담당 코치(이름·직함·번호) — 번호 없는 코치는 이름만 */
export async function loadCoachesBySlotKeys(slotKeys: string[]): Promise<ContactPerson[]> {
    const keys = [...new Set(slotKeys.filter(Boolean))];
    if (keys.length === 0) return [];
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; role: string | null; phone: string | null }>>(
        `SELECT DISTINCT c.id, c.name, c.role, c.phone FROM "ScheduleSlot" ss JOIN "Coach" c ON c.id = ss."coachId"
          WHERE ss."slotKey" = ANY($1::text[])
         UNION
         SELECT DISTINCT c.id, c.name, c.role, c.phone FROM "ClassSlotOverride" o JOIN "Coach" c ON c.id = o."coachId"
          WHERE o."slotKey" = ANY($1::text[])
         UNION
         SELECT DISTINCT c.id, c.name, c.role, c.phone FROM "CustomClassSlot" cs JOIN "Coach" c ON c.id = cs."coachId"
          WHERE cs.id = ANY($1::text[]) OR ('custom-' || cs.id) = ANY($1::text[])
         ORDER BY name ASC`,
        keys,
    );
    return rows.map((row) => ({ name: row.name, title: coachGuideTitle(row.role), phone: row.phone ?? "" }));
}

type ClassRow = { slotKey: string | null; dayOfWeek: string; startTime: string; endTime: string; name: string };

function classLabel(row: ClassRow): string {
    return `${DAY_LABEL[row.dayOfWeek] ?? row.dayOfWeek} ${row.startTime}~${row.endTime} ${row.name}`.trim();
}

/** 실제 발송은 결제 완료 금액만, 관리자 미리보기는 미결제 신청도 설정 금액으로 예시를 만들 수 있다. */
export async function previewTrialGuide(
    trialLeadId: string,
    options: { requirePaid?: boolean } = {},
): Promise<(GuidePreview & { phone: string | null }) | null> {
    const [lead] = await prisma.$queryRawUnsafe<Array<{ childName: string; parentPhone: string | null; paidAmount: number | null }>>(
        `SELECT l."childName", l."parentPhone", p.amount AS "paidAmount"
           FROM "TrialLead" l
           LEFT JOIN LATERAL (
             SELECT amount FROM "TrialFeePayment"
              WHERE "trialLeadId" = l.id AND status = 'DONE'
              ORDER BY "createdAt" DESC, id DESC LIMIT 1
           ) p ON true
          WHERE l.id = $1 LIMIT 1`,
        trialLeadId,
    );
    if (!lead || (options.requirePaid && lead.paidAmount == null)) return null;
    const settings = await getTrialFeeSettings();
    const body = buildTrialGuideMessage({
        childName: lead.childName,
        feeLabel: formatTrialFeeAmount(lead.paidAmount == null ? settings.amount : Number(lead.paidAmount)),
        academyPhone: settings.contactPhone,
    });
    const sample = lead.paidAmount == null ? " · 미결제 예시" : "";
    return { phone: lead.parentPhone, recipientMasked: maskPhone(lead.parentPhone), body, subject: `${lead.childName} · 체험비 결제 확인${sample}` };
}

/** 등록 완료 안내는 실제 재원 수업과 셔틀 이용 정보로 작성한다. */
export async function previewEnrollGuideForStudent(studentId: string, options: { usesShuttle?: boolean } = {}): Promise<(GuidePreview & { phone: string | null }) | null> {
    const students = await prisma.$queryRawUnsafe<Array<{ name: string; parentPhone: string | null }>>(
        `SELECT s.name, u.phone AS "parentPhone" FROM "Student" s LEFT JOIN "User" u ON u.id = s."parentId"
          WHERE s.id = $1 AND ${notMergedStudent("s")} LIMIT 1`,
        studentId,
    );
    const student = students[0];
    if (!student) return null;
    const classRows = await prisma.$queryRawUnsafe<ClassRow[]>(
        `SELECT c."slotKey", c."dayOfWeek", c."startTime", c."endTime", c.name
           FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId"
          WHERE e."studentId" = $1 AND e.status = 'ACTIVE'
          ORDER BY c."dayOfWeek", c."startTime"`,
        studentId,
    );
    if (classRows.length === 0) return null;
    const thisMonth = todayKst().slice(0, 7);
    const shuttle = await prisma.$queryRawUnsafe<Array<{ uses: boolean }>>(
        `SELECT (
            EXISTS (SELECT 1 FROM "RegularShuttleStop" r WHERE r."studentId" = $1
                     AND r."serviceMonth" = (SELECT MAX("serviceMonth") FROM "RegularShuttleStop" WHERE "serviceMonth" <= $2))
            OR EXISTS (SELECT 1 FROM "StudentShuttleLocation" l WHERE l."studentId" = $1)
         ) AS uses`,
        studentId,
        thisMonth,
    );
    const usesShuttle = options.usesShuttle ?? (shuttle[0]?.uses === true);
    const body = buildEnrollGuideMessage({
        childName: student.name,
        classLabels: classRows.map(classLabel),
        coaches: await loadCoachesBySlotKeys(classRows.map((row) => row.slotKey).filter((key): key is string => Boolean(key))),
        // 정규 명단에는 학생별 담당 기사 배정이 없어 안내 문구로 대신한다.
        drivers: [],
        usesShuttle,
    });
    return { phone: student.parentPhone, recipientMasked: maskPhone(student.parentPhone), body, subject: `${student.name} · 수강 등록 완료` };
}

export type GuideSendResult = { sent: boolean; reason: "OFF" | "NO_TARGET" | "NO_PHONE" | "SENT" | "FAILED" };

/** (a) 체험비 결제 완료 직후 — 스위치가 켜졌을 때만 보낸다(기본 꺼짐). 실패해도 결제 확정은 그대로. */
export async function sendTrialGuideIfEnabled(trialLeadId: string): Promise<GuideSendResult> {
    const settings = await getTrialFeeSettings();
    if (!settings.trialGuideAutoSend) return { sent: false, reason: "OFF" };
    const preview = await previewTrialGuide(trialLeadId, { requirePaid: true });
    if (!preview) return { sent: false, reason: "NO_TARGET" };
    if (!preview.phone) return { sent: false, reason: "NO_PHONE" };
    const result = await sendTrackedSms({
        eventType: "TRIAL_PAID_GUIDE",
        eventId: `trial:${trialLeadId}:paid-guide`,
        recipientPhone: preview.phone,
        body: preview.body,
        trigger: TRIAL_GUIDE_TRIGGER,
        recipientRole: "PARENT",
        audienceScope: "EXTERNAL",
    });
    return { sent: result.ok, reason: result.ok ? "SENT" : "FAILED" };
}

/** (b) 실제 수강 등록 직후 — 스위치가 켜졌을 때만(기본 꺼짐). 같은 학생에게는 한 번만(eventId 고정 → 장부 중복 차단). */
export async function sendEnrollGuideIfEnabled(studentId: string, options: { usesShuttle?: boolean } = {}): Promise<GuideSendResult> {
    const settings = await getTrialFeeSettings();
    if (!settings.enrollGuideAutoSend) return { sent: false, reason: "OFF" };
    const preview = await previewEnrollGuideForStudent(studentId, options);
    if (!preview) return { sent: false, reason: "NO_TARGET" };
    if (!preview.phone) return { sent: false, reason: "NO_PHONE" };
    const result = await sendTrackedSms({
        eventType: "ENROLL_WELCOME_GUIDE",
        eventId: `student:${studentId}:enroll-guide`,
        recipientPhone: preview.phone,
        body: preview.body,
        trigger: ENROLL_GUIDE_TRIGGER,
        recipientRole: "PARENT",
        audienceScope: "EXTERNAL",
    });
    return { sent: result.ok, reason: result.ok ? "SENT" : "FAILED" };
}
