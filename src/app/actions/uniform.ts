"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { sendParentSmsWithResult } from "@/lib/notification";
import { prisma } from "@/lib/prisma";
import { dispatchUniformOrderById } from "@/lib/uniform-order-service";
import { markUniformArrived, markUniformReceived } from "@/lib/uniform/arrivalService";
import { updateUniformOrderItem, type UniformItemEditFields } from "@/lib/uniform/orderEdit";

export async function retryUniformOrderDispatch(orderId: string) {
  await requireAdmin();
  const result = await dispatchUniformOrderById(orderId);
  revalidatePath("/admin/uniform");
  return result;
}

function revalidateUniformScreens() {
  revalidatePath("/admin/uniform/status");
  revalidatePath("/admin/uniform");
  revalidatePath("/admin/students");
  // 유니폼 보유율(대시보드 카드·통계 «유니폼» 탭)이 학생 유니폼 상태로 계산된다
  revalidateTag("admin-stats", { expire: 0 });
  revalidatePath("/admin/stats");
  revalidatePath("/admin");
}

/**
 * «학원 도착» — 고른 유니폼(한 건 또는 여러 건)을 도착으로 적고 학생마다 보호자에게 도착 문자 한 통.
 * 이미 도착한 줄은 다시 보내지 않는다(멱등). 문자는 자동 문자 규칙 UNIFORM_ARRIVED_PARENT 를 따른다.
 */
export async function markUniformArrivedAction(keys: string[]) {
  const admin = await requireAdmin();
  const result = await markUniformArrived(
    {
      db: prisma,
      sendSms: (phone, trigger, variables, options) => sendParentSmsWithResult(phone, trigger, variables, options),
    },
    { keys, actorName: admin.appUserName || null },
  );
  revalidateUniformScreens();
  return result;
}

/** «수령 완료» — 학생이 받아 간 유니폼. 문자는 보내지 않는다 */
export async function markUniformReceivedAction(keys: string[]) {
  const admin = await requireAdmin();
  const result = await markUniformReceived(prisma, { keys, actorName: admin.appUserName || null });
  revalidateUniformScreens();
  return result;
}

/**
 * 유니폼 신청 내용 수정(2026-11-21) — 본사에 아직 안 간 사이트 신청의 학생 한 명분(이름·디자인·이니셜·등번호·사이즈).
 * 본사 접수·취소된 신청은 서버가 거절한다. 전후 값은 운영 감사 기록에 남는다.
 */
export async function updateUniformOrderItemAction(itemId: string, fields: UniformItemEditFields) {
  const admin = await requireAdmin();
  const result = await updateUniformOrderItem(prisma, { itemId, fields, actorUserId: admin.appUserId || null });
  revalidateUniformScreens();
  return result;
}
