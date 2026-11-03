"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import {
  dispatchUniformOrderById,
  type UniformOrderSubmitResult,
} from "@/lib/uniform-order-service";
import type { UniformOrderFormInput } from "@/lib/uniform-partner";

export async function submitUniformOrder(input: UniformOrderFormInput): Promise<UniformOrderSubmitResult> {
  void input;
  throw new Error("기존 유니폼 신청은 종료되었습니다. STIZ 본사 상품 페이지에서 신청해 주세요.");
}

export async function retryUniformOrderDispatch(orderId: string) {
  await requireAdmin();
  const result = await dispatchUniformOrderById(orderId);
  revalidatePath("/admin/uniform");
  return result;
}
