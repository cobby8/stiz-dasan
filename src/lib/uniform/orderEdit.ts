// 유니폼 신청 내용 수정(2026-11-21 원장 «주문 내용을 수정하는 기능도 필요해»).
//
// ★ 지키는 것
//   1) 사이트 신청(UniformOrderItem)만 고친다. 본사몰 주문은 본사 쇼핑몰이 정본이라 여기서 고치지 않는다.
//   2) 본사에 아직 안 간 신청만(전송 대기·재시도 대기·확인 필요·키 설정 필요). 본사 접수(SENT·DUPLICATE)·전송 중(SENDING)·
//      취소된 신청은 거절한다 — 여기만 고치면 본사 주문과 어긋난다. 조건은 UPDATE 의 WHERE 에 넣어 «읽고 나서 바뀐» 경우도 막는다.
//   3) 검증은 신청 화면과 같은 목록(uniform-options). 다만 예전 신청에 목록 밖 값(옛 사이즈 표기 등)이 있으면
//      «그대로 둔 값»은 통과시킨다 — 다른 칸을 고치려다 막히지 않게.
//   4) 수량은 신청 화면과 같은 규칙(상의 1 + 하의 1, 본사 규칙)으로 다시 계산하고, 주문의 중복 확인 열쇠(itemSignature)도 다시 만든다.
//   5) 누가 무엇을 바꿨는지 OperationsAuditLog 에 전후 값을 남긴다(전화번호는 넣지 않는다).
import { canonicalJson } from "@/lib/uniform-partner";
import { DESIGN_OPTIONS, SIZE_OPTIONS } from "@/lib/uniform-options";

export const UNIFORM_ORDER_EDIT_AUDIT_ACTION = "UNIFORM_ORDER_ITEM_EDIT";
/** 본사로 아직 안 간 상태 — 이 상태의 신청만 고칠 수 있다(재전송 버튼이 보이는 상태와 같다) */
export const EDITABLE_SYNC_STATUSES = ["PENDING", "RETRY_WAIT", "NEEDS_REVIEW", "SETUP_REQUIRED"] as const;

export type UniformItemEditFields = {
  studentName: string;
  design: string;
  initials: string;
  backNumber: string;
  topSize: string;
  bottomSize: string;
};

export type UniformItemSnapshot = {
  studentName: string;
  design: string | null;
  initials: string | null;
  backNumber: string | null;
  topSize: string | null;
  bottomSize: string | null;
  quantity: number;
};

