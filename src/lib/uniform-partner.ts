import crypto from "node:crypto";

export const STIZ_PARTNER_ID = "dasan";
export const STIZ_UNIFORM_ORDER_NAME = "스티즈농구교실 다산점 유니폼";
export const STIZ_UNIFORM_API_URL = "https://custom.stiz.kr/api/orders";

export type UniformOrderStudentInput = {
  studentName: string;
  design?: string | null;
  initials?: string | null;
  backNumber?: string | null;
  topSize?: string | null;
  bottomSize?: string | null;
};

export type UniformOrderFormInput = {
  parentName: string;
  parentPhone: string;
  memo?: string | null;
  agreedPrivacy?: boolean;
  honeypot?: string | null;
  students: UniformOrderStudentInput[];
};

export type NormalizedUniformOrderItem = {
  studentName: string;
  design: string | null;
  initials: string | null;
  backNumber: string | null;
  topSize: string | null;
  bottomSize: string | null;
  quantity: number;
};

export type NormalizedUniformOrderInput = {
  parentName: string;
  parentPhone: string;
  parentPhoneDigits: string;
  memo: string | null;
  itemSignature: string;
  students: NormalizedUniformOrderItem[];
};

export type StizUniformPayload = {
  partnerRequestId: string;
  status: "consult_started";
  customer: {
    name: string;
    phone: string;
  };
  items: Array<{
    name: string;
    quantity: number;
    options: Record<string, string>;
  }>;
  customerMemo: string;
};

export type StizUniformResponse = {
  success?: boolean;
  orderNumber?: string;
  duplicate?: boolean;
  message?: string;
  error?: string;
};

export class StizUniformPartnerError extends Error {
  statusCode: number | null;
  retryable: boolean;

  constructor(message: string, options: { statusCode?: number | null; retryable: boolean }) {
    super(message);
    this.name = "StizUniformPartnerError";
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable;
  }
}

function compact(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("010")) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  return raw.trim();
}

export function normalizeUniformOrderInput(input: UniformOrderFormInput): NormalizedUniformOrderInput {
  const parentName = compact(input.parentName);
  const parentPhone = compact(input.parentPhone);
  if (!parentName) throw new Error("학부모 이름을 입력해주세요.");
  if (!parentPhone) throw new Error("학부모 휴대폰 번호를 입력해주세요.");

  const parentPhoneDigits = parentPhone.replace(/\D/g, "");
  if (parentPhoneDigits.length < 10 || parentPhoneDigits.length > 11) {
    throw new Error("학부모 휴대폰 번호를 정확히 입력해주세요.");
  }
  if (!input.agreedPrivacy) throw new Error("개인정보 수집 및 이용에 동의해주세요.");

  const students = input.students
    .map((student) => {
      const studentName = compact(student.studentName);
      const design = compact(student.design);
      const initials = compact(student.initials);
      const backNumber = compact(student.backNumber);
      const topSize = compact(student.topSize);
      const bottomSize = compact(student.bottomSize);
      const quantity = (topSize ? 1 : 0) + (bottomSize ? 1 : 0);
      return studentName ? { studentName, design, initials, backNumber, topSize, bottomSize, quantity } : null;
    })
    .filter((student): student is NormalizedUniformOrderItem => Boolean(student));

  if (students.length === 0) throw new Error("학생 정보를 1명 이상 입력해주세요.");
  if (students.length > 6) throw new Error("한 번에 신청 가능한 학생은 최대 6명입니다.");
  if (students.some((student) => student.quantity === 0)) {
    throw new Error("학생마다 상의 또는 하의 사이즈 중 하나 이상을 선택해주세요.");
  }

  const signatureSource = students
    .map((student) => ({
      bottomSize: student.bottomSize,
      backNumber: student.backNumber,
      design: student.design,
      initials: student.initials,
      studentName: student.studentName,
      topSize: student.topSize,
    }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), "ko"));

  return {
    parentName,
    parentPhone: normalizePhone(parentPhone),
    parentPhoneDigits,
    memo: compact(input.memo),
    itemSignature: canonicalJson(signatureSource),
    students,
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function buildStizUniformOrderPayload(input: {
  partnerRequestId: string;
  parentName: string;
  parentPhone: string;
  memo?: string | null;
  students: NormalizedUniformOrderItem[];
}): StizUniformPayload {
  return {
    partnerRequestId: input.partnerRequestId,
    status: "consult_started",
    customer: {
      name: input.parentName,
      phone: input.parentPhone,
    },
    items: input.students.map((student) => {
      const options: Record<string, string> = {
        "학생명": student.studentName,
      };
      if (student.design) options["디자인"] = student.design;
      if (student.initials) options["이니셜"] = student.initials;
      if (student.backNumber) options["등번호"] = student.backNumber;
      if (student.topSize) options["상의"] = student.topSize;
      if (student.bottomSize) options["하의"] = student.bottomSize;

      return {
        name: STIZ_UNIFORM_ORDER_NAME,
        quantity: student.quantity,
        options,
      };
    }),
    customerMemo: input.memo
      ? `다산점 유니폼 추가주문 · 학원 사이트 접수 · ${input.memo}`
      : "다산점 유니폼 추가주문 · 학원 사이트 접수",
  };
}

export function signStizPartnerPayload(input: {
  secret: string;
  timestamp: number;
  payload: StizUniformPayload;
}) {
  return crypto
    .createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${STIZ_PARTNER_ID}.${canonicalJson(input.payload)}`, "utf8")
    .digest("hex");
}

export async function postStizUniformOrder(payload: StizUniformPayload) {
  const secret = process.env.STIZ_PARTNER_SECRET?.trim();
  if (!secret) {
    throw new StizUniformPartnerError("STIZ_PARTNER_SECRET 환경변수 설정이 필요합니다.", {
      retryable: false,
    });
  }
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) {
    throw new StizUniformPartnerError("STIZ_PARTNER_SECRET 형식이 올바르지 않습니다.", {
      retryable: false,
    });
  }

  const apiUrl = process.env.STIZ_UNIFORM_ORDER_API_URL?.trim() || STIZ_UNIFORM_API_URL;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signStizPartnerPayload({ secret, timestamp, payload });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-STIZ-Partner": STIZ_PARTNER_ID,
        "X-STIZ-Timestamp": String(timestamp),
        "X-STIZ-Signature": signature,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as StizUniformResponse;

    if (!response.ok) {
      const message = body.error || body.message || `STIZ 본사 접수 실패 (${response.status})`;
      throw new StizUniformPartnerError(message, {
        statusCode: response.status,
        retryable: response.status >= 500 && response.status !== 503,
      });
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}
