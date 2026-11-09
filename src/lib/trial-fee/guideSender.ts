// 체험 안내·등록 안내 — 데이터 읽기(코치·기사 연락처) + 미리보기 + «스위치 켜졌을 때만» 발송. 서버 전용.
//
// ■ 연락처는 어디서 오나 (DB 조사 결과, 2026-11-10)
//   - 코치: Coach.name·role·phone. 반 → 코치는 슬롯 키로 잇는다(ScheduleSlot.coachId → ClassSlotOverride.coachId →
//           CustomClassSlot.coachId). 체험 신청 코치 문자(notification.ts getCoachPhonesBySlotKeys)와 같은 연결.
//   - 셔틀 기사님: 기사 역할 계정(User.role=DRIVER 또는 승인된 추가 역할 DRIVER, 탈퇴 제외)의 name·phone.
//           명단 변경 기사 알림(regularRosterNotify)과 같은 «기사 역할 전원» 기준 — 반별 담당 기사 칸은 DB 에 없다.
//   - 셔틀 이용 여부: 학생이 정규 셔틀 명단(RegularShuttleStop, 이번 달 이하 최신 달)에 있거나 셔틀 위치를 등록했으면 이용.
// ■ 발송은 두 겹으로 잠겨 있다: 설정 스위치(trialGuideAutoSend·enrollGuideAutoSend, 기본 꺼짐) + 문자 규칙
//   (MessageAutomationRule isActive=false 로 추가). 원장 문구 승인 전에는 미리보기만 된다.

import { prisma } from "@/lib/prisma";
import { sendTrackedSms } from "@/lib/notification";
import { isKstYmd, todayKst, toKstYmd, kstDow } from "@/lib/datetime/kst";
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
const DOW_LABEL = ["일", "월", "화", "수", "목", "금", "토"];
const DRIVER_CONDITION = `(u.role::text='DRIVER' OR EXISTS (SELECT 1 FROM "UserRoleGrant" g WHERE g."userId"=u.id AND g.role='DRIVER' AND g.status='ACTIVE'))`;

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

/** 기사 역할 계정 전원(탈퇴 제외)의 이름·번호 */
export async function loadDriverContacts(): Promise<ContactPerson[]> {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string; phone: string | null }>>(
        `SELECT u.name, u.phone FROM "User" u WHERE u."withdrawnAt" IS NULL AND ${DRIVER_CONDITION} ORDER BY u.name ASC`,
    );
    return rows.map((row) => ({ name: row.name, title: "기사님", phone: row.phone ?? "" }));
}

type ClassRow = { slotKey: string | null; dayOfWeek: string; startTime: string; endTime: string; name: string };

function classLabel(row: ClassRow): string {
    return `${DAY_LABEL[row.dayOfWeek] ?? row.dayOfWeek} ${row.startTime}~${row.endTime} ${row.name}`.trim();
}

/** 체험 희망 일정 «11월 12일(수) 4교시 16:00~17:00» — 날짜는 KST 모듈로만 */
async function preferredScheduleLabel(lead: { trialDate: unknown; preferredPeriod: string | null; preferredSlotKey: string | null }): Promise<string> {
    const parts: string[] = [];
    if (lead.trialDate) {
        const ymd = toKstYmd(lead.trialDate as Date | string);
        if (isKstYmd(ymd)) {
            const [, month, day] = ymd.split("-");
            parts.push(`${Number(month)}월 ${Number(day)}일(${DOW_LABEL[kstDow(ymd)]})`);
        }
    }
    if (lead.preferredPeriod) parts.push(`${lead.preferredPeriod}교시`);
    if (lead.preferredSlotKey) {
        const rows = await prisma.$queryRawUnsafe<ClassRow[]>(
            `SELECT "slotKey", "dayOfWeek", "startTime", "endTime", name FROM "Class" WHERE "slotKey" = $1 LIMIT 1`,
            lead.preferredSlotKey,
        );
        if (rows[0]) parts.push(`${rows[0].startTime}~${rows[0].endTime}`);
    }
    return parts.join(" ");
}

type GuideLead = {
    id: string; childName: string; parentPhone: string | null; trialDate: unknown; preferredPeriod: string | null;
    preferredSlotKey: string | null; scheduledClassId: string | null; createdAt: unknown;
};

async function loadLead(trialLeadId: string): Promise<GuideLead | null> {
    const rows = await prisma.$queryRawUnsafe<GuideLead[]>(
        `SELECT id, "childName", "parentPhone", "trialDate", "preferredPeriod", "preferredSlotKey", "scheduledClassId", "createdAt"
           FROM "TrialLead" WHERE id = $1 LIMIT 1`,
        trialLeadId,
    );
    return rows[0] ?? null;
}

