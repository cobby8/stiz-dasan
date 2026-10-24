import { createHash } from "node:crypto";

export const SYNC_TARGETS = ["SHEET", "RALLYZ", "WEBSITE"] as const;
export type SyncTarget = (typeof SYNC_TARGETS)[number];

export type OperationsKind =
  | "PAUSE"
  | "WITHDRAW"
  | "RESUME"
  | "CLASS_CHANGE"
  | "CLASS_ADD"
  | "SHUTTLE_START"
  | "SHUTTLE_STOP"
  | "SHUTTLE_EXEMPT"
  | "SHUTTLE_CHANGE"
  | "CONTACT_UPDATE"
  | "BILLING_CORRECTION"
  | "UNKNOWN";

export type ParsedOperationsCommand = {
  sourceText: string;
  studentName: string | null;
  kind: OperationsKind;
  effectiveMonth: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  holdReason: string | null;
  idempotencyKey: string;
};

const KIND_RULES: Array<[OperationsKind, RegExp]> = [
  ["SHUTTLE_EXEMPT", /셔틀\s*비?\s*면제|차량\s*비?\s*면제/],
  ["SHUTTLE_STOP", /셔틀\s*(중단|해지|미탑승)|차량\s*(중단|해지|미탑승)/],
  ["SHUTTLE_START", /셔틀\s*(탑승|신청|이용)|차량\s*(탑승|신청|이용)/],
  ["SHUTTLE_CHANGE", /셔틀|차량|탑승지|하차지/],
  ["WITHDRAW", /퇴원|수강\s*종료/],
  ["RESUME", /복귀|재개|휴원\s*종료/],
  ["PAUSE", /휴원/],
  ["CLASS_CHANGE", /반\s*변경|요일\s*변경|시간\s*변경/],
  ["CLASS_ADD", /추가\s*수강|수업\s*추가|반\s*추가/],
  ["CONTACT_UPDATE", /보호자|연락처|전화번호/],
  ["BILLING_CORRECTION", /청구|수강료|할인|금액/],
];

function normalizeMonth(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const match = value.match(/(20\d{2})[-년.\s]*(1[0-2]|0?[1-9])(?:월)?/);
  if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}`;
  const monthOnly = value.match(/(?:^|\s)(1[0-2]|0?[1-9])월/);
  if (!monthOnly) return fallback;
  return `${fallback.slice(0, 4)}-${String(Number(monthOnly[1])).padStart(2, "0")}`;
}

function extractStudentName(value: string): string | null {
  const cleaned = value.trim().replace(/^[-*•\d.)\s]+/, "");
  const match = cleaned.match(/^([가-힣]{2,5}(?:[AB])?|[A-Za-z][A-Za-z .'-]{1,30})(?=\s|$)/);
  return match?.[1]?.trim() || null;
}

export function operationsRequestKey(input: {
  sourceText: string;
  studentName: string | null;
  kind: OperationsKind;
  effectiveMonth: string;
  scope?: string;
  effectiveDate?: string | null;
  fromClassId?: string | null;
  toClassId?: string | null;
  shuttleIntent?: string | null;
  details?: string | null;
}): string {
  const legacyFields = [
    input.scope || "ADMIN",
    input.sourceText.trim().replace(/\s+/g, " "),
    input.studentName || "",
    input.kind,
    input.effectiveMonth,
  ];
  const hasStructuredIdentity = Boolean(
    input.effectiveDate || input.fromClassId || input.toClassId || input.shuttleIntent || input.details,
  );
  return createHash("sha256")
    // 구조화 필드가 없는 기존 관리자 명령은 배포 전 키와 동일하게 유지한다.
    .update((hasStructuredIdentity ? [...legacyFields, input.effectiveDate || "", input.fromClassId || "", input.toClassId || "", input.shuttleIntent || "", input.details?.trim().replace(/\s+/g, " ") || ""] : legacyFields).join("|"))
    .digest("hex");
}

export function parseOperationsRequest(sourceText: string, fallbackMonth: string): ParsedOperationsCommand[] {
  const fragments = sourceText
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  return fragments.map((fragment) => {
    const studentName = extractStudentName(fragment);
    const kind = KIND_RULES.find(([, pattern]) => pattern.test(fragment))?.[0] ?? "UNKNOWN";
    const effectiveMonth = normalizeMonth(fragment, fallbackMonth);
    const holdReasons = [
      !studentName ? "학생 이름을 확인해야 합니다." : null,
      kind === "UNKNOWN" ? "변경 종류를 확인해야 합니다." : null,
    ].filter(Boolean) as string[];
    const confidence = holdReasons.length > 0 ? "LOW" : /\d{4}|\d{1,2}월/.test(fragment) ? "HIGH" : "MEDIUM";

    return {
      sourceText: fragment,
      studentName,
      kind,
      effectiveMonth,
      confidence,
      holdReason: holdReasons.join(" ") || null,
      idempotencyKey: operationsRequestKey({ sourceText: fragment, studentName, kind, effectiveMonth }),
    };
  });
}

export function overallSyncStatus(statuses: Array<"PENDING" | "SUCCEEDED" | "FAILED" | "SKIPPED">) {
  if (statuses.some((status) => status === "FAILED")) return "PARTIAL" as const;
  if (statuses.length === SYNC_TARGETS.length && statuses.every((status) => status === "SUCCEEDED" || status === "SKIPPED")) {
    return "SYNCED" as const;
  }
  return "PENDING" as const;
}
