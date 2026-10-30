import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { createNotificationRecord } from "@/lib/notification";
import type { AdminAuthUser } from "@/lib/auth-guard";

export type SiteOpsCheckStatus = "ok" | "fixed" | "warning" | "critical";

export type SiteOpsCheck = {
  id: string;
  label: string;
  status: SiteOpsCheckStatus;
  message: string;
  actionLabel?: string;
  actionHref?: string;
};

export type SiteOpsBotResult = {
  checkedAt: string;
  ok: boolean;
  fixedCount: number;
  manualActionCount: number;
  criticalCount: number;
  checks: SiteOpsCheck[];
  notified: boolean;
};

const MANUAL_STATUSES = new Set<SiteOpsCheckStatus>(["warning", "critical"]);

function toBool(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "1";
  return Boolean(value);
}

function countFrom(rows: Array<{ count: number }>) {
  return Number(rows[0]?.count ?? 0);
}

function isOlderThan(date: Date | null, days: number) {
  if (!date) return true;
  return Date.now() - date.getTime() > days * 24 * 60 * 60 * 1000;
}

async function countRows(sql: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(sql);
  return countFrom(rows);
}

async function ensureAcademySettings(checks: SiteOpsCheck[]) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
  );

  if (rows[0]) {
    checks.push({
      id: "academy-settings-row",
      label: "기본 설정",
      status: "ok",
      message: "사이트 기본 설정이 정상입니다.",
      actionHref: "/admin/settings",
      actionLabel: "설정 보기",
    });
    return rows[0];
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO "AcademySettings" (id, "createdAt", "updatedAt")
     VALUES ('singleton', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  );

  checks.push({
    id: "academy-settings-row",
    label: "기본 설정",
    status: "fixed",
    message: "누락된 사이트 기본 설정을 자동으로 생성했습니다.",
    actionHref: "/admin/settings",
    actionLabel: "내용 채우기",
  });

  const refreshed = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
  );
  return refreshed[0] ?? null;
}

async function checkPublicContent(checks: SiteOpsCheck[]) {
  const [programCount, coachCount, galleryCount, noticeCount] = await Promise.all([
    countRows(`SELECT COUNT(*)::int AS count FROM "Program"`),
    countRows(`SELECT COUNT(*)::int AS count FROM "Coach"`),
    countRows(`SELECT COUNT(*)::int AS count FROM "GalleryPost" WHERE "isPublic" = true`),
    countRows(`SELECT COUNT(*)::int AS count FROM "Notice"`),
  ]);

  checks.push({
    id: "program-content",
    label: "프로그램",
    status: programCount > 0 ? "ok" : "warning",
    message: programCount > 0 ? `공개할 프로그램 ${programCount}개가 등록되어 있습니다.` : "프로그램이 없어 수업 안내가 비어 보일 수 있습니다.",
    actionHref: "/admin/programs",
    actionLabel: "프로그램 관리",
  });

  checks.push({
    id: "coach-content",
    label: "코치/강사진",
    status: coachCount > 0 ? "ok" : "warning",
    message: coachCount > 0 ? `코치/강사진 ${coachCount}명이 등록되어 있습니다.` : "코치/강사진 소개가 비어 있습니다.",
    actionHref: "/admin/coaches",
    actionLabel: "강사진 관리",
  });

  checks.push({
    id: "gallery-content",
    label: "갤러리",
    status: galleryCount > 0 ? "ok" : "warning",
    message: galleryCount > 0 ? `공개 갤러리 게시물 ${galleryCount}개가 있습니다.` : "홈/갤러리에 보여줄 공개 사진이 없습니다.",
    actionHref: "/admin/gallery",
    actionLabel: "갤러리 관리",
  });

  checks.push({
    id: "notice-content",
    label: "공지사항",
    status: noticeCount > 0 ? "ok" : "warning",
    message: noticeCount > 0 ? `공지사항 ${noticeCount}개가 등록되어 있습니다.` : "공지사항이 없어 홈 공지 영역이 비어 보일 수 있습니다.",
    actionHref: "/admin/notices",
    actionLabel: "공지 관리",
  });
}

