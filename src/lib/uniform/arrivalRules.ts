// 유니폼 신청 현황·학원 도착 규칙(순수 함수 — 테스트에서 바로 부른다). 2026-11-21 원장 지시:
//   «유니폼 신청 현황을 볼 수 있는 페이지 만들고 내가 학원 도착을 누르면 학부모에게 도착 알림 가도록 하자.»
//   «우리 주문건은 생산완료 되면 내가 직접 학원으로 갖고와서 송장은 없어.»
//
// ★ 두 출처를 한 줄 목록으로 만든다
//   · 사이트 신청(UniformOrder + UniformOrderItem) — 무료 증정 포함. 본사로 보내는 연동 상태가 따로 있다.
//   · 본사 쇼핑몰(UniformShopOrder + UniformShopOrderItem) — 매시 동기화로 들어온다(송장 없음).
// ★ «학원 도착»·«수령 완료»는 주문 표가 아니라 UniformArrival 표에 따로 적는다.
//   쇼핑몰 품목 상태는 동기화가 매시 덮어쓰므로 주문 표에 쓰면 사라진다.
// ★ 학생 연결: 무료 증정 링크(UniformFreeGrant.studentId)가 있으면 그것, 없으면 «주문 전화번호 + 학생 이름»이
//   정확히 한 명일 때만(SQL 이 고른다). 이름만으로는 잇지 않는다(동명이인). 못 이으면 문자를 보내지 않는다.
import { isFreeUniformOrderMemo } from "@/lib/uniform-free-grant-rules";

export const UNIFORM_ARRIVED_TRIGGER = "UNIFORM_ARRIVED_PARENT";
export const UNIFORM_ARRIVED_EVENT = "UNIFORM_ARRIVED";
/** 한 번에 도착 처리할 수 있는 최대 줄 수 — 실수로 전체를 눌러도 문자가 수백 건 나가지 않게 */
export const UNIFORM_ARRIVAL_BATCH_LIMIT = 40;

export type UniformSource = "SITE" | "SHOP";
export const UNIFORM_SOURCES: readonly UniformSource[] = ["SITE", "SHOP"];

/** 진행 단계 — 신청 → (무료 증정은 원장 확인) → 본사 주문/생산 중 → 학원 도착 → 수령 */
export type UniformStage = "APPLIED" | "OWNER_REVIEW" | "ORDERED" | "ARRIVED" | "RECEIVED" | "CANCELED";

export const UNIFORM_STAGE_LABEL: Record<UniformStage, string> = {
  APPLIED: "신청",
  OWNER_REVIEW: "원장 확인",
  ORDERED: "본사 주문·생산 중",
  ARRIVED: "학원 도착",
  RECEIVED: "수령 완료",
  CANCELED: "취소",
};

/** 문자 결과 — UniformArrival.noticeStatus */
export type UniformNoticeStatus = "SENT" | "FAILED" | "SKIPPED_NO_STUDENT" | "SKIPPED_NO_PHONE" | "DISABLED";

export const UNIFORM_NOTICE_LABEL: Record<UniformNoticeStatus, string> = {
  SENT: "도착 문자 보냄",
  FAILED: "문자 실패",
  SKIPPED_NO_STUDENT: "학생 미연결 — 문자 안 보냄",
  SKIPPED_NO_PHONE: "보호자 번호 없음 — 문자 안 보냄",
  DISABLED: "자동 문자 꺼짐 — 문자 안 보냄",
};

export type UniformWarningCode = "MISSING_TOP_SIZE" | "MISSING_BOTTOM_SIZE" | "DUPLICATE_NUMBER" | "NO_STUDENT" | "NO_STUDENT_NAME";

export type UniformWarning = { code: UniformWarningCode; message: string };

