"use client";

import { FormEvent, type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import CompactListFilters from "@/components/academy/CompactListFilters";
import SeasonalHeader from "./SeasonalHeader";
import { createCsv, createSafeCsvFilename, maskPhoneNumber } from "@/lib/seasonal/roster-export";
import { seoulDateTimeToIso } from "./seasonalDateTime";
import { kstLabel } from "@/lib/datetime/kst";

type SeasonStatus = "DRAFT" | "PUBLISHED" | "CLOSED" | "ARCHIVED";
type ItemStatus = "PENDING" | "APPROVED" | "WAITLISTED" | "REJECTED" | "CANCELLED";
type ApplicationCloseStatus = "REJECTED" | "CANCELLED";

type SeasonalClass = {
  id: string;
  name: string;
  branch?: string | null;
  targetGrade?: string | null;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  instructorName?: string | null;
  instructorId?: string | null;
  capacity: number;
  confirmedCount?: number;
  waitlistCount?: number;
  price: number;
  code?: string | null;
  targetGrades?: string | null;
  location?: string | null;
  newApplicantPrice?: number | null;
  existingApplicantPrice?: number | null;
  shuttleAvailable?: boolean;
  shuttleFee?: number | null;
  status?: "DRAFT" | "OPEN" | "CLOSED" | "CANCELLED";
  linkedProgramId?: string | null;
  linkedClassId?: string | null;
  sessionDates?: Array<{
    id?: string;
    startsAt: string;
    endsAt: string;
    location?: string | null;
    note?: string | null;
    session?: { coachId?: string | null } | null;
  }>;
  operationalStats?: {
    confirmedTotal?: number;
    heldTotal?: number;
    waitlistedTotal?: number;
    weekdays?: Record<string, { confirmed?: number; held?: number; waitlisted?: number }>;
  };
};

type ShuttleRequest = {
  id?: string | null;
  pickupLocation?: string | null;
  pickupAddress?: string | null;
  pickupRoadAddress?: string | null;
  pickupLatitude?: number | string | null;
  pickupLongitude?: number | string | null;
  pickupPlaceId?: string | null;
  pickupLocationSource?: string | null;
  pickupAccuracyMeters?: number | string | null;
  pickupConfirmedAt?: string | null;
  pickupTime?: string | null;
  dropoffLocation?: string | null;
  dropoffAddress?: string | null;
  dropoffRoadAddress?: string | null;
  dropoffLatitude?: number | string | null;
  dropoffLongitude?: number | string | null;
  dropoffPlaceId?: string | null;
  dropoffLocationSource?: string | null;
  dropoffAccuracyMeters?: number | string | null;
  dropoffConfirmedAt?: string | null;
  locationConsentVersion?: string | null;
  note?: string | null;
  status?: string | null;
  assignedRouteId?: string | null;
  assignedStopId?: string | null;
};

type InvoiceInfo = {
  id: string;
  paymentId: string;
  invoiceNo?: string | null;
  status?: string | null;
  amount?: number | null;
  dueDate?: string | null;
  checkoutUrl?: string | null;
  accountActivationRequired?: boolean;
  notificationSummary?: NotificationSummary | null;
};

type NotificationSummary = {
  trigger: string;
  status: "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED" | "UNKNOWN";
  attemptCount: number;
  updatedAt: string;
  errorCode: string | null;
  canRetry: boolean;
};

type NotificationMutationResponse = {
  notification?: Pick<NotificationSummary, "status" | "errorCode"> | null;
  notificationWarning?: boolean;
};

type Season = {
  id: string;
  name: string;
  slug?: string | null;
  status: SeasonStatus;
  enrollmentStartsAt?: string | null;
  enrollmentEndsAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  branch?: string | null;
  classes: SeasonalClass[];
};

type ApplicationItem = {
  id: string;
  classId: string;
  className: string;
  scheduleLabel?: string | null;
  status: ItemStatus;
  amount?: number;
  /** 할인 전 수강료 */
  tuitionPriceSnapshot?: number | null;
  /** 형제할인 금액(양수로 저장된다) */
  siblingDiscountSnapshot?: number | null;
  discountReasonSnapshot?: string | null;
  shuttleFeeSnapshot?: number | null;
  waitlistOrder?: number | null;
  linkedProgramId?: string | null;
  linkedClassId?: string | null;
  enrollmentId?: string | null;
  paymentId?: string | null;
  invoice?: InvoiceInfo | null;
  shuttleRequest?: ShuttleRequest | null;
  notificationSummary?: NotificationSummary | null;
};

type Application = {
  id: string;
  seasonId: string;
  childName: string;
  childBirthDate?: string | null;
  childGender?: string | null;
  childGrade?: string | null;
  childSchool?: string | null;
  childPhone?: string | null;
  parentName: string;
  parentPhone: string;
  parentRelation?: string | null;
  address?: string | null;
  status: string;
  createdAt: string;
  processedNote?: string | null;
  shuttleNeeded?: boolean;
  shuttleStatus?: string | null;
  paymentStatus?: string | null;
  totalAmount?: number;
  memo?: string | null;
  applicantType?: "NEW" | "EXISTING" | string | null;
  selectedWeekdays?: string[];
  importSource?: string | null;
  imported?: boolean;
  reviewReasons?: string[];
  notificationSummary?: NotificationSummary | null;
  items: ApplicationItem[];
};

type ShuttlePointKind = "pickup" | "dropoff";

type Payload = {
  seasons: Season[];
  applications: Application[];
  stats?: { pending?: number; confirmed?: number; unpaid?: number; waitlisted?: number; shuttleUnassigned?: number };
  applicationsPagination?: ApplicationsPagination;
};

type ApplicationsPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore?: boolean;
};

type SeasonalAdminClientProps = {
  initialData?: Record<string, unknown>;
};

type BulkItemResult = {
  itemId: string;
  ok: boolean;
  status?: string;
  applicationId?: string;
  message?: string;
  code?: string;
  notification?: { status: NotificationSummary["status"]; errorCode?: string | null } | null;
  notificationWarning?: boolean;
};

type BulkItemResponse = {
  success?: boolean;
  summary?: { total?: number; succeeded?: number; failed?: number; notificationsFailed?: number };
  results?: BulkItemResult[];
  error?: string;
};

type RosterRow = {
  id: string;
  applicationId: string;
  itemId: string;
  seasonId: string;
  seasonName: string;
  offeringId: string;
  offeringName: string;
  weekday: string;
  scheduleLabel: string;
  childName: string;
  childGrade: string;
  childSchool: string;
  parentName: string;
  parentPhone: string;
  paymentStatus: string;
  shuttleStatus: string;
};

type RosterPayload = {
  rows: RosterRow[];
  stats: { confirmed: number; unpaid: number; shuttle: number };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type RosterFilters = {
  seasonId: string;
  offeringId: string;
  weekday: string;
  date: string;
  paymentStatus: string;
  shuttleStatus: string;
  q: string;
  page: number;
};

type CoachOption = {
  id: string;
  name: string;
};

type OperationalSlot = {
  key: string;
  weekdayKey: string;
  label: string;
  startTime: string;
  endTime: string;
  location: string;
  dateCount: number;
  instructorId: string;
  instructorName: string;
  mixedInstructor: boolean;
  confirmed: number;
  held: number;
  waitlisted: number;
};

type OperationalClassGroup = {
  key: string;
  name: string;
  baseClass: SeasonalClass;
  offerings: SeasonalClass[];
  slots: OperationalSlot[];
  pricingRules: Array<{ key: string; label: string; price: number; newPrice?: number | null; existingPrice?: number | null; shuttleFee?: number | null }>;
  capacity: number;
  confirmedTotal: number;
  heldTotal: number;
  waitlistedTotal: number;
};

type ApplicationsMode = "applications" | "roster";

type Tab = "overview" | "seasons" | "applications";

type AssignmentInput = {
  applicationId: string;
  itemId?: string;
  offeringId: string;
  selectedWeekdays: string[];
  priceSnapshot: number;
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "작성 중", PUBLISHED: "모집 중", OPEN: "모집 중", CLOSED: "모집 마감", ARCHIVED: "보관",
  PENDING: "승인 대기", APPROVED: "승인", PAYMENT_PENDING: "결제 대기", CONFIRMED: "최종 확정", WAITLISTED: "대기", REJECTED: "반려", CANCELLED: "취소",
  PAID: "결제 완료", UNPAID: "미결제", REQUESTED: "요청", ASSIGNED: "배정 완료", UNASSIGNED: "미배정",
};

const NOTIFICATION_ERROR_LABEL: Record<string, string> = {
  FAILED_DELIVERY_UNCERTAIN: "수신 여부 불확실 — 솔라피 발송 이력을 확인해주세요.",
  TEMPLATE_DISABLED_OR_MISSING: "문자 템플릿이 비활성화되어 있습니다. 솔라피 설정을 확인해주세요.",
  INVALID_RECIPIENT: "수신 번호가 올바르지 않습니다.",
  INSUFFICIENT_BALANCE: "솔라피 계정 잔액이 부족합니다.",
  BLOCKED_NUMBER: "수신 거부 번호입니다.",
};

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: "overview", label: "운영 현황", icon: "dashboard" },
  { key: "seasons", label: "시즌·반", icon: "calendar_month" },
  { key: "applications", label: "신청 관리", icon: "assignment_ind" },
];

