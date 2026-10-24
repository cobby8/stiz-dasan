import type { OperationsKind } from "@/lib/operationsSync";

export type ParentEnrollmentContext = {
  enrollmentId: string;
  classId: string;
  className: string;
  status: "ACTIVE" | "PAUSED";
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  slotKey: string | null;
};

export type ParentClassOption = {
  classId: string;
  className: string;
  programName: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  slotKey: string | null;
};

export type ShuttleIntent = "START" | "STOP" | "EXEMPT" | "CHANGE" | null;
export type InterpretationConfidence = "HIGH" | "MEDIUM" | "LOW";

export type ParentOperationsDraftCommand = {
  sourceText: string;
  kind: OperationsKind;
  effectiveDate: string;
  fromClassId: string | null;
  toClassId: string | null;
  shuttleIntent: ShuttleIntent;
  details: string;
  confidence: InterpretationConfidence;
  warnings: string[];
  blockingQuestions: string[];
};

export type ParentOperationsInterpretation = {
  sourceText: string;
  targetMonth: string;
  commands: ParentOperationsDraftCommand[];
  warnings: string[];
  blockingQuestions: string[];
  readyToSubmit: boolean;
};

export type ConfirmedParentOperationsDraft = {
  sourceText: string;
  targetMonth: string;
  commands: ParentOperationsDraftCommand[];
};

const DAY_ALIASES: Record<string, string[]> = {
  월: ["월", "월요일", "MON", "MONDAY"], 화: ["화", "화요일", "TUE", "TUESDAY"],
  수: ["수", "수요일", "WED", "WEDNESDAY"], 목: ["목", "목요일", "THU", "THURSDAY"],
  금: ["금", "금요일", "FRI", "FRIDAY"], 토: ["토", "토요일", "SAT", "SATURDAY"],
  일: ["일", "일요일", "SUN", "SUNDAY"],
};

function normalized(value: string) { return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase(); }

function defaultDate(targetMonth: string) { return `${targetMonth}-01`; }

