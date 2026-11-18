"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { dispatchUniformOrderById } from "@/lib/uniform-order-service";

export async function retryUniformOrderDispatch(orderId: string) {
  await requireAdmin();
  const result = await dispatchUniformOrderById(orderId);
  revalidatePath("/admin/uniform");
  return result;
}
