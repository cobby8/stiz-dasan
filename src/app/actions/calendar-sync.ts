"use server";

/**
 * «내 캘린더에 연동» 서버 기능 — 화면(CalendarSyncButton)이 부른다.
 *
 * 원칙
 *  - 권한·로그인 실패는 던지지 않고 결과로 돌려준다(비로그인도 학원 일정은 연동할 수 있다)
 *  - 항목은 화면이 보낸 값을 믿지 않고 서버에서 역할로 다시 거른다
 *  - 주소의 앞부분(사이트 주소)은 요청 헤더가 아니라 고정 상수를 쓴다(헤더를 속여 엉뚱한 주소를 만들지 못하게)
 */
import { getVerifiedParentState, requireStaff } from "@/lib/auth-guard";
import { PUBLIC_SITE_URL } from "@/lib/publicMetadata";
import {
  CALENDAR_KIND_HINTS,
  CALENDAR_KIND_LABELS,
  allowedCalendarKinds,
  filterCalendarKinds,
  hasPersonalKind,
  parseCalendarKinds,
  PERSONAL_KINDS,
  type CalendarKind,
} from "@/lib/calendar/feedEvents";
import {
  countFeedTokens,
  createFeedToken,
  getFeedAccessForUser,
  revokeFeedTokens,
} from "@/lib/calendar/feedServer";

export type CalendarSyncOption = { kind: CalendarKind; label: string; hint: string; personal: boolean };

export type CalendarSyncOptions = {
  /** 고를 수 있는 항목(지금 로그인한 사람의 역할 기준). 비로그인은 학원 일정만 */
  options: CalendarSyncOption[];
  /** 이미 만들어 둔 개인 연동 주소 수(0 이면 «연동 끊기»를 숨긴다) */
  linkCount: number;
};

export type CalendarFeedLinkResult =
  | { ok: true; personal: boolean; httpsUrl: string; webcalUrl: string; googleUrl: string }
  | { ok: false; message: string };

type Viewer = { userId: string | null; allowed: CalendarKind[] };

/**
 * 지금 로그인한 사람과 고를 수 있는 항목.
 * 직원·학부모 문지기를 «있으면 쓰고 없으면 null»로 받는다(둘 다 던지거나 상태로 알려 주므로 여기서 받아 낸다).
 * 그 뒤 userId 기준 판정(캘린더가 받아 갈 때 쓰는 것과 같은 함수)과 **둘 다 통과한 항목만** 연다 —
 * 만들어 준 주소가 실제로는 비어 있거나, 화면 문지기보다 넓게 열리는 일이 없게.
 */
async function resolveViewer(): Promise<Viewer> {
  const staff = await requireStaff().catch(() => null);
  const parentState = await getVerifiedParentState().catch(() => null);
  const parent = parentState?.status === "OK" ? parentState.parent : null;

  const userId = staff?.appUserId ?? parent?.appUserId ?? null;
  if (!userId) return { userId: null, allowed: ["academy"] };

  const access = await getFeedAccessForUser(userId).catch(() => null);
  const allowed = allowedCalendarKinds({
    teacher: Boolean(staff?.roles.teacher) && Boolean(access?.teacher),
    // 직원이면서 학부모인 사람은 두 문지기가 같은 계정을 가리킬 때만 아이 수업을 연다
    parent: Boolean(parent) && parent?.appUserId === userId && Boolean(access?.parent),
  });
  return { userId, allowed };
}

/** 지금 로그인한 사람에게 가능한 항목과, 이미 연동 주소가 있는지 */
export async function getCalendarSyncOptions(): Promise<CalendarSyncOptions> {
  const academyOnly: CalendarSyncOptions = {
    options: [{ kind: "academy", label: CALENDAR_KIND_LABELS.academy, hint: CALENDAR_KIND_HINTS.academy, personal: false }],
    linkCount: 0,
  };
  try {
    const viewer = await resolveViewer();
    const linkCount = viewer.userId ? await countFeedTokens(viewer.userId).catch(() => 0) : 0;
    return {
      options: viewer.allowed.map((kind) => ({
        kind,
        label: CALENDAR_KIND_LABELS[kind],
        hint: CALENDAR_KIND_HINTS[kind],
        personal: PERSONAL_KINDS.includes(kind),
      })),
      linkCount,
    };
  } catch (error) {
    // 확인이 실패해도 학원 일정 연동은 열어 둔다
    console.error("[calendar-sync] 항목 확인 실패:", error instanceof Error ? error.message : "UNKNOWN");
    return academyOnly;
  }
}

function linksFor(httpsUrl: string, personal: boolean): CalendarFeedLinkResult {
  // webcal:// 은 «캘린더 구독» 전용 주소 — 아이폰·맥이 캘린더 앱으로 바로 연다
  const webcalUrl = httpsUrl.replace(/^https:\/\//, "webcal://");
  return {
    ok: true,
    personal,
    httpsUrl,
    webcalUrl,
    googleUrl: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`,
  };
}

/** 고른 항목으로 연동 주소를 만든다. 학원 일정만이면 공개 주소, 개인 항목이 있으면 본인 전용 주소 */
export async function createCalendarFeedLink(kinds: string[]): Promise<CalendarFeedLinkResult> {
  try {
    const viewer = await resolveViewer();
    // 화면이 보낸 값은 믿지 않는다 — 아는 항목만 남기고 역할로 다시 거른다
    const picked = filterCalendarKinds(parseCalendarKinds(kinds), viewer.allowed);
    if (picked.length === 0) return { ok: false, message: "연동할 항목을 하나 이상 골라 주세요." };

    if (!hasPersonalKind(picked)) return linksFor(`${PUBLIC_SITE_URL}/api/calendar/academy`, false);

    if (!viewer.userId) return { ok: false, message: "로그인한 뒤 다시 시도해 주세요." };
    const token = await createFeedToken(viewer.userId, picked);
    if (!token) return { ok: false, message: "지금은 내 일정을 연동할 수 없어요. 잠시 후 다시 시도해 주세요." };
    return linksFor(`${PUBLIC_SITE_URL}/api/calendar/feed/${token}`, true);
  } catch (error) {
    console.error("[calendar-sync] 연동 주소 만들기 실패:", error instanceof Error ? error.message : "UNKNOWN");
    return { ok: false, message: "연동 주소를 만들지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
}

/** «연동 끊기» — 내 개인 연동 주소를 모두 지운다(이미 넣어 둔 캘린더는 더 이상 새로 받아 오지 못한다) */
export async function revokeCalendarFeedLinks(): Promise<{ ok: boolean; removed: number; message?: string }> {
  try {
    const viewer = await resolveViewer();
    if (!viewer.userId) return { ok: false, removed: 0, message: "로그인한 뒤 다시 시도해 주세요." };
    const removed = await revokeFeedTokens(viewer.userId);
    return { ok: true, removed };
  } catch (error) {
    console.error("[calendar-sync] 연동 끊기 실패:", error instanceof Error ? error.message : "UNKNOWN");
    return { ok: false, removed: 0, message: "연동을 끊지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
}