const BULK_ITEM_STATUSES: ItemStatus[] = ["APPROVED", "WAITLISTED", "REJECTED", "CANCELLED"];
const APPLICATION_CLOSE_STATUSES: ApplicationCloseStatus[] = ["REJECTED", "CANCELLED"];
const WEEKDAY_OPTIONS = [
  { value: "MON", label: "월" },
  { value: "TUE", label: "화" },
  { value: "WED", label: "수" },
  { value: "THU", label: "목" },
  { value: "FRI", label: "금" },
  { value: "SAT", label: "토" },
  { value: "SUN", label: "일" },
] as const;

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`} aria-hidden="true">{name}</span>;
}

function formatDate(value?: string | null) {
  if (!value) return "미정";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(date);
}

function formatDateTime(value?: string | null) {
  if (!value) return "미정";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function todayDateInputValue() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getItemInvoiceHref(item: Pick<ApplicationItem, "invoice">) {
  if (item.invoice?.accountActivationRequired) return null;
  if (item.invoice?.checkoutUrl) return item.invoice.checkoutUrl;
  if (!item.invoice?.id) return null;
  return `/payments/${encodeURIComponent(item.invoice.id)}`;
}

function toAbsoluteHref(href: string) {
  if (/^https?:\/\//i.test(href)) return href;
  const normalizedHref = href.startsWith("/") ? href : `/${href}`;
  return `${window.location.origin}${normalizedHref}`;
}

function badge(status?: string | null) {
  const tone = status === "CONFIRMED" || status === "PAID" || status === "OPEN" || status === "ASSIGNED"
      || status === "APPROVED" || status === "PUBLISHED" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
    : status === "WAITLISTED" || status === "PAYMENT_PENDING" || status === "UNPAID" || status === "UNASSIGNED"
      ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      : status === "REJECTED" || status === "CANCELLED"
        ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
        : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200";
  return `inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-bold ${tone}`;
}

function stringList(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (typeof value === "string" && value.trim()) return value.split(/[,/]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function weekdayLabel(value: string) {
  return WEEKDAY_OPTIONS.find((option) => option.value === value || option.label === value)?.label ?? value;
}

function weekdayKey(value: string) {
  return WEEKDAY_OPTIONS.find((option) => option.value === value || option.label === value)?.value ?? null;
}

function normalizeWeekdayKeys(values?: string[] | null) {
  const keys: string[] = [];
  for (const value of values ?? []) {
    const key = weekdayKey(value);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function assignmentPriceFor(application: Application, offering?: SeasonalClass) {
  if (!offering) return 0;
  if (application.applicantType === "EXISTING" && offering.existingApplicantPrice !== null && offering.existingApplicantPrice !== undefined) {
    return offering.existingApplicantPrice;
  }
  if (application.applicantType === "NEW" && offering.newApplicantPrice !== null && offering.newApplicantPrice !== undefined) {
    return offering.newApplicantPrice;
  }
  return offering.price ?? 0;
}

function seasonalOfferingFrequency(offering?: Pick<SeasonalClass, "name" | "code"> | null) {
  if (!offering) return null;
  const matched = `${offering.name ?? ""} ${offering.code ?? ""}`.match(/주\s*(\d+)\s*회|-(\d)(?:\D|$)/i);
  const value = matched ? Number(matched[1] ?? matched[2]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function operationalClassKey(offering: SeasonalClass) {
  return offering.linkedClassId || offering.id;
}

function operationalGroupKey(offering: SeasonalClass) {
  return offering.linkedClassId ? `class:${offering.linkedClassId}` : `name:${compactOperationalClassName(offering.name)}`;
}

function compactOperationalClassName(name: string) {
  return name.replace(/\s*주\s*\d+\s*회.*$/u, "").trim() || name;
}

function operationalOfferingOptions(offerings: SeasonalClass[]) {
  const seen = new Set<string>();
  return offerings.filter((offering) => {
    const key = operationalClassKey(offering);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((offering) => ({ ...offering, name: compactOperationalClassName(offering.name) }));
}

function matchingOfferingForWeekdays(offerings: SeasonalClass[], baseOffering: SeasonalClass | undefined, selectedWeekdays: string[]) {
  if (!baseOffering || selectedWeekdays.length === 0) return baseOffering;
  const key = operationalClassKey(baseOffering);
  return offerings.find((offering) => operationalClassKey(offering) === key && seasonalOfferingFrequency(offering) === selectedWeekdays.length)
    ?? baseOffering;
}

function seoulWeekdayKey(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(date);
  return ({ Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT", Sun: "SUN" } as Record<string, string>)[short] ?? null;
}

function seoulTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function firstNumber(...values: Array<number | null | undefined>) {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value)) ?? 0;
}

function coachNameById(coaches: CoachOption[], coachId?: string | null) {
  return coaches.find((coach) => coach.id === coachId)?.name ?? "";
}

function groupOperationalClasses(offerings: SeasonalClass[], coaches: CoachOption[]): OperationalClassGroup[] {
  const groups = new Map<string, SeasonalClass[]>();
  for (const offering of offerings) {
    const key = operationalGroupKey(offering);
    groups.set(key, [...(groups.get(key) ?? []), offering]);
  }

  return Array.from(groups.entries()).map(([key, groupOfferings]) => {
    const sortedOfferings = [...groupOfferings].sort((left, right) => {
      const leftFrequency = seasonalOfferingFrequency(left) ?? 99;
      const rightFrequency = seasonalOfferingFrequency(right) ?? 99;
      return leftFrequency - rightFrequency || left.name.localeCompare(right.name);
    });
    const baseClass = sortedOfferings[0]!;
    const slotMap = new Map<string, {
      weekdayKey: string;
      startTime: string;
      endTime: string;
      location: string;
      dateKeys: Set<string>;
      sessionCoachIdsByDate: Map<string, Set<string>>;
      fallbackCoachIdsByDate: Map<string, Set<string>>;
    }>();
    const stats = baseClass.operationalStats ?? {};
    for (const offering of sortedOfferings) {
      for (const sessionDate of offering.sessionDates ?? []) {
        const weekdayKey = seoulWeekdayKey(sessionDate.startsAt);
        if (!weekdayKey) continue;
        const startTime = seoulTime(sessionDate.startsAt) || offering.startTime;
        const endTime = seoulTime(sessionDate.endsAt) || offering.endTime;
        const slotKey = `${weekdayKey}:${startTime}:${endTime}`;
        const current = slotMap.get(slotKey) ?? {
          weekdayKey,
          startTime,
          endTime,
          location: sessionDate.location || offering.location || "",
          dateKeys: new Set<string>(),
          sessionCoachIdsByDate: new Map<string, Set<string>>(),
          fallbackCoachIdsByDate: new Map<string, Set<string>>(),
        };
        const dateKey = `${sessionDate.startsAt}:${sessionDate.endsAt}`;
        current.dateKeys.add(dateKey);
        const sessionCoachId = sessionDate.session?.coachId || "";
        const fallbackCoachId = offering.instructorId || "";
        if (sessionCoachId) {
          const sessionCoachIds = current.sessionCoachIdsByDate.get(dateKey) ?? new Set<string>();
          sessionCoachIds.add(sessionCoachId);
          current.sessionCoachIdsByDate.set(dateKey, sessionCoachIds);
        } else if (fallbackCoachId) {
          const fallbackCoachIds = current.fallbackCoachIdsByDate.get(dateKey) ?? new Set<string>();
          fallbackCoachIds.add(fallbackCoachId);
          current.fallbackCoachIdsByDate.set(dateKey, fallbackCoachIds);
        }
        if (!current.location) current.location = sessionDate.location || offering.location || "";
        slotMap.set(slotKey, current);
      }
    }

    const slots = Array.from(slotMap.entries()).map(([slotKey, slot]) => {
      const instructorIdSet = new Set<string>();
      for (const dateKey of slot.dateKeys) {
        const sessionCoachIds = slot.sessionCoachIdsByDate.get(dateKey);
        const fallbackCoachIds = slot.fallbackCoachIdsByDate.get(dateKey);
        for (const coachId of sessionCoachIds?.size ? sessionCoachIds : fallbackCoachIds ?? []) instructorIdSet.add(coachId);
      }
      const instructorIds = Array.from(instructorIdSet);
      const instructorId = instructorIds.length === 1 ? instructorIds[0] : "";
      const weekdayStats = stats.weekdays?.[slot.weekdayKey] ?? {};
      return {
        key: slotKey,
        weekdayKey: slot.weekdayKey,
        label: weekdayLabel(slot.weekdayKey),
        startTime: slot.startTime,
        endTime: slot.endTime,
        location: slot.location,
        dateCount: slot.dateKeys.size,
        instructorId,
        instructorName: instructorId ? coachNameById(coaches, instructorId) || "담당 선생님" : instructorIds.length > 1 ? "혼합 배정" : "미배정",
        mixedInstructor: instructorIds.length > 1,
        confirmed: firstNumber(weekdayStats.confirmed),
        held: firstNumber(weekdayStats.held),
        waitlisted: firstNumber(weekdayStats.waitlisted),
      } satisfies OperationalSlot;
    }).sort((left, right) => {
      const leftIndex = WEEKDAY_OPTIONS.findIndex((option) => option.value === left.weekdayKey);
      const rightIndex = WEEKDAY_OPTIONS.findIndex((option) => option.value === right.weekdayKey);
      return leftIndex - rightIndex || left.startTime.localeCompare(right.startTime);
    });

    const pricingRules = sortedOfferings.map((offering) => {
      const frequency = seasonalOfferingFrequency(offering);
      return {
        key: offering.id,
        label: frequency ? `주 ${frequency}회` : compactOperationalClassName(offering.name),
        price: offering.price,
        newPrice: offering.newApplicantPrice,
        existingPrice: offering.existingApplicantPrice,
        shuttleFee: offering.shuttleFee,
      };
    });

    return {
      key,
      name: compactOperationalClassName(baseClass.name),
      baseClass,
      offerings: sortedOfferings,
      slots,
      pricingRules,
      capacity: baseClass.capacity,
      confirmedTotal: firstNumber(stats.confirmedTotal, sortedOfferings.reduce((sum, offering) => sum + (offering.confirmedCount ?? 0), 0)),
      heldTotal: firstNumber(stats.heldTotal),
      waitlistedTotal: firstNumber(stats.waitlistedTotal, sortedOfferings.reduce((sum, offering) => sum + (offering.waitlistCount ?? 0), 0)),
    } satisfies OperationalClassGroup;
  });
}

function recordValue(record: Record<string, unknown>, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return fallback;
}

function normalizeRosterPayload(body: Record<string, unknown>): RosterPayload {
  const source = body.roster && typeof body.roster === "object" ? body.roster as Record<string, unknown> : body;
  const rawRows = Array.isArray(source.rows) ? source.rows : Array.isArray(source.items) ? source.items : [];
  const rows = rawRows.map((value, index) => {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      id: recordValue(row, ["id", "itemId", "applicationItemId"], `roster-${index}`),
      applicationId: recordValue(row, ["applicationId"]),
      itemId: recordValue(row, ["itemId", "applicationItemId", "id"]),
      seasonId: recordValue(row, ["seasonId"]),
      seasonName: recordValue(row, ["seasonName", "seasonTitle"], "시즌"),
      offeringId: recordValue(row, ["offeringId", "classId"]),
      offeringName: recordValue(row, ["offeringName", "offeringTitle", "className"], "특강 반"),
      weekday: recordValue(row, ["weekday", "dayOfWeek"]),
      scheduleLabel: recordValue(row, ["scheduleLabel", "schedule"]),
      childName: recordValue(row, ["childName", "studentName"], "학생 미확인"),
      childGrade: recordValue(row, ["childGrade", "grade"]),
      childSchool: recordValue(row, ["childSchool", "school"]),
      parentName: recordValue(row, ["parentName", "guardianName"]),
      parentPhone: recordValue(row, ["parentPhone", "guardianPhone"]),
      paymentStatus: recordValue(row, ["paymentStatus"], "UNPAID"),
      shuttleStatus: recordValue(row, ["shuttleStatus"], "NOT_USED"),
    } satisfies RosterRow;
  });
  const rawStats = source.stats && typeof source.stats === "object" ? source.stats as Record<string, unknown> : {};
  const rawPagination = source.pagination && typeof source.pagination === "object" ? source.pagination as Record<string, unknown> : {};
  const numberValue = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const pageSize = numberValue(rawPagination.pageSize, Math.max(rows.length, 50));
  const total = numberValue(rawPagination.total, rows.length);
  return {
    rows,
    stats: {
      confirmed: numberValue(rawStats.confirmed ?? rawStats.confirmedSeats, rows.length),
      unpaid: numberValue(rawStats.unpaid, rows.filter((row) => row.paymentStatus !== "PAID").length),
      shuttle: numberValue(rawStats.shuttle ?? rawStats.shuttleRequested, rows.filter((row) => row.shuttleStatus !== "NOT_USED" && row.shuttleStatus !== "NONE").length),
    },
    pagination: {
      page: numberValue(rawPagination.page, 1),
      pageSize,
      total,
      totalPages: numberValue(rawPagination.totalPages, Math.max(1, Math.ceil(total / pageSize))),
    },
  };
}

function maskRosterName(value: string) {
  if (!value) return "미입력";
  if (value.length === 1) return `${value}○`;
  return `${value[0]}${"○".repeat(Math.max(1, value.length - 1))}`;
}

function maskRosterPhone(value: string) {
  return maskPhoneNumber(value) || "미입력";
}

function applicantTypeLabel(value?: string | null) {
  if (value === "NEW") return "신규";
  if (value === "EXISTING") return "기존";
  return value || "구분 미확인";
}

// 수업 반 이름("초등 고학년 주 2회")을 [반 이름, 횟수]로 나눈다. 방학특강은 횟수(주N회)별로 반이 나뉜다.
function parseClassParts(name: string): { base: string; freq: string | null } {
  const raw = name || "";
  const m = raw.match(/주\s*(\d+)\s*회/);
  const freq = m ? `주${m[1]}회` : null;
  const base = raw.replace(/주\s*\d+\s*회/g, "").replace(/\s{2,}/g, " ").trim() || raw;
  return { base, freq };
}
// 한 신청의 반 이름·횟수 목록(중복 제거). 신청이 여러 반이면 각각 표시/필터에 쓴다.
function applicationClassInfo(items: { className: string }[]): { bases: string[]; freqs: string[] } {
  const bases = new Set<string>(); const freqs = new Set<string>();
  for (const it of items) { const p = parseClassParts(it.className); if (p.base) bases.add(p.base); if (p.freq) freqs.add(p.freq); }
  return { bases: [...bases], freqs: [...freqs] };
}
// 결제 상태를 3버킷으로: 청구전(청구서 없음)·미납(PENDING/OVERDUE 등)·결제완료(PAID).
function paymentBucket(status?: string | null): "청구전" | "미납" | "결제완료" {
  const s = (status ?? "").toUpperCase();
  if (!s) return "청구전";
  if (s.includes("PAID") || s.includes("완료")) return "결제완료";
  return "미납";
}
function shuttleBucket(needed?: boolean): "이용" | "미이용" { return needed ? "이용" : "미이용"; }

// 구글시트식 열 헤더 — 제목 + 필터/정렬 아이콘. 클릭하면 팝오버(정렬 버튼 + 값 체크박스)가 뜬다.
// excluded 모델: 체크 해제한 값만 selected(=excluded)에 담는다. 비어 있으면 전체 표시.
function ColHeader({
  title, open, onToggleOpen, active,
  sortDir, onSort,
  options, excluded, onToggleValue, onAll, onNone, alignRight,
}: {
  title: string; open: boolean; onToggleOpen: () => void; active: boolean;
  sortDir?: "asc" | "desc" | null; onSort?: (dir: "asc" | "desc") => void;
  options?: string[]; excluded?: Set<string>;
  onToggleValue?: (v: string) => void; onAll?: () => void; onNone?: () => void; alignRight?: boolean;
}) {
  return (
    <div className="relative inline-flex items-center gap-1">
      <span className="font-bold">{title}</span>
      {sortDir && <span className="text-[10px] text-[var(--brand-accent)]">{sortDir === "asc" ? "▲" : "▼"}</span>}
      <button type="button" aria-label={`${title} 필터`} onClick={onToggleOpen}
        className={`grid h-5 w-5 place-items-center rounded ${active ? "bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]" : "text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}>
        <span className="material-symbols-outlined text-[16px]">filter_list</span>
      </button>
      {open && (
        <>
          <button type="button" aria-hidden className="fixed inset-0 z-40 cursor-default" onClick={onToggleOpen} />
          <div className={`absolute top-full z-50 mt-1 w-52 rounded-xl border border-gray-200 bg-white p-2 text-gray-700 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 ${alignRight ? "right-0" : "left-0"}`} onClick={(e) => e.stopPropagation()}>
            {onSort && (
              <div className="mb-1 flex gap-1">
                <button type="button" onClick={() => onSort("asc")} className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] font-bold ${sortDir === "asc" ? "bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]" : "hover:bg-gray-100 dark:hover:bg-gray-800"}`}>▲ 오름차순</button>
                <button type="button" onClick={() => onSort("desc")} className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] font-bold ${sortDir === "desc" ? "bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]" : "hover:bg-gray-100 dark:hover:bg-gray-800"}`}>▼ 내림차순</button>
              </div>
            )}
            {options && excluded && (
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] font-bold text-gray-400">
                  <button type="button" onClick={onAll} className="hover:text-[var(--brand-accent)]">모두 선택</button>
                  <button type="button" onClick={onNone} className="hover:text-[var(--brand-accent)]">모두 해제</button>
                </div>
                <div className="max-h-56 space-y-0.5 overflow-auto">
                  {options.length === 0 && <p className="px-1 py-2 text-[12px] text-gray-400">값 없음</p>}
                  {options.map((o) => (
                    <label key={o} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-[12.5px] font-semibold hover:bg-gray-50 dark:hover:bg-gray-800">
                      <input type="checkbox" checked={!excluded.has(o)} onChange={() => onToggleValue?.(o)} className="h-4 w-4 rounded border-gray-300 accent-[var(--brand-accent)]" />
                      {o}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function paymentReviewLabel(value?: string | null) {
  if (!value || value === "PAYMENT_PENDING" || value === "UNPAID") return "결제 확인 전";
  return STATUS_LABEL[value] ?? value;
}

function normalizeSeasons(body: Record<string, unknown>): Season[] {
  return ((body.seasons ?? []) as Array<Record<string, unknown>>).map((season) => ({
    ...season,
    name: season.name ?? season.title ?? "이름 없는 시즌",
    enrollmentStartsAt: season.enrollmentStartsAt ?? season.applicationOpensAt,
    enrollmentEndsAt: season.enrollmentEndsAt ?? season.applicationClosesAt,
    classes: ((season.classes ?? season.offerings ?? []) as Array<Record<string, unknown>>).map((offering) => {
      const firstDate = (offering.sessionDates as Array<Record<string, unknown>> | undefined)?.[0];
      const startsAt = typeof firstDate?.startsAt === "string" ? new Date(firstDate.startsAt) : null;
      const endsAt = typeof firstDate?.endsAt === "string" ? new Date(firstDate.endsAt) : null;
      return {
        ...offering,
        name: offering.name ?? offering.title ?? "Untitled class",
        targetGrade: offering.targetGrade ?? offering.targetGrades,
        dayOfWeek: offering.dayOfWeek ?? (startsAt ? new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(startsAt) : "Schedule TBD"),
        startTime: offering.startTime ?? (startsAt ? startsAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : ""),
        endTime: offering.endTime ?? (endsAt ? endsAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : ""),
        confirmedCount: offering.confirmedCount ?? offering.approvedCount ?? 0,
      } as SeasonalClass;
    }),
  })) as Season[];
}

function normalizeApplications(body: Record<string, unknown>): Application[] {
  return ((body.applications ?? []) as Array<Record<string, unknown>>).map((application) => {
    const items = ((application.items ?? []) as Array<Record<string, unknown>>).map((item) => {
      const offering = item.offering as Record<string, unknown> | undefined;
      return {
        ...item,
        classId: item.classId ?? item.offeringId,
        className: item.className ?? item.titleSnapshot ?? offering?.title ?? "Untitled class",
        amount: item.amount ?? item.priceSnapshot,
        waitlistOrder: item.waitlistOrder ?? null,
        linkedProgramId: item.linkedProgramId ?? offering?.linkedProgramId ?? null,
        linkedClassId: item.linkedClassId ?? offering?.linkedClassId ?? null,
        enrollmentId: item.enrollmentId ?? null,
        paymentId: item.paymentId ?? null,
        invoice: (item.invoice ?? null) as InvoiceInfo | null,
        shuttleRequest: (item.shuttleRequest ?? null) as ShuttleRequest | null,
      } as ApplicationItem;
    });
    const shuttleRequests = [
      ...(((application.shuttleRequests as unknown[] | undefined) ?? []) as ShuttleRequest[]),
      ...items.map((item) => item.shuttleRequest).filter(Boolean) as ShuttleRequest[],
    ];
    const firstShuttle = shuttleRequests[0];
    const applicantType = application.applicantType ?? application.memberType ?? application.customerType;
    const selectedWeekdays = stringList(application.selectedWeekdays ?? application.weekdays ?? application.selectedDays);
    const importSource = application.importSource ?? application.sourceLabel ?? application.source;
    const reviewReasons = stringList(application.reviewReasons ?? application.needsReviewReasons ?? application.reviewReason);
    return {
      ...application,
      totalAmount: application.totalAmount ?? application.totalPriceSnapshot,
      shuttleNeeded: application.shuttleNeeded !== undefined ? Boolean(application.shuttleNeeded) : shuttleRequests.length > 0,
      shuttleStatus: application.shuttleStatus ?? firstShuttle?.status ?? null,
      applicantType: typeof applicantType === "string" ? applicantType : null,
      selectedWeekdays,
      importSource: typeof importSource === "string" ? importSource : null,
      imported: Boolean(application.imported ?? application.isImported ?? importSource),
      reviewReasons,
      items,
    } as Application;
  });
}

function normalizePayload(body: Record<string, unknown>, includeApplications: boolean, currentApplications: Application[] = []): Payload {
  return {
    seasons: normalizeSeasons(body),
    applications: includeApplications ? normalizeApplications(body) : currentApplications,
    stats: body.stats as Payload["stats"],
  };
}

function normalizeInitialPayload(initialData?: Record<string, unknown>): Payload {
  if (!initialData) return { seasons: [], applications: [] };
  return normalizePayload(initialData, false);
}

export default function SeasonalAdminClient({ initialData }: SeasonalAdminClientProps) {
  const [tab, setTab] = useState<Tab>("seasons");
  const [data, setData] = useState<Payload>(() => normalizeInitialPayload(initialData));
  const [selectedSeasonId, setSelectedSeasonId] = useState(() => normalizeInitialPayload(initialData).seasons[0]?.id ?? "");
  const [selectedApplication, setSelectedApplication] = useState<Application | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  // 신청 관리 상단 탭: 진행 중(취소 제외) / 취소자(완전 취소만). 취소자를 본 목록에서 분리해 관리 편의를 높인다.
  const [appTab, setAppTab] = useState<"active" | "cancelled">("active");
  // 서버로 보낼 실제 상태값: 취소자 탭이면 CANCELLED_ONLY, 진행 탭이면 드롭다운(전체=ACTIVE로 취소 제외).
  const effectiveStatus = appTab === "cancelled" ? "CANCELLED_ONLY" : (statusFilter === "ALL" ? "ACTIVE" : statusFilter);
  const [applicationsPagination, setApplicationsPagination] = useState<ApplicationsPagination>({
    page: 1,
    pageSize: 30,
    total: 0,
    totalPages: 1,
    hasMore: false,
  });
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"season" | "class" | null>(null);
  const [editingSeason, setEditingSeason] = useState<Season | null>(null);
  const [editingClass, setEditingClass] = useState<SeasonalClass | null>(null);
  const [convertingItemId, setConvertingItemId] = useState("");
  const updatingItemIdsRef = useRef(new Set<string>());
  const requestedInitialLoad = useRef(false);
  const applicationsQueryKeyRef = useRef("");
  const [updatingItemIds, setUpdatingItemIds] = useState<Set<string>>(() => new Set());
  const [itemUpdateErrors, setItemUpdateErrors] = useState<Record<string, string>>({});
  const [assigningKey, setAssigningKey] = useState("");
  const [updatingApplicationStatus, setUpdatingApplicationStatus] = useState("");
  const [sendingNotificationKey, setSendingNotificationKey] = useState("");
  const [resolvingReview, setResolvingReview] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [bulkProcessingStatus, setBulkProcessingStatus] = useState<ItemStatus | "">("");
  const [bulkConverting, setBulkConverting] = useState(false);
  const [applicationsMode, setApplicationsMode] = useState<ApplicationsMode>("applications");
  const [applicationsLoaded, setApplicationsLoaded] = useState(false);
  const [roster, setRoster] = useState<RosterPayload>({ rows: [], stats: { confirmed: 0, unpaid: 0, shuttle: 0 }, pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 } });
  const [rosterFilters, setRosterFilters] = useState<RosterFilters>({ seasonId: "", offeringId: "", weekday: "", date: "", paymentStatus: "", shuttleStatus: "", q: "", page: 1 });
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState("");
  const [coachOptions, setCoachOptions] = useState<CoachOption[]>([]);
  const [assigningInstructorClassId, setAssigningInstructorClassId] = useState("");

  useEffect(() => {
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab && TABS.some((item) => item.key === requestedTab)) setTab(requestedTab as Tab);
  }, []);

  const load = useCallback(async (options?: { includeApplications?: boolean; page?: number; search?: string; status?: string }) => {
    const includeApplications = options?.includeApplications === true;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams();
      let applicationsQueryKey = "";
      if (includeApplications) {
        const requestedPage = options?.page ?? applicationsPagination.page;
        const nextSearch = options?.search ?? search;
        const nextStatus = options?.status ?? effectiveStatus;
        applicationsQueryKey = `${requestedPage}|${nextSearch.trim()}|${nextStatus}`;
        params.set("includeApplications", "true");
        params.set("page", String(requestedPage));
        params.set("pageSize", String(applicationsPagination.pageSize));
        if (nextSearch.trim()) params.set("q", nextSearch.trim());
        if (nextStatus !== "ALL") params.set("status", nextStatus);
      }
      const query = params.toString();
      const response = await fetch(`/api/admin/seasonal${query ? `?${query}` : ""}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "방학특강 정보를 불러오지 못했습니다.");
      const seasons: Season[] = (body.seasons ?? []).map((season: Record<string, unknown>) => ({
        ...season,
        name: season.name ?? season.title ?? "이름 없는 시즌",
        enrollmentStartsAt: season.enrollmentStartsAt ?? season.applicationOpensAt,
        enrollmentEndsAt: season.enrollmentEndsAt ?? season.applicationClosesAt,
        classes: ((season.classes ?? season.offerings ?? []) as Array<Record<string, unknown>>).map((offering) => {
          const firstDate = (offering.sessionDates as Array<Record<string, unknown>> | undefined)?.[0];
          const startsAt = typeof firstDate?.startsAt === "string" ? new Date(firstDate.startsAt) : null;
          const endsAt = typeof firstDate?.endsAt === "string" ? new Date(firstDate.endsAt) : null;
          return {
            ...offering,
            name: offering.name ?? offering.title ?? "이름 없는 반",
            targetGrade: offering.targetGrade ?? offering.targetGrades,
            dayOfWeek: offering.dayOfWeek ?? (startsAt ? new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(startsAt) : "일정 미정"),
            startTime: offering.startTime ?? (startsAt ? startsAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : ""),
            endTime: offering.endTime ?? (endsAt ? endsAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : ""),
            confirmedCount: offering.confirmedCount ?? offering.approvedCount ?? 0,
          } as SeasonalClass;
        }),
      })) as Season[];
      const applications: Application[] = includeApplications ? (body.applications ?? []).map((application: Record<string, unknown>) => {
        const items = ((application.items ?? []) as Array<Record<string, unknown>>).map((item) => {
          const offering = item.offering as Record<string, unknown> | undefined;
          return {
            ...item,
            classId: item.classId ?? item.offeringId,
            className: item.className ?? item.titleSnapshot ?? offering?.title ?? "특강 반",
            amount: item.amount ?? item.priceSnapshot,
            waitlistOrder: item.waitlistOrder ?? null,
            linkedProgramId: item.linkedProgramId ?? offering?.linkedProgramId ?? null,
            linkedClassId: item.linkedClassId ?? offering?.linkedClassId ?? null,
            enrollmentId: item.enrollmentId ?? null,
            paymentId: item.paymentId ?? null,
            invoice: (item.invoice ?? null) as InvoiceInfo | null,
            shuttleRequest: (item.shuttleRequest ?? null) as ShuttleRequest | null,
          } as ApplicationItem;
        });
        const shuttleRequests = [
          ...(((application.shuttleRequests as unknown[] | undefined) ?? []) as ShuttleRequest[]),
          ...items.map((item) => item.shuttleRequest).filter(Boolean) as ShuttleRequest[],
        ];
        const firstShuttle = shuttleRequests[0];
        const applicantType = application.applicantType ?? application.memberType ?? application.customerType;
        const selectedWeekdays = stringList(application.selectedWeekdays ?? application.weekdays ?? application.selectedDays);
        const importSource = application.importSource ?? application.sourceLabel ?? application.source;
        const reviewReasons = stringList(application.reviewReasons ?? application.needsReviewReasons ?? application.reviewReason);
        return {
          ...application,
          totalAmount: application.totalAmount ?? application.totalPriceSnapshot,
          shuttleNeeded: application.shuttleNeeded !== undefined ? Boolean(application.shuttleNeeded) : shuttleRequests.length > 0,
          shuttleStatus: application.shuttleStatus ?? firstShuttle?.status ?? null,
          applicantType: typeof applicantType === "string" ? applicantType : null,
          selectedWeekdays,
          importSource: typeof importSource === "string" ? importSource : null,
          imported: Boolean(application.imported ?? application.isImported ?? importSource),
          reviewReasons,
          items,
        } as Application;
      }) : [];
      setData((current) => ({
        seasons,
        applications: includeApplications ? applications : current.applications,
        stats: body.stats,
      }));
      if (includeApplications) {
        setApplicationsLoaded(true);
        applicationsQueryKeyRef.current = applicationsQueryKey;
        setApplicationsPagination(body.applicationsPagination ?? {
          page: options?.page ?? 1,
          pageSize: applicationsPagination.pageSize,
          total: applications.length,
          totalPages: 1,
          hasMore: false,
        });
        setSelectedApplication((current) => current ? applications.find((application) => application.id === current.id) ?? current : null);
      }
      setSelectedSeasonId((current) => current || seasons[0]?.id || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "방학특강 정보를 불러오지 못했습니다.");
    } finally { setLoading(false); }
  }, [applicationsPagination.page, applicationsPagination.pageSize, search, effectiveStatus]);

  useEffect(() => {
    if (initialData || requestedInitialLoad.current) return;
    requestedInitialLoad.current = true;
    void load();
  }, [initialData, load]);

  useEffect(() => {
    let cancelled = false;
    const loadCoachOptions = async () => {
      try {
        const response = await fetch("/api/admin/coach-options", { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(body.coaches)) return;
        if (!cancelled) setCoachOptions(body.coaches.filter((coach: CoachOption) => coach?.id && coach?.name));
      } catch {
        if (!cancelled) setCoachOptions([]);
      }
    };
    void loadCoachOptions();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (tab === "applications" && !applicationsLoaded && !loading) void load({ includeApplications: true });
  }, [applicationsLoaded, load, loading, tab]);

  useEffect(() => {
    if (tab !== "applications" || !applicationsLoaded || applicationsMode !== "applications") return;
    const queryKey = `1|${search.trim()}|${effectiveStatus}`;
    if (applicationsQueryKeyRef.current === queryKey) return;
    const timer = window.setTimeout(() => {
      setSelectedItemIds([]);
      void load({ includeApplications: true, page: 1, search, status: effectiveStatus });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [applicationsLoaded, applicationsMode, load, search, effectiveStatus, tab]);

  useEffect(() => {
    if (tab !== "applications" || applicationsMode !== "roster") return;
    const controller = new AbortController();
    const fetchRoster = async () => {
      setRosterLoading(true);
      setRosterError("");
      try {
        const params = new URLSearchParams({ view: "roster", page: String(rosterFilters.page), pageSize: "100" });
        for (const [key, value] of Object.entries(rosterFilters)) {
          if (key !== "page" && value) params.set(key, String(value));
        }
        const response = await fetch(`/api/admin/seasonal?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "반별 확정 명단을 불러오지 못했습니다.");
        setRoster(normalizeRosterPayload(body as Record<string, unknown>));
      } catch (caught) {
        if ((caught as Error).name !== "AbortError") setRosterError(caught instanceof Error ? caught.message : "반별 확정 명단을 불러오지 못했습니다.");
      } finally {
        if (!controller.signal.aborted) setRosterLoading(false);
      }
    };
    void fetchRoster();
    return () => controller.abort();
  }, [applicationsMode, rosterFilters, tab]);

  const selectedSeason = data.seasons.find((season) => season.id === selectedSeasonId) ?? data.seasons[0];
  const filteredApplications = data.applications;
  const visibleItemIds = useMemo(() => filteredApplications.flatMap((application) => application.items.map((item) => item.id)), [filteredApplications]);
  const visibleItemIdSet = useMemo(() => new Set(visibleItemIds), [visibleItemIds]);
  const selectedItemIdSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);
  const selectedApplicationCount = useMemo(
    () => filteredApplications.filter((application) => application.items.some((item) => selectedItemIdSet.has(item.id))).length,
    [filteredApplications, selectedItemIdSet],
  );
  const allVisibleSelected = visibleItemIds.length > 0 && visibleItemIds.every((itemId) => selectedItemIdSet.has(itemId));

  useEffect(() => {
    setSelectedItemIds((current) => {
      const next = current.filter((itemId) => visibleItemIdSet.has(itemId));
      return next.length === current.length ? current : next;
    });
  }, [visibleItemIdSet]);

  const calculatedStats = {
    pending: data.stats?.pending ?? data.applications.filter((a) => a.items.some((i) => i.status === "PENDING")).length,
    confirmed: data.stats?.confirmed ?? data.applications.filter((a) => a.items.some((i) => i.status === "APPROVED")).length,
    unpaid: data.stats?.unpaid ?? data.applications.filter((a) => a.paymentStatus === "UNPAID" || a.paymentStatus === "PAYMENT_PENDING").length,
    waitlisted: data.stats?.waitlisted ?? data.applications.filter((a) => a.items.some((i) => i.status === "WAITLISTED")).length,
    shuttleUnassigned: data.stats?.shuttleUnassigned ?? data.applications.filter((a) => a.shuttleNeeded && a.shuttleStatus !== "ASSIGNED").length,
  };

  function openRosterForClass(klass: SeasonalClass, options: { date?: string; weekday?: string } = {}) {
    setApplicationsMode("roster");
    setRosterFilters((current) => ({
      ...current,
      seasonId: selectedSeason?.id ?? current.seasonId,
      offeringId: klass.id,
      weekday: options.weekday ?? "",
      date: options.date ?? "",
      page: 1,
    }));
    setTab("applications");
  }

  async function mutate(method: "POST" | "PATCH", body: Record<string, unknown>, success: string) {
    setError(""); setNotice("");
    const response = await fetch("/api/admin/seasonal", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "요청을 처리하지 못했습니다.");
    setNotice(success); await load({ includeApplications: applicationsLoaded || tab === "applications" }); return result;
  }

  async function updateItem(itemId: string, status: ItemStatus) {
    if (updatingItemIdsRef.current.has(itemId)) return;
    updatingItemIdsRef.current.add(itemId);
    setUpdatingItemIds(new Set(updatingItemIdsRef.current));
    setItemUpdateErrors((current) => {
      if (!current[itemId]) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    try {
      const result = await mutate("PATCH", { resource: "item", id: itemId, data: { status } }, `신청 항목을 '${STATUS_LABEL[status]}' 상태로 변경했습니다.`) as { notification?: { status: NotificationSummary["status"]; errorCode?: string | null } | null };
      const expected = itemNotification(status);
      const nextSummary = result.notification && expected ? {
        trigger: expected.trigger,
        status: result.notification.status,
        attemptCount: 1,
        updatedAt: new Date().toISOString(),
        errorCode: result.notification.errorCode ?? null,
        canRetry: result.notification.status !== "PENDING",
      } satisfies NotificationSummary : null;
      setSelectedApplication((current) => current ? { ...current, items: current.items.map((item) => item.id === itemId ? {
        ...item,
        status,
        notificationSummary: nextSummary ?? (item.notificationSummary?.trigger === expected?.trigger ? item.notificationSummary : null),
      } : item) } : current);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "상태를 변경하지 못했습니다.";
      setError(message);
      setItemUpdateErrors((current) => ({ ...current, [itemId]: message }));
    } finally {
      updatingItemIdsRef.current.delete(itemId);
      setUpdatingItemIds(new Set(updatingItemIdsRef.current));
    }
  }

  async function updateApplicationStatus(applicationId: string, status: ApplicationCloseStatus) {
    setUpdatingApplicationStatus(status);
    setError("");
    try {
      await mutate(
        "PATCH",
        { resource: "application", id: applicationId, data: { status } },
        `신청을 '${STATUS_LABEL[status] ?? status}' 처리했습니다.`,
      );
      setSelectedApplication((current) => current?.id === applicationId ? {
        ...current,
        status,
        reviewReasons: [],
        processedNote: current.processedNote,
      } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "신청 상태를 변경하지 못했습니다.");
    } finally {
      setUpdatingApplicationStatus("");
    }
  }

  async function saveAssignment(input: AssignmentInput) {
    const key = input.itemId ?? input.applicationId;
    setAssigningKey(key);
    setError("");
    setItemUpdateErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await mutate(
        "PATCH",
        {
          resource: input.itemId ? "itemAssignment" : "applicationAssignment",
          id: key,
          data: {
            offeringId: input.offeringId,
            selectedWeekdays: input.selectedWeekdays,
            priceSnapshot: input.priceSnapshot,
          },
        },
        "수업 정보를 저장했습니다.",
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "수업 정보를 저장하지 못했습니다.";
      setError(message);
      setItemUpdateErrors((current) => ({ ...current, [key]: message }));
    } finally {
      setAssigningKey("");
    }
  }

  async function convertItem(itemId: string) {
    setConvertingItemId(itemId);
    try {
      const result = await mutate("PATCH", { resource: "conversion", id: itemId, data: {} }, "수강 등록과 청구서를 생성했습니다.") as NotificationMutationResponse;
      if (notificationMutationFailed(result)) {
        setNotice("수강·청구 생성 완료 / 안내 실패, 재발송이 필요합니다.");
      } else {
        setSelectedApplication(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "수강·청구 생성에 실패했습니다.");
    } finally {
      setConvertingItemId("");
    }
  }

  function toggleApplicationSelection(application: Application, checked: boolean) {
    const itemIds = application.items.map((item) => item.id);
    setSelectedItemIds((current) => {
      const next = new Set(current);
      for (const itemId of itemIds) {
        if (checked) next.add(itemId);
        else next.delete(itemId);
      }
      return Array.from(next);
    });
  }

  function toggleAllVisibleApplications(checked: boolean) {
    setSelectedItemIds((current) => {
      const next = new Set(current);
      for (const itemId of visibleItemIds) {
        if (checked) next.add(itemId);
        else next.delete(itemId);
      }
      return Array.from(next);
    });
  }

  async function handleBulkItemStatus(status: ItemStatus) {
    if (selectedItemIds.length === 0) return;
    const targetLabel = STATUS_LABEL[status] ?? status;
    const confirmed = window.confirm(`${selectedApplicationCount}명, 신청 반 ${selectedItemIds.length}개를 '${targetLabel}' 처리할까요?`);
    if (!confirmed) return;

    setBulkProcessingStatus(status);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/seasonal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "bulkItems", data: { itemIds: selectedItemIds, status } }),
      });
      const body = (await response.json().catch(() => ({}))) as BulkItemResponse;
      if (!response.ok) throw new Error(body.error || "일괄 처리를 완료하지 못했습니다.");

      const results = body.results ?? [];
      const failed = results.filter((result) => !result.ok);
      const succeeded = body.summary?.succeeded ?? results.filter((result) => result.ok).length;
      const failedIds = failed.map((result) => result.itemId);
      const notificationFailedResults = results.filter((result) => result.ok && (result.notificationWarning || result.notification?.status === "FAILED"));
      const notificationsFailed = body.summary?.notificationsFailed ?? notificationFailedResults.length;
      const retryIds = Array.from(new Set([...failedIds, ...notificationFailedResults.map((result) => result.itemId)]));
      const failureMessage = failed[0]?.message ? ` 첫 실패 사유: ${failed[0].message}` : "";
      setSelectedItemIds(retryIds);
      setNotice(`${targetLabel} 상태 처리 성공 ${succeeded}개 / 처리 실패 ${failed.length}개 / 안내 실패 ${notificationsFailed}개.${failureMessage}`);
      await load({ includeApplications: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "일괄 처리를 완료하지 못했습니다.");
    } finally {
      setBulkProcessingStatus("");
    }
  }

  async function handleBulkConversion() {
    if (selectedItemIds.length === 0) return;
    const confirmed = window.confirm(`${selectedApplicationCount}명, 신청 반 ${selectedItemIds.length}개의 수강 등록과 청구서를 생성할까요? 승인되지 않은 항목은 실패 사유로 남습니다.`);
    if (!confirmed) return;

    setBulkConverting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/seasonal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "bulkConversion", data: { itemIds: selectedItemIds } }),
      });
      const body = (await response.json().catch(() => ({}))) as BulkItemResponse;
      if (!response.ok) throw new Error(body.error || "수강·청구 생성을 완료하지 못했습니다.");

      const results = body.results ?? [];
      const failed = results.filter((result) => !result.ok);
      const succeeded = body.summary?.succeeded ?? results.filter((result) => result.ok).length;
      const notificationFailedResults = results.filter((result) => result.ok && (result.notificationWarning || result.notification?.status === "FAILED"));
      const notificationsFailed = body.summary?.notificationsFailed ?? notificationFailedResults.length;
      const retryIds = Array.from(new Set([...failed.map((result) => result.itemId), ...notificationFailedResults.map((result) => result.itemId)]));
      const failureMessage = failed[0]?.message ? ` 첫 실패 사유: ${failed[0].message}` : "";
      setSelectedItemIds(retryIds);
      setNotice(`수강·청구 처리 성공 ${succeeded}개 / 처리 실패 ${failed.length}개 / 안내 실패 ${notificationsFailed}개.${failureMessage}`);
      await load({ includeApplications: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "수강·청구 생성을 완료하지 못했습니다.");
    } finally {
      setBulkConverting(false);
    }
  }

  async function copyInvoiceLink(item: ApplicationItem) {
    if (item.invoice?.accountActivationRequired) {
      try {
        const response = await fetch("/api/admin/seasonal", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resource: "accountActivation", id: item.id, data: { action: "reissue" } }),
        });
        const body = (await response.json().catch(() => ({}))) as NotificationMutationResponse & { activationUrl?: string; error?: string };
        if (!response.ok || !body.activationUrl) throw new Error(body.error || "보호자 가입 안내 링크를 만들지 못했습니다.");
        const absoluteHref = toAbsoluteHref(body.activationUrl);
        const notificationFailed = notificationMutationFailed(body);
        try {
          await navigator.clipboard.writeText(absoluteHref);
          setNotice(notificationFailed
            ? `${item.className} 링크 재발급 완료 / 문자 안내 실패, 재발송이 필요합니다.`
            : `${item.className} 보호자 가입 안내 링크를 복사했습니다.`);
        } catch {
          window.open(absoluteHref, "_blank", "noopener,noreferrer");
          setNotice(notificationFailed
            ? "링크 재발급 완료 / 문자 안내 실패. 복사 대신 새 창으로 열었습니다."
            : "브라우저가 복사를 막아 보호자 가입 안내 링크를 새 창으로 열었습니다.");
        }
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "보호자 가입 안내 링크를 만들지 못했습니다.");
      }
      return;
    }
    const href = getItemInvoiceHref(item);
    if (!href) {
      setNotice("먼저 청구서를 생성해야 링크를 복사할 수 있습니다.");
      return;
    }
    const absoluteHref = toAbsoluteHref(href);
    try {
      await navigator.clipboard.writeText(absoluteHref);
      setNotice(`${item.className} 청구서 링크를 복사했습니다.`);
    } catch {
      window.open(absoluteHref, "_blank", "noopener,noreferrer");
      setNotice("브라우저가 복사를 막아 청구서를 새 창으로 열었습니다.");
    }
  }

  async function retryNotification(scope: "application" | "item" | "invoice", id: string, trigger: string) {
    const requestKey = `${scope}:${id}:${trigger}`;
    setSendingNotificationKey(requestKey);
    setError("");
    try {
      const response = await fetch("/api/admin/seasonal", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "notificationRetry", id, data: { scope, trigger } }),
      });
      const body = (await response.json().catch(() => ({}))) as { success?: boolean; notification?: NotificationSummary; error?: string };
      if (!response.ok || !body.notification) throw new Error(body.error || "안내 문자를 발송하지 못했습니다.");
      const summary = body.notification;
      setSelectedApplication((current) => {
        if (!current) return current;
        if (scope === "application") return { ...current, notificationSummary: summary };
        return {
          ...current,
          items: current.items.map((item) => item.id !== id ? item : scope === "item"
            ? { ...item, notificationSummary: summary }
            : { ...item, invoice: item.invoice ? { ...item.invoice, notificationSummary: summary } : item.invoice }),
        };
      });
      setNotice(summary.status === "SENT" ? "보호자 안내 문자를 발송했습니다." : "문자 발송 결과를 확인해 주세요.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "안내 문자를 발송하지 못했습니다.");
    } finally {
      setSendingNotificationKey("");
    }
  }

  async function resolveApplicationReview(applicationId: string, reviewNote: string) {
    setResolvingReview(true);
    try {
      await mutate("PATCH", { resource: "applicationReview", id: applicationId, data: { action: "CLEAR", reviewNote } }, "확인 필요 항목을 검토 완료로 처리했습니다.");
      setSelectedApplication((current) => current?.id === applicationId ? { ...current, reviewReasons: [] } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "검토 완료 처리에 실패했습니다.");
    } finally {
      setResolvingReview(false);
    }
  }

  async function assignClassInstructor(klass: SeasonalClass, slot: OperationalSlot, instructorId: string) {
    const selectedCoach = coachOptions.find((coach) => coach.id === instructorId) ?? null;
    setAssigningInstructorClassId(`${klass.id}:${slot.key}`);
    try {
      await mutate(
        "PATCH",
        {
          resource: "operationalSlotInstructor",
          id: klass.id,
          data: {
            weekday: slot.weekdayKey,
            instructorId: instructorId || null,
            instructorName: selectedCoach?.name ?? null,
          },
        },
        selectedCoach
          ? `${compactOperationalClassName(klass.name)} ${slot.label}요일 담당 선생님을 ${selectedCoach.name} 선생님으로 배정했습니다.`
          : `${compactOperationalClassName(klass.name)} ${slot.label}요일 담당 선생님 배정을 해제했습니다.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "담당 선생님을 변경하지 못했습니다.");
    } finally {
      setAssigningInstructorClassId("");
    }
  }

  return (
    <main className="mx-auto min-w-0 max-w-7xl space-y-6 overflow-x-clip pb-20">
      {/* 공통 헤더로 교체. "새 시즌 만들기" 버튼은 action 슬롯으로 옮겼고 onClick 동작은 그대로다. */}
      <SeasonalHeader
        action={<button type="button" onClick={() => { setEditingSeason(null); setModal("season"); }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--brand-accent)] px-4 font-black text-[var(--brand-accent-contrast)]"><Icon name="add" />새 시즌 만들기</button>}
      />

      <nav className="relative flex min-w-0 items-center justify-between gap-2" aria-label="방학특강 관리 메뉴">
        <select aria-label="방학특강 업무" value={tab} onChange={(event) => setTab(event.target.value as Tab)} className="h-11 min-h-11 max-w-full shrink-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-3 text-[17px] font-bold text-[var(--color-academy-primary)]">{TABS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
        <details className="relative shrink-0"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold text-[var(--color-academy-primary)]">관련 업무<Icon name="expand_more" className="text-lg" /></summary><div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-1 shadow-lg">
        <a href="/admin/seasonal/attendance" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"><Icon name="fact_check" className="text-xl" />출석 관리</a>
        <a href="/admin/seasonal/attendance?view=makeup" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"><Icon name="cached" className="text-xl" />보강 관리</a>
        <a href="/admin/shuttle" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"><Icon name="directions_bus" className="text-xl" />셔틀 관리</a>
        </div></details>
      </nav>

      {notice && <div role="status" className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><Icon name="check_circle" />{notice}</div>}
      {error && <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800"><span>{error}</span><button type="button" onClick={() => void load()} className="underline">다시 시도</button></div>}
      {loading ? <Loading /> : tab === "overview" ? <Overview stats={calculatedStats} seasons={data.seasons} applications={data.applications} onNavigate={setTab} /> : tab === "seasons" ? (
        <SeasonsView seasons={data.seasons} selected={selectedSeason} coaches={coachOptions} assigningInstructorClassId={assigningInstructorClassId} onSelect={setSelectedSeasonId} onAddClass={() => { setEditingClass(null); setModal("class"); }} onEditSeason={(season) => { setEditingSeason(season); setModal("season"); }} onEditClass={(klass) => { setEditingClass(klass); setModal("class"); }} onOpenRoster={(klass, weekday) => openRosterForClass(klass, { weekday })} onOpenTodayRoster={(klass) => openRosterForClass(klass, { date: todayDateInputValue() })} onAssignInstructor={assignClassInstructor} onStatus={async (id, status) => { try { await mutate("PATCH", { resource: "season", id, data: { status } }, "시즌 상태를 변경했습니다."); } catch (caught) { setError(caught instanceof Error ? caught.message : "시즌 상태를 변경하지 못했습니다."); } }} />
      ) : <ApplicationsView applications={filteredApplications} allApplications={data.applications} seasons={data.seasons} search={search} status={statusFilter} pagination={applicationsPagination} selectedItemIdSet={selectedItemIdSet} selectedItemCount={selectedItemIds.length} selectedApplicationCount={selectedApplicationCount} allVisibleSelected={allVisibleSelected} bulkProcessingStatus={bulkProcessingStatus} bulkConverting={bulkConverting} mode={applicationsMode} appTab={appTab} onAppTab={setAppTab} roster={roster} rosterFilters={rosterFilters} rosterLoading={rosterLoading} rosterError={rosterError} onMode={setApplicationsMode} onRosterFilters={setRosterFilters} onSearch={setSearch} onStatus={setStatusFilter} onPage={(page) => { setSelectedItemIds([]); void load({ includeApplications: true, page }); }} onSelect={setSelectedApplication} onToggleApplication={toggleApplicationSelection} onToggleAll={toggleAllVisibleApplications} onBulkStatus={handleBulkItemStatus} onBulkConversion={handleBulkConversion} />}

      {selectedApplication && <ApplicationDrawer application={selectedApplication} seasons={data.seasons} onClose={() => { setSelectedApplication(null); setItemUpdateErrors({}); }} onUpdateItem={updateItem} updatingItemIds={updatingItemIds} itemUpdateErrors={itemUpdateErrors} onSaveAssignment={saveAssignment} assigningKey={assigningKey} onConvertItem={convertItem} onCopyInvoiceLink={copyInvoiceLink} onRetryNotification={retryNotification} sendingNotificationKey={sendingNotificationKey} onResolveReview={resolveApplicationReview} resolvingReview={resolvingReview} onUpdateApplicationStatus={updateApplicationStatus} updatingApplicationStatus={updatingApplicationStatus} convertingItemId={convertingItemId} onShuttleChanged={() => { void load({ includeApplications: true }); }} />}
      {modal === "season" && <SeasonForm initial={editingSeason} onClose={() => setModal(null)} onSubmit={async (payload) => { await mutate(editingSeason ? "PATCH" : "POST", editingSeason ? { resource: "season", id: editingSeason.id, data: payload } : { resource: "season", data: payload }, editingSeason ? "시즌 정보를 수정했습니다." : "새 시즌을 만들었습니다."); setModal(null); setTab("seasons"); }} />}
      {modal === "class" && selectedSeason && <ClassForm seasonId={selectedSeason.id} initial={editingClass} coaches={coachOptions} onClose={() => setModal(null)} onSubmit={async (payload) => { await mutate(editingClass ? "PATCH" : "POST", editingClass ? { resource: "offering", id: editingClass.id, data: payload } : { resource: "offering", data: { ...payload, seasonId: selectedSeason.id } }, editingClass ? "특강 반을 수정했습니다." : "특강 반을 추가했습니다."); setModal(null); }} />}
    </main>
  );
}

function Overview({ stats, seasons, applications, onNavigate }: { stats: Record<string, number>; seasons: Season[]; applications: Application[]; onNavigate: (tab: Tab) => void }) {
  // 마지막 값(clickable)은 "눌렀을 때 실제로 신청 관리 탭으로 이동하는가"를 뜻한다.
  // false 인 카드는 이동할 곳이 없으므로 버튼이 아니라 단순 표시(div)로 그린다.
  const cards = [
    ["승인 대기", stats.pending, "pending_actions", "신청 관리", true], ["승인 완료", stats.confirmed, "verified", "신청 관리", false], ["미결제", stats.unpaid, "payments", "결제 관리", false], ["대기자", stats.waitlisted, "hourglass_top", "신청 관리", true], ["차량 미배정", stats.shuttleUnassigned, "directions_bus", "차량 관리", false],
  ] as const;
  return <div className="space-y-6"><section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{cards.map(([label, count, icon, helper, clickable]) => {
    // 카드 내용은 클릭 가능 여부와 무관하게 동일하다 (숫자 표시는 그대로 유지)
    const body = <><div className="flex items-center justify-between"><Icon name={icon} className="text-2xl text-[var(--brand-accent)]" /><span className="text-xs font-bold text-gray-400">{helper}</span></div><p className="mt-4 text-3xl font-black">{count}</p><p className="mt-1 text-sm font-bold text-gray-600 dark:text-gray-300">{label}</p></>;
    // 이동 대상이 없는 카드에서는 hover 들썩임(transition hover:-translate-y-0.5)을 빼서 눌리는 것처럼 보이지 않게 한다
    return clickable
      ? <button type="button" key={label} onClick={() => onNavigate("applications")} className="rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 dark:border-gray-700 dark:bg-gray-900">{body}</button>
      : <div key={label} className="rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm dark:border-gray-700 dark:bg-gray-900">{body}</div>;
  })}</section>
    <section className="grid gap-4 lg:grid-cols-2"><Panel title="운영 중인 시즌" icon="calendar_month">{seasons.length ? seasons.slice(0, 4).map((season) => <div key={season.id} className="flex items-center justify-between border-b border-gray-100 py-3 last:border-0 dark:border-gray-800"><div><p className="font-bold">{season.name}</p><p className="text-xs text-gray-500">{formatDate(season.startsAt)} ~ {formatDate(season.endsAt)} · {season.classes.length}개 반</p></div><span className={badge(season.status)}>{STATUS_LABEL[season.status] ?? season.status}</span></div>) : <Empty text="아직 개설된 시즌이 없습니다." />}</Panel>
    <Panel title="최근 신청" icon="person_add">{applications.length ? applications.slice(0, 5).map((application) => <div key={application.id} className="flex items-center justify-between border-b border-gray-100 py-3 last:border-0 dark:border-gray-800"><div><p className="font-bold">{application.childName} <span className="text-xs text-gray-400">{application.childGrade}</span></p><p className="text-xs text-gray-500">{application.parentName} · {application.items.length}개 반</p></div><span className={badge(application.items[0]?.status)}>{STATUS_LABEL[application.items[0]?.status] ?? "접수"}</span></div>) : <Empty text="접수된 신청이 없습니다." />}</Panel></section></div>;
}

function SeasonsView({
  seasons,
  selected,
  coaches,
  assigningInstructorClassId,
  onSelect,
  onAddClass,
  onEditSeason,
  onEditClass,
  onOpenRoster,
  onOpenTodayRoster,
  onAssignInstructor,
  onStatus,
}: {
  seasons: Season[];
  selected?: Season;
  coaches: CoachOption[];
  assigningInstructorClassId: string;
  onSelect: (id: string) => void;
  onAddClass: () => void;
  onEditSeason: (season: Season) => void;
  onEditClass: (klass: SeasonalClass) => void;
  onOpenRoster: (klass: SeasonalClass, weekday?: string) => void;
  onOpenTodayRoster: (klass: SeasonalClass) => void;
  onAssignInstructor: (klass: SeasonalClass, slot: OperationalSlot, instructorId: string) => Promise<void>;
  onStatus: (id: string, status: SeasonStatus) => Promise<void>;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const operationalGroups = selected ? groupOperationalClasses(selected.classes, coaches) : [];
  const inactiveGroups = operationalGroups.filter((group) => group.offerings.every((offering) => offering.status === "CANCELLED"));
  const visibleGroups = showInactive
    ? operationalGroups
    : operationalGroups.filter((group) => !inactiveGroups.includes(group));
  return (
    <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
      <Panel title="시즌 목록" icon="event_note">
        <div className="space-y-2">
          {seasons.map((season) => {
            const groupCount = groupOperationalClasses(season.classes, coaches).length;
            return (
              <button
                type="button"
                key={season.id}
                onClick={() => onSelect(season.id)}
                className={`w-full rounded-xl border p-3 text-left ${selected?.id === season.id ? "border-[var(--brand-accent)] bg-[var(--brand-accent-soft)]" : "border-gray-200 dark:border-gray-700"}`}
              >
                <p className="font-bold">{season.name}</p>
                <p className="mt-1 text-xs text-gray-500">{STATUS_LABEL[season.status]} · 운영반 {groupCount}개</p>
              </button>
            );
          })}
          {!seasons.length && <Empty text="개설된 시즌이 없습니다." />}
        </div>
      </Panel>

      <Panel
        title={selected?.name ?? "시즌을 선택하세요"}
        icon="view_week"
        action={selected && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onEditSeason(selected)} className="min-h-10 rounded-lg border border-gray-200 px-3 text-sm font-bold dark:border-gray-700">시즌 수정</button>
            <select aria-label="시즌 상태" value={selected.status} onChange={(event) => void onStatus(selected.id, event.target.value as SeasonStatus)} className="min-h-10 rounded-lg border border-gray-200 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-800">
              {["DRAFT", "PUBLISHED", "CLOSED", "ARCHIVED"].map((value) => <option key={value} value={value}>{STATUS_LABEL[value]}</option>)}
            </select>
            <button type="button" onClick={onAddClass} className="min-h-10 rounded-lg bg-[var(--brand-accent)] px-3 text-sm font-black text-[var(--brand-accent-contrast)]">운영반/요금 추가</button>
          </div>
        )}
      >
        {selected ? (
          <>
            <div className="mb-4 grid gap-3 rounded-xl bg-gray-50 p-4 text-sm sm:grid-cols-3 dark:bg-gray-800">
              <p><span className="block text-xs text-gray-500">모집 기간</span>{formatDate(selected.enrollmentStartsAt)} ~ {formatDate(selected.enrollmentEndsAt)}</p>
              <p><span className="block text-xs text-gray-500">운영 기간</span>{formatDate(selected.startsAt)} ~ {formatDate(selected.endsAt)}</p>
              <p><span className="block text-xs text-gray-500">지점</span>{selected.branch || "전체"}</p>
            </div>
            <div className="space-y-3">
              {inactiveGroups.length > 0 && (
                <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm dark:border-gray-700 dark:bg-gray-800">
                  <span className="font-bold">취소된 운영 반 {inactiveGroups.length}개{showInactive ? "를 함께 표시합니다." : "를 숨겼습니다."}</span>
                  <button type="button" onClick={() => setShowInactive((current) => !current)} className="min-h-9 rounded-lg border border-gray-300 bg-white px-3 text-xs font-black dark:border-gray-600 dark:bg-gray-900">
                    {showInactive ? "운영 반만 보기" : "취소 반 보기"}
                  </button>
                </div>
              )}
              {visibleGroups.map((group) => {
                const classStatus = group.baseClass.status ?? "";
                const classStatusLabel = classStatus ? STATUS_LABEL[classStatus] ?? classStatus : "상태 미정";
                const activeSlots = group.slots.length;
                const missingSlots = group.slots.filter((slot) => !slot.instructorId || slot.mixedInstructor);
                const attendanceMissing = selected.status === "PUBLISHED" && classStatus === "OPEN"
                  ? [
                      !group.baseClass.linkedClassId?.trim() ? "연결 반" : null,
                      activeSlots === 0 ? "수업 일정" : null,
                      missingSlots.length > 0 ? "요일별 담당 선생님" : null,
                    ].filter((item): item is string => Boolean(item))
                  : [];
                return (
                  <article key={group.key} className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-black">{group.name}</h3>
                          {group.baseClass.shuttleAvailable && <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-bold text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">셔틀</span>}
                          <span className={badge(classStatus)}>{classStatusLabel}</span>
                        </div>
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                          {group.baseClass.targetGrade || "전체 학년"} · {group.baseClass.location || selected.branch || "장소 미정"} · 운영 요일 {activeSlots || "미등록"}개
                        </p>
                        <p className="mt-2 text-xs font-bold text-gray-500 dark:text-gray-400">
                          주 n회 정보는 수강료 계산용입니다. 실제 반은 이 운영반 하나로 관리합니다.
                        </p>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-[120px_auto] xl:min-w-[440px]">
                        <div className="rounded-lg bg-gray-50 px-3 py-2 text-right dark:bg-gray-800">
                          <p className="font-black">확정 {group.confirmedTotal}명</p>
                          <p className="text-xs text-gray-500">요일 정원 {group.capacity || "미정"}명 · 대기 {group.waitlistedTotal}명</p>
                        </div>
                        <div className="flex flex-wrap gap-2 xl:justify-end">
                          <button type="button" onClick={() => onOpenRoster(group.baseClass)} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-gray-200 px-3 text-sm font-bold dark:border-gray-700"><Icon name="groups" className="text-lg" />전체 명단</button>
                          <button type="button" onClick={() => onOpenTodayRoster(group.baseClass)} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-gray-200 px-3 text-sm font-bold dark:border-gray-700"><Icon name="fact_check" className="text-lg" />오늘 출석</button>
                          <button type="button" onClick={() => onEditClass(group.baseClass)} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-gray-200 px-3 text-sm font-bold dark:border-gray-700"><Icon name="edit" className="text-lg" />기본정보</button>
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_260px]">
                      <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800/80">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <h4 className="text-sm font-black">요일별 운영</h4>
                          <span className="text-xs font-bold text-gray-500">학생별 신청 요일 기준</span>
                        </div>
                        <div className="grid gap-2 md:grid-cols-2">
                          {group.slots.map((slot) => {
                            const assigningKey = `${group.baseClass.id}:${slot.key}`;
                            const currentCoachMissingFromOptions = Boolean(slot.instructorId && !coaches.some((coach) => coach.id === slot.instructorId));
                            return (
                              <div key={slot.key} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <p className="font-black">{slot.label}요일</p>
                                    <p className="text-xs font-bold text-gray-500">{slot.startTime}~{slot.endTime} · {slot.dateCount}회차</p>
                                    <p className="text-xs text-gray-500">{slot.location || "장소 미정"}</p>
                                  </div>
                                  <button type="button" onClick={() => onOpenRoster(group.baseClass, slot.weekdayKey)} className="min-h-8 rounded-lg border border-gray-200 px-2 text-xs font-black dark:border-gray-700">명단 {slot.confirmed}</button>
                                </div>
                                <label className="mt-3 block text-xs font-black text-gray-500 dark:text-gray-400">
                                  담당 선생님
                                  <select
                                    aria-label={`${group.name} ${slot.label}요일 담당 선생님`}
                                    value={slot.instructorId}
                                    disabled={assigningInstructorClassId === assigningKey}
                                    onChange={(event) => void onAssignInstructor(group.baseClass, slot, event.target.value)}
                                    className="mt-1 min-h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold text-gray-950 disabled:cursor-wait disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                                  >
                                    <option value="">{slot.mixedInstructor ? "혼합 배정" : "담당자 미정"}</option>
                                    {currentCoachMissingFromOptions && <option value={slot.instructorId}>{slot.instructorName || "현재 담당 선생님"}</option>}
                                    {coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}
                                  </select>
                                </label>
                              </div>
                            );
                          })}
                          {!group.slots.length && <Empty text="등록된 요일별 수업 일정이 없습니다." />}
                        </div>
                      </div>
                      <div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800/80">
                        <h4 className="text-sm font-black">수강료 계산 규칙</h4>
                        <div className="mt-2 space-y-2">
                          {group.pricingRules.map((rule) => (
                            <div key={rule.key} className="rounded-lg bg-white px-3 py-2 text-sm dark:bg-gray-900">
                              <div className="flex items-center justify-between">
                                <span className="font-black">{rule.label}</span>
                                {group.baseClass.shuttleAvailable && <span className="text-xs font-bold text-blue-700 dark:text-blue-300">셔틀 +{(rule.shuttleFee ?? 0).toLocaleString()}원</span>}
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-3 text-xs">
                                <span className="text-gray-500">기존 {(rule.existingPrice ?? rule.price).toLocaleString()}원</span>
                                <span className="font-bold text-[var(--brand-accent)]">신규 {(rule.newPrice ?? rule.price).toLocaleString()}원</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    {attendanceMissing.length > 0 && (
                      <div role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                        <p className="flex items-center gap-2 font-black"><Icon name="warning" />출석 준비 미완료</p>
                        <p className="mt-1 text-xs">빠진 항목: {attendanceMissing.join(" · ")}</p>
                      </div>
                    )}
                  </article>
                );
              })}
              {!operationalGroups.length && <Empty text="아직 개설된 운영반이 없습니다. '운영반/요금 추가'를 눌러 시작하세요." />}
            </div>
          </>
        ) : <Empty text="왼쪽에서 시즌을 선택하세요." />}
      </Panel>
    </div>
  );
}

function ApplicationsView({
  applications,
  allApplications,
  seasons,
  search,
  status,
  pagination,
  selectedItemIdSet,
  selectedItemCount,
  selectedApplicationCount,
  allVisibleSelected,
  bulkProcessingStatus,
  bulkConverting,
  mode,
  appTab,
  onAppTab,
  roster,
  rosterFilters,
  rosterLoading,
  rosterError,
  onMode,
  onRosterFilters,
  onSearch,
  onStatus,
  onPage,
  onSelect,
  onToggleApplication,
  onToggleAll,
  onBulkStatus,
  onBulkConversion,
}: {
  applications: Application[];
  allApplications: Application[];
  seasons: Season[];
  search: string;
  status: string;
  pagination: ApplicationsPagination;
  selectedItemIdSet: Set<string>;
  selectedItemCount: number;
  selectedApplicationCount: number;
  allVisibleSelected: boolean;
  bulkProcessingStatus: ItemStatus | "";
  bulkConverting: boolean;
  mode: ApplicationsMode;
  appTab: "active" | "cancelled";
  onAppTab: (tab: "active" | "cancelled") => void;
  roster: RosterPayload;
  rosterFilters: RosterFilters;
  rosterLoading: boolean;
  rosterError: string;
  onMode: (mode: ApplicationsMode) => void;
  onRosterFilters: Dispatch<SetStateAction<RosterFilters>>;
  onSearch: (value: string) => void;
  onStatus: (value: string) => void;
  onPage: (page: number) => void;
  onSelect: (application: Application) => void;
  onToggleApplication: (application: Application, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onBulkStatus: (status: ItemStatus) => Promise<void>;
  onBulkConversion: () => Promise<void>;
}) {
  const visibleItemCount = applications.reduce((sum, application) => sum + application.items.length, 0);

  // ── 목록 정렬·헤더 필터(구글시트식, 클라이언트) ────────────────────
  // 한 시즌 신청이 한 페이지에 다 들어와(≤pageSize) 클라이언트 정렬·필터가 정확하다.
  const [openCol, setOpenCol] = useState<string | null>(null); // 열려 있는 팝오버 열
  const [sort, setSort] = useState<{ key: "name" | "parent" | "createdAt"; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  // 각 열의 '제외한 값' 집합. 비어 있으면 전체 표시.
  const [exType, setExType] = useState<Set<string>>(new Set());
  const [exBase, setExBase] = useState<Set<string>>(new Set());
  const [exFreq, setExFreq] = useState<Set<string>>(new Set());
  const [exPay, setExPay] = useState<Set<string>>(new Set());
  const [exShuttle, setExShuttle] = useState<Set<string>>(new Set());
  const typeOptions = ["기존", "신규"];
  const payOptions = ["청구전", "미납", "결제완료"];
  const shuttleOptions = ["이용", "미이용"];
  const baseOptions = useMemo(() => [...new Set(applications.flatMap((a) => applicationClassInfo(a.items).bases))].sort((x, y) => x.localeCompare(y, "ko")), [applications]);
  const freqOptions = useMemo(() => [...new Set(applications.flatMap((a) => applicationClassInfo(a.items).freqs))].sort((x, y) => x.localeCompare(y, "ko")), [applications]);
  const typeToLabel = (t?: string | null) => (t === "NEW" ? "신규" : t === "EXISTING" ? "기존" : "");
  const toggleEx = (setter: Dispatch<SetStateAction<Set<string>>>) => (v: string) => setter((prev) => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n; });
  const displayApplications = useMemo(() => {
    const filtered = applications.filter((a) => {
      const info = applicationClassInfo(a.items);
      if (exType.has(typeToLabel(a.applicantType))) return false;
      if (info.bases.length > 0 && info.bases.every((b) => exBase.has(b))) return false;
      if (info.freqs.length > 0 && info.freqs.every((f) => exFreq.has(f))) return false;
      if (exPay.has(paymentBucket(a.paymentStatus))) return false;
      if (exShuttle.has(shuttleBucket(a.shuttleNeeded))) return false;
      return true;
    });
    const val = (a: Application) => sort.key === "parent" ? (a.parentName || "") : sort.key === "createdAt" ? (a.createdAt || "") : (a.childName || "");
    return [...filtered].sort((a, b) => val(a).localeCompare(val(b), "ko") * (sort.dir === "asc" ? 1 : -1));
  }, [applications, exType, exBase, exFreq, exPay, exShuttle, sort]);
  const toggleOpen = (col: string) => setOpenCol((c) => (c === col ? null : col));
  const sortFor = (key: "name" | "parent" | "createdAt") => (dir: "asc" | "desc") => { setSort({ key, dir }); setOpenCol(null); };
  // 행 키보드: 안쪽 체크박스·링크·버튼에서 누른 Enter/Space 는 가로채지 않는다
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, application: Application) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(application);
    }
  }

  return <div className="space-y-4">
    <label className="print:hidden inline-flex items-center gap-2 text-sm font-bold text-[var(--color-academy-muted)]">보기<select aria-label="신청 관리 보기" value={mode} onChange={(event) => onMode(event.target.value as ApplicationsMode)} className="h-11 min-h-11 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px] text-[var(--color-academy-ink)]"><option value="applications">신청별</option><option value="roster">반별 명단</option></select></label>
    {mode === "roster" ? <RosterView seasons={seasons} applications={allApplications} roster={roster} filters={rosterFilters} loading={rosterLoading} error={rosterError} onFilters={onRosterFilters} onSelect={onSelect} /> : <Panel title="신청 목록" icon="assignment_ind">
    <CompactListFilters className="mb-4" activeCount={(appTab === "cancelled" ? 1 : Number(status !== "ALL")) + [exType, exBase, exFreq, exPay, exShuttle].filter(values => values.size > 0).length}
      resultCount={`표시 ${displayApplications.length}건 · 조회 ${pagination.total}건`}
      summary={[appTab === "cancelled" ? "취소자" : status === "ALL" ? "진행 중 · 취소 제외" : STATUS_LABEL[status] ?? status, [exType, exBase, exFreq, exPay, exShuttle].some(values => values.size > 0) ? "열 제외 조건 적용" : ""].filter(Boolean).join(" · ")}
      onReset={() => { onAppTab("active"); onStatus("ALL"); setExType(new Set()); setExBase(new Set()); setExFreq(new Set()); setExPay(new Set()); setExShuttle(new Set()); }}
      search={<label className="relative block"><span className="sr-only">신청 검색</span><Icon name="search" className="absolute left-3 top-3 text-xl text-[var(--color-academy-muted)]" /><input type="search" enterKeyHint="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="학생·학부모·전화번호 검색" className="min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] pl-10 pr-3 text-[17px]" /></label>}
    >
      <label className="grid min-w-0 gap-1 text-sm font-bold">조회 범위<select aria-label="신청 진행 상태" value={appTab} onChange={(event) => onAppTab(event.target.value as "active" | "cancelled")} className="h-11 min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]"><option value="active">진행 중 · 취소 제외</option><option value="cancelled">취소자만</option></select></label>
      {appTab === "active" && <label className="grid min-w-0 gap-1 text-sm font-bold">신청 상태<select aria-label="신청 상태" value={status} onChange={(event) => onStatus(event.target.value)} className="h-11 min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]"><option value="ALL">전체 상태(취소 제외)</option>{["PENDING","APPROVED","WAITLISTED","REJECTED"].map((value) => <option value={value} key={value}>{STATUS_LABEL[value]}</option>)}</select></label>}
    </CompactListFilters>

    {selectedItemCount > 0 && (
      <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-[var(--brand-accent)] bg-[var(--brand-accent-soft)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-black text-gray-950 dark:text-white">선택한 신청 반 {selectedItemCount}개</p>
          <p className="mt-1 text-xs font-bold text-gray-600 dark:text-gray-300">{selectedApplicationCount}명 학생을 현재 목록에서 처리합니다.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {BULK_ITEM_STATUSES.map((nextStatus) => (
            <button
              key={nextStatus}
              type="button"
              disabled={Boolean(bulkProcessingStatus) || bulkConverting}
              onClick={() => void onBulkStatus(nextStatus)}
              className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xl border border-gray-200 bg-white px-3 text-sm font-black text-gray-900 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)] disabled:cursor-wait disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            >
              {bulkProcessingStatus === nextStatus ? "처리 중" : STATUS_LABEL[nextStatus]}
            </button>
          ))}
          <button
            type="button"
            disabled={Boolean(bulkProcessingStatus) || bulkConverting}
            onClick={() => void onBulkConversion()}
            className="inline-flex min-h-10 items-center justify-center gap-1 rounded-xl bg-[var(--brand-accent)] px-3 text-sm font-black text-[var(--brand-accent-contrast)] disabled:cursor-wait disabled:opacity-60"
          >
            <Icon name="receipt_long" className="text-lg" />
            {bulkConverting ? "생성 중" : "수강·청구 생성"}
          </button>
        </div>
      </div>
    )}

    <div className="overflow-x-auto">
      {/* 한 줄 행(목록 개편 7단계): 칸 안의 두세 줄(학생+학년·학교, 학부모+전화+안내, 결제+금액)을 칸별로 나눴다.
          글자 왼쪽·금액/날짜 오른쪽(admin-cell-num), 말줄임 없음(좁으면 가로 스크롤). 행 클릭 = 기존 상세 서랍 */}
      <table className="admin-list-table w-full border-collapse text-sm">
        <thead className="bg-[var(--color-academy-soft)] text-xs text-[var(--color-academy-muted)]">
          <tr>
            <th className="px-2 py-2">
              <input
                type="checkbox"
                aria-label="현재 목록 전체 선택"
                checked={allVisibleSelected}
                disabled={visibleItemCount === 0}
                onChange={(event) => onToggleAll(event.target.checked)}
                className="h-5 w-5 rounded border-gray-300 accent-[var(--brand-accent)]"
              />
            </th>
            <th className="px-2 py-2">
              <ColHeader title="학생" open={openCol === "name"} onToggleOpen={() => toggleOpen("name")} active={sort.key === "name"}
                sortDir={sort.key === "name" ? sort.dir : null} onSort={sortFor("name")} />
            </th>
            <th className="hidden px-2 py-2 lg:table-cell">학년·학교</th>
            <th className="px-2 py-2">
              <ColHeader title="구분" open={openCol === "type"} onToggleOpen={() => toggleOpen("type")} active={exType.size > 0}
                options={typeOptions} excluded={exType} onToggleValue={toggleEx(setExType)} onAll={() => setExType(new Set())} onNone={() => setExType(new Set(typeOptions))} />
            </th>
            <th className="px-2 py-2">
              <ColHeader title="수업" open={openCol === "base"} onToggleOpen={() => toggleOpen("base")} active={exBase.size > 0}
                options={baseOptions} excluded={exBase} onToggleValue={toggleEx(setExBase)} onAll={() => setExBase(new Set())} onNone={() => setExBase(new Set(baseOptions))} />
            </th>
            <th className="px-2 py-2">상태</th>
            <th className="px-2 py-2">
              <ColHeader title="횟수" open={openCol === "freq"} onToggleOpen={() => toggleOpen("freq")} active={exFreq.size > 0}
                options={freqOptions} excluded={exFreq} onToggleValue={toggleEx(setExFreq)} onAll={() => setExFreq(new Set())} onNone={() => setExFreq(new Set(freqOptions))} />
            </th>
            <th className="px-2 py-2">
              <ColHeader title="학부모" open={openCol === "parent"} onToggleOpen={() => toggleOpen("parent")} active={sort.key === "parent"}
                sortDir={sort.key === "parent" ? sort.dir : null} onSort={sortFor("parent")} />
            </th>
            <th className="admin-cell-num hidden px-2 py-2 md:table-cell">연락처</th>
            <th className="hidden px-2 py-2 xl:table-cell">안내</th>
            <th className="px-2 py-2">
              <ColHeader title="결제" open={openCol === "pay"} onToggleOpen={() => toggleOpen("pay")} active={exPay.size > 0}
                options={payOptions} excluded={exPay} onToggleValue={toggleEx(setExPay)} onAll={() => setExPay(new Set())} onNone={() => setExPay(new Set(payOptions))} />
            </th>
            <th className="admin-cell-num hidden px-2 py-2 md:table-cell">금액</th>
            <th className="px-2 py-2">
              <ColHeader title="셔틀" open={openCol === "shuttle"} onToggleOpen={() => toggleOpen("shuttle")} active={exShuttle.size > 0} alignRight
                options={shuttleOptions} excluded={exShuttle} onToggleValue={toggleEx(setExShuttle)} onAll={() => setExShuttle(new Set())} onNone={() => setExShuttle(new Set(shuttleOptions))} />
            </th>
            <th className="admin-cell-num px-2 py-2">
              <ColHeader title="접수일" open={openCol === "createdAt"} onToggleOpen={() => toggleOpen("createdAt")} active={sort.key === "createdAt"} alignRight
                sortDir={sort.key === "createdAt" ? sort.dir : null} onSort={sortFor("createdAt")} />
            </th>
            <th className="admin-cell-center px-2 py-2"><span className="sr-only">상세</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-academy-line)]">
          {displayApplications.map((application) => {
            const itemIds = application.items.map((item) => item.id);
            const selectedCount = itemIds.filter((itemId) => selectedItemIdSet.has(itemId)).length;
            const checked = itemIds.length > 0 && selectedCount === itemIds.length;
            const classInfo = applicationClassInfo(application.items);
            const notice = notificationStatus(latestApplicationNotification(application));
            return (
              <tr
                key={application.id}
                tabIndex={0}
                aria-label={`${application.childName} 신청 상세 보기`}
                onClick={() => onSelect(application)}
                onKeyDown={(event) => handleRowKeyDown(event, application)}
                className={`cursor-pointer transition-colors focus:bg-[var(--color-academy-primary-soft)] focus:outline-none ${checked ? "bg-[var(--brand-accent-soft)]/60 dark:bg-gray-800" : "hover:bg-[var(--color-academy-soft)]"}`}
              >
                {/* 선택 체크박스 — 행 클릭(상세 서랍)과 겹치지 않게 전파 차단 */}
                <td className="px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`${application.childName} 신청 선택`}
                    checked={checked}
                    disabled={itemIds.length === 0}
                    onChange={(event) => onToggleApplication(application, event.target.checked)}
                    className="h-5 w-5 rounded border-gray-300 accent-[var(--brand-accent)]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <span className="font-black text-[var(--color-academy-ink)]">{application.childName}</span>
                  {selectedCount > 0 && <span className="ml-1.5 text-xs font-black tabular-nums text-[var(--brand-accent)]">{selectedCount}/{itemIds.length}개 선택</span>}
                </td>
                <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] lg:table-cell">{[application.childGrade, application.childSchool].filter(Boolean).join(" ") || "-"}</td>
                <td className="px-2 py-1.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-black ${application.applicantType === "NEW" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200" : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"}`}>{application.applicantType === "NEW" ? "신규" : application.applicantType === "EXISTING" ? "기존" : "-"}</span>
                </td>
                {/* 수업: 1개면 이름, 여러 개면 «첫 수업 외 N» — 전체는 상세 서랍 */}
                <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">
                  {classInfo.bases.length === 0 ? <span className="text-[var(--color-academy-muted)]">-</span>
                    : classInfo.bases.length === 1 ? classInfo.bases[0]
                    : <>{classInfo.bases[0]} 외 <span className="tabular-nums">{classInfo.bases.length - 1}</span></>}
                </td>
                <td className="px-2 py-1.5">
                  <span className="inline-flex gap-1">
                    {application.items.slice(0,2).map((item) => <span key={item.id} className={badge(item.status)}>{STATUS_LABEL[item.status]}</span>)}
                    {application.items.length > 2 && <span className="inline-flex min-h-7 items-center rounded-full bg-gray-100 px-2.5 text-xs font-bold text-gray-700 dark:bg-gray-700 dark:text-gray-200">+{application.items.length - 2}</span>}
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  <span className="inline-flex gap-1">
                    {classInfo.freqs.length ? classInfo.freqs.map((f) => <span key={f} className="inline-flex min-h-7 items-center rounded-full bg-[var(--brand-accent-soft)] px-2.5 text-xs font-black text-[var(--brand-accent)]">{f}</span>) : <span className="text-[var(--color-academy-muted)]">-</span>}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{application.parentName}</td>
                {/* 전화 걸기 링크 — 행 클릭과 겹치지 않게 전파 차단 */}
                <td className="admin-cell-num hidden px-2 py-1.5 md:table-cell">
                  <a href={`tel:${application.parentPhone}`} onClick={(event) => event.stopPropagation()} className="text-[var(--brand-accent)] hover:underline">{application.parentPhone}</a>
                </td>
                {/* 안내 문자 상태(가장 확인이 급한 것 하나) — 시각·재발송은 상세 서랍 */}
                <td className={`hidden px-2 py-1.5 text-xs font-bold xl:table-cell ${notice.className}`}>{notice.text}</td>
                <td className="px-2 py-1.5">
                  <span className={badge(application.paymentStatus)}>{STATUS_LABEL[application.paymentStatus || ""] ?? application.paymentStatus ?? "청구 전"}</span>
                </td>
                <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-ink)] md:table-cell">{(application.totalAmount ?? 0).toLocaleString()}원</td>
                <td className="px-2 py-1.5">
                  {application.shuttleNeeded
                    ? <span className="inline-flex min-h-7 items-center rounded-full bg-green-100 px-2.5 text-xs font-black text-green-700 dark:bg-green-900/40 dark:text-green-200">🚌 이용</span>
                    : <span className="inline-flex min-h-7 items-center rounded-full bg-gray-100 px-2.5 text-xs font-black text-gray-500 dark:bg-gray-700 dark:text-gray-300">미이용</span>}
                </td>
                <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{application.createdAt ? kstLabel(application.createdAt) : "미정"}</td>
                <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                  <button type="button" onClick={() => onSelect(application)} className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-academy-line)] px-3 font-bold">상세</button>
                </td>
              </tr>
            );
          })}
          {!displayApplications.length && <tr><td colSpan={15}><Empty text="조건에 맞는 신청이 없습니다." /></td></tr>}
        </tbody>
      </table>
    </div>
    {pagination.totalPages > 1 && (
      <nav className="mt-4 flex flex-col gap-2 text-sm font-bold sm:flex-row sm:items-center sm:justify-between" aria-label="신청 목록 페이지">
        <span className="text-gray-500">
          {pagination.total.toLocaleString()}건 중 {(pagination.page - 1) * pagination.pageSize + 1}-
          {Math.min(pagination.page * pagination.pageSize, pagination.total).toLocaleString()}건
        </span>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={pagination.page <= 1}
            onClick={() => onPage(pagination.page - 1)}
            className="min-h-10 rounded-lg border border-gray-200 px-3 disabled:opacity-40 dark:border-gray-700"
          >
            이전
          </button>
          <span className="px-2">{pagination.page} / {pagination.totalPages}</span>
          <button
            type="button"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => onPage(pagination.page + 1)}
            className="min-h-10 rounded-lg border border-gray-200 px-3 disabled:opacity-40 dark:border-gray-700"
          >
            다음
          </button>
        </div>
      </nav>
    )}
  </Panel>}
  </div>;
}