async function checkSchedule(checks: SiteOpsCheck[], settings: any) {
  const [classCount, scheduleSlotCount, customSlotCount, sheetRows] = await Promise.all([
    countRows(`SELECT COUNT(*)::int AS count FROM "Class"`),
    countRows(`SELECT COUNT(*)::int AS count FROM "ScheduleSlot" WHERE "isHidden" = false`).catch(() => 0),
    countRows(`SELECT COUNT(*)::int AS count FROM "CustomClassSlot" WHERE "isHidden" = false`),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT "slotsJson", "syncedAt" FROM "SheetSlotCache" WHERE id = 'singleton' LIMIT 1`,
    ).catch(() => []),
  ]);

  const sheetUrl = settings?.googleSheetsScheduleUrl ?? settings?.googlesheetsscheduleurl ?? null;
  const sheetRow = sheetRows[0];
  const syncedAt = sheetRow?.syncedAt ?? sheetRow?.syncedat ? new Date(sheetRow.syncedAt ?? sheetRow.syncedat) : null;
  let sheetSlotCount = 0;

  try {
    const parsed = JSON.parse(sheetRow?.slotsJson ?? sheetRow?.slotsjson ?? "[]");
    sheetSlotCount = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    sheetSlotCount = 0;
  }

  const hasScheduleData = scheduleSlotCount > 0 || classCount > 0 || customSlotCount > 0 || sheetSlotCount > 0;
  const staleSheet = Boolean(scheduleSlotCount === 0 && sheetUrl && isOlderThan(syncedAt, 14));
  const readyMessage = scheduleSlotCount > 0
    ? `DB 시간표 ${scheduleSlotCount}개가 준비되어 있습니다. 연결 반 ${classCount}개`
    : `시간표 데이터가 준비되어 있습니다. 반 ${classCount}개, 동기화 슬롯 ${sheetSlotCount}개`;

  checks.push({
    id: "schedule-data",
    label: "수업시간표",
    status: hasScheduleData && !staleSheet ? "ok" : "warning",
    message: hasScheduleData
      ? staleSheet
        ? "구글시트 시간표 동기화가 14일 이상 오래됐습니다."
        : readyMessage
      : "공개 시간표에 보여줄 수업 데이터가 없습니다.",
    actionHref: "/admin/schedule",
    actionLabel: staleSheet ? "동기화하기" : "시간표 관리",
  });
}

async function checkApplicationForms(checks: SiteOpsCheck[], settings: any) {
  const useBuiltInTrial = toBool(settings?.useBuiltInTrialForm ?? settings?.usebuiltintrialform);
  const useBuiltInEnroll = toBool(settings?.useBuiltInEnrollForm ?? settings?.usebuiltinenrollform);
  const trialFormUrl = settings?.trialFormUrl ?? settings?.trialformurl ?? null;
  const enrollFormUrl = settings?.enrollFormUrl ?? settings?.enrollformurl ?? null;

  checks.push({
    id: "trial-form",
    label: "체험 신청",
    status: useBuiltInTrial || trialFormUrl ? "ok" : "warning",
    message: useBuiltInTrial || trialFormUrl
      ? "체험 신청 진입점이 준비되어 있습니다."
      : "자체 체험 신청을 쓰지 않으면서 외부 신청 링크도 비어 있습니다.",
    actionHref: "/admin/apply",
    actionLabel: "신청 설정",
  });

  checks.push({
    id: "enroll-form",
    label: "수강 신청",
    status: useBuiltInEnroll || enrollFormUrl ? "ok" : "warning",
    message: useBuiltInEnroll || enrollFormUrl
      ? "수강 신청 진입점이 준비되어 있습니다."
      : "자체 수강 신청을 쓰지 않으면서 외부 신청 링크도 비어 있습니다.",
    actionHref: "/admin/apply",
    actionLabel: "신청 설정",
  });
}

async function checkBackup(checks: SiteOpsCheck[]) {
  try {
    const supabase = createAdminClient();
    const { data: buckets } = await supabase.storage.listBuckets();
    const exists = buckets?.some((bucket) => bucket.name === "backups");

    if (!exists) {
      const { error } = await supabase.storage.createBucket("backups", { public: false });
      if (error) throw error;
      checks.push({
        id: "backup-bucket",
        label: "백업 저장소",
        status: "fixed",
        message: "누락된 백업 저장소를 자동으로 생성했습니다.",
      });
    } else {
      checks.push({
        id: "backup-bucket",
        label: "백업 저장소",
        status: "ok",
        message: "백업 저장소가 준비되어 있습니다.",
      });
    }

    const { data: files } = await supabase.storage.from("backups").list("", {
      limit: 50,
      sortBy: { column: "created_at", order: "desc" },
    });
    const lastBackupAt = files?.[0]?.created_at ? new Date(files[0].created_at) : null;
    const backupStale = isOlderThan(lastBackupAt, 7);

    checks.push({
      id: "recent-backup",
      label: "최근 백업",
      status: backupStale ? "warning" : "ok",
      message: backupStale
        ? "최근 7일 내 백업이 없습니다. 관리자 확인이 필요합니다."
        : `최근 백업: ${lastBackupAt?.toLocaleDateString("ko-KR")}`,
      actionHref: "/admin",
      actionLabel: "백업하기",
    });
  } catch {
    checks.push({
      id: "backup-status",
      label: "백업",
      status: "critical",
      message: "백업 저장 공간 상태를 확인하지 못했습니다. 백업 설정을 확인해 주세요.",
      actionHref: "/admin",
      actionLabel: "시스템 도구 확인",
    });
  }
}

async function checkInstagram(checks: SiteOpsCheck[], settings: any) {
  const autoPublish = toBool(settings?.instagramAutoPublishEnabled ?? settings?.instagramautopublishenabled);
  const accountId = settings?.instagramBusinessAccountId ?? settings?.instagrambusinessaccountid ?? process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN?.trim() || process.env.META_ACCESS_TOKEN?.trim();
  const publicUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim() || process.env.VERCEL_URL?.trim();

  if (!autoPublish) {
    checks.push({
      id: "instagram-config",
      label: "인스타그램 자동 게시",
      status: "ok",
      message: "자동 게시가 꺼져 있어 필수 설정 점검을 건너뜁니다.",
      actionHref: "/admin/settings",
      actionLabel: "설정 보기",
    });
  } else {
    const missing = [
      !accountId ? "계정 ID" : null,
      !accessToken ? "Access Token" : null,
      !publicUrl ? "공개 사이트 URL" : null,
    ].filter(Boolean);

    checks.push({
      id: "instagram-config",
      label: "인스타그램 자동 게시",
      status: missing.length === 0 ? "ok" : "critical",
      message: missing.length === 0
        ? "인스타그램 자동 게시 설정이 준비되어 있습니다."
        : `인스타그램 자동 게시에 필요한 ${missing.join(", ")} 설정이 없습니다.`,
      actionHref: "/admin/settings",
      actionLabel: "설정 확인",
    });
  }

  const failedDrafts = await countRows(
    `SELECT COUNT(*)::int AS count FROM "SocialPostDraft" WHERE status = 'FAILED'`,
  ).catch(() => 0);
  const stuckDrafts = await countRows(
    `SELECT COUNT(*)::int AS count
     FROM "SocialPostDraft"
     WHERE status = 'PUBLISHING'
       AND COALESCE("instagramNextRetryAt", "updatedAt") < NOW() - INTERVAL '2 hours'`,
  ).catch(() => 0);

  checks.push({
    id: "instagram-drafts",
    label: "인스타 게시 대기열",
    status: failedDrafts > 0 || stuckDrafts > 0 ? "warning" : "ok",
    message: failedDrafts > 0 || stuckDrafts > 0
      ? `실패 ${failedDrafts}건, 오래 대기 중 ${stuckDrafts}건이 있습니다.`
      : "실패하거나 오래 멈춘 인스타 게시 초안이 없습니다.",
    actionHref: "/admin/gallery",
    actionLabel: "갤러리 확인",
  });
}

async function notifyManualActions(checks: SiteOpsCheck[]) {
  const manual = checks.filter((check) => MANUAL_STATUSES.has(check.status));
  if (manual.length === 0) return false;

  const criticalCount = manual.filter((check) => check.status === "critical").length;
  const title = criticalCount > 0
    ? `사이트 점검 봇: 긴급 확인 ${criticalCount}건`
    : `사이트 점검 봇: 확인 필요 ${manual.length}건`;
  const summary = manual.slice(0, 4).map((check) => `${check.label}: ${check.message}`).join("\n");
  const message = manual.length > 4 ? `${summary}\n외 ${manual.length - 4}건` : summary;
  const admins = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "User" WHERE role IN ('ADMIN', 'VICE_ADMIN')`,
  );

  for (const admin of admins) {
    const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Notification"
       WHERE "userId" = $1
         AND type = 'SITE_OPS'
         AND title = $2
         AND "createdAt" >= NOW() - INTERVAL '6 hours'
       LIMIT 1`,
      admin.id,
      title,
    );

    if (existing.length === 0) {
      await createNotificationRecord({
        userId: admin.id,
        type: "SITE_OPS",
        title,
        message,
        linkUrl: "/admin",
      });
    }
  }

  return true;
}

export async function runSiteOpsBot(_requestedBy?: AdminAuthUser | "cron"): Promise<SiteOpsBotResult> {
  const checks: SiteOpsCheck[] = [];
  let dbAvailable = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.push({
      id: "database",
      label: "자료 저장소",
      status: "ok",
      message: "자료 저장소가 정상입니다.",
    });
  } catch {
    dbAvailable = false;
    checks.push({
      id: "database",
      label: "자료 저장소",
      status: "critical",
      message: "자료 저장소에 연결하지 못했습니다.",
    });
  }

  if (!dbAvailable) {
    return {
      checkedAt: new Date().toISOString(),
      ok: false,
      fixedCount: 0,
      manualActionCount: 1,
      criticalCount: 1,
      checks,
      notified: false,
    };
  }

  const settings = await ensureAcademySettings(checks);

  if (settings) {
    const missingBasics = [
      !settings.contactPhone && !settings.contactphone ? "대표 전화" : null,
      !settings.address ? "주소" : null,
      !settings.introductionText && !settings.introductiontext ? "학원 소개" : null,
    ].filter(Boolean);

    checks.push({
      id: "site-basic-info",
      label: "사이트 기본 정보",
      status: missingBasics.length === 0 ? "ok" : "warning",
      message: missingBasics.length === 0
        ? "대표 전화, 주소, 학원 소개가 준비되어 있습니다."
        : `${missingBasics.join(", ")} 정보가 비어 있습니다.`,
      actionHref: "/admin/settings",
      actionLabel: "기본 정보 관리",
    });
  }

  await Promise.all([
    checkPublicContent(checks),
    checkSchedule(checks, settings),
    checkApplicationForms(checks, settings),
    checkBackup(checks),
    checkInstagram(checks, settings),
  ]);

  const fixedCount = checks.filter((check) => check.status === "fixed").length;
  const manualActionCount = checks.filter((check) => MANUAL_STATUSES.has(check.status)).length;
  const criticalCount = checks.filter((check) => check.status === "critical").length;
  const notified = await notifyManualActions(checks);

  return {
    checkedAt: new Date().toISOString(),
    ok: manualActionCount === 0,
    fixedCount,
    manualActionCount,
    criticalCount,
    checks,
    notified,
  };
}
