"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  getMakeupOptionsForCredit,
  bookMakeup,
  cancelMakeupBooking,
  rescheduleMakeup,
  type MakeupOption,
} from "@/lib/makeup/parent-makeup";
import type { MakeupEmptyReason } from "@/lib/makeup/credit-rules";

// 학부모 보강 예약 서버 액션.
//
// ★ 모든 액션이 requireVerifiedParent() 로 **서버에서 다시** 부모를 확인하고,
//   그 appUserId 를 조회 함수에 넘긴다. 클라이언트가 보낸 값으로 소유권을 판단하지 않는다.

// forReschedule(2026-11-15 날짜 바꾸기): 예약 중인 보강권의 «바꿀 수 있는» 후보(지금 예약한 반·날짜 제외)
export async function fetchMakeupOptions(
  creditId: string,
  forReschedule: boolean = false,
): Promise<{ ok: boolean; message?: string; options?: MakeupOption[]; emptyReason?: MakeupEmptyReason | null }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, message: "로그인이 필요합니다." };

  const r = await getMakeupOptionsForCredit(parent.appUserId, creditId, { forReschedule: forReschedule === true });
  if (!r.ok) return { ok: false, message: r.message };
  // emptyReason: 후보가 0건일 때 화면이 이유(학년 정보 없음 / 맞는 반 없음 / 자리 없음)를 나눠 보인다
  return { ok: true, options: r.options, emptyReason: r.emptyReason };
}

export async function bookMakeupAction(input: {
  creditId: string;
  classId: string;
  dateYmd: string;
}): Promise<{ ok: boolean; message: string }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, message: "로그인이 필요합니다." };

  const r = await bookMakeup(parent.appUserId, input);
  if (r.ok) revalidatePath("/mypage/makeup");
  return r;
}

export async function cancelMakeupAction(
  creditId: string,
): Promise<{ ok: boolean; message: string }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, message: "로그인이 필요합니다." };

  const r = await cancelMakeupBooking(parent.appUserId, creditId);
  if (r.ok) revalidatePath("/mypage/makeup");
  return r;
}

// 날짜 바꾸기(2026-11-15) — 예약을 새 반·날짜로 한 번에 갈아 끼운다(보강권은 예약 상태 그대로)
export async function rescheduleMakeupAction(input: {
  creditId: string;
  classId: string;
  dateYmd: string;
}): Promise<{ ok: boolean; message: string }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, message: "로그인이 필요합니다." };

  const r = await rescheduleMakeup(parent.appUserId, input);
  if (r.ok) revalidatePath("/mypage/makeup");
  return r;
}