function RosterView({ seasons, applications, roster, filters, loading, error, onFilters, onSelect }: {
  seasons: Season[];
  applications: Application[];
  roster: RosterPayload;
  filters: RosterFilters;
  loading: boolean;
  error: string;
  onFilters: Dispatch<SetStateAction<RosterFilters>>;
  onSelect: (application: Application) => void;
}) {
  const selectedSeason = seasons.find((season) => season.id === filters.seasonId);
  const offerings = operationalOfferingOptions(selectedSeason?.classes ?? seasons.flatMap((season) => season.classes));
  const changeFilter = (key: keyof typeof filters, value: string | number) => onFilters((current) => ({
    ...current,
    [key]: value,
    page: key === "page" ? Number(value) : 1,
    ...(key === "seasonId" ? { offeringId: "", weekday: "" } : {}),
  }));
  const openApplication = (applicationId: string) => {
    const application = applications.find((candidate) => candidate.id === applicationId);
    if (application) onSelect(application);
  };
  const downloadCsv = async () => {
    const params = new URLSearchParams({ view: "roster", page: "1", pageSize: "100" });
    for (const [key, value] of Object.entries(filters)) if (key !== "page" && value) params.set(key, String(value));
    const rows: RosterRow[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      params.set("page", String(page));
      const response = await fetch(`/api/admin/seasonal?${params.toString()}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "CSV 명단을 준비하지 못했습니다.");
      const payload = normalizeRosterPayload(body as Record<string, unknown>);
      rows.push(...payload.rows);
      totalPages = payload.pagination.totalPages;
      page += 1;
    } while (page <= totalPages);
    const csvRows = rows.map((row) => ({
      offering: row.offeringName,
      schedule: [row.weekday, row.scheduleLabel].filter(Boolean).join(" "),
      student: row.childName,
      grade: row.childGrade,
      school: row.childSchool,
      parent: maskRosterName(row.parentName),
      phone: maskRosterPhone(row.parentPhone),
      payment: STATUS_LABEL[row.paymentStatus] ?? row.paymentStatus,
      shuttle: STATUS_LABEL[row.shuttleStatus] ?? row.shuttleStatus,
    }));
    const csv = createCsv([
      { key: "offering", header: "반" },
      { key: "schedule", header: "요일·시간" },
      { key: "student", header: "학생" },
      { key: "grade", header: "학년" },
      { key: "school", header: "학교" },
      { key: "parent", header: "보호자" },
      { key: "phone", header: "연락처" },
      { key: "payment", header: "결제" },
      { key: "shuttle", header: "셔틀" },
    ] as const, csvRows);
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = createSafeCsvFilename(`특강명단_${selectedSeason?.name ?? "전체"}_${new Date().toISOString().slice(0, 10)}`);
    anchor.click();
    URL.revokeObjectURL(href);
  };
  const printTitle = [
    selectedSeason?.name,
    filters.date ? formatDate(filters.date) : "",
    offerings.find((offering) => offering.id === filters.offeringId)?.name,
    filters.weekday ? `${filters.weekday}요일` : "",
  ].filter(Boolean).join(" · ") || "방학특강 일자별 출석부";

  return <Panel title="일자별 출석부" icon="fact_check" action={<div className="print:hidden flex gap-2">
    <button type="button" onClick={() => window.print()} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-gray-200 px-3 text-sm font-black dark:border-gray-700"><Icon name="print" />인쇄</button>
    <button type="button" onClick={() => void downloadCsv().catch((caught) => window.alert(caught instanceof Error ? caught.message : "CSV 다운로드에 실패했습니다."))} className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-[var(--brand-accent)] px-3 text-sm font-black text-[var(--brand-accent-contrast)]"><Icon name="download" />CSV</button>
  </div>}>
    <style>{`@media print { @page { size: A4 landscape; margin: 12mm; } body * { visibility: hidden !important; } .seasonal-roster-print, .seasonal-roster-print * { visibility: visible !important; } .seasonal-roster-print { position: absolute; inset: 0; width: 100%; color: #000 !important; } .roster-desktop { display: block !important; } .roster-mobile, .print\\:hidden { display: none !important; } .seasonal-roster-print table { width: 100%; border-collapse: collapse; font-size: 10pt; } .seasonal-roster-print th, .seasonal-roster-print td { border: 1px solid #777; padding: 6px; } .seasonal-roster-print thead { display: table-header-group; } }`}</style>
    <div className="print:hidden mb-2 flex min-w-0 items-center gap-2 text-sm font-bold"><span>시즌</span><select aria-label="명단 시즌" value={filters.seasonId} onChange={(event) => changeFilter("seasonId", event.target.value)} className="h-11 min-h-11 flex-1 min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]"><option value="">전체 시즌</option>{seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></div>
    <CompactListFilters className="print:hidden" activeCount={[filters.offeringId, filters.weekday, filters.date, filters.paymentStatus, filters.shuttleStatus].filter(Boolean).length}
      resultCount={`명단 ${roster.pagination.total}명`}
      summary={[offerings.find(offering => offering.id === filters.offeringId)?.name, filters.date ? formatDate(filters.date) : "", filters.weekday ? `${filters.weekday}요일` : "", filters.paymentStatus ? STATUS_LABEL[filters.paymentStatus] ?? filters.paymentStatus : "", filters.shuttleStatus ? STATUS_LABEL[filters.shuttleStatus] ?? (filters.shuttleStatus === "NOT_USED" ? "미이용" : filters.shuttleStatus) : ""].filter(Boolean).join(" · ") || "전체 반 · 전체 일정"}
      onReset={() => onFilters(current => ({ ...current, offeringId: "", weekday: "", date: "", paymentStatus: "", shuttleStatus: "", page: 1 }))}
      search={<label className="relative block"><span className="sr-only">명단 검색</span><Icon name="search" className="absolute left-3 top-3 text-xl text-[var(--color-academy-muted)]" /><input type="search" enterKeyHint="search" value={filters.q} onChange={(event) => changeFilter("q", event.target.value)} placeholder="학생·학교 검색" className="min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] pl-10 pr-3 text-[17px]" /></label>}
    >
      <label className="grid min-w-0 gap-1 text-sm font-bold">운영 반<select aria-label="명단 반" value={filters.offeringId} onChange={(event) => changeFilter("offeringId", event.target.value)} className="h-11 min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]"><option value="">전체 운영 반</option>{offerings.map((offering) => <option key={offering.id} value={offering.id}>{offering.name}</option>)}</select></label>
      <label className="grid min-w-0 gap-1 text-sm font-bold">출석일<input aria-label="명단 출석일" type="date" value={filters.date} onChange={(event) => changeFilter("date", event.target.value)} className="h-11 max-w-full appearance-none box-border min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]" /></label>
      <label className="grid min-w-0 gap-1 text-sm font-bold">요일<select aria-label="명단 요일" value={filters.weekday} onChange={(event) => changeFilter("weekday", event.target.value)} className="h-11 min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]"><option value="">전체 요일</option>{["월","화","수","목","금","토","일"].map((day) => <option key={day} value={day}>{day}요일</option>)}</select></label>
      <label className="grid min-w-0 gap-1 text-sm font-bold">결제<select aria-label="명단 결제" value={filters.paymentStatus} onChange={(event) => changeFilter("paymentStatus", event.target.value)} className="h-11 min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]"><option value="">전체 결제</option><option value="PAID">결제 완료</option><option value="UNPAID">미결제</option><option value="PAYMENT_PENDING">결제 대기</option></select></label>
      <label className="grid min-w-0 gap-1 text-sm font-bold">셔틀<select aria-label="명단 셔틀" value={filters.shuttleStatus} onChange={(event) => changeFilter("shuttleStatus", event.target.value)} className="h-11 min-h-11 w-full min-w-0 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-[17px]"><option value="">전체 셔틀</option><option value="NOT_USED">미이용</option><option value="REQUESTED">요청</option><option value="UNASSIGNED">미배정</option><option value="ASSIGNED">배정 완료</option></select></label>
    </CompactListFilters>
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--color-academy-muted)]" aria-label="명단 현황"><span><span>확정</span> <strong className="text-[var(--color-academy-ink)]">{roster.stats.confirmed}</strong></span><span><span>미결제</span> <strong className="text-[var(--color-academy-ink)]">{roster.stats.unpaid}</strong></span><span><span>셔틀</span> <strong className="text-[var(--color-academy-ink)]">{roster.stats.shuttle}</strong></span></p>
    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
    {loading ? <Loading /> : <section className="seasonal-roster-print mt-4" aria-label="반별 확정 명단 결과">
      <div className="mb-3 hidden print:block"><h2 className="text-xl font-black">{printTitle}</h2><p className="text-sm">확정 {roster.stats.confirmed}명 · 출력 {formatDateTime(new Date().toISOString())}</p></div>
      <div className="roster-desktop hidden overflow-x-auto md:block"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="px-3 py-3">번호</th><th className="px-3 py-3">요일</th><th className="px-3 py-3">운영 반</th><th className="px-3 py-3">학생</th><th className="px-3 py-3">결제</th><th className="px-3 py-3">셔틀</th><th className="px-3 py-3">출석</th><th className="px-3 py-3">메모</th></tr></thead><tbody className="divide-y divide-gray-100">{roster.rows.map((row, index) => <tr key={row.id} className="hover:bg-gray-50"><td className="px-3 py-3">{(roster.pagination.page - 1) * roster.pagination.pageSize + index + 1}</td><td className="px-3 py-3 font-black">{row.weekday || "미정"}</td><td className="px-3 py-3 font-bold">{row.offeringName}</td><td className="px-3 py-3"><button type="button" onClick={() => openApplication(row.applicationId)} className="font-black hover:underline print:pointer-events-none">{row.childName}</button><p className="text-xs text-gray-500">{[row.childGrade,row.childSchool].filter(Boolean).join(" · ")}</p></td><td className="px-3 py-3"><span className={badge(row.paymentStatus)}>{STATUS_LABEL[row.paymentStatus] ?? row.paymentStatus}</span></td><td className="px-3 py-3"><span className={badge(row.shuttleStatus)}>{STATUS_LABEL[row.shuttleStatus] ?? (row.shuttleStatus === "NOT_USED" ? "미이용" : row.shuttleStatus)}</span></td><td className="px-3 py-3">□</td><td className="px-3 py-3"> </td></tr>)}{!roster.rows.length && <tr><td colSpan={8}><Empty text="조건에 맞는 출석부 명단이 없습니다." /></td></tr>}</tbody></table></div>
      <div className="roster-mobile space-y-3 md:hidden">{roster.rows.map((row) => <article key={row.id} className="rounded-xl border border-gray-200 p-4"><div className="flex items-start justify-between gap-2"><div><button type="button" onClick={() => openApplication(row.applicationId)} className="min-h-11 font-black hover:underline">{row.childName}</button><p className="text-xs text-gray-500">{[row.childGrade,row.childSchool].filter(Boolean).join(" · ")}</p></div><span className="rounded-full bg-[var(--brand-accent-soft)] px-2.5 py-1 text-xs font-black text-[var(--brand-accent)]">{row.weekday || "요일 미정"}</span></div><p className="mt-2 text-sm font-bold">{row.offeringName}</p><div className="mt-2 flex flex-wrap gap-2"><span className={badge(row.paymentStatus)}>{STATUS_LABEL[row.paymentStatus] ?? row.paymentStatus}</span><span className={badge(row.shuttleStatus)}>{STATUS_LABEL[row.shuttleStatus] ?? (row.shuttleStatus === "NOT_USED" ? "미이용" : row.shuttleStatus)}</span></div><button type="button" onClick={() => openApplication(row.applicationId)} className="mt-3 min-h-11 w-full rounded-lg border border-gray-200 font-bold">신청 상세</button></article>)}</div>
    </section>}
    {roster.pagination.totalPages > 1 && <nav className="print:hidden mt-4 flex items-center justify-center gap-3" aria-label="명단 페이지"><button type="button" disabled={filters.page <= 1} onClick={() => changeFilter("page", filters.page - 1)} className="min-h-10 rounded-lg border px-3 disabled:opacity-40">이전</button><span className="text-sm font-bold">{filters.page} / {roster.pagination.totalPages}</span><button type="button" disabled={filters.page >= roster.pagination.totalPages} onClick={() => changeFilter("page", filters.page + 1)} className="min-h-10 rounded-lg border px-3 disabled:opacity-40">다음</button></nav>}
  </Panel>;
}

function ApplicationDrawer({
  application,
  seasons,
  onClose,
  onUpdateItem,
  updatingItemIds,
  itemUpdateErrors,
  onSaveAssignment,
  assigningKey,
  onConvertItem,
  onCopyInvoiceLink,
  onRetryNotification,
  sendingNotificationKey,
  onResolveReview,
  resolvingReview,
  onUpdateApplicationStatus,
  updatingApplicationStatus,
  convertingItemId,
  onShuttleChanged,
}: {
  application: Application;
  seasons: Season[];
  onClose: () => void;
  onUpdateItem: (id: string, status: ItemStatus) => Promise<void>;
  updatingItemIds: Set<string>;
  itemUpdateErrors: Record<string, string>;
  onSaveAssignment: (input: AssignmentInput) => Promise<void>;
  assigningKey: string;
  onConvertItem: (id: string) => Promise<void>;
  onCopyInvoiceLink: (item: ApplicationItem) => Promise<void>;
  onRetryNotification: (scope: "application" | "item" | "invoice", id: string, trigger: string) => Promise<void>;
  sendingNotificationKey: string;
  onResolveReview: (applicationId: string, reviewNote: string) => Promise<void>;
  resolvingReview: boolean;
  onUpdateApplicationStatus: (applicationId: string, status: ApplicationCloseStatus) => Promise<void>;
  updatingApplicationStatus: string;
  convertingItemId: string;
  onShuttleChanged?: () => void;
}) {
  const totalAmount = application.totalAmount ?? application.items.reduce((sum, item) => sum + (item.amount ?? 0), 0);
  const parentPhoneHref = application.parentPhone ? `tel:${application.parentPhone}` : undefined;
  const parentSmsHref = application.parentPhone ? `sms:${application.parentPhone}` : undefined;
  const offeringOptions = seasons.find((season) => season.id === application.seasonId)?.classes ?? seasons.flatMap((season) => season.classes);
  const hasNoItems = application.items.length === 0;
  const applicationClosed = application.status === "CANCELLED" || application.status === "REJECTED";

  return <AdminModal onClose={onClose} titleId="application-title" panelClassName="h-full max-w-2xl rounded-none sm:ml-auto sm:mr-0 sm:rounded-l-2xl sm:rounded-r-none">
    <aside className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-7">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-[var(--brand-accent)]">신청 상세</p>
          <h2 id="application-title" className="mt-1 text-2xl font-black text-gray-950 dark:text-white">{application.childName} <span className="text-base text-gray-400">{application.childGrade || "학년 미입력"}</span></h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={badge(application.status)}>{STATUS_LABEL[application.status] ?? application.status}</span>
            <span className={badge(application.paymentStatus)}>{STATUS_LABEL[application.paymentStatus || ""] ?? application.paymentStatus ?? "청구 전"}</span>
            {application.shuttleNeeded && <span className={badge(application.shuttleStatus || "REQUESTED")}>셔틀 {STATUS_LABEL[application.shuttleStatus || "REQUESTED"]}</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="닫기" data-admin-modal-initial-focus className="rounded-full p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"><Icon name="close" /></button>
      </header>

      <ApplicationReviewSummary application={application} onResolveReview={onResolveReview} resolving={resolvingReview} />

      <section className="mt-6 grid gap-3 rounded-2xl bg-gray-50 p-4 text-sm dark:bg-gray-800 sm:grid-cols-2">
        <Info label="학부모">{application.parentName}{application.parentRelation ? ` · ${application.parentRelation}` : ""}</Info>
        <Info label="학부모 연락처">{application.parentPhone || "미입력"}</Info>
        <Info label="학생 정보">{[formatDate(application.childBirthDate), application.childGender, application.childPhone].filter(Boolean).join(" · ") || "미입력"}</Info>
        <Info label="학교">{[application.childSchool, application.childGrade].filter(Boolean).join(" · ") || "미입력"}</Info>
        <Info label="접수일">{formatDateTime(application.createdAt)}</Info>
        <Info label="예상 금액">{totalAmount.toLocaleString()}원</Info>
        {application.address && <div className="sm:col-span-2"><Info label="주소">{application.address}</Info></div>}
      </section>

      {/* 연락처가 없으면 눌러도 아무 일이 없는 빈 링크가 되므로, 번호가 있을 때만 버튼을 보여준다 */}
      {parentPhoneHref && parentSmsHref && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <a href={parentPhoneHref} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 font-bold text-gray-900 dark:border-gray-700 dark:text-white"><Icon name="call" />전화</a>
          <a href={parentSmsHref} className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 font-bold text-gray-900 dark:border-gray-700 dark:text-white"><Icon name="sms" />직접 문자</a>
        </div>
      )}

      <NotificationActionRow
        label="특강 신청 접수 안내"
        summary={application.notificationSummary?.trigger === "SPECIAL_APPLICATION_RECEIVED_PARENT" ? application.notificationSummary : null}
        sending={sendingNotificationKey === `application:${application.id}:SPECIAL_APPLICATION_RECEIVED_PARENT`}
        onSend={() => void onRetryNotification("application", application.id, "SPECIAL_APPLICATION_RECEIVED_PARENT")}
      />

      <section className="mt-7">
        <div className="flex items-end justify-between gap-3">
          <div>
            {/* 설명문 제거 — 아래 항목마다 승인/대기/반려/취소 버튼이 그대로 보인다 */}
            <h3 className="font-black text-gray-950 dark:text-white">신청 항목별 처리</h3>
          </div>
          <span className="text-xs font-bold text-gray-500 dark:text-gray-400">{application.items.length}개 반 신청</span>
        </div>
        <div className="mt-3 space-y-3">
          {hasNoItems && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-black">신청 반이 아직 없습니다.</p>
                  <p className="mt-1 text-xs font-bold opacity-80">반을 배정해 접수하거나, 실제 취소 건이면 여기서 신청 자체를 닫아 주세요.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {APPLICATION_CLOSE_STATUSES.map((status) => (
                    <button
                      key={status}
                      type="button"
                      disabled={applicationClosed || Boolean(updatingApplicationStatus)}
                      onClick={() => void onUpdateApplicationStatus(application.id, status)}
                      className="min-h-10 rounded-xl border border-amber-300 bg-white px-3 text-xs font-black text-amber-950 shadow-sm disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-400/40 dark:bg-gray-950 dark:text-amber-100"
                    >
                      {updatingApplicationStatus === status ? "처리 중" : STATUS_LABEL[status]}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}
          {hasNoItems && !applicationClosed && (
            <ApplicationAssignmentEditor
              application={application}
              offerings={offeringOptions}
              saving={assigningKey === application.id}
              error={itemUpdateErrors[application.id]}
              onSaveAssignment={onSaveAssignment}
            />
          )}
          {application.items.map((item) => (
            <ApplicationItemCard
              key={item.id}
              application={application}
              offerings={offeringOptions}
              item={item}
              onUpdateItem={onUpdateItem}
              updating={updatingItemIds.has(item.id)}
              updateError={itemUpdateErrors[item.id]}
              onSaveAssignment={onSaveAssignment}
              assignmentSaving={assigningKey === item.id}
              onConvertItem={onConvertItem}
              onCopyInvoiceLink={onCopyInvoiceLink}
              onRetryNotification={onRetryNotification}
              sendingNotificationKey={sendingNotificationKey}
              converting={convertingItemId === item.id}
              onShuttleChanged={onShuttleChanged}
            />
          ))}
        </div>
      </section>

      {application.memo && <section className="mt-6 rounded-2xl border border-gray-200 p-4 dark:border-gray-700"><h3 className="text-sm font-black text-gray-950 dark:text-white">요청사항</h3><p className="mt-2 whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-300">{application.memo}</p></section>}
      {application.processedNote && <section className="mt-3 rounded-2xl border border-gray-200 p-4 dark:border-gray-700"><h3 className="text-sm font-black text-gray-950 dark:text-white">처리 메모</h3><p className="mt-2 whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-300">{application.processedNote}</p></section>}
    </aside>
  </AdminModal>;
}

function ApplicationReviewSummary({ application, onResolveReview, resolving }: { application: Application; onResolveReview: (applicationId: string, reviewNote: string) => Promise<void>; resolving: boolean }) {
  const importedLabel = application.imported ? `가져온 신청${application.importSource ? ` · ${application.importSource}` : ""}` : "홈페이지 신청";
  const weekdays = application.selectedWeekdays?.length ? application.selectedWeekdays.map(weekdayLabel).join(" · ") : "요일 미확인";
  const needsReview = application.reviewReasons ?? [];
  const [reviewNote, setReviewNote] = useState("");
  return <section aria-label="운영 확인 정보" className="mt-5 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
    <div className="flex flex-wrap gap-2">
      <span className="inline-flex min-h-7 items-center rounded-full bg-[var(--brand-accent-soft)] px-2.5 text-xs font-black text-[var(--brand-accent)]">{applicantTypeLabel(application.applicantType)} 회원</span>
      <span className="inline-flex min-h-7 items-center rounded-full bg-gray-100 px-2.5 text-xs font-bold text-gray-700 dark:bg-gray-800 dark:text-gray-200"><Icon name={application.imported ? "upload_file" : "language"} className="mr-1 text-base" />{importedLabel}</span>
      <span className={badge(application.paymentStatus)}>{paymentReviewLabel(application.paymentStatus)}</span>
    </div>
    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><Info label="선택 요일">{weekdays}</Info><Info label="원본 가져오기">{application.imported ? "완료" : "해당 없음"}</Info></dl>
    {needsReview.length > 0 && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100"><p className="flex items-center gap-1 text-sm font-black"><Icon name="error" className="text-lg" />확인 필요</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{needsReview.map((reason) => <li key={reason}>{reason}</li>)}</ul><label className="mt-3 block text-xs font-black">검토 메모 (필수)<textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={2} placeholder="확인한 내용과 처리 근거를 입력하세요" className="mt-1 w-full rounded-lg border border-amber-300 bg-white p-2 font-normal text-gray-950 dark:border-amber-700 dark:bg-gray-900 dark:text-white" /></label><div className="mt-2 flex justify-end"><button type="button" disabled={resolving || !reviewNote.trim()} onClick={() => void onResolveReview(application.id, reviewNote.trim())} className="min-h-9 rounded-lg bg-amber-900 px-3 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-100 dark:text-amber-950">{resolving ? "처리 중…" : "검토 완료"}</button></div></div>}
  </section>;
}

function ApplicationAssignmentEditor({
  application,
  item,
  offerings,
  saving,
  error,
  onSaveAssignment,
}: {
  application: Application;
  item?: ApplicationItem;
  offerings: SeasonalClass[];
  saving: boolean;
  error?: string;
  onSaveAssignment: (input: AssignmentInput) => Promise<void>;
}) {
  const initialOfferingId = item?.classId || offerings[0]?.id || "";
  const [offeringId, setOfferingId] = useState(initialOfferingId);
  const [selectedWeekdays, setSelectedWeekdays] = useState<string[]>(() => normalizeWeekdayKeys(application.selectedWeekdays));
  const selectedOffering = useMemo(() => offerings.find((offering) => offering.id === offeringId), [offeringId, offerings]);
  const pricingOffering = useMemo(
    () => matchingOfferingForWeekdays(offerings, selectedOffering, selectedWeekdays),
    [offerings, selectedOffering, selectedWeekdays],
  );
  const [price, setPrice] = useState(() => String(item?.amount ?? assignmentPriceFor(application, selectedOffering)));
  const [localError, setLocalError] = useState("");
  const lastOfferingIdRef = useRef(initialOfferingId);
  const locked = Boolean(item?.enrollmentId || item?.paymentId);

  useEffect(() => {
    const nextOfferingId = item?.classId || offerings[0]?.id || "";
    const nextOffering = offerings.find((offering) => offering.id === nextOfferingId);
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setOfferingId(nextOfferingId);
      setSelectedWeekdays(normalizeWeekdayKeys(application.selectedWeekdays));
      setPrice(String(item?.amount ?? assignmentPriceFor(application, nextOffering)));
      setLocalError("");
      lastOfferingIdRef.current = nextOfferingId;
    });
    return () => { cancelled = true; };
  }, [application.id, application.selectedWeekdays, item?.id, item?.amount, item?.classId, offerings]);

  useEffect(() => {
    if (locked || !pricingOffering) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (pricingOffering.id !== offeringId) {
        lastOfferingIdRef.current = pricingOffering.id;
        setOfferingId(pricingOffering.id);
      } else if (lastOfferingIdRef.current !== offeringId) {
        lastOfferingIdRef.current = offeringId;
      }
      setPrice(String(assignmentPriceFor(application, pricingOffering)));
    });
    return () => { cancelled = true; };
  }, [application, locked, offeringId, pricingOffering]);

  const toggleWeekday = (value: string, checked: boolean) => {
    setSelectedWeekdays((current) => {
      const next = new Set(current);
      if (checked) next.add(value);
      else next.delete(value);
      return WEEKDAY_OPTIONS.map((option) => option.value).filter((weekday) => next.has(weekday));
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError("");
    const priceSnapshot = Number(price);
    if (!offeringId) {
      setLocalError("특강 반을 선택해 주세요.");
      return;
    }
    if (selectedWeekdays.length === 0) {
      setLocalError("학생이 참여할 요일을 선택해 주세요.");
      return;
    }
    if (!Number.isFinite(priceSnapshot) || priceSnapshot <= 0) {
      setLocalError("금액을 확인해 주세요.");
      return;
    }
    await onSaveAssignment({ applicationId: application.id, itemId: item?.id, offeringId, selectedWeekdays, priceSnapshot });
  };

  return <form onSubmit={submit} className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800/70">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h4 className="font-black text-gray-950 dark:text-white">{item ? "수업 정보" : "반 지정 필요"}</h4>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{locked ? "수강·청구 연결 후에는 이 화면에서 반 정보를 바꿀 수 없습니다." : "운영 반과 참여 요일을 고르면 금액은 자동으로 맞춰집니다."}</p>
      </div>
      <button type="submit" disabled={saving || locked || offerings.length === 0} className="min-h-9 rounded-lg bg-[var(--brand-accent)] px-3 text-xs font-black text-[var(--brand-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-50">{saving ? "저장 중…" : "저장"}</button>
    </div>
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px]">
      <label className="text-xs font-black text-gray-600 dark:text-gray-300">
        특강 반
        <select value={offeringId} disabled={saving || locked} onChange={(event) => setOfferingId(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold text-gray-950 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white">
          <option value="">반 선택</option>
          {offerings.map((offering) => <option key={offering.id} value={offering.id}>{offering.name}</option>)}
        </select>
      </label>
      <label className="text-xs font-black text-gray-600 dark:text-gray-300">
        자동 금액
        <input value={price} readOnly disabled={saving || locked} inputMode="numeric" type="number" min={1} className="mt-1 min-h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold text-gray-950 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white" />
      </label>
    </div>
    {!locked && <p className="mt-2 text-xs font-bold text-gray-500 dark:text-gray-400">저장 시 {applicantTypeLabel(application.applicantType)} · 주 {selectedWeekdays.length || "-"}회 기준으로 청구 금액을 다시 계산합니다.</p>}
    <fieldset className="mt-3">
      <legend className="text-xs font-black text-gray-600 dark:text-gray-300">참여 요일</legend>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {WEEKDAY_OPTIONS.map((option) => (
          <label key={option.value} className={`inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-black ${selectedWeekdays.includes(option.value) ? "border-[var(--brand-accent)] bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]" : "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"}`}>
            <input type="checkbox" disabled={saving || locked} checked={selectedWeekdays.includes(option.value)} onChange={(event) => toggleWeekday(option.value, event.target.checked)} className="sr-only" />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
    {(localError || error) && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs font-bold text-red-700 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-200">{localError || error}</p>}
  </form>;
}

// 최종 금액만 보이면 "왜 이 금액인지" 알 수 없어서, 할인이 붙은 항목은 계산 과정을 한 줄로 펼쳐 보여준다.
// 셔틀비는 할인 대상이 아니라는 점이 화면에서도 드러나야 한다.
function ItemPriceBreakdown({ item }: { item: ApplicationItem }) {
  const discount = item.siblingDiscountSnapshot ?? 0;
  if (discount <= 0) return null;
  const tuition = item.tuitionPriceSnapshot ?? 0;
  const shuttle = item.shuttleFeeSnapshot ?? 0;
  return (
    <p className="mt-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
      수강료 {tuition.toLocaleString()}원 · 형제할인 −{discount.toLocaleString()}원
      {shuttle > 0 ? ` · 셔틀비(할인 없음) +${shuttle.toLocaleString()}원` : ""}
    </p>
  );
}

function ApplicationItemCard({
  application,
  offerings,
  item,
  onUpdateItem,
  updating,
  updateError,
  onSaveAssignment,
  assignmentSaving,
  onConvertItem,
  onCopyInvoiceLink,
  onRetryNotification,
  sendingNotificationKey,
  converting,
  onShuttleChanged,
}: {
  application: Application;
  offerings: SeasonalClass[];
  item: ApplicationItem;
  onUpdateItem: (id: string, status: ItemStatus) => Promise<void>;
  updating: boolean;
  updateError?: string;
  onSaveAssignment: (input: AssignmentInput) => Promise<void>;
  assignmentSaving: boolean;
  onConvertItem: (id: string) => Promise<void>;
  onCopyInvoiceLink: (item: ApplicationItem) => Promise<void>;
  onRetryNotification: (scope: "application" | "item" | "invoice", id: string, trigger: string) => Promise<void>;
  sendingNotificationKey: string;
  converting: boolean;
  onShuttleChanged?: () => void;
}) {
  const quickStatuses: ItemStatus[] = ["APPROVED", "WAITLISTED", "REJECTED", "CANCELLED"];
  const statusNotification = itemNotification(item.status);
  const currentNotificationSummary = item.notificationSummary?.trigger === statusNotification?.trigger ? item.notificationSummary : null;
  return <article className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700" aria-busy={updating}>
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="font-black text-gray-950 dark:text-white">{item.className}</p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{item.scheduleLabel || "일정 미정"} · {(item.amount ?? 0).toLocaleString()}원</p>
        <ItemPriceBreakdown item={item} />
        {item.waitlistOrder && <p className="mt-1 text-xs font-bold text-amber-700 dark:text-amber-300">대기 {item.waitlistOrder}번</p>}
      </div>
      <span className={badge(item.status)}>{STATUS_LABEL[item.status]}</span>
    </div>
    <ApplicationAssignmentEditor
      application={application}
      item={item}
      offerings={offerings}
      saving={assignmentSaving}
      error={updateError}
      onSaveAssignment={onSaveAssignment}
    />
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {quickStatuses.map((status) => <button key={status} type="button" disabled={updating || item.status === status} onClick={() => void onUpdateItem(item.id, status)} className={`min-h-10 rounded-xl border px-3 text-sm font-black disabled:cursor-wait disabled:opacity-60 ${item.status === status ? "border-transparent bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]" : "border-gray-200 text-gray-700 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)] dark:border-gray-700 dark:text-gray-200"}`}>{updating ? "처리 중…" : STATUS_LABEL[status]}</button>)}
    </div>
    {updateError && <p role="alert" aria-live="assertive" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-200">{updateError}</p>}
    <label className="mt-4 block text-xs font-bold text-gray-500 dark:text-gray-400">
      상태 직접 변경
      <select value={item.status} disabled={updating} aria-busy={updating} onChange={(event) => void onUpdateItem(item.id, event.target.value as ItemStatus)} className="h-11 mt-1 min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 disabled:cursor-wait disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
        {["PENDING","APPROVED","WAITLISTED","REJECTED","CANCELLED"].map((value) => <option key={value} value={value}>{STATUS_LABEL[value]}</option>)}
      </select>
    </label>
    {statusNotification && <NotificationActionRow label={statusNotification.label} summary={currentNotificationSummary} sending={sendingNotificationKey === `item:${item.id}:${statusNotification.trigger}`} onSend={() => void onRetryNotification("item", item.id, statusNotification.trigger)} />}
    <ConversionReadinessBox item={item} onConvertItem={onConvertItem} converting={converting} />
    {item.invoice && <InvoiceActionBox item={item} onCopyInvoiceLink={onCopyInvoiceLink} onRetryNotification={onRetryNotification} sendingNotificationKey={sendingNotificationKey} onRefresh={onShuttleChanged} />}
    {item.shuttleRequest && <ShuttleRequestBox request={item.shuttleRequest} onChanged={onShuttleChanged} />}
  </article>;
}

function ConversionReadinessBox({ item, onConvertItem, converting }: { item: ApplicationItem; onConvertItem: (id: string) => Promise<void>; converting: boolean }) {
  const approved = item.status === "APPROVED";
  const hasClass = Boolean(item.linkedClassId);
  const hasEnrollment = Boolean(item.enrollmentId);
  const hasPayment = Boolean(item.paymentId);
  const readyToConvert = approved && (!hasEnrollment || !hasPayment);
  let title = "전환 준비됨";
  // 안내문은 제목(전환 준비됨 / 승인 후 청구서 발행 가능)의 풀어쓰기라 비워 둔다 — 다른 분기와 동일하게 helper = ""
  let helper = "";
  let tone = "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-100";

  if (hasEnrollment && hasPayment) {
    title = "수강·청구 완료";
    helper = "";
  } else if (!approved) {
    title = "승인 후 청구서 발행 가능";
    helper = "";
    tone = "border-gray-200 bg-gray-50 text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100";
  } else if (!hasClass) {
    title = "청구서 발행 가능";
    helper = "";
    tone = "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-950/30 dark:text-sky-100";
  } else if (!hasEnrollment && hasPayment) {
    title = "수강 등록 필요";
    helper = "";
    tone = "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100";
  } else if (hasEnrollment && !hasPayment) {
    title = "청구서 발행 필요";
    helper = "";
    tone = "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100";
  }

  return <div className={`mt-4 rounded-xl border p-3 text-sm ${tone}`}>
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p className="font-black">{title}</p>
        <p className="mt-1 text-xs opacity-80">{helper}</p>
      </div>
      <div className="flex shrink-0 flex-wrap justify-start gap-1 sm:justify-end">
        <MiniState active={hasClass} label="반 연결" />
        <MiniState active={hasEnrollment} label="수강" />
        <MiniState active={hasPayment} label="청구" />
        {readyToConvert && (
          <button
            type="button"
            disabled={converting}
            onClick={() => void onConvertItem(item.id)}
            className="ml-0 min-h-8 rounded-full bg-[var(--brand-accent)] px-3 text-[11px] font-black text-[var(--brand-accent-contrast)] disabled:opacity-60 sm:ml-2"
          >
            {converting ? "생성 중" : "수강·청구 생성"}
          </button>
        )}
      </div>
    </div>
  </div>;
}

function MiniState({ active, label }: { active: boolean; label: string }) {
  return <span className={`rounded-full px-2 py-1 text-[11px] font-black ${active ? "bg-white text-emerald-700 dark:bg-emerald-100 dark:text-emerald-900" : "bg-white/60 text-gray-500 dark:bg-gray-900/50 dark:text-gray-300"}`}>{label}</span>;
}

function InvoiceActionBox({ item, onCopyInvoiceLink, onRetryNotification, sendingNotificationKey, onRefresh }: { item: ApplicationItem; onCopyInvoiceLink: (item: ApplicationItem) => Promise<void>; onRetryNotification: (scope: "application" | "item" | "invoice", id: string, trigger: string) => Promise<void>; sendingNotificationKey: string; onRefresh?: () => void }) {
  const href = getItemInvoiceHref(item);
  const activationRequired = Boolean(item.invoice?.accountActivationRequired);
  const defaultTrigger = activationRequired ? "SPECIAL_ACCOUNT_ACTIVATION_PARENT" : "SPECIAL_PAYMENT_REQUEST_PARENT";
  const notificationLabel = activationRequired ? "가입 안내·결제" : "결제 요청 안내";
  const currentNotificationSummary = item.invoice?.notificationSummary?.trigger === defaultTrigger ? item.invoice.notificationSummary : null;
  const isPaid = item.invoice?.status === "PAID" || item.invoice?.status === "COMPLETED";
  const [paying, setPaying] = useState<"CASH" | "BANK_TRANSFER" | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);

  async function handleMarkPaid(method: "CASH" | "BANK_TRANSFER") {
    if (!item.id) return;
    const label = method === "CASH" ? "현금" : "계좌이체";
    if (!window.confirm(`${label} 납부 완료로 처리할까요? 이 작업은 되돌리기 어렵습니다.`)) return;
    setPaying(method); setPayErr(null);
    try {
      const r = await fetch(`/api/admin/seasonal/${item.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "markPaid", method }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "납부 처리에 실패했습니다.");
      onRefresh?.();
    } catch (e: any) { setPayErr(e?.message || "납부 처리에 실패했습니다."); }
    finally { setPaying(null); }
  }

  return <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="flex items-center gap-2">
          <p className="font-black text-gray-950 dark:text-white">청구서</p>
          {isPaid && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-black text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">납부 완료</span>}
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {item.invoice?.invoiceNo || "청구번호 준비됨"} · {STATUS_LABEL[item.invoice?.status || ""] ?? item.invoice?.status ?? "발행"}
        </p>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {(item.invoice?.amount ?? item.amount ?? 0).toLocaleString()}원 · 납부기한 {formatDate(item.invoice?.dueDate)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {href && <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-xl border border-gray-200 px-3 text-xs font-black text-gray-700 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)] dark:border-gray-700 dark:text-gray-200">청구서 열기</a>}
        {!isPaid && <button type="button" onClick={() => void onCopyInvoiceLink(item)} className="inline-flex min-h-10 items-center rounded-xl bg-[var(--brand-accent)] px-3 text-xs font-black text-[var(--brand-accent-contrast)]">{activationRequired ? "가입 링크 재발급·복사" : "결제 링크 복사"}</button>}
      </div>
    </div>
    {!isPaid && item.invoice && <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
      <p className="w-full text-xs font-bold text-gray-500 dark:text-gray-400">직접 납부 확인</p>
      <button type="button" disabled={paying !== null} onClick={() => void handleMarkPaid("CASH")} className="inline-flex min-h-9 items-center rounded-xl border border-gray-200 px-3 text-xs font-black text-gray-800 hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-50 dark:border-gray-700 dark:text-white">{paying === "CASH" ? "처리 중…" : "현금 납부 완료"}</button>
      <button type="button" disabled={paying !== null} onClick={() => void handleMarkPaid("BANK_TRANSFER")} className="inline-flex min-h-9 items-center rounded-xl border border-gray-200 px-3 text-xs font-black text-gray-800 hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-50 dark:border-gray-700 dark:text-white">{paying === "BANK_TRANSFER" ? "처리 중…" : "계좌이체 납부 완료"}</button>
      {payErr && <p className="w-full text-xs font-bold text-red-600">⚠ {payErr}</p>}
    </div>}
    <NotificationActionRow label={notificationLabel} summary={currentNotificationSummary} sending={sendingNotificationKey === `invoice:${item.id}:${defaultTrigger}`} onSend={() => void onRetryNotification("invoice", item.id, defaultTrigger)} />
  </div>;
}

function itemNotification(status: ItemStatus) {
  const notifications: Partial<Record<ItemStatus, { label: string; trigger: string }>> = {
    APPROVED: { label: "특강 승인 안내", trigger: "SPECIAL_APPLICATION_APPROVED_PARENT" },
    WAITLISTED: { label: "특강 대기 안내", trigger: "SPECIAL_APPLICATION_WAITLISTED_PARENT" },
    REJECTED: { label: "특강 반려 안내", trigger: "SPECIAL_APPLICATION_REJECTED_PARENT" },
    CANCELLED: { label: "특강 취소 안내", trigger: "SPECIAL_APPLICATION_CANCELLED_PARENT" },
  };
  return notifications[status] ?? null;
}

function latestApplicationNotification(application: Application) {
  const summaries = [
    application.notificationSummary,
    ...application.items.flatMap((item) => [item.notificationSummary, item.invoice?.notificationSummary]),
  ].filter((summary): summary is NotificationSummary => Boolean(summary));
  const priority: Record<NotificationSummary["status"], number> = { FAILED: 6, UNKNOWN: 5, SENDING: 4, PENDING: 3, SKIPPED: 2, SENT: 1 };
  return summaries.sort((a, b) => priority[b.status] - priority[a.status] || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
}

function notificationStatus(summary?: NotificationSummary | null) {
  if (!summary) return { text: "미발송", className: "text-gray-500 dark:text-gray-400" };
  if (notificationNeedsReview(summary)) return { text: "발송 여부 확인 필요", className: "text-amber-700 dark:text-amber-300" };
  if (summary.status === "SENDING") return { text: "발송 처리 중", className: "text-amber-700 dark:text-amber-300" };
  if (summary.status === "PENDING") return { text: "발송 중", className: "text-amber-700 dark:text-amber-300" };
  if (summary.status === "SENT") return { text: "발송 완료", className: "text-emerald-700 dark:text-emerald-300" };
  if (summary.status === "FAILED") return { text: "발송 실패", className: "text-red-700 dark:text-red-300" };
  if (summary.status === "SKIPPED") return { text: "템플릿 꺼짐·미발송", className: "text-amber-700 dark:text-amber-300" };
  return { text: "발송 상태 확인 필요", className: "text-amber-700 dark:text-amber-300" };
}

function notificationNeedsReview(summary?: NotificationSummary | null) {
  if (!summary) return false;
  if (summary.errorCode === "FAILED_DELIVERY_UNCERTAIN") return true;
  if (summary.status === "UNKNOWN") return true;
  if (summary.status !== "PENDING" && summary.status !== "SENDING") return false;
  const updatedAt = new Date(summary.updatedAt).getTime();
  const staleAfterMs = summary.status === "SENDING" ? 2 * 60 * 1000 : 15 * 60 * 1000;
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= staleAfterMs;
}

function notificationMutationFailed(result: NotificationMutationResponse) {
  return Boolean(
    result.notificationWarning
    || result.notification?.status === "FAILED"
    || result.notification?.errorCode === "TEMPLATE_DISABLED_OR_MISSING",
  );
}

function NotificationActionRow({ label, summary, sending, onSend }: { label: string; summary?: NotificationSummary | null; sending: boolean; onSend: () => void }) {
  const state = notificationStatus(summary);
  const needsReview = notificationNeedsReview(summary);
  const pending = sending || ((summary?.status === "PENDING" || summary?.status === "SENDING") && !needsReview);
  const disabled = pending || Boolean(summary && !summary.canRetry && !needsReview);
  return <div className="mt-3 flex flex-col gap-2 rounded-xl bg-gray-50 p-3 text-sm dark:bg-gray-800 sm:flex-row sm:items-center sm:justify-between" aria-live="polite">
    <div className="min-w-0">
      <p className="font-black text-gray-900 dark:text-white">{label}</p>
      <p className={`mt-1 text-xs font-bold ${state.className}`}>{pending ? "발송 중" : state.text}{summary?.updatedAt ? ` · ${formatDateTime(summary.updatedAt)}` : ""}</p>
      {summary?.status === "FAILED" && summary.errorCode && <p className="mt-1 text-xs text-red-600 dark:text-red-300">{NOTIFICATION_ERROR_LABEL[summary.errorCode] ?? "발송 오류 — 솔라피 이력을 확인해주세요."}</p>}
      {needsReview && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">중복 발송을 피하려면 발송 이력을 확인한 뒤 재시도하세요.</p>}
      {summary?.status === "SKIPPED" && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">문자 템플릿이 켜져 있는지 확인한 뒤 재시도하세요.</p>}
    </div>
    <button type="button" disabled={disabled} onClick={onSend} aria-label={`${label} ${needsReview ? "확인 후 재시도" : summary ? "재발송" : "발송"}`} className="min-h-10 shrink-0 rounded-xl border border-gray-200 bg-white px-3 text-xs font-black text-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-white">{pending ? "발송 중…" : needsReview ? "확인 후 재시도" : summary ? "재발송" : "발송"}</button>
  </div>;
}

type ShuttlePoint = {
  label: string;
  location?: string | null;
  address?: string | null;
  roadAddress?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  placeId?: string | null;
  source?: string | null;
  accuracyMeters?: number | string | null;
  confirmedAt?: string | null;
};

function shuttlePoint(request: ShuttleRequest, kind: ShuttlePointKind): ShuttlePoint {
  if (kind === "pickup") {
    return {
      label: "탑승 위치",
      location: request.pickupLocation,
      address: request.pickupAddress,
      roadAddress: request.pickupRoadAddress,
      latitude: request.pickupLatitude,
      longitude: request.pickupLongitude,
      placeId: request.pickupPlaceId,
      source: request.pickupLocationSource,
      accuracyMeters: request.pickupAccuracyMeters,
      confirmedAt: request.pickupConfirmedAt,
    };
  }
  return {
    label: "하차 위치",
    location: request.dropoffLocation,
    address: request.dropoffAddress,
    roadAddress: request.dropoffRoadAddress,
    latitude: request.dropoffLatitude,
    longitude: request.dropoffLongitude,
    placeId: request.dropoffPlaceId,
    source: request.dropoffLocationSource,
    accuracyMeters: request.dropoffAccuracyMeters,
    confirmedAt: request.dropoffConfirmedAt,
  };
}

function finiteCoordinate(value?: number | string | null) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ShuttleLocationCard({ point }: { point: ShuttlePoint }) {
  const latitude = finiteCoordinate(point.latitude);
  const longitude = finiteCoordinate(point.longitude);
  const hasCoordinates = latitude !== null && longitude !== null;
  const displayAddress = point.roadAddress || point.address || point.location || "위치 미입력";
  const searchQuery = displayAddress === "위치 미입력" ? "" : displayAddress;
  const encodedLabel = encodeURIComponent(`${point.label} ${displayAddress}`);
  const kakaoHref = hasCoordinates
    ? `https://map.kakao.com/link/map/${encodedLabel},${latitude},${longitude}`
    : searchQuery ? `https://map.kakao.com/?q=${encodeURIComponent(searchQuery)}` : null;
  const naverHref = hasCoordinates
    ? `https://map.naver.com/p?c=${longitude},${latitude},15,0,0,0,dh`
    : searchQuery ? `https://map.naver.com/p/search/${encodeURIComponent(searchQuery)}` : null;
  const accuracy = finiteCoordinate(point.accuracyMeters);

  return <article className="min-w-0 rounded-xl border border-blue-200 bg-white p-3 dark:border-blue-800 dark:bg-gray-900">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={point.label === "탑승 위치" ? "trip_origin" : "location_on"} className="shrink-0 text-xl text-blue-700 dark:text-blue-300" />
        <h5 className="font-black text-gray-950 dark:text-white">{point.label}</h5>
      </div>
      {hasCoordinates ? (
        <span className={badge("UNASSIGNED")}>지도 핀 제출 · 관리자 확인 필요</span>
      ) : (
        <span className={badge("UNASSIGNED")}>텍스트 신청 · 위치 확인 필요</span>
      )}
    </div>

    <p className="mt-3 break-words text-sm font-bold text-gray-900 dark:text-white">{displayAddress}</p>
    {point.location && point.location !== displayAddress && <p className="mt-1 break-words text-xs text-gray-600 dark:text-gray-300">상세 설명: {point.location}</p>}
    {(kakaoHref || naverHref) && <div className="mt-3 grid grid-cols-2 gap-2">
      {kakaoHref && <a href={kakaoHref} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-blue-200 bg-white px-2 text-xs font-black text-blue-800 hover:bg-blue-50 dark:border-blue-800 dark:bg-gray-900 dark:text-blue-200 dark:hover:bg-blue-950/40"><Icon name="map" className="text-base" />카카오맵</a>}
      {naverHref && <a href={naverHref} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-emerald-200 bg-white px-2 text-xs font-black text-emerald-800 hover:bg-emerald-50 dark:border-emerald-800 dark:bg-gray-900 dark:text-emerald-200 dark:hover:bg-emerald-950/40"><Icon name="map" className="text-base" />네이버 지도</a>}
    </div>}
  </article>;
}

function ShuttleRequestBox({ request, onChanged }: { request: ShuttleRequest; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cancelled = request.status === "CANCELLED";
  async function toggleRide(ride: boolean) {
    if (busy || !request.id) return;
    if (!ride && typeof window !== "undefined" && !window.confirm("이 학생의 셔틀 신청을 취소(미이용)할까요? 배차 명단에서 빠집니다.")) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/admin/seasonal/shuttle-roster", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: request.id, patch: { ride } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "저장 실패");
      onChanged?.();
    } catch (e: any) { setErr(e?.message || "셔틀 상태를 바꾸지 못했습니다."); }
    finally { setBusy(false); }
  }
  // 취소(미이용) 상태면 회색 톤 + 상세 카드를 접어, 실제로 신청이 빠졌음을 한눈에 알 수 있게 한다.
  return <div className={`mt-4 min-w-0 rounded-xl p-3 text-sm ${cancelled ? "bg-gray-100 dark:bg-gray-800/50" : "bg-blue-50 dark:bg-blue-950/30"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className={`font-black ${cancelled ? "text-gray-500 line-through dark:text-gray-400" : "text-blue-900 dark:text-blue-100"}`}>셔틀 요청</h4>
      <div className="flex items-center gap-2">
        <span className={badge(request.status || "REQUESTED")}>{STATUS_LABEL[request.status || "REQUESTED"]}</span>
        {cancelled
          ? <button type="button" disabled={busy} onClick={() => toggleRide(true)} className="rounded-lg border border-green-300 px-2.5 py-1 text-[11px] font-black text-green-700 disabled:opacity-50">{busy ? "처리 중…" : "🚌 셔틀 이용으로 변경"}</button>
          : <button type="button" disabled={busy} onClick={() => toggleRide(false)} className="rounded-lg border border-red-300 px-2.5 py-1 text-[11px] font-black text-red-600 disabled:opacity-50">{busy ? "처리 중…" : "🚫 셔틀 신청 취소"}</button>}
      </div>
    </div>
    {err && <p className="mt-1 text-[11px] font-bold text-red-600">⚠ {err}</p>}
    {cancelled ? (
      <p className="mt-2 rounded-lg bg-white px-3 py-2 text-xs font-bold text-gray-500 dark:bg-gray-900 dark:text-gray-400">🚫 셔틀 미이용 처리됨 — 배차 명단에서 제외되었습니다. 다시 태우려면 위 버튼을 누르세요.</p>
    ) : <>
      <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
        <ShuttleLocationCard point={shuttlePoint(request, "pickup")} />
        <ShuttleLocationCard point={shuttlePoint(request, "dropoff")} />
      </div>
      {request.pickupTime && <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        <Info label="희망 시간">{request.pickupTime}</Info>
      </dl>}
      {request.note && <p className="mt-3 whitespace-pre-wrap break-words text-xs text-blue-900 dark:text-blue-100">{request.note}</p>}
    </>}
  </div>;
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <p><span className="block text-xs font-bold text-gray-500 dark:text-gray-400">{label}</span><b className="font-bold text-gray-900 dark:text-white">{children}</b></p>;
}

function dateInputValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toISOString().slice(0, 10);
}

function dateTimeInputValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function missingAttendancePreparation(linkedClassId?: string | null, instructorId?: string | null) {
  return [
    !linkedClassId?.trim() ? "연결 반" : null,
    !instructorId?.trim() ? "담당 강사" : null,
  ].filter((item): item is string => Boolean(item));
}

function SeasonForm({ initial, onClose, onSubmit }: { initial?: Season | null; onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<void> }) {
  return <FormModal title="새 방학특강 시즌" onClose={onClose} onSubmit={onSubmit} fields={[{name:"title",label:"시즌명",placeholder:"예: 2026 여름방학 특강",required:true,defaultValue:initial?.name},{name:"slug",label:"홈페이지 주소",placeholder:"예: 2026-summer",required:true,defaultValue:initial?.slug},{name:"applicationOpensAt",label:"모집 시작일",type:"date",required:true,defaultValue:dateInputValue(initial?.enrollmentStartsAt)},{name:"applicationClosesAt",label:"모집 종료일",type:"date",required:true,defaultValue:dateInputValue(initial?.enrollmentEndsAt)},{name:"startsAt",label:"수업 시작일",type:"date",required:true,defaultValue:dateInputValue(initial?.startsAt)},{name:"endsAt",label:"수업 종료일",type:"date",required:true,defaultValue:dateInputValue(initial?.endsAt)}]} />;
}

function ClassForm({ seasonId, initial, coaches, onClose, onSubmit }: { seasonId: string; initial?: SeasonalClass | null; coaches: CoachOption[]; onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [selectedInstructorId, setSelectedInstructorId] = useState(initial?.instructorId ?? "");
  const [attendanceReadiness, setAttendanceReadiness] = useState({
    status: initial?.status ?? "DRAFT",
    instructorId: initial?.instructorId ?? "",
    linkedClassId: initial?.linkedClassId ?? "",
  });
  const [sessionDates, setSessionDates] = useState(() => initial?.sessionDates?.length
    ? initial.sessionDates.map((row) => ({ id: row.id, startsAt: dateTimeInputValue(row.startsAt), endsAt: dateTimeInputValue(row.endsAt), location: row.location ?? "", note: row.note ?? "" }))
    : [{ startsAt: "", endsAt: "", location: initial?.location ?? "", note: "" }]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    const capacity = String(payload.capacity ?? "").trim();
    const newApplicantPrice = String(payload.newApplicantPrice ?? "").trim();
    const existingApplicantPrice = String(payload.existingApplicantPrice ?? "").trim();
    const shuttleFee = String(payload.shuttleFee ?? "").trim();
    try {
      await onSubmit({
        ...payload,
        seasonId,
        capacity: capacity ? Number(capacity) : null,
        price: Number(payload.price),
        newApplicantPrice: newApplicantPrice ? Number(newApplicantPrice) : null,
        existingApplicantPrice: existingApplicantPrice ? Number(existingApplicantPrice) : null,
        shuttleFee: shuttleFee ? Number(shuttleFee) : 0,
        shuttleAvailable: payload.shuttleAvailable === "on",
        sessionDates: sessionDates.map((row) => ({
          ...row,
          startsAt: seoulDateTimeToIso(row.startsAt),
          endsAt: seoulDateTimeToIso(row.endsAt),
        })),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "저장하지 못했습니다.");
      setPending(false);
    }
  }

  const inputClass = "mt-1 min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 font-normal text-gray-950 dark:border-gray-700 dark:bg-gray-800 dark:text-white";
  const selectedCoach = coaches.find((coach) => coach.id === selectedInstructorId);
  const currentCoachMissingFromOptions = Boolean(selectedInstructorId && !selectedCoach);
  const attendanceMissing = ["OPEN", "CLOSED"].includes(attendanceReadiness.status)
    ? missingAttendancePreparation(attendanceReadiness.linkedClassId, attendanceReadiness.instructorId)
    : [];
  return <AdminModal onClose={() => { if (!pending) onClose(); }} titleId="seasonal-class-modal-title"><form onSubmit={submit} className="w-full max-w-3xl p-6"><header className="flex items-center justify-between"><div><h2 id="seasonal-class-modal-title" className="text-xl font-black">{initial ? "특강 반 수정" : "특강 반 추가"}</h2></div><button type="button" onClick={onClose} disabled={pending} aria-label="닫기"><Icon name="close" /></button></header>
    {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
    <div className="mt-5 grid gap-4 sm:grid-cols-2">
      <ClassInput name="code" label="반 코드" required defaultValue={initial?.code} placeholder="예: MON-1" />
      <ClassInput name="title" label="반 이름" required defaultValue={initial?.name} placeholder="예: 초등 고학년 1교시" />
      <ClassInput name="targetGrades" label="대상" required defaultValue={initial?.targetGrades ?? initial?.targetGrade} placeholder="예: 초등 4~6학년" />
      <ClassInput name="location" label="기본 수업 장소" defaultValue={initial?.location} placeholder="예: 다산2호점" />
      <ClassInput name="capacity" label="정원 (미확정 가능)" type="number" defaultValue={initial?.capacity} />
      <ClassInput name="price" label="기본 수강료" type="number" required defaultValue={initial?.price} />
      <ClassInput name="newApplicantPrice" label="신규 회원 수강료" type="number" defaultValue={initial?.newApplicantPrice} />
      <ClassInput name="existingApplicantPrice" label="기존 회원 수강료" type="number" defaultValue={initial?.existingApplicantPrice} />
      <ClassInput name="shuttleFee" label="셔틀비" type="number" defaultValue={initial?.shuttleFee ?? 0} />
      <label className="text-sm font-bold text-gray-700 dark:text-gray-200">담당 선생님
        <select name="instructorId" value={selectedInstructorId} onChange={(event) => {
          setSelectedInstructorId(event.target.value);
          setAttendanceReadiness((current) => ({ ...current, instructorId: event.target.value }));
        }} className={inputClass}>
          <option value="">담당자 미정</option>
          {currentCoachMissingFromOptions && <option value={selectedInstructorId}>{initial?.instructorName || "현재 담당 선생님"}</option>}
          {coaches.map((coach) => <option key={coach.id} value={coach.id}>{coach.name}</option>)}
        </select>
        <input type="hidden" name="instructorName" value={selectedCoach?.name ?? (currentCoachMissingFromOptions ? initial?.instructorName ?? "" : "")} />
      </label>
      <ClassInput name="linkedProgramId" label="연결 프로그램 ID" defaultValue={initial?.linkedProgramId} placeholder="기존 프로그램 ID (선택)" />
      <ClassInput name="linkedClassId" label="연결 정규 반 ID" defaultValue={initial?.linkedClassId} placeholder="수강·출석에 연결할 반 ID" onChange={(value) => setAttendanceReadiness((current) => ({ ...current, linkedClassId: value }))} />
      <label className="text-sm font-bold text-gray-700 dark:text-gray-200">공개 상태<select name="status" value={attendanceReadiness.status} onChange={(event) => setAttendanceReadiness((current) => ({ ...current, status: event.target.value as NonNullable<SeasonalClass["status"]> }))} className={inputClass}><option value="DRAFT">작성 중</option><option value="OPEN">모집 중</option><option value="CLOSED">모집 마감</option><option value="CANCELLED">취소</option></select></label>
      <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border border-gray-200 px-3 text-sm font-bold dark:border-gray-700"><input name="shuttleAvailable" type="checkbox" defaultChecked={initial?.shuttleAvailable} className="size-5" />셔틀 이용 가능</label>
    </div>
    {attendanceMissing.length > 0 && <div role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"><p className="flex items-center gap-2 font-black"><Icon name="warning" />출석 준비 미완료</p><p className="mt-1">빠진 항목: {attendanceMissing.join(" · ")}. 모집 상태로 저장할 수 있지만 수업 시작 전 연결해 주세요.</p></div>}
    <section className="mt-6 border-t border-gray-100 pt-5 dark:border-gray-800"><div className="flex items-center justify-between"><div><h3 className="font-black">전체 수업 일정</h3><p className="text-xs text-gray-500">학생에게 안내할 모든 회차를 입력하세요.</p></div><button type="button" onClick={() => setSessionDates((rows) => [...rows, { startsAt: "", endsAt: "", location: initial?.location ?? "", note: "" }])} className="min-h-10 rounded-lg border border-gray-200 px-3 text-sm font-bold dark:border-gray-700">회차 추가</button></div>
      <div className="mt-3 space-y-3">{sessionDates.map((row, index) => <div key={index} className="grid gap-3 rounded-xl bg-gray-50 p-3 sm:grid-cols-2 dark:bg-gray-800"><label className="text-xs font-bold">{index + 1}회 시작<input required type="datetime-local" value={row.startsAt} onChange={(event) => setSessionDates((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, startsAt: event.target.value } : item))} className={inputClass} /></label><label className="text-xs font-bold">{index + 1}회 종료<input required type="datetime-local" value={row.endsAt} onChange={(event) => setSessionDates((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, endsAt: event.target.value } : item))} className={inputClass} /></label><label className="text-xs font-bold">장소<input value={row.location} onChange={(event) => setSessionDates((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, location: event.target.value } : item))} className={inputClass} /></label><div className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs font-bold">메모<input value={row.note} onChange={(event) => setSessionDates((rows) => rows.map((item, rowIndex) => rowIndex === index ? { ...item, note: event.target.value } : item))} className={inputClass} /></label>{sessionDates.length > 1 && <button type="button" aria-label={`${index + 1}회 삭제`} onClick={() => setSessionDates((rows) => rows.filter((_, rowIndex) => rowIndex !== index))} className="mb-0 min-h-11 rounded-lg border border-red-200 px-3 text-sm font-bold text-red-700">삭제</button>}</div></div>)}</div>
    </section>
    <footer className="mt-6 flex justify-end gap-2"><button type="button" onClick={onClose} disabled={pending} className="min-h-11 rounded-xl border border-gray-200 px-4 font-bold disabled:opacity-60 dark:border-gray-700">취소</button><button disabled={pending} className="min-h-11 rounded-xl bg-[var(--brand-accent)] px-5 font-black text-[var(--brand-accent-contrast)] disabled:opacity-60">{pending ? "저장 중…" : "저장"}</button></footer>
  </form></AdminModal>;
}

function ClassInput({ name, label, type = "text", placeholder, required, defaultValue, onChange }: Field) {
  return <label className="text-sm font-bold text-gray-700 dark:text-gray-200">{label}{required && <span className="text-red-500"> *</span>}<input name={name} type={type} required={required} placeholder={placeholder} defaultValue={defaultValue ?? ""} onChange={onChange ? (event) => onChange(event.target.value) : undefined} min={type === "number" ? 0 : undefined} className="mt-1 min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 font-normal text-gray-950 dark:border-gray-700 dark:bg-gray-800 dark:text-white" /></label>;
}

type Field = { name: string; label: string; type?: string; placeholder?: string; required?: boolean; defaultValue?: string | number | null; onChange?: (value: string) => void };
function FormModal({ title, helper, fields, onClose, onSubmit }: { title: string; helper?: string; fields: Field[]; onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<void> }) {
  const [pending, setPending] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setError(""); const form = new FormData(event.currentTarget); const payload = Object.fromEntries(form.entries()); try { await onSubmit(payload); } catch (caught) { setError(caught instanceof Error ? caught.message : "저장하지 못했습니다."); setPending(false); } }
  const titleId = "seasonal-form-modal-title";
  return <AdminModal onClose={() => { if (!pending) onClose(); }} titleId={titleId}><form onSubmit={submit} className="w-full p-6"><header className="flex items-center justify-between"><h2 id={titleId} className="text-xl font-black">{title}</h2><button type="button" onClick={onClose} disabled={pending} aria-label="닫기"><Icon name="close" /></button></header>{helper && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">{helper}</p>}{error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}<div className="mt-5 grid gap-4 sm:grid-cols-2">{fields.map((field, index) => <label key={field.name} className="text-sm font-bold text-gray-700 dark:text-gray-200">{field.label}{field.required && <span className="text-red-500"> *</span>}<input name={field.name} type={field.type || "text"} required={field.required} placeholder={field.placeholder} defaultValue={field.defaultValue ?? ""} min={field.type === "number" ? 0 : undefined} data-admin-modal-initial-focus={index === 0 ? "true" : undefined} className="mt-1 min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 font-normal text-gray-950 dark:border-gray-700 dark:bg-gray-800 dark:text-white" /></label>)}</div><footer className="mt-6 flex justify-end gap-2"><button type="button" onClick={onClose} disabled={pending} className="min-h-11 rounded-xl border border-gray-200 px-4 font-bold disabled:opacity-60 dark:border-gray-700">취소</button><button disabled={pending} className="min-h-11 rounded-xl bg-[var(--brand-accent)] px-5 font-black text-[var(--brand-accent-contrast)] disabled:opacity-60">{pending ? "저장 중…" : "저장"}</button></footer></form></AdminModal>;
}

function Panel({ title, icon, action, children }: { title: string; icon: string; action?: React.ReactNode; children: React.ReactNode }) { return <section className="min-w-0 max-w-full rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"><header className="flex min-w-0 flex-col justify-between gap-3 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-center dark:border-gray-800"><h2 className="flex min-w-0 items-center gap-2 break-words font-black"><Icon name={icon} className="text-[var(--brand-accent)]" />{title}</h2>{action}</header><div className="min-w-0 max-w-full p-5">{children}</div></section>; }
function Empty({ text }: { text: string }) { return <div className="py-10 text-center"><Icon name="inbox" className="text-4xl text-gray-300" /><p className="mt-2 text-sm text-gray-500">{text}</p></div>; }
function Loading() { return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, index) => <div key={index} className="h-36 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" />)}</div>; }