function isRealCalendarDate(value: string): boolean {
  const match = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function extractDate(text: string, targetMonth: string): { value: string; explicit: boolean; valid: boolean } {
  const iso = text.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  const monthDay = text.match(/\b(0?[1-9]|1[0-2])월\s*(0?[1-9]|[12]\d|3[01])일/);
  const value = iso
    ? `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`
    : monthDay
      ? `${targetMonth.slice(0, 4)}-${String(Number(monthDay[1])).padStart(2, "0")}-${String(Number(monthDay[2])).padStart(2, "0")}`
      : defaultDate(targetMonth);
  return { value, explicit: Boolean(iso || monthDay), valid: isRealCalendarDate(value) };
}

function kindFor(text: string): OperationsKind {
  if (/셔틀\s*비?\s*면제|차량\s*비?\s*면제/.test(text)) return "SHUTTLE_EXEMPT";
  if (/셔틀|차량|탑승|하차/.test(text)) {
    if (/안\s*(타|탈|탑승)|이용(?:하지|하지는)\s*않|이용\s*안|중단|해지|미탑승/.test(text)) return "SHUTTLE_STOP";
    if (/신청|이용|타겠습니다|탑승/.test(text)) return "SHUTTLE_START";
    return "SHUTTLE_CHANGE";
  }
  if (/퇴원|수강\s*종료/.test(text)) return "WITHDRAW";
  if (/복귀|재개|휴원\s*종료/.test(text)) return "RESUME";
  if (/휴원/.test(text)) return "PAUSE";
  if (/추가\s*수강|수업\s*추가|반\s*추가/.test(text)) return "CLASS_ADD";
  if (/옮|변경|바꾸|교시|요일/.test(text)) return "CLASS_CHANGE";
  if (/보호자|연락처|전화번호/.test(text)) return "CONTACT_UPDATE";
  if (/청구|수강료|할인|금액/.test(text)) return "BILLING_CORRECTION";
  return "UNKNOWN";
}

function shuttleIntent(kind: OperationsKind): ShuttleIntent {
  return kind === "SHUTTLE_START" ? "START" : kind === "SHUTTLE_STOP" ? "STOP" :
    kind === "SHUTTLE_EXEMPT" ? "EXEMPT" : kind === "SHUTTLE_CHANGE" ? "CHANGE" : null;
}

function mentionedClassIds(text: string, classes: ParentClassOption[]): string[] {
  const compact = normalized(text);
  const dayKeys = Object.keys(DAY_ALIASES).filter((key) => new RegExp(`${key}(?:요일)?`).test(text));
  const periods = [...text.matchAll(/(\d{1,2})\s*교시/g)].map((match) => match[1]);
  return classes.filter((candidate) => {
    if (compact.includes(normalized(candidate.className))) return true;
    const candidateDay = normalized(candidate.dayOfWeek);
    const dayMatch = dayKeys.some((key) => DAY_ALIASES[key].some((alias) => candidateDay === normalized(alias)));
    if (!dayMatch) return false;
    if (!periods.length) return true;
    const searchable = normalized(`${candidate.className} ${candidate.slotKey || ""}`);
    return periods.some((period) => searchable.includes(`${period}교시`) || searchable.endsWith(`-${period}`));
  }).map((candidate) => candidate.classId);
}

function splitRequests(sourceText: string): string[] {
  // 학부모는 보통 한 문장에 "수업을 바꾸고 셔틀은…"처럼 이어 쓴다.
  // 서로 다른 도메인 키워드가 뒤따르는 연결어만 경계로 삼아 일반 문장을 과분할하지 않는다.
  const withBoundaries = sourceText
    .replace(/(바꾸고|변경하고|옮기고|추가하고|휴원하고|퇴원하고)\s*(?=셔틀|차량|탑승|하차)/g, "$1|")
    .replace(/(중단하고|신청하고|이용하고|면제하고)\s*(?=수업|반|[월화수목금토일](?:요일)?)/g, "$1|");
  return withBoundaries.split(/[\n,;|]+|(?:\s+(?:그리고|또한)\s+)/).map((part) => part.trim()).filter(Boolean);
}

function isRealDate(value: string): boolean {
  return isRealCalendarDate(value);
}

export function interpretParentOperationsRequest(input: {
  sourceText: string;
  targetMonth: string;
  enrollments: ParentEnrollmentContext[];
  classes: ParentClassOption[];
}): ParentOperationsInterpretation {
  const fragments = splitRequests(input.sourceText);
  const commands = fragments.map((fragment): ParentOperationsDraftCommand => {
    const kind = kindFor(fragment);
    const date = extractDate(fragment, input.targetMonth);
    const warnings: string[] = [];
    const blockingQuestions: string[] = [];
    const mentioned = mentionedClassIds(fragment, input.classes);
    const activeIds = input.enrollments.map((item) => item.classId);
    let fromClassId: string | null = null;
    let toClassId: string | null = null;

    if (!date.explicit) warnings.push(`적용일을 입력하지 않아 ${date.value}로 임시 표시했습니다.`);
    if (!date.valid || !isRealDate(date.value) || !date.value.startsWith(`${input.targetMonth}-`)) blockingQuestions.push("적용일을 정확히 확인해 주세요.");
    if (kind === "UNKNOWN") blockingQuestions.push("어떤 변경을 원하는지 선택해 주세요.");

    if (["CLASS_CHANGE", "CLASS_ADD"].includes(kind)) {
      const targets = mentioned.filter((id) => !activeIds.includes(id));
      const currentMentioned = mentioned.filter((id) => activeIds.includes(id));
      fromClassId = currentMentioned.length === 1 ? currentMentioned[0] : input.enrollments.length === 1 ? input.enrollments[0].classId : null;
      toClassId = targets.length === 1 ? targets[0] : mentioned.length === 1 && kind === "CLASS_ADD" ? mentioned[0] : null;
      if (kind === "CLASS_CHANGE" && !fromClassId) blockingQuestions.push("변경할 현재 수업을 선택해 주세요.");
      if (!toClassId) blockingQuestions.push("희망 수업을 실제 개설반 목록에서 선택해 주세요.");
      if (targets.length > 1) blockingQuestions.push("희망 수업 후보가 여러 개입니다. 하나를 선택해 주세요.");
    } else if (["PAUSE", "WITHDRAW", "RESUME"].includes(kind)) {
      fromClassId = mentioned.find((id) => activeIds.includes(id)) || (input.enrollments.length === 1 ? input.enrollments[0].classId : null);
      if (!fromClassId && input.enrollments.length > 1) blockingQuestions.push("요청을 적용할 수업을 선택해 주세요.");
    }

    const confidence: InterpretationConfidence = blockingQuestions.length ? "LOW" : warnings.length ? "MEDIUM" : "HIGH";
    return { sourceText: fragment, kind, effectiveDate: date.value, fromClassId, toClassId, shuttleIntent: shuttleIntent(kind), details: fragment, confidence, warnings, blockingQuestions };
  });
  const warnings = [...new Set(commands.flatMap((command) => command.warnings))];
  const blockingQuestions = [...new Set(commands.flatMap((command) => command.blockingQuestions))];
  return { sourceText: input.sourceText, targetMonth: input.targetMonth, commands, warnings, blockingQuestions, readyToSubmit: commands.length > 0 && blockingQuestions.length === 0 };
}

export function validateConfirmedParentOperationsDraft(
  value: unknown,
  context: { sourceText: string; targetMonth: string; enrollments: ParentEnrollmentContext[]; classes: ParentClassOption[] },
): ConfirmedParentOperationsDraft {
  if (!value || typeof value !== "object") throw new Error("해석된 요청 내용을 먼저 확인해 주세요.");
  const draft = value as Partial<ConfirmedParentOperationsDraft>;
  if (draft.sourceText !== context.sourceText || draft.targetMonth !== context.targetMonth || !Array.isArray(draft.commands) || !draft.commands.length || draft.commands.length > 20) {
    throw new Error("확인한 요청 내용이 원문과 일치하지 않습니다. 다시 해석해 주세요.");
  }
  const validKinds = new Set<string>(["PAUSE", "WITHDRAW", "RESUME", "CLASS_CHANGE", "CLASS_ADD", "SHUTTLE_START", "SHUTTLE_STOP", "SHUTTLE_EXEMPT", "SHUTTLE_CHANGE", "CONTACT_UPDATE", "BILLING_CORRECTION", "UNKNOWN", "OTHER"]);
  const currentIds = new Set(context.enrollments.map((item) => item.classId));
  const classIds = new Set(context.classes.map((item) => item.classId));
  const commands = draft.commands.map((raw) => {
    if (!raw || typeof raw !== "object" || !validKinds.has(raw.kind)) throw new Error("요청 종류를 다시 선택해 주세요.");
    if (!isRealDate(raw.effectiveDate) || !raw.effectiveDate.startsWith(`${context.targetMonth}-`)) throw new Error("적용일은 선택한 적용 월 안에서 골라 주세요.");
    if (raw.fromClassId && !currentIds.has(raw.fromClassId)) throw new Error("현재 수업 정보가 달라졌습니다. 다시 해석해 주세요.");
    if (raw.toClassId && !classIds.has(raw.toClassId)) throw new Error("실제로 개설된 수업만 선택할 수 있습니다.");
    const rawKind = raw.kind as string;
    const kind: OperationsKind = rawKind === "OTHER" ? "UNKNOWN" : raw.kind;
    if (kind === "CLASS_CHANGE") {
      if (!raw.fromClassId) throw new Error("변경할 현재 수업을 선택해 주세요.");
      if (!raw.toClassId) throw new Error("희망 수업을 선택해 주세요.");
      if (raw.fromClassId === raw.toClassId) throw new Error("현재 수업과 다른 희망 수업을 선택해 주세요.");
    }
    if (kind === "CLASS_ADD" && !raw.toClassId) throw new Error("추가할 희망 수업을 선택해 주세요.");
    if (["PAUSE", "WITHDRAW", "RESUME"].includes(kind) && !raw.fromClassId) throw new Error("요청을 적용할 현재 수업을 선택해 주세요.");
    const expectedShuttle = shuttleIntent(kind);
    if (expectedShuttle !== raw.shuttleIntent) throw new Error("요청 종류와 셔틀 변경 상태가 일치하지 않습니다.");
    const serverWarnings = kind === "UNKNOWN" ? ["기타 요청은 원장이 내용을 직접 확인합니다."] : [];
    return { ...raw, kind, sourceText: String(raw.sourceText || context.sourceText).slice(0, 2000), details: String(raw.details || "").slice(0, 2000), warnings: serverWarnings, blockingQuestions: [], confidence: kind === "UNKNOWN" ? "LOW" as const : raw.confidence === "HIGH" ? "HIGH" as const : "MEDIUM" as const };
  });
  return { sourceText: context.sourceText, targetMonth: context.targetMonth, commands };
}