export function canEditUniformOrder(order: { orderStatus: string; stizSyncStatus: string }): boolean {
  return order.orderStatus !== "CANCELED" && (EDITABLE_SYNC_STATUSES as readonly string[]).includes(order.stizSyncStatus);
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * 고친 값 검증 → 저장할 값. 문제가 있으면 { error }.
 * 목록 밖 값은 «원래 값과 같을 때만» 통과(옛 신청 보존).
 */
export function normalizeUniformItemEdit(
  input: Partial<Record<keyof UniformItemEditFields, unknown>>,
  original: UniformItemSnapshot,
): { ok: true; value: Omit<UniformItemSnapshot, "quantity"> & { quantity: number } } | { ok: false; error: string } {
  const studentName = clean(input.studentName);
  const design = clean(input.design);
  const initials = clean(input.initials);
  const backNumber = clean(input.backNumber).replace(/^#+/, "");
  const topSize = clean(input.topSize);
  const bottomSize = clean(input.bottomSize);
  const same = (value: string, before: string | null) => value === clean(before);

  if (!studentName) return { ok: false, error: "학생 이름을 입력해 주세요." };
  if (studentName.length > 30) return { ok: false, error: "학생 이름은 30자 이내로 입력해 주세요." };
  if (design && !DESIGN_OPTIONS.includes(design) && !same(design, original.design)) return { ok: false, error: "유니폼 디자인을 다시 선택해 주세요." };
  if (initials.length > 20) return { ok: false, error: "이니셜은 20자 이내로 입력해 주세요." };
  if (backNumber && !/^\d{1,3}$/.test(backNumber)) return { ok: false, error: "등번호는 숫자 3자리 이내로 입력해 주세요." };
  if (!topSize && !bottomSize) return { ok: false, error: "상의 또는 하의 사이즈 중 하나 이상을 선택해 주세요." };
  if (topSize && !SIZE_OPTIONS.includes(topSize) && !same(topSize, original.topSize)) return { ok: false, error: "상의 사이즈를 다시 선택해 주세요." };
  if (bottomSize && !SIZE_OPTIONS.includes(bottomSize) && !same(bottomSize, original.bottomSize)) return { ok: false, error: "하의 사이즈를 다시 선택해 주세요." };

  return {
    ok: true,
    value: {
      studentName,
      design: design || null,
      initials: initials || null,
      backNumber: backNumber || null,
      topSize: topSize || null,
      bottomSize: bottomSize || null,
      // 신청 화면(uniform-partner normalizeUniformOrderInput)과 같은 규칙 — 본사가 이 수량으로 받는다
      quantity: (topSize ? 1 : 0) + (bottomSize ? 1 : 0),
    },
  };
}

/** 주문의 중복 확인 열쇠 — uniform-partner 의 itemSignature 와 같은 모양 */
export function uniformItemSignature(items: Array<Omit<UniformItemSnapshot, "quantity">>): string {
  return canonicalJson(items
    .map((item) => ({
      bottomSize: item.bottomSize,
      backNumber: item.backNumber,
      design: item.design,
      initials: item.initials,
      studentName: item.studentName,
      topSize: item.topSize,
    }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), "ko")));
}

type EditDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

export type UniformItemEditResult = { orderId: string; item: UniformItemSnapshot; changed: string[] };

const FIELD_LABEL: Record<keyof Omit<UniformItemSnapshot, "quantity">, string> = {
  studentName: "학생 이름",
  design: "디자인",
  initials: "이니셜",
  backNumber: "등번호",
  topSize: "상의 사이즈",
  bottomSize: "하의 사이즈",
};

export async function updateUniformOrderItem(
  db: EditDb,
  input: { itemId: unknown; fields: unknown; actorUserId: string | null },
): Promise<UniformItemEditResult> {
  const itemId = clean(input.itemId);
  if (!itemId || itemId.length > 100) throw new Error("고칠 신청을 찾지 못했습니다.");
  const fields = (input.fields && typeof input.fields === "object" ? input.fields : {}) as Record<string, unknown>;

  const rows = await db.$queryRawUnsafe<Array<UniformItemSnapshot & { orderId: string; orderStatus: string; stizSyncStatus: string }>>(
    `SELECT i."uniformOrderId" AS "orderId", i."studentName", i.design, i.initials, i."backNumber", i."topSize", i."bottomSize", i.quantity,
            o."orderStatus", o."stizSyncStatus"
       FROM "UniformOrderItem" i JOIN "UniformOrder" o ON o.id = i."uniformOrderId"
      WHERE i.id = $1 LIMIT 1`,
    itemId,
  );
  const before = rows[0];
  if (!before) throw new Error("고칠 신청을 찾지 못했습니다.");
  if (!canEditUniformOrder(before)) {
    throw new Error("본사에 이미 접수됐거나 취소된 신청은 여기서 고칠 수 없어요. 본사에 직접 수정을 요청해 주세요.");
  }
  const normalized = normalizeUniformItemEdit(fields, before);
  if (!normalized.ok) throw new Error(normalized.error);
  const after = normalized.value;

  const changed = (Object.keys(FIELD_LABEL) as Array<keyof typeof FIELD_LABEL>)
    .filter((key) => clean(before[key]) !== clean(after[key]))
    .map((key) => FIELD_LABEL[key]);
  if (changed.length === 0) return { orderId: before.orderId, item: { ...before }, changed };

  // 저장 — 본사로 안 간 상태일 때만(읽은 뒤 전송이 시작됐으면 0줄 → 거절)
  const statuses = [...EDITABLE_SYNC_STATUSES];
  const updated = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "UniformOrderItem" i
        SET "studentName" = $2, design = $3, initials = $4, "backNumber" = $5, "topSize" = $6, "bottomSize" = $7, quantity = $8
       FROM "UniformOrder" o
      WHERE i.id = $1 AND o.id = i."uniformOrderId"
        AND o."orderStatus" <> 'CANCELED' AND o."stizSyncStatus" = ANY($9::text[])
     RETURNING i.id`,
    itemId, after.studentName, after.design, after.initials, after.backNumber, after.topSize, after.bottomSize, after.quantity, statuses,
  );
  if (updated.length === 0) throw new Error("방금 본사 전송이 시작돼 고치지 못했어요. 새로고침 뒤 상태를 확인해 주세요.");

  // 주문 중복 확인 열쇠 다시 만들기(같은 주문의 모든 학생 기준)
  const items = await db.$queryRawUnsafe<Array<Omit<UniformItemSnapshot, "quantity">>>(
    `SELECT "studentName", design, initials, "backNumber", "topSize", "bottomSize"
       FROM "UniformOrderItem" WHERE "uniformOrderId" = $1 ORDER BY "createdAt" ASC`,
    before.orderId,
  );
  await db.$executeRawUnsafe(
    `UPDATE "UniformOrder" SET "itemSignature" = $2, "updatedAt" = NOW() WHERE id = $1`,
    before.orderId,
    uniformItemSignature(items),
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
     VALUES (gen_random_uuid()::text, $1, 'ADMIN', $2, $3::jsonb)`,
    UNIFORM_ORDER_EDIT_AUDIT_ACTION,
    input.actorUserId,
    JSON.stringify({
      orderId: before.orderId,
      itemId,
      changed,
      before: { studentName: before.studentName, design: before.design, initials: before.initials, backNumber: before.backNumber, topSize: before.topSize, bottomSize: before.bottomSize, quantity: before.quantity },
      after,
    }),
  );
  return { orderId: before.orderId, item: after, changed };
}
