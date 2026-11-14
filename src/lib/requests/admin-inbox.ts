/**
 * 관리자 신청함 어댑터 — 14종류의 신청 표를 «공통 한 줄»로 바꿔 모은다 (2026-11-10 설계 A)
 *
 * 왜: 신청이 표 14개·화면 11개에 흩어져 원장이 메뉴를 돌며 확인했다. 여기서 종류마다 «어댑터»(어느 표에서
 * 무엇을 읽어 어떤 상태로 볼지)를 하나씩 두고, 결과를 같은 모양(InboxRow)으로 만들어 코드에서 합쳐 정렬한다.
 *
 * - 상태 → 칸(처리 필요/진행 중/완료)·이름은 catalog.ts 한 곳에서만 정한다(여기서 상태 글자를 새로 만들지 않는다).
 * - 모든 조회는 $queryRawUnsafe(PgBouncer 트랜잭션 모드). 학생 조인은 ON 절에 notMergedStudent —
 *   LEFT JOIN 이라 병합된 학생이어도 신청 행 자체는 사라지지 않는다(이름만 비고, 병합 엔진이 행을 대표 학생으로 옮긴다).
 * - 날짜는 KST: timestamptz 는 AT TIME ZONE 한 번, date 컬럼은 ::text(이미 달력 값). 서버 시계를 믿지 않는다.
 * - 상태 목록은 catalog 의 영문 대문자 상수뿐이라(테스트가 /^[A-Z_]+$/ 확인) SQL 배열 글자로 넣어도 안전하다.
 */
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { isKstYmd } from "@/lib/datetime/kst";
import { notClosedByDeletedEnrollmentSql } from "@/lib/enrollment/admin-enrollment-edit";
import { externalSyncPendingSql } from "@/lib/operations-sync/rallyzRetirement";
import { settlementTablesReady } from "@/lib/enrollment/pause-settlement";
import { groupEnrollmentChangeInboxSql, PAUSE_GROUP_KEY_SQL } from "@/lib/requests/inbox-enrollment-change-group";
import {
  bucketFor,
  ENROLLMENT_CANCEL_REQUESTED,
  RENTAL_COMPLETED_NO_DEPOSIT,
  kindEntry,
  REQUEST_KINDS,
  statusLabel,
  statusesOf,
  tabActionCounts,
  type InboxBucket,
  type InboxTab,
  type RequestKind,
} from "@/lib/requests/catalog";
import type { StatusTone } from "@/lib/ui/statusTones";
// 상담 탭(신설) — 이 파일의 두 함수만 부른다. 상담 작업이 그 파일만 채운다(원장 결정 k1)
import { countConsultAction } from "@/lib/requests/consult-inbox";
import { illnessReviewReady } from "@/lib/regular/illness-carry-tx";
import { evidenceScopeSql } from "@/lib/regular/illnessCarryRules";

export type InboxFact = [label: string, value: string];
export type InboxEnrollmentChangeMember = {
  id: string;
  className: string;
  rawStatus: string;
  statusLabel: string;
  enrollmentStatus?: string;
  holdReason?: string;
};

/** 신청함 한 줄 — 종류가 달라도 모양은 같다 */
export type InboxRow = {
  /** catalog 종류(상담 "CONSULT" 행은 consult-inbox.ts 가 만든다) */
  kind: RequestKind;
  id: string;
  studentName: string | null;
  title: string;
  summary: string;
  rawStatus: string;
  bucket: InboxBucket;
  statusLabel: string;
  /** 신청 시각(ISO) — 정렬·«n일 전» 표시 */
  createdAt: string;
  /** 대상 날짜(KST «YYYY-MM-DD») — 결석일·적용일·대관일 등. 없으면 null */
  targetDate: string | null;
  /** 기존 관리자 화면(복잡한 처리는 여기서) */
  detailHref: string;
  /** 상세 칸에 보일 사실들 */
  facts: InboxFact[];
  /** 신청 건의 대상 반. 묶음은 id 와 별개로 실제 처리할 반별 신청 id를 가진다. */
  members?: InboxEnrollmentChangeMember[];
  /** 처리 버튼이 쓰는 추가 값(학부모 계정 id·청구 종류 등) */
  ref?: Record<string, string | null>;
  /** 색 뜻 — 보통 비워 둔다(catalog 가 정한다). 넣으면 그 색 뜻이 이긴다 */
  tone?: StatusTone;
};

export type InboxCounts = {
  /** 처리 필요 합계(메뉴 배지·«오늘 업무» 카드) — 6탭 전부(체험 새 문의·수강신청 대기·상담 포함) */
  action: number;
  /** 진행 중 합계(catalog 종류만) */
  ongoing: number;
  byKind: Partial<Record<RequestKind, { action: number; ongoing: number }>>;
  /** 탭 옆 배지 숫자(처리 필요) — 원장 결정 k1 */
  byTab: Record<InboxTab, number>;
};

type RawRow = {
  id: string;
  raw: string;
  studentName: string | null;
  createdAt: Date | string;
  targetDate: string | null;
  extra: Record<string, unknown> | null;
};

type Adapter = {
  kind: RequestKind;
  /** FROM … JOIN … (본 표 별칭은 x) */
  from: string;
  /** 원래 상태(파생 포함) SQL 식 */
  rawExpr: string;
  /** 신청함에 올릴 행의 기본 조건(상태 조건 제외) */
  where?: string;
  studentNameExpr: string;
  createdAtExpr: string;
  targetDateExpr: string;
  /** json_build_object(...) 안에 들어갈 «'키', 식» 목록 */
  extra: string;
  /**
   * 운영 DB 에 아직 없는 칸을 읽는 어댑터의 «예전 식»(마이그레이션 적용 전 대비).
   * 첫 조회가 실패하면 이 식으로 한 번 더 읽는다 — 새 칸 때문에 신청함·메뉴 숫자가 통째로 죽지 않게.
   */
  fallback?: Pick<Adapter, "rawExpr" | "createdAtExpr" | "extra"> & Partial<Pick<Adapter, "from" | "where">>;
  /** true 면 메뉴 숫자(UNION ALL 한 번) 계산에서 뺀다 — 처리 필요 상태가 없는 종류(원장 손이 필요 없다) */
  skipCount?: boolean;
  format: (row: RawRow, extra: Record<string, unknown>) => { title: string; summary: string; facts: InboxFact[]; ref?: Record<string, string | null> };
};

