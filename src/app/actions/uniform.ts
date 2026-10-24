"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import {
  createUniformOrderSubmission,
  dispatchUniformOrderById,
  type UniformOrderSubmitResult,
} from "@/lib/uniform-order-service";
import type { UniformOrderFormInput } from "@/lib/uniform-partner";

export async function submitUniformOrder(input: UniformOrderFormInput): Promise<UniformOrderSubmitResult> {
  const result = await createUniformOrderSubmission(input);
  revalidatePath("/admin/uniform");
  return result;
}

export async function retryUniformOrderDispatch(orderId: string) {
  await requireAdmin();
  const result = await dispatchUniformOrderById(orderId);
  revalidatePath("/admin/uniform");
  return result;
}
