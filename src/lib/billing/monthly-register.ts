/** 관리자가 근거를 입력한 월 수강대장. 시트·청구서·납부 기록을 자동 수정하지 않는다. */
export type MonthlyRegisterClassStatus = "ACTIVE" | "PAUSED" | "WITHDRAWN" | "CARRY_OVER";

export type MonthlyRegisterClass = {
  classId: string;
  status: MonthlyRegisterClassStatus;
  periodStart: string;
  periodEnd: string;
  baseAmount: number;
  discountAmount: number;
  carryAmount: number;
  prorationAmount: number;
  basis: string;
};

export type MonthlyRegisterDraft = {
  studentId: string;
  month: string;
  classes: MonthlyRegisterClass[];
  shuttleAmount: number;
  shuttleBasis: string;
  reason: string;
};

export type MonthlyRegisterTotals = {
  tuitionAmount: number;
  shuttleAmount: number;
  totalAmount: number;
  rows: Array<{ classId: string; amount: number }>;
};

export type MonthlyRegisterRecord = {
  id: string;
  studentId: string;
  month: string;
  version: number;
  status: "DRAFT" | "CONFIRMED";
  payload: MonthlyRegisterDraft;
  totals: MonthlyRegisterTotals;
  updatedAt: string;
  confirmedAt: string | null;
};

export type MonthlyRegisterView = {
  record: MonthlyRegisterRecord | null;
  history: Array<{
    version: number;
    status: "DRAFT" | "CONFIRMED";
    reason: string;
    createdAt: string;
  }>;
  candidates: Array<{ classId: string; className: string; status: string }>;
  studentName: string;
  writesEnabled: boolean;
};

export class MonthlyRegisterError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MonthlyRegisterError";
    this.status = status;
  }
}