/** SQL 이 돌려준 한 줄(두 출처 공통 모양). 전화번호는 들어오지 않는다 */
export type UniformBoardRow = {
  source: UniformSource;
  itemId: string;
  orderId: string;
  /** 신청일 KST "YYYY-MM-DD" */
  appliedYmd: string;
  studentName: string | null;
  design: string | null;
  printName: string | null;
  backNumber: string | null;
  topSize: string | null;
  bottomSize: string | null;
  quantity: number;
  // 사이트 신청
  orderStatus?: string | null;
  stizSyncStatus?: string | null;
  hasOrderNumber?: boolean | null;
  customerMemo?: string | null;
  // 쇼핑몰
  shopItemStatus?: string | null;
  shopCanceled?: boolean | null;
  // 학생 연결(SQL)
  studentId: string | null;
  /** 전화+이름으로 찾은 후보 수(0 = 없음, 2 이상 = 동명이인 등으로 못 정함) */
  candidateCount: number;
  linkedByGrant: boolean;
  // 도착 기록(UniformArrival)
  arrivedAt: string | null;
  receivedAt: string | null;
  noticeStatus: string | null;
};

/** 반 정보 — 학생 id → 수강 중인 반 목록 */
export type StudentClassInfo = { classId: string; className: string };

/** 같은 반 친구의 이미 정해진 유니폼 번호(Student.uniformNumber) */
export type ClassmateNumber = { classId: string; studentId: string; studentName: string; uniformNumber: string };

export type UniformBoardItem = UniformBoardRow & {
  key: string;
  stage: UniformStage;
  stageLabel: string;
  classNames: string[];
  warnings: UniformWarning[];
  canArrive: boolean;
  canReceive: boolean;
};

const ORDERED_SITE_SYNC = new Set(["SENT", "DUPLICATE"]);
const ORDERED_SHOP_STATUS = new Set(["PAID", "PREPARING", "SHIPPING", "DELIVERED"]);
const CANCELED_SHOP_STATUS = new Set(["CANCELED", "RETURNED"]);

export function uniformItemKey(source: UniformSource, itemId: string): string {
  return `${source}:${itemId}`;
}