/** (a) 체험 확정 안내 미리보기 — 신청 1건 기준 */
export async function previewTrialGuide(trialLeadId: string): Promise<(GuidePreview & { phone: string | null }) | null> {
    const lead = await loadLead(trialLeadId);
    if (!lead) return null;
    const settings = await getTrialFeeSettings();
    const body = buildTrialGuideMessage({
        childName: lead.childName,
        feeLabel: formatTrialFeeAmount(settings.amount),
        preferredSchedule: await preferredScheduleLabel(lead),
        academyPhone: settings.contactPhone,
    });
    return { phone: lead.parentPhone, recipientMasked: maskPhone(lead.parentPhone), body, subject: `${lead.childName} · 체험 신청` };
}

/** (b) 등록 안내 미리보기 — 체험 신청 기준(체험 완료 후): 배정 반(없으면 희망 슬롯) · 셔틀은 연결된 수강 신청서의 셔틀 희망으로 */
export async function previewEnrollGuideForTrialLead(trialLeadId: string): Promise<(GuidePreview & { phone: string | null }) | null> {
    const lead = await loadLead(trialLeadId);
    if (!lead) return null;
    const classRows = lead.scheduledClassId
        ? await prisma.$queryRawUnsafe<ClassRow[]>(
            `SELECT "slotKey", "dayOfWeek", "startTime", "endTime", name FROM "Class" WHERE id = $1 LIMIT 1`, lead.scheduledClassId)
        : lead.preferredSlotKey
            ? await prisma.$queryRawUnsafe<ClassRow[]>(
                `SELECT "slotKey", "dayOfWeek", "startTime", "endTime", name FROM "Class" WHERE "slotKey" = $1 LIMIT 1`, lead.preferredSlotKey)
            : [];
    const shuttleRows = await prisma.$queryRawUnsafe<Array<{ shuttleNeeded: boolean }>>(
        `SELECT ea."shuttleNeeded" FROM "TrialLead" tl JOIN "EnrollmentApplication" ea ON ea.id = tl."enrollApplicationId"
          WHERE tl.id = $1 LIMIT 1`,
        trialLeadId,
    );
    const usesShuttle = shuttleRows[0]?.shuttleNeeded === true;
    const slotKeys = classRows.map((row) => row.slotKey).filter((key): key is string => Boolean(key));
    if (lead.preferredSlotKey && slotKeys.length === 0) slotKeys.push(lead.preferredSlotKey);
    const body = buildEnrollGuideMessage({
        childName: lead.childName,
        classLabels: classRows.map(classLabel),
        coaches: await loadCoachesBySlotKeys(slotKeys),
        drivers: usesShuttle ? await loadDriverContacts() : [],
        usesShuttle,
    });
    return { phone: lead.parentPhone, recipientMasked: maskPhone(lead.parentPhone), body, subject: `${lead.childName} · 체험 후 등록 안내` };
}

/** (b) 등록 안내 — 원생(실제 수강 등록) 기준: 지금 다니는 반 전부 · 셔틀 = 명단(이번 달 이하 최신 달) 또는 셔틀 위치 등록 */
export async function previewEnrollGuideForStudent(studentId: string): Promise<(GuidePreview & { phone: string | null }) | null> {
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
    const usesShuttle = shuttle[0]?.uses === true;
    const body = buildEnrollGuideMessage({
        childName: student.name,
        classLabels: classRows.map(classLabel),
        coaches: await loadCoachesBySlotKeys(classRows.map((row) => row.slotKey).filter((key): key is string => Boolean(key))),
        drivers: usesShuttle ? await loadDriverContacts() : [],
        usesShuttle,
    });
    return { phone: student.parentPhone, recipientMasked: maskPhone(student.parentPhone), body, subject: `${student.name} · 수강 등록 안내` };
}

export type GuideSendResult = { sent: boolean; reason: "OFF" | "NO_TARGET" | "NO_PHONE" | "SENT" | "FAILED" };

/** (a) 체험비 결제 완료 직후 — 스위치가 켜졌을 때만 보낸다(기본 꺼짐). 실패해도 결제 확정은 그대로. */
export async function sendTrialGuideIfEnabled(trialLeadId: string): Promise<GuideSendResult> {
    const settings = await getTrialFeeSettings();
    if (!settings.trialGuideAutoSend) return { sent: false, reason: "OFF" };
    const preview = await previewTrialGuide(trialLeadId);
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
export async function sendEnrollGuideIfEnabled(studentId: string): Promise<GuideSendResult> {
    const settings = await getTrialFeeSettings();
    if (!settings.enrollGuideAutoSend) return { sent: false, reason: "OFF" };
    const preview = await previewEnrollGuideForStudent(studentId);
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