const MAX_AMOUNT = 100_000_000;
const DAY_MS = 86_400_000;
const CLASS_STATUSES = new Set<string>(["ACTIVE", "PAUSED", "WITHDRAWN", "CARRY_OVER"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MonthlyRegisterError(`${label} 형식이 올바르지 않습니다.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MonthlyRegisterError(`${label} 형식이 올바르지 않습니다.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== "string") throw new MonthlyRegisterError(`${label}을 입력해 주세요.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new MonthlyRegisterError(`${label}은 1~${maxLength}자로 입력해 주세요.`);
  }
  return normalized;
}

function money(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT) {
    throw new MonthlyRegisterError(`${label}은 0~100,000,000원의 정수여야 합니다.`);
  }
  // -0도 저장·해시 비교에서는 일반적인 0으로 통일한다.
  return value === 0 ? 0 : value;
}

function date(value: unknown, label: string): { value: string; timestamp: number } {
  const normalized = text(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new MonthlyRegisterError(`${label}은 YYYY-MM-DD 형식이어야 합니다.`);
  }
  const [year, month, day] = normalized.split("-").map(Number);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  // 날짜 값은 시각이 아니므로 시간대 변환 없이 달력 자체로 유효성을 확인한다.
  if (year === 0 || day < 1 || day > daysInMonth) {
    throw new MonthlyRegisterError(`${label}은 실제 존재하는 날짜여야 합니다.`);
  }
  const timestamp = Date.UTC(year, month - 1, day);
  return { value: normalized, timestamp };
}

export function validateMonthlyRegisterDraft(value: unknown): MonthlyRegisterDraft {
  const input = object(value, "월 수강대장");
  const studentId = text(input.studentId, "학생 ID", 200);
  const month = text(input.month, "대상 월", 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 2020 || Number(month.slice(0, 4)) > 2100) {
    throw new MonthlyRegisterError("대상 월은 2020~2100년의 YYYY-MM 형식이어야 합니다.");
  }
  if (!Array.isArray(input.classes) || input.classes.length < 1 || input.classes.length > 20) {
    throw new MonthlyRegisterError("수강 반은 1~20개를 입력해 주세요.");
  }
  const monthStart = Date.parse(`${month}-01T00:00:00.000Z`);
  const nextMonthStart = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
  const classIds = new Set<string>();
  const classes: MonthlyRegisterClass[] = [];

  for (const item of input.classes) {
    const row = object(item, "수강 반");
    const classId = text(row.classId, "반 ID", 200);
    if (classIds.has(classId)) throw new MonthlyRegisterError("같은 반을 중복 입력할 수 없습니다.");
    classIds.add(classId);
    const status = text(row.status, "수강 상태", 20);
    if (!CLASS_STATUSES.has(status)) throw new MonthlyRegisterError("허용되지 않은 수강 상태입니다.");
    const periodStart = date(row.periodStart, "수강 시작일");
    const periodEnd = date(row.periodEnd, "수강 종료일");
    if (periodStart.timestamp > periodEnd.timestamp) {
      throw new MonthlyRegisterError("수강 시작일은 종료일보다 늦을 수 없습니다.");
    }
    if ((periodEnd.timestamp - periodStart.timestamp) / DAY_MS + 1 > 62) {
      throw new MonthlyRegisterError("수강 기간은 시작일과 종료일을 포함해 62일 이하여야 합니다.");
    }
    if (periodEnd.timestamp < monthStart || periodStart.timestamp >= nextMonthStart) {
      throw new MonthlyRegisterError("수강 기간은 선택한 대상 월과 겹쳐야 합니다.");
    }
    const baseAmount = money(row.baseAmount, "기준 수강료");
    const discountAmount = money(row.discountAmount, "할인 차감액");
    const carryAmount = money(row.carryAmount, "이월 차감액");
    const prorationAmount = money(row.prorationAmount, "일할 차감액");
    if (discountAmount + carryAmount + prorationAmount > baseAmount) {
      throw new MonthlyRegisterError("할인·이월·일할 차감액 합계는 기준 수강료를 넘을 수 없습니다.");
    }
    if (status !== "ACTIVE" && [baseAmount, discountAmount, carryAmount, prorationAmount].some((amount) => amount !== 0)) {
      throw new MonthlyRegisterError("휴원·퇴원·이월 상태의 금액은 모두 0원이어야 합니다.");
    }
    classes.push({
      classId, status: status as MonthlyRegisterClassStatus,
      periodStart: periodStart.value, periodEnd: periodEnd.value,
      baseAmount, discountAmount, carryAmount, prorationAmount,
      basis: text(row.basis, "수강료 산정 근거"),
    });
  }

  const shuttleAmount = money(input.shuttleAmount, "셔틀비");
  if (!classes.some((row) => row.status === "ACTIVE") && shuttleAmount !== 0) {
    throw new MonthlyRegisterError("활성 수강 반이 없으면 셔틀비만 부과할 수 없습니다.");
  }
  // 반 입력 순서나 숨은 추가 속성이 승인 대상 내용을 바꾸지 않도록 정규화한다.
  classes.sort((a, b) => a.classId < b.classId ? -1 : a.classId > b.classId ? 1 : 0);
  return {
    studentId, month, classes, shuttleAmount,
    shuttleBasis: text(input.shuttleBasis, "셔틀비 산정 근거"),
    reason: text(input.reason, "변경 사유"),
  };
}

export function calculateMonthlyRegister(draft: MonthlyRegisterDraft): MonthlyRegisterTotals {
  // 호출자가 검증을 빠뜨려도 잘못된 금액은 계산·저장 경로로 넘기지 않는다.
  const normalized = validateMonthlyRegisterDraft(draft);
  const rows = normalized.classes.map((row) => ({
    classId: row.classId,
    amount: row.status === "ACTIVE" ? row.baseAmount - row.discountAmount - row.carryAmount - row.prorationAmount : 0,
  }));
  const tuitionAmount = rows.reduce((sum, row) => sum + row.amount, 0);
  return {
    tuitionAmount,
    shuttleAmount: normalized.shuttleAmount,
    totalAmount: tuitionAmount + normalized.shuttleAmount,
    rows,
  };
}