/** "SITE:abc" → { source, itemId }. 모양이 다르면 null */
export function parseUniformItemKey(key: unknown): { source: UniformSource; itemId: string } | null {
  if (typeof key !== "string") return null;
  const index = key.indexOf(":");
  if (index <= 0) return null;
  const source = key.slice(0, index);
  const itemId = key.slice(index + 1);
  if (source !== "SITE" && source !== "SHOP") return null;
  if (!itemId || itemId.length > 200) return null;
  return { source, itemId };
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** 등번호 비교 열쇠 — 앞의 «#»·공백을 지운다. «07»과 «7»은 다른 번호로 본다(유니폼에 찍히는 글자가 다르다) */
export function backNumberKey(value: unknown): string {
  return text(value).replace(/^#+/, "").replace(/\s+/g, "");
}

export function uniformStage(row: Pick<UniformBoardRow, "source" | "orderStatus" | "stizSyncStatus" | "hasOrderNumber" | "customerMemo" | "shopItemStatus" | "shopCanceled" | "arrivedAt" | "receivedAt">): UniformStage {
  const canceled = row.source === "SITE"
    ? text(row.orderStatus) === "CANCELED"
    : row.shopCanceled === true || CANCELED_SHOP_STATUS.has(text(row.shopItemStatus));
  // 도착 기록이 있으면 주문 쪽 상태보다 앞선다(원장이 실제로 받아 온 것) — 다만 취소된 주문은 취소로 보인다
  if (canceled) return "CANCELED";
  if (row.receivedAt) return "RECEIVED";
  if (row.arrivedAt) return "ARRIVED";
  if (row.source === "SITE") {
    const sync = text(row.stizSyncStatus);
    if (row.hasOrderNumber === true || ORDERED_SITE_SYNC.has(sync)) return "ORDERED";
    if (sync === "NEEDS_REVIEW" && isFreeUniformOrderMemo(row.customerMemo)) return "OWNER_REVIEW";
    return "APPLIED";
  }
  return ORDERED_SHOP_STATUS.has(text(row.shopItemStatus)) ? "ORDERED" : "APPLIED";
}

/**
 * 목록 줄 만들기 — 단계·반·경고를 붙인다.
 * 등번호 겹침: «같은 반»에서 다른 학생이 같은 번호를 쓰면 경고. 비교 대상은
 *   ① 이번 목록의 다른 신청(취소 제외) ② 같은 반 친구에게 이미 정해진 번호(Student.uniformNumber).
 * 학생을 못 이은 줄은 반을 모르므로 겹침을 보지 않는다(대신 «학생 연결 필요» 경고).
 */
export function buildUniformBoard(
  rows: UniformBoardRow[],
  classesByStudent: Map<string, StudentClassInfo[]>,
  classmateNumbers: ClassmateNumber[] = [],
): UniformBoardItem[] {
  const items = rows.map((row) => {
    const stage = uniformStage(row);
    return { row, stage, classes: row.studentId ? classesByStudent.get(row.studentId) ?? [] : [] };
  });

  // 반 → 번호 → 그 번호를 쓰는 학생들(id → 이름)
  const numberOwners = new Map<string, Map<string, Map<string, string>>>();
  const addOwner = (classId: string, number: string, studentId: string, studentName: string) => {
    if (!number) return;
    let byNumber = numberOwners.get(classId);
    if (!byNumber) numberOwners.set(classId, (byNumber = new Map()));
    let owners = byNumber.get(number);
    if (!owners) byNumber.set(number, (owners = new Map()));
    if (!owners.has(studentId)) owners.set(studentId, studentName);
  };
  for (const { row, stage, classes } of items) {
    if (stage === "CANCELED" || !row.studentId) continue;
    for (const klass of classes) addOwner(klass.classId, backNumberKey(row.backNumber), row.studentId, text(row.studentName));
  }
  for (const mate of classmateNumbers) addOwner(mate.classId, backNumberKey(mate.uniformNumber), mate.studentId, text(mate.studentName));

  return items.map(({ row, stage, classes }) => {
    const warnings: UniformWarning[] = [];
    if (stage !== "CANCELED") {
      if (!text(row.studentName)) warnings.push({ code: "NO_STUDENT_NAME", message: "학생 이름이 비어 있어요" });
      if (!text(row.topSize)) warnings.push({ code: "MISSING_TOP_SIZE", message: "상의 사이즈가 비어 있어요" });
      if (!text(row.bottomSize)) warnings.push({ code: "MISSING_BOTTOM_SIZE", message: "하의 사이즈가 비어 있어요" });
      if (!row.studentId && text(row.studentName)) {
        warnings.push({
          code: "NO_STUDENT",
          message: row.candidateCount > 1
            ? "같은 번호·이름의 학생이 여러 명이라 학생을 정하지 못했어요 — 도착 문자를 보내지 않아요"
            : "원생과 연결되지 않았어요(주문 전화번호·이름 확인) — 도착 문자를 보내지 않아요",
        });
      }
      const number = backNumberKey(row.backNumber);
      if (number && row.studentId) {
        const clashes: string[] = [];
        for (const klass of classes) {
          const owners = numberOwners.get(klass.classId)?.get(number);
          if (!owners) continue;
          for (const [otherId, otherName] of owners) {
            if (otherId === row.studentId) continue;
            clashes.push(`${klass.className} ${otherName || "다른 학생"}`);
          }
        }
        if (clashes.length > 0) {
          warnings.push({ code: "DUPLICATE_NUMBER", message: `같은 반에 #${number} 이(가) 겹쳐요: ${[...new Set(clashes)].join(", ")}` });
        }
      }
    }
    return {
      ...row,
      key: uniformItemKey(row.source, row.itemId),
      stage,
      stageLabel: UNIFORM_STAGE_LABEL[stage],
      classNames: classes.map((klass) => klass.className),
      warnings,
      canArrive: stage !== "CANCELED" && stage !== "ARRIVED" && stage !== "RECEIVED",
      canReceive: stage === "ARRIVED",
    };
  });
}

export type UniformBoardFilter = {
  /** NOT_ARRIVED(미도착만) · ARRIVED(도착·수령 대기) · RECEIVED · ALL */
  progress: "NOT_ARRIVED" | "ARRIVED" | "RECEIVED" | "ALL";
  source: "ALL" | UniformSource;
  warningsOnly?: boolean;
};

type FilterableItem = Pick<UniformBoardItem, "source" | "stage" | "warnings" | "canArrive">;

export function filterUniformBoard<T extends FilterableItem>(items: T[], filter: UniformBoardFilter): T[] {
  return items.filter((item) => {
    if (filter.source !== "ALL" && item.source !== filter.source) return false;
    if (filter.warningsOnly && item.warnings.length === 0) return false;
    switch (filter.progress) {
      case "NOT_ARRIVED": return item.canArrive;
      case "ARRIVED": return item.stage === "ARRIVED";
      case "RECEIVED": return item.stage === "RECEIVED";
      default: return true;
    }
  });
}

export function countUniformBoard(items: FilterableItem[]) {
  return {
    total: items.length,
    notArrived: items.filter((item) => item.canArrive).length,
    arrived: items.filter((item) => item.stage === "ARRIVED").length,
    received: items.filter((item) => item.stage === "RECEIVED").length,
    warnings: items.filter((item) => item.warnings.length > 0).length,
  };
}

/** 도착 문자 기본 문구 — /admin/sms 에서 고칠 수 있다(코드 기본값은 처음 한 번만 들어간다) */
export function uniformArrivedDefaultBody(prefix: string): string {
  return `${prefix} {{childName}} 학생 유니폼이 학원에 도착했어요. 수업 오실 때 받아 가세요.`;
}

/**
 * 도착 문자 묶음 — 이번에 «새로» 도착 처리된 줄만 받아, 학생 한 명당 문자 한 통으로 묶는다
 * (상·하의가 따로 들어온 쇼핑몰 품목이나 같은 아이의 두 벌이 문자 두 통이 되지 않게).
 * 학생을 못 이은 줄은 notices 에 넣지 않고 skipped 로 돌려준다.
 * eventId 는 묶인 도착 기록 id 중 가장 작은 것 — 같은 묶음을 다시 보내도 문자 장부의 중복 방지 키가 같다.
 */
export function planUniformArrivalNotices(
  claimed: Array<{ arrivalId: string; key: string; studentId: string | null; studentName: string }>,
): { notices: Array<{ studentId: string; studentName: string; eventId: string; arrivalIds: string[]; keys: string[] }>; skipped: Array<{ arrivalId: string; key: string }> } {
  const byStudent = new Map<string, { studentId: string; studentName: string; arrivalIds: string[]; keys: string[] }>();
  const skipped: Array<{ arrivalId: string; key: string }> = [];
  for (const row of claimed) {
    if (!row.studentId) {
      skipped.push({ arrivalId: row.arrivalId, key: row.key });
      continue;
    }
    let group = byStudent.get(row.studentId);
    if (!group) byStudent.set(row.studentId, (group = { studentId: row.studentId, studentName: row.studentName, arrivalIds: [], keys: [] }));
    group.arrivalIds.push(row.arrivalId);
    group.keys.push(row.key);
  }
  const notices = [...byStudent.values()].map((group) => {
    const arrivalIds = [...group.arrivalIds].sort();
    return { ...group, arrivalIds, eventId: `uniform-arrival:${arrivalIds[0]}` };
  });
  return { notices, skipped };
}

/** 문자 보내기 결과 → 도착 기록에 남길 상태 */
export function uniformNoticeStatusFromSms(result: { ok: boolean; reason?: string | null }): UniformNoticeStatus {
  if (result.ok) return "SENT";
  if (result.reason === "AUTOMATION_DISABLED" || result.reason === "SMS_TEMPLATE_UNAVAILABLE") return "DISABLED";
  if (result.reason === "INVALID_RECIPIENT") return "SKIPPED_NO_PHONE";
  return "FAILED";
}

/** 학생 이름 표시 — 문자 변수에 넣는 이름(끝의 동명이인 구분 글자 A/B 는 뗀다) */
export function noticeChildName(name: unknown): string {
  const compact = text(name);
  const stripped = compact.replace(/[A-Za-z0-9]+$/, "").trim();
  return stripped.length > 0 ? stripped : compact;
}