// ── 표시용 글자 도우미 ──────────────────────────────────────────────────────

const text = (value: unknown): string => (value == null ? "" : String(value).trim());
const join = (...parts: unknown[]) => parts.map(text).filter(Boolean).join(" · ");
const won = (value: unknown) => (value == null || value === "" ? "" : `${Number(value).toLocaleString("ko-KR")}원`);
const fact = (label: string, value: unknown): InboxFact[] => (text(value) ? [[label, text(value)]] : []);
const hm = (minutes: unknown) => {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return "";
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

const ABSENCE_REASON: Record<string, string> = {
  ILLNESS_INJURY: "아픔·부상", PERSONAL: "개인 사정", FAMILY_TRIP: "가족 여행", SCHOOL_EVENT: "학교 행사", ETC: "기타",
};
const CHANGE_KIND: Record<string, string> = { CLASS_CHANGE: "반 변경", PAUSE: "휴원", WITHDRAW: "퇴원", RESUME: "복귀" };
const REQUEST_TYPE: Record<string, string> = { ABSENCE: "결석", SHUTTLE: "셔틀", EARLY_LEAVE: "조퇴", OTHER: "기타" };
const DIRECTION: Record<string, string> = { PICKUP: "등원", DROPOFF: "하원", BOTH: "등·하원" };
const PAY_METHOD: Record<string, string> = { TRANSFER: "계좌이체", RALLYZ: "랠리즈", CARD: "카드", CASH: "현금", MANUAL: "직접" };
const KAKAO_KIND: Record<string, string> = {
  PAUSE: "휴원", WITHDRAW: "퇴원", RESUME: "복귀", CLASS_CHANGE: "반 변경", CLASS_ADD: "반 추가", SHUTTLE_START_STOP: "셔틀 이용 변경",
  SHUTTLE_CHANGE: "탑승 정보 변경", SHUTTLE_FEE: "셔틀비", CONTACT_CHANGE: "연락처 변경", BILLING_CORRECTION: "청구 정정", MAKEUP: "보강", OTHER: "기타 문의",
};
const ILLNESS_SOURCE: Record<string, string> = { PARENT: "학부모 앱", KAKAO: "카카오 대화", STAFF: "학원 등록" };
const CREDIT_LABEL: Record<string, string> = { AVAILABLE: "보강권 있음(미사용)", RESERVED: "보강 예약됨", USED: "보강 완료", NO_SHOW: "보강 불참", EXPIRED: "보강권 만료", REVOKED: "보강권 보류" };
const ROLE_LABEL: Record<string, string> = { INSTRUCTOR: "선생님", DRIVER: "기사님" };
const CHANNEL_LABEL: Record<string, string> = { GALLERY: "갤러리", INSTAGRAM: "인스타그램" };

/** 학생 이름 LEFT JOIN — 병합 학생 제외 조건을 ON 에 건다(행은 살리고 이름만 비운다) */
const studentJoin = (alias: string, onExpr: string) => `LEFT JOIN "Student" ${alias} ON ${alias}.id = ${onExpr} AND ${notMergedStudent(alias)}`;
const kstYmd = (expr: string) => `to_char((${expr}) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
const enrollmentChangeExtra = `
  'enrollmentId', x."enrollmentId", 'fromClassId', x."fromClassId", 'enrollmentStatus', en.status,
  'pauseGroupKey', ${PAUSE_GROUP_KEY_SQL}, 'operationStatus', oc.status,
  'holdReason', CASE WHEN oc.status = 'HELD' THEN oc."holdReason" END,
  'syncPending', EXISTS (
    SELECT 1 FROM "OperationsSyncAttempt" a WHERE a."commandId" = oc.id
     -- 2026-11-14 랠리즈 은퇴: 시트·랠리즈 모두 건너뜀(SKIPPED)은 끝난 것(공용 조건 하나)
     AND ${externalSyncPendingSql("a")}
  )`;

// ── 종류별 어댑터 ──────────────────────────────────────────────────────────

const ADAPTERS: Adapter[] = [
  {
    kind: "ENROLLMENT_CHANGE",
    from: `"EnrollmentChangeRequest" x ${studentJoin("s", `x."studentId"`)}
           LEFT JOIN "Class" fc ON fc.id = x."fromClassId" LEFT JOIN "Class" tc ON tc.id = x."toClassId"
           LEFT JOIN "Enrollment" en ON en.id = x."enrollmentId" AND en."studentId" = x."studentId"
           LEFT JOIN LATERAL (
             SELECT c.id, c.status, c."holdReason" FROM "OperationsCommand" c
              WHERE (c."idempotencyKey" = 'enrollment-change:' || x.id OR c."afterJson"->>'enrollmentChangeRequestId' = x.id)
                AND ${notClosedByDeletedEnrollmentSql("c")}
              ORDER BY c."createdAt" DESC, c.id DESC LIMIT 1
           ) oc ON true`,
    // 파생 상태 순서는 catalog.deriveEnrollmentChangeStatus 와 같다(취소 요청 대기 → 적용됨 → 원래 상태)
    rawExpr: `CASE WHEN x.status = 'APPROVED' AND x."cancelRequestStatus" = 'PENDING' THEN '${ENROLLMENT_CANCEL_REQUESTED}'
                   WHEN x.status = 'APPROVED' AND x."appliedAt" IS NOT NULL THEN 'APPLIED' ELSE x.status END`,
    studentNameExpr: "s.name",
    // 취소 요청 행은 «요청한 시각»으로 줄 세운다(«n일 전»·신청일 필터가 원래 신청일이 아니라 요청일을 보게)
    createdAtExpr: `CASE WHEN x.status = 'APPROVED' AND x."cancelRequestStatus" = 'PENDING' THEN COALESCE(x."cancelRequestedAt", x."createdAt") ELSE x."createdAt" END`,
    targetDateExpr: `x."effectiveFrom"::text`,
    extra: `'changeKind', x.kind, 'fromClass', fc.name, 'toClass', tc.name, 'resumeOn', x."resumeOn"::text,
            'reason', x.reason, 'waitlisted', x.waitlisted, 'decisionNote', x."decisionNote",
            'cancelRequestedAt', ${kstYmd(`x."cancelRequestedAt"`)}, 'cancelReason', x."cancelRequestReason",
            'tooLate', (x."appliedAt" IS NOT NULL OR x."effectiveFrom" <= (now() AT TIME ZONE 'Asia/Seoul')::date),
            ${enrollmentChangeExtra}`,
    // 마이그레이션 20261110130000(취소 요청 칸) 적용 전: 취소 요청 없이 예전 그대로 읽는다
    fallback: {
      createdAtExpr: `x."createdAt"`,
      rawExpr: `CASE WHEN x.status = 'APPROVED' AND x."appliedAt" IS NOT NULL THEN 'APPLIED' ELSE x.status END`,
      extra: `'changeKind', x.kind, 'fromClass', fc.name, 'toClass', tc.name, 'resumeOn', x."resumeOn"::text,
              'reason', x.reason, 'waitlisted', x.waitlisted, 'decisionNote', x."decisionNote",
              ${enrollmentChangeExtra}`,
    },
    format: (row, e) => {
      const kind = CHANGE_KIND[text(e.changeKind)] ?? "수강 변경";
      const classes = e.toClass ? `${text(e.fromClass) || "?"} → ${text(e.toClass)}` : text(e.fromClass);
      if (row.raw === ENROLLMENT_CANCEL_REQUESTED) {
        // 학부모 «취소 요청»(d8) — 승인된 휴원·퇴원을 되돌려 달라는 요청. 적용일이 왔으면 취소는 못 하고 거절만.
        return {
          title: `${kind} 취소 요청`,
          summary: join(classes, row.targetDate ? `${row.targetDate}부터 예정` : "", e.tooLate ? "적용일 지남" : ""),
          facts: [["종류", `${kind} 취소 요청`], ...fact("반", classes), ...fact("적용일", row.targetDate), ...fact("복귀 예정", e.resumeOn),
            ...fact("취소 요청일", e.cancelRequestedAt), ...fact("취소 사유", e.cancelReason), ...fact("원래 신청 사유", e.reason),
            ...(e.tooLate ? [["안내", "적용일이 이미 왔거나 반영돼 취소할 수 없습니다. 요청 거절로 닫아 주세요."] as InboxFact] : [])],
          ref: { cancelRequest: "PENDING", tooLate: e.tooLate ? "1" : null },
        };
      }
      return {
        title: `${kind} 신청`,
        summary: join(classes, row.targetDate ? `${row.targetDate}부터` : "", e.waitlisted ? "희망 반 만석" : ""),
        facts: [["종류", kind], ...fact("반", classes), ...fact("적용일", row.targetDate), ...fact("복귀 예정", e.resumeOn),
          ...fact("사유", e.reason), ...fact("원장 메모", e.decisionNote)],
        // 신청함 상세 칸이 휴원(PAUSE) 승인 전에 수강료 처리 미리보기를 띄울지 판단한다(통합 11-10)
        ref: { changeKind: text(e.changeKind) || null } as Record<string, string | null>,
      };
    },
  },
  {
    kind: "REGULAR_ABSENCE",
    from: `"RegularAbsence" x ${studentJoin("s", `x."studentId"`)} LEFT JOIN "Class" c ON c.id = x."classId"`,
    rawExpr: "x.status",
    // 관리자 «기간 결석»이 만든 행은 신청이 아니다. 학부모가 «여러 날»로 알린 행(학부모 표시 있음)은 하루 신고와 같이 확인 대상이다
    where: `(x."periodId" IS NULL OR x."reportedByUserId" IS NOT NULL)`,
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x.date::text`,
    extra: `'className', c.name, 'reason', x.reason, 'note', x.note`,
    format: (row, e) => ({
      title: "결석 신고",
      summary: join(row.targetDate, e.className, ABSENCE_REASON[text(e.reason)] ?? ""),
      facts: [...fact("결석일", row.targetDate), ...fact("반", e.className), ...fact("사유", ABSENCE_REASON[text(e.reason)] ?? e.reason), ...fact("메모", e.note)],
    }),
  },
  {
    // 질병·부상 결석 «이월 검토»(2026-11-14 원장 결정 a3·a7) — 학부모 신고·카카오 접수·기간 결석·출석부 표시가 모두 같은 표라 한 줄로 모인다.
    // 이 기능 이전에 보강권이 나간 결석(검토 줄 없음)도 뜬다 — 이월 승인 시 기존 규칙이 보강권을 회수한다.
    // 검토 줄 없이 이미 보강을 들은 결석은 고를 것이 없어 뺀다. 사유 글(건강 정보)은 목록에 싣지 않고 상세를 열 때 따로 읽는다.
    kind: "ILLNESS_CARRY",
    from: `"RegularAbsence" x ${studentJoin("s", `x."studentId"`)} LEFT JOIN "Class" c ON c.id = x."classId"
           LEFT JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = x.id`,
    // 결정이 났으면 그 결정, 아니면 결석일이 지났는지(KST — date 칼럼은 이미 달력 값이라 now() 쪽만 한 번 변환)
    rawExpr: `CASE WHEN r.status = 'APPROVED' THEN 'APPROVED' WHEN r.status = 'MAKEUP' THEN 'MAKEUP'
                   WHEN x.date > (now() AT TIME ZONE 'Asia/Seoul')::date THEN 'WAITING' ELSE 'PENDING' END`,
    // 2026-10-05 = 보강권 발급·청구 작업대 결석 정산이 시작된 날(그 전 결석은 대상이 아니다)
    // 닫힌 검토(CLOSED — 그날 출석으로 기록돼 자동으로 닫힌 건 등)는 고를 것이 없어 뺀다(결석 신고 자체는 «결석» 줄에 그대로 있다)
    where: `x.reason = 'ILLNESS_INJURY' AND x.status <> 'CANCELLED' AND x.date >= '2026-10-05'::date
            AND COALESCE(r.status, '') <> 'CLOSED'
            AND NOT (r."absenceId" IS NULL AND EXISTS (
              SELECT 1 FROM "MakeupCredit" used WHERE used."studentId" = x."studentId"
                 AND used."sourceKey" = 'REGULAR:' || x."classId" || ':' || to_char(x.date, 'YYYY-MM-DD')
                 AND used.status IN ('USED', 'NO_SHOW')))`,
    studentNameExpr: "s.name",
    createdAtExpr: `COALESCE(r."requestedAt", x."createdAt")`,
    targetDateExpr: `x.date::text`,
    extra: `'className', c.name, 'source', COALESCE(r.source, 'STAFF'), 'period', (x."periodId" IS NOT NULL AND x."reportedByUserId" IS NULL),
            'parentPeriod', (x."periodId" IS NOT NULL AND x."reportedByUserId" IS NOT NULL),
            'photoCount', (SELECT COUNT(*)::int FROM "RegularAbsenceEvidence" e WHERE ${evidenceScopeSql("x", "e")} AND e."removedAt" IS NULL),
            'creditStatus', (SELECT mc.status FROM "MakeupCredit" mc WHERE mc."studentId" = x."studentId"
                              AND mc."sourceKey" = 'REGULAR:' || x."classId" || ':' || to_char(x.date, 'YYYY-MM-DD') LIMIT 1)`,
    // 마이그레이션(20261114130000) 적용 전: 검토 표가 없다 — 이 종류만 비운다(다른 종류·메뉴 숫자는 그대로)
    fallback: {
      from: `"RegularAbsence" x ${studentJoin("s", `x."studentId"`)}`,
      where: "false",
      rawExpr: `'NOT_READY'::text`,
      createdAtExpr: `x."createdAt"`,
      extra: `'className', NULL`,
    },
    format: (row, e) => {
      const photos = Number(e.photoCount ?? 0);
      const source = e.period ? "학원 등록(기간 결석)" : e.parentPeriod ? `${ILLNESS_SOURCE[text(e.source)] ?? "학부모 앱"}(여러 날)` : ILLNESS_SOURCE[text(e.source)] ?? "학원 등록";
      const evidence = photos > 0 ? `사진 ${photos}장` : e.source === "STAFF" ? "학부모 증빙 없음" : "사진 아직 없음";
      return {
        title: "질병·부상 결석",
        summary: join(row.targetDate, e.className, evidence),
        facts: [...fact("결석일", row.targetDate), ...fact("반", e.className), ["접수", source], ["증빙", evidence],
          ...fact("보강권", CREDIT_LABEL[text(e.creditStatus)]),
          ...(row.raw === "WAITING" ? [["안내", "결석일이 지난 뒤에 이월을 승인할 수 있습니다."] as InboxFact] : [])],
        ref: { source: text(e.source) || "STAFF", photoCount: String(photos), creditStatus: text(e.creditStatus) || null },
      };
    },
  },
  {
    kind: "MAKEUP",
    from: `"MakeupSession" x ${studentJoin("s", `x."studentId"`)}
           LEFT JOIN "Class" oc ON oc.id = x."originalClassId" LEFT JOIN "Class" mc ON mc.id = x."makeupClassId"`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: kstYmd(`x."makeupDate"`),
    extra: `'originalClass', oc.name, 'makeupClass', mc.name, 'originalDate', ${kstYmd(`x."originalDate"`)}`,
    format: (row, e) => ({
      title: "보강 예약",
      summary: join(row.targetDate, e.makeupClass),
      facts: [...fact("보강일", row.targetDate), ...fact("보강 반", e.makeupClass), ...fact("결석일", e.originalDate), ...fact("원래 반", e.originalClass)],
    }),
  },
  {
    kind: "SHUTTLE_DAY",
    from: `"ShuttleDayException" x ${studentJoin("s", `x."studentId"`)}`,
    rawExpr: `CASE WHEN x."canceledAt" IS NOT NULL THEN 'CANCELED' ELSE 'ACTIVE' END`,
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x."serviceDate"::text`,
    extra: `'direction', x.direction, 'exceptionKind', x.kind, 'location', x.location, 'note', x.note`,
    format: (row, e) => {
      const what = e.exceptionKind === "LOCATION" ? `다른 곳에서 탑승: ${text(e.location)}` : "안 탐";
      return {
        title: "셔틀 오늘만 변경",
        summary: join(row.targetDate, DIRECTION[text(e.direction)] ?? "", what),
        facts: [...fact("날짜", row.targetDate), ...fact("방향", DIRECTION[text(e.direction)]), ["변경", what], ...fact("메모", e.note),
          ["안내", "승인 없이 바로 반영된 알림입니다."]],
      };
    },
  },
  {
    kind: "SEASONAL_ABSENCE",
    from: `"SpecialProgramAbsence" x
           JOIN "SpecialProgramEnrollmentDate" ed ON ed.id = x."enrollmentDateId"
           JOIN "SpecialProgramApplicationItem" it ON it.id = ed."applicationItemId"
           JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
           LEFT JOIN "SpecialProgramSessionDate" sd ON sd.id = ed."sessionDateId"
           LEFT JOIN "SpecialProgramOffering" o ON o.id = ed."offeringId"`,
    rawExpr: "x.status",
    studentNameExpr: `a."childName"`,
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: kstYmd(`sd."startsAt"`),
    extra: `'offering', o.title, 'reason', x.reason, 'resolution', x.resolution, 'note', x.note`,
    format: (row, e) => ({
      title: "방학특강 결석",
      summary: join(row.targetDate, e.offering, ABSENCE_REASON[text(e.reason)] ?? ""),
      facts: [...fact("결석일", row.targetDate), ...fact("특강", e.offering), ...fact("사유", ABSENCE_REASON[text(e.reason)] ?? e.reason), ...fact("메모", e.note)],
    }),
  },
  {
    kind: "SEASONAL_MAKEUP",
    from: `"SpecialProgramMakeup" x
           JOIN "SpecialProgramApplicationItem" it ON it.id = x."applicationItemId"
           JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
           LEFT JOIN "SpecialProgramOffering" o ON o.id = x."offeringId"
           LEFT JOIN "SpecialProgramSessionDate" absd ON absd.id = x."absentSessionDateId"
           LEFT JOIN "SpecialProgramSessionDate" tsd ON tsd.id = x."targetSessionDateId"
           LEFT JOIN "Class" c ON c.id = x."targetClassId"`,
    rawExpr: "x.status",
    studentNameExpr: `a."childName"`,
    createdAtExpr: `x."requestedAt"`,
    targetDateExpr: kstYmd(`COALESCE(tsd."startsAt", x."targetDate")`),
    extra: `'offering', o.title, 'targetType', x."targetType", 'targetClass', c.name, 'absentDate', ${kstYmd(`absd."startsAt"`)}, 'note', x.note`,
    format: (row, e) => ({
      title: "방학특강 보강",
      summary: join(row.targetDate, e.targetType === "REGULAR" ? text(e.targetClass) || "정규 수업" : e.offering),
      facts: [...fact("보강일", row.targetDate), ...fact("결석일", e.absentDate), ...fact("특강", e.offering),
        ...fact("보강 대상", e.targetType === "REGULAR" ? `정규 ${text(e.targetClass)}` : "특강 다른 날"), ...fact("메모", e.note)],
    }),
  },
  {
    kind: "PARENT_REQUEST",
    from: `"ParentRequest" x ${studentJoin("s", `x."studentId"`)} LEFT JOIN "User" u ON u.id = x."userId"`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `CASE WHEN x.date IS NULL THEN NULL ELSE ${kstYmd("x.date")} END`,
    extra: `'type', x.type, 'title', x.title, 'content', x.content, 'parentName', u.name, 'adminNote', x."adminNote"`,
    format: (row, e) => ({
      title: text(e.title) || "학부모 문의",
      summary: join(REQUEST_TYPE[text(e.type)] ?? "", text(e.content).slice(0, 60)),
      facts: [...fact("종류", REQUEST_TYPE[text(e.type)]), ...fact("보호자", e.parentName), ...fact("날짜", row.targetDate),
        ...fact("내용", e.content), ...fact("답변", e.adminNote)],
      ref: { adminNote: text(e.adminNote) || null },
    }),
  },
  {
    kind: "PAYMENT_REQUEST",
    from: `"PaymentParentRequest" x ${studentJoin("s", `x."studentId"`)} LEFT JOIN "Payment" p ON p.id = x."paymentId"`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x."paidOn"::text`,
    extra: `'requestKind', x.kind, 'method', x.method, 'depositorName', x."depositorName", 'note', x.note,
            'amount', p.amount, 'description', p.description, 'receiptType', x."receiptType", 'receiptTarget', x."receiptTarget", 'decisionNote', x."decisionNote"`,
    format: (row, e) => {
      const claim = e.requestKind === "PAYMENT_CLAIM";
      return {
        title: claim ? "입금했어요" : "영수증 요청",
        summary: join(e.description, won(e.amount), claim ? PAY_METHOD[text(e.method)] ?? "" : ""),
        facts: [...fact("청구", e.description), ...fact("금액", won(e.amount)), ...fact("입금일", row.targetDate),
          ...fact("방법", PAY_METHOD[text(e.method)] ?? e.method), ...fact("입금자", e.depositorName), ...fact("영수증 대상", e.receiptTarget),
          ...fact("메모", e.note), ...fact("원장 메모", e.decisionNote)],
        ref: { requestKind: text(e.requestKind) },
      };
    },
  },
  {
    kind: "KAKAO",
    from: `"KakaoParentIntake" x ${studentJoin("s", `x."studentId"`)}`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: "NULL::text",
    extra: `'intakeKind', x.kind, 'sourceText', x."sourceText", 'decisionNote', x."decisionNote"`,
    format: (_row, e) => ({
      title: `카카오 · ${KAKAO_KIND[text(e.intakeKind)] ?? "기타 문의"}`,
      summary: text(e.sourceText).slice(0, 60),
      facts: [...fact("종류", KAKAO_KIND[text(e.intakeKind)] ?? e.intakeKind), ...fact("대화 내용", e.sourceText), ...fact("원장 메모", e.decisionNote)],
    }),
  },
  {
    kind: "RENTAL",
    from: `"GymRentalRequest" x`,
    // 파생 순서는 catalog.deriveRentalStatus 와 같다(사용 완료 + 보증금 0원 → 완료)
    rawExpr: `CASE WHEN x.status = 'COMPLETED' AND x.deposit = 0 THEN '${RENTAL_COMPLETED_NO_DEPOSIT}' ELSE x.status END`,
    studentNameExpr: "NULL::text",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x."rentalDate"`,
    extra: `'applicantName', x."applicantName", 'headcount', x.headcount, 'startMinute', COALESCE(x."startMinute", x."startHour" * 60),
            'endMinute', COALESCE(x."endMinute", x."endHour" * 60), 'totalAmount', x."totalAmount", 'memberFree', x."memberFree", 'purpose', x.purpose`,
    format: (row, e) => {
      const time = `${hm(e.startMinute)}~${hm(e.endMinute)}`;
      return {
        title: `대관 · ${text(e.applicantName)}`,
        summary: join(row.targetDate, time, `${text(e.headcount)}명`, e.memberFree ? "재원생 무료" : won(e.totalAmount)),
        facts: [...fact("신청자", e.applicantName), ...fact("날짜", row.targetDate), ["시간", time], ...fact("인원", `${text(e.headcount)}명`),
          ...fact("금액", e.memberFree ? "재원생 무료" : won(e.totalAmount)), ...fact("목적", e.purpose)],
      };
    },
  },
  {
    kind: "WITHDRAWAL",
    from: `"User" x`,
    rawExpr: `CASE WHEN x."withdrawnAt" IS NOT NULL THEN 'WITHDRAWN' ELSE 'REQUESTED' END`,
    where: `x."withdrawRequestedAt" IS NOT NULL`,
    studentNameExpr: "NULL::text",
    createdAtExpr: `x."withdrawRequestedAt"`,
    targetDateExpr: "NULL::text",
    // 자녀 이름 — 누구의 보호자인지 알아야 판단할 수 있다(병합 학생 제외)
    extra: `'accountName', x.name, 'role', x.role::text,
            'childNames', (SELECT STRING_AGG(cs.name, ', ' ORDER BY cs.name) FROM "Student" cs WHERE cs."parentId" = x.id AND ${notMergedStudent("cs")}),
            'activeEnrollments', (SELECT COUNT(*)::int FROM "Enrollment" en JOIN "Student" es ON es.id = en."studentId" AND ${notMergedStudent("es")} WHERE es."parentId" = x.id AND en.status = 'ACTIVE')`,
    format: (_row, e) => ({
      title: `회원 탈퇴 · ${text(e.accountName)}`,
      summary: join(e.childNames ? `자녀 ${text(e.childNames)}` : "", Number(e.activeEnrollments) > 0 ? `수강 중 ${text(e.activeEnrollments)}건` : ""),
      facts: [...fact("계정", e.accountName), ...fact("자녀", e.childNames), ["수강 중", `${Number(e.activeEnrollments ?? 0)}건`]],
    }),
  },
  {
    kind: "ROLE_GRANT",
    from: `"UserRoleGrant" x JOIN "User" u ON u.id = x."userId" LEFT JOIN "Coach" c ON c."userId" = u.id`,
    rawExpr: `CASE WHEN x.status = 'ACTIVE' AND x.role = 'INSTRUCTOR' AND c.id IS NULL THEN 'COACH_LINK_REQUIRED' ELSE x.status END`,
    where: `u."withdrawnAt" IS NULL AND (x.source = 'REQUEST' OR x.status = 'PENDING'
      OR (x.status = 'ACTIVE' AND x.role = 'INSTRUCTOR'))`,
    studentNameExpr: "NULL::text",
    createdAtExpr: `x."requestedAt"`,
    targetDateExpr: "NULL::text",
    extra: `'userName', u.name, 'role', x.role, 'note', x.note, 'coachName', c.name`,
    format: (_row, e) => ({
      title: `직원 역할 · ${text(e.userName)}`,
      summary: `${ROLE_LABEL[text(e.role)] ?? text(e.role)} 역할 신청`,
      facts: [...fact("신청자", e.userName), ...fact("역할", ROLE_LABEL[text(e.role)] ?? e.role), ...fact("코치 프로필", e.coachName), ...fact("메모", e.note)],
      ref: { role: text(e.role) },
    }),
  },
  {
    kind: "MEDIA_REVOCATION",
    from: `"MediaRevocationJob" x ${studentJoin("s", `x."studentId"`)}`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: "NULL::text",
    extra: `'channel', x.channel, 'attempts', x.attempts, 'lastError', x."lastError"`,
    format: (_row, e) => ({
      title: "사진 공개 회수",
      summary: join(CHANNEL_LABEL[text(e.channel)] ?? e.channel, `시도 ${text(e.attempts)}회`),
      facts: [...fact("채널", CHANNEL_LABEL[text(e.channel)] ?? e.channel), ...fact("시도", `${text(e.attempts)}회`)],
    }),
  },
  {
    kind: "STAFF_PAYMENT",
    from: `"StaffPaymentConfirmationRequest" x ${studentJoin("s", `x."studentId"`)}
           LEFT JOIN "Class" c ON c.id = x."classId" LEFT JOIN "User" u ON u.id = x."requestedByUserId"`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: kstYmd(`x."receivedAt"`),
    extra: `'className', c.name, 'staffName', u.name, 'method', x.method, 'amount', x.amount, 'note', x.note, 'reviewNote', x."reviewNote"`,
    format: (row, e) => ({
      title: "현장 수납 승인",
      summary: join(won(e.amount), PAY_METHOD[text(e.method)] ?? e.method, e.staffName ? `${text(e.staffName)} 선생님` : ""),
      facts: [...fact("금액", won(e.amount)), ...fact("방법", PAY_METHOD[text(e.method)] ?? e.method), ...fact("받은 날", row.targetDate),
        ...fact("반", e.className), ...fact("받은 사람", e.staffName), ...fact("메모", e.note), ...fact("원장 메모", e.reviewNote)],
    }),
  },
  {
    // 학부모 연결 요청(원장 결정 k1 «기타» 탭) — 승인은 먼저 연결된 보호자가 한다. 원장은 상황만 본다(처리 버튼 없음).
    // 기한 지난 대기 = 만료(학부모 화면 getChildConnectionState 와 같은 판정)
    kind: "CHILD_LINK",
    from: `"ChildLinkRequest" x ${studentJoin("s", `x."studentId"`)} LEFT JOIN "User" ap ON ap.id = x."approverId"`,
    rawExpr: `CASE WHEN x.status = 'PENDING' AND x."expiresAt" <= now() THEN 'EXPIRED' ELSE x.status END`,
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: "NULL::text",
    extra: `'requesterName', x."requesterName", 'phoneLast4', x."requesterPhoneLast4", 'relation', x.relation,
            'approverName', ap.name, 'expiresOn', ${kstYmd(`x."expiresAt"`)}, 'decidedOn', ${kstYmd(`x."decidedAt"`)}`,
    // 처리 필요 상태가 없어 메뉴 숫자에 안 들어간다 — 개수 SQL 에서 빼 두면 이 표 때문에 숫자 전체가 죽는 일도 없다
    skipCount: true,
    format: (row, e) => {
      const relation = e.relation === "PARENT" ? "부모" : "가족·보호자";
      return {
        title: `학부모 연결 · ${text(e.requesterName)}`,
        summary: join(relation, e.approverName ? `승인할 보호자 ${text(e.approverName)}` : "", row.raw === "PENDING" && e.expiresOn ? `${text(e.expiresOn)}까지` : ""),
        facts: [...fact("요청자", e.requesterName), ...fact("연락처 끝자리", e.phoneLast4), ["관계", relation], ...fact("승인할 보호자", e.approverName),
          ...fact("기한", e.expiresOn), ...fact("처리일", e.decidedOn), ["안내", "먼저 연결된 보호자가 앱에서 승인합니다."]],
      };
    },
  },
];

// 모든 catalog 종류에 어댑터가 하나씩 있어야 한다(빠지면 그 종류가 신청함에서 조용히 사라진다 — 테스트가 확인)
export const INBOX_ADAPTER_KINDS: readonly RequestKind[] = ADAPTERS.map((a) => a.kind);

/** catalog 의 상태 목록 → SQL 배열 글자. 상태는 영문 대문자만이라 따옴표 탈출이 필요 없지만 한 번 더 거른다 */
function sqlTextArray(values: string[]): string {
  const safe = values.filter((v) => /^[A-Z_]+$/.test(v));
  return safe.length ? `ARRAY[${safe.map((v) => `'${v}'`).join(",")}]::text[]` : `ARRAY[]::text[]`;
}

/** 마이그레이션 전 대비용 — 예전 식으로 바꾼 어댑터(fallback 이 없으면 그대로) */
function legacyOf(adapter: Adapter): Adapter {
  return adapter.fallback ? { ...adapter, ...adapter.fallback } : adapter;
}

function selectSql(adapter: Adapter): string {
  return `SELECT x.id::text AS id, ${adapter.rawExpr} AS raw, ${adapter.studentNameExpr} AS "studentName",
                 ${adapter.createdAtExpr} AS "createdAt", ${adapter.targetDateExpr} AS "targetDate",
                 json_build_object(${adapter.extra}) AS extra
            FROM ${adapter.from}
           ${adapter.where ? `WHERE ${adapter.where}` : ""}`;
}

/** 개수 조회와 목록이 같은 신청을 세도록 수강 변경은 같은 SQL을 사용한다. */
function inboxRowsSql(adapter: Adapter, settlementTableReady: boolean): string {
  const rows = selectSql(adapter);
  if (adapter.kind !== "ENROLLMENT_CHANGE") return rows;
  return groupEnrollmentChangeInboxSql(
    rows,
    sqlTextArray(statusesOf(adapter.kind, "ACTION")),
    sqlTextArray(statusesOf(adapter.kind, "ONGOING")),
    settlementTableReady,
  );
}

const inboxSettlementTableReady = cache(() => settlementTablesReady(prisma).catch(() => false));
// 질병·부상 이월 검토 표(마이그레이션 20261114130000)가 있는가 — 없으면 그 종류만 예전 식(빈 목록)으로 센다
const inboxIllnessTableReady = cache(() => illnessReviewReady(prisma).catch(() => false));

export type InboxQuery = {
  bucket: InboxBucket;
  kinds?: RequestKind[];
  /** 신청일(KST) 범위 «YYYY-MM-DD» */
  from?: string | null;
  to?: string | null;
  /** 종류마다 최대 몇 줄(완료 칸이 끝없이 길어지지 않게) */
  limitPerKind?: number;
};

/**
 * 신청함 목록 — 종류마다 따로 읽어(한 종류의 표가 아직 없어도 나머지는 보이게) 코드에서 합쳐 정렬한다.
 * 정렬: 처리 필요·진행 중은 오래된 것부터(밀린 일 먼저), 완료는 최신부터.
 */
export async function getInboxRows(query: InboxQuery): Promise<{ rows: InboxRow[]; failedKinds: RequestKind[] }> {
  // 종류를 안 주면 전부, 빈 배열이면 아무것도(체험·수강처럼 catalog 종류가 없는 탭)
  const wanted = new Set(query.kinds ?? REQUEST_KINDS.map((k) => k.kind));
  const requestedLimit = query.limitPerKind ?? 150;
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500) : 150;
  const from = isKstYmd(query.from) ? query.from : null;
  const to = isKstYmd(query.to) ? query.to : null;
  const failedKinds: RequestKind[] = [];
  const settlementTableReady = wanted.has("ENROLLMENT_CHANGE") && await inboxSettlementTableReady();

  const parts = await Promise.all(ADAPTERS.filter((a) => wanted.has(a.kind)).map(async (adapter) => {
    const statuses = statusesOf(adapter.kind, query.bucket);
    if (!statuses.length) return [] as InboxRow[];
    const read = (a: Adapter, settlements = false) => prisma.$queryRawUnsafe<RawRow[]>(
      `SELECT * FROM (${inboxRowsSql(a, settlements)}) t
        WHERE t.raw = ANY(${sqlTextArray(statuses)})
          AND ($1::date IS NULL OR (t."createdAt" AT TIME ZONE 'Asia/Seoul')::date >= $1::date)
          AND ($2::date IS NULL OR (t."createdAt" AT TIME ZONE 'Asia/Seoul')::date <= $2::date)
        ORDER BY t."createdAt" ${query.bucket === "DONE" ? "DESC" : "ASC"}, t.id
        LIMIT ${limit}`,
      from, to,
    );
    try {
      const rows = await read(adapter, settlementTableReady);
      return rows.map((row) => toInboxRow(adapter, row));
    } catch (error) {
      // 새 칸이 아직 없는 운영 DB(마이그레이션 전)면 예전 식으로 한 번 더 — 그래도 실패면 그 종류만 비운다
      if (adapter.fallback) {
        try {
          const rows = await read(legacyOf(adapter));
          return rows.map((row) => toInboxRow(adapter, row));
        } catch { /* 아래에서 기록 */ }
      }
      console.error(`[admin-inbox] ${adapter.kind} 조회 실패:`, error);
      failedKinds.push(adapter.kind);
      return [] as InboxRow[];
    }
  }));

  const rows = parts.flat().sort((a, b) =>
    query.bucket === "DONE" ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt));
  return { rows, failedKinds };
}

function toInboxRow(adapter: Adapter, row: RawRow): InboxRow {
  const extra = (typeof row.extra === "string" ? JSON.parse(row.extra) : row.extra) ?? {};
  const members = adapter.kind === "ENROLLMENT_CHANGE" ? enrollmentChangeMembers(row, extra) : undefined;
  const formatted = adapter.format(row, members && members.length > 1
    ? { ...extra, fromClass: members.map((member) => member.className).join(" · ") }
    : extra);
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
  return {
    kind: adapter.kind,
    id: row.id,
    studentName: row.studentName ?? null,
    title: formatted.title,
    summary: formatted.summary,
    rawStatus: row.raw,
    bucket: bucketFor(adapter.kind, row.raw),
    statusLabel: statusLabel(adapter.kind, row.raw),
    createdAt,
    targetDate: row.targetDate ?? null,
    detailHref: kindEntry(adapter.kind).adminHref,
    facts: formatted.facts,
    ...(members ? { members } : {}),
    ref: formatted.ref,
  };
}

function enrollmentChangeMembers(row: RawRow, extra: Record<string, unknown>): InboxEnrollmentChangeMember[] {
  const source: Record<string, unknown>[] = Array.isArray(extra.members) ? extra.members : [{
    id: row.id, className: extra.fromClass, rawStatus: row.raw,
    enrollmentStatus: extra.enrollmentStatus, holdReason: extra.holdReason,
  }];
  return source.map((member) => {
    const rawStatus = text(member.rawStatus);
    return {
      id: text(member.id),
      className: text(member.className) || "반 정보 없음",
      rawStatus,
      statusLabel: statusLabel("ENROLLMENT_CHANGE", rawStatus),
      enrollmentStatus: text(member.enrollmentStatus) || undefined,
      holdReason: text(member.holdReason) || undefined,
    };
  });
}

/**
 * 처리 필요·진행 중 개수를 세는 SQL — 종류별 조각을 UNION ALL 로 붙여 «한 번»에 센다.
 * legacy=true 면 마이그레이션 전 식(fallback)으로 만든다.
 */
export function buildInboxCountsSql(legacy = false, settlementTableReady = false, illnessTableReady = true): string {
  const pieces = ADAPTERS.filter((original) => !original.skipCount).map((original) => {
    // 질병·부상 검토 표가 아직 없으면 그 종류만 예전 식으로 — 새 표 하나 때문에 메뉴 숫자 전체가 예전 식으로 떨어지지 않게
    const adapter = legacy || (original.kind === "ILLNESS_CARRY" && !illnessTableReady) ? legacyOf(original) : original;
    const open = [...statusesOf(adapter.kind, "ACTION"), ...statusesOf(adapter.kind, "ONGOING")];
    const rows = adapter.kind === "ENROLLMENT_CHANGE"
      ? inboxRowsSql(adapter, settlementTableReady)
      : `SELECT ${adapter.rawExpr} AS raw FROM ${adapter.from} ${adapter.where ? `WHERE ${adapter.where}` : ""}`;
    return `SELECT '${adapter.kind}'::text AS kind, t.raw, COUNT(*)::int AS n
              FROM (${rows}) t
             WHERE t.raw = ANY(${sqlTextArray(open)})
             GROUP BY t.raw`;
  });
  return pieces.join("\nUNION ALL\n");
}

/**
 * 체험·수강 탭 «처리 필요» 숫자 — /admin/apply 의 탭 숫자와 같은 기준(체험 «새 문의» NEW · 수강신청 «대기» PENDING).
 * 두 표는 catalog 종류가 아니라 SQL 한 번에 따로 센다.
 */
export const APPLY_TAB_COUNTS_SQL = `SELECT (SELECT COUNT(*)::int FROM "TrialLead" WHERE status = 'NEW') AS trial,
                (SELECT COUNT(*)::int FROM "EnrollmentApplication" WHERE status = 'PENDING') AS enroll`;

async function readApplyTabCounts(): Promise<Partial<Record<InboxTab, number>>> {
  try {
    const [row] = await prisma.$queryRawUnsafe<Array<{ trial: number; enroll: number }>>(APPLY_TAB_COUNTS_SQL);
    return { TRIAL: Number(row?.trial ?? 0), ENROLL: Number(row?.enroll ?? 0) };
  } catch (error) {
    console.error("[admin-inbox] 체험·수강 개수 조회 실패:", error);
    return {};
  }
}

async function readConsultCount(): Promise<number> {
  try {
    return await countConsultAction();
  } catch (error) {
    console.error("[admin-inbox] 상담 개수 조회 실패:", error);
    return 0;
  }
}

/**
 * 메뉴 배지·«오늘 업무» 카드 숫자. 실패하면 null(화면은 숫자만 숨긴다 — 관리자 화면 전체를 죽이지 않는다)
 * react.cache — 같은 요청 안에서 layout(메뉴 배지)·page(탭 배지)가 같이 불러도 DB 는 한 번만 읽는다.
 */
export const getInboxCounts = cache(readInboxCounts);

async function readInboxCounts(): Promise<InboxCounts | null> {
  type CountRow = { kind: RequestKind; raw: string; n: number };
  const readCatalog = async (): Promise<CountRow[] | null> => {
    try {
      return await prisma.$queryRawUnsafe<CountRow[]>(buildInboxCountsSql(false, await inboxSettlementTableReady(), await inboxIllnessTableReady()));
    } catch (error) {
      // 취소 요청 칸(마이그레이션 20261110130000) 적용 전이면 예전 식으로 다시 센다
      try {
        return await prisma.$queryRawUnsafe<CountRow[]>(buildInboxCountsSql(true));
      } catch {
        console.error("[admin-inbox] 개수 조회 실패:", error);
        return null;
      }
    }
  };
  // 세 묶음은 서로 기다릴 이유가 없어 동시에 읽는다
  const [rows, applyCounts, consult] = await Promise.all([readCatalog(), readApplyTabCounts(), readConsultCount()]);
  if (!rows) return null;
  return summarizeCounts(rows, { ...applyCounts, CONSULT: consult });
}

/** 순수 합산 — 테스트가 직접 부른다. extra = catalog 밖 탭(체험·수강·상담)의 처리 필요 숫자 */
export function summarizeCounts(
  rows: Array<{ kind: RequestKind; raw: string; n: number }>,
  extra: Partial<Record<InboxTab, number>> = {},
): InboxCounts {
  const counts: InboxCounts = { action: 0, ongoing: 0, byKind: {}, byTab: tabActionCounts({}) };
  for (const row of rows) {
    const bucket = bucketFor(row.kind, row.raw);
    if (bucket === "DONE") continue;
    const slot = (counts.byKind[row.kind] ??= { action: 0, ongoing: 0 });
    const n = Number(row.n) || 0;
    if (bucket === "ACTION") slot.action += n; else { slot.ongoing += n; counts.ongoing += n; }
  }
  // 탭 배지 = catalog 종류 합 + 체험·수강·상담. 메뉴 숫자(action)는 탭 배지의 합과 같다(어긋나지 않게 한 곳에서)
  counts.byTab = tabActionCounts(counts.byKind, extra);
  counts.action = Object.values(counts.byTab).reduce((sum, n) => sum + n, 0);
  return counts;
}
