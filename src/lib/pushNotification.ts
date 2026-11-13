import webpush from "web-push";
import { prisma } from "@/lib/prisma";
// 학부모가 «종류별 받기»에서 끈 종류(출결·청구·공지·셔틀)는 여기 한 곳에서 거른다 — 발송 경로가 여럿이라도 모두 이 두 함수를 지난다
import { isPushAllowed, optedOutUserIds } from "@/lib/parent-notification-preferences";
// 스토어 앱(안드로이드·아이폰) 알림(e2, 2026-11-14): 웹푸시 구독에 더해 앱 토큰에도 FCM 으로 보낸다.
// 설정(FCM_SERVICE_ACCOUNT_JSON)이 없으면 앱 쪽은 조용히 건너뛰고 웹푸시만 예전처럼 나간다.
import { fcmServiceAccount, sendFcm, type FcmServiceAccount } from "@/lib/push/fcm";
import { deleteNativeToken, listNativeTokensForParents, listNativeTokensForUser, type NativeTokenRow } from "@/lib/push/nativePushStore";
import { NATIVE_RETRY_PREFIX, splitRetryIds } from "@/lib/push/nativePushPolicy";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:admin@stiz.kr", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export type PushDeliveryStatus =
  | "SENT"
  | "NO_SUBSCRIPTION"
  | "NOT_CONFIGURED"
  | "PARTIAL"
  | "FAILED";

export type PushDeliveryResult = {
  status: PushDeliveryStatus;
  /** 보낸 기기 수 = 웹푸시 구독 + 앱 토큰 */
  subscriptionCount: number;
  sentCount: number;
  failedCount: number;
  removedCount: number;
  /** 다시 보낼 기기 id. 웹푸시 구독은 id 그대로, 앱 토큰은 "native:<id>" (push-outbox 재시도가 그대로 돌려준다) */
  failedSubscriptionIds?: string[];
  errorCode?: string;
};

type PushSubscriptionRow = {
  id: string;
  userId?: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

/** 기기 하나에 보낸 결과: 보냄 / 죽은 구독·토큰이라 지움 / 죽었는데 지우기 실패(다시 보내지 않음) / 실패(다시 보낼 수 있음) */
type DeviceOutcome = "sent" | "removed" | "dropped" | "failed";

/** 보낼 기기 하나 — 웹푸시 구독이든 앱 토큰이든 같은 모양으로 모아 한 번에 센다 */
type DeviceTarget = { retryId: string; send: () => Promise<DeviceOutcome> };

function statusCodeOf(error: unknown) {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function errorMessageOf(error: unknown) {
  return error instanceof Error ? error.message : "PUSH_FAILED";
}

function webPushReady() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

function emptyResult(status: PushDeliveryStatus, errorCode: string): PushDeliveryResult {
  return { status, subscriptionCount: 0, sentCount: 0, failedCount: 0, removedCount: 0, errorCode };
}

/** 웹푸시 구독 하나 → 기기 발송. 404·410(브라우저가 구독을 버림)이면 그 구독을 지운다 */
function webTarget(subscription: PushSubscriptionRow, payload: PushPayload): DeviceTarget {
  return {
    retryId: subscription.id,
    send: async () => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
        );
        return "sent";
      } catch (error) {
        const statusCode = statusCodeOf(error);
        if (statusCode === 404 || statusCode === 410) {
          try {
            await prisma.$executeRawUnsafe(`DELETE FROM "PushSubscription" WHERE id = $1`, subscription.id);
            return "removed";
          } catch (deleteError) {
            console.error("Expired push subscription cleanup failed:", errorMessageOf(deleteError));
            return "dropped";
          }
        }
        console.error("Push delivery failed:", errorMessageOf(error));
        return "failed";
      }
    },
  };
}

/** 앱 토큰 하나 → FCM 발송. UNREGISTERED 등 죽은 토큰이면 그 토큰을 지운다 */
function nativeTarget(row: NativeTokenRow, account: FcmServiceAccount, payload: PushPayload): DeviceTarget {
  return {
    retryId: `${NATIVE_RETRY_PREFIX}${row.id}`,
    send: async () => {
      const outcome = await sendFcm(account, row.platform, row.token, payload);
      if (outcome.kind === "sent") return "sent";
      if (outcome.kind === "invalid-token") {
        return (await deleteNativeToken(row.id)) ? "removed" : "dropped";
      }
      console.error("Native push delivery failed:", outcome.code);
      return "failed";
    },
  };
}

/** 한 번에 동시에 보내는 기기 수 — 전체 공지(학부모 수백 명)에서 연결·메모리가 한꺼번에 몰리지 않게 */
export const PUSH_SEND_CONCURRENCY = 20;

/**
 * 모은 기기에 동시 PUSH_SEND_CONCURRENCY 개씩 보내고 결과를 센다(예전 웹푸시 계산과 같은 규칙).
 * 지운 구독·토큰도 «실패 1»로 세고(예전과 같음), 다시 보낼 목록에는 넣지 않는다.
 */
async function deliver(targets: DeviceTarget[], collectRetry: boolean): Promise<PushDeliveryResult> {
  if (targets.length === 0) return emptyResult("NO_SUBSCRIPTION", "NO_SUBSCRIPTION");
  let sentCount = 0;
  let failedCount = 0;
  let removedCount = 0;
  const failedSubscriptionIds: string[] = [];
  // 일꾼 N 명이 목록에서 다음 기기를 하나씩 가져가 보낸다(순서대로 20개씩 묶는 것보다 느린 기기 하나에 덜 막힌다)
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++];
      const outcome = await target.send();
      if (outcome === "sent") {
        sentCount += 1;
        continue;
      }
      failedCount += 1;
      if (outcome === "removed") removedCount += 1;
      else if (outcome === "failed" && collectRetry) failedSubscriptionIds.push(target.retryId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PUSH_SEND_CONCURRENCY, targets.length) }, worker));
  const status: PushDeliveryStatus =
    sentCount === targets.length ? "SENT" : sentCount > 0 ? "PARTIAL" : "FAILED";
  return {
    status,
    subscriptionCount: targets.length,
    sentCount,
    failedCount,
    removedCount,
    ...(failedSubscriptionIds.length ? { failedSubscriptionIds } : {}),
    ...(status === "PARTIAL" ? { errorCode: "PARTIAL_DELIVERY" } : {}),
    ...(status === "FAILED" ? { errorCode: "PUSH_DELIVERY_FAILED" } : {}),
  };
}

/**
 * 한 사람에게 보낸다 — 이 사람의 웹푸시 구독(브라우저) + 앱 토큰(스토어 앱) 전부.
 * 같은 사람이 PC 브라우저와 휴대폰 앱을 둘 다 쓰면 둘 다 받는다(예전에도 기기마다 하나씩 보냈다 — 같은 규칙).
 * 같은 알림을 두 번 만들지 않는 건 이 함수 바깥(NotificationDelivery 중복방지 키 «…:push» 1건 = 1회 호출)이 맡는다.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  options?: { subscriptionIds?: string[] },
): Promise<PushDeliveryResult> {
  const webReady = webPushReady();
  const fcm = fcmServiceAccount();
  if (!webReady && !fcm) {
    return emptyResult("NOT_CONFIGURED", "VAPID_NOT_CONFIGURED");
  }

  // 받는 사람이 이 종류를 껐으면 보내지 않는다(종 목록 알림은 이미 저장됨 — 휴대폰 울림만 끈다). 웹·앱 모두 같은 스위치.
  // 대기열(push-outbox)은 NO_SUBSCRIPTION 을 «건너뜀(SKIPPED)»으로 기록하고 다시 보내지 않는다.
  if (payload.tag && !(await isPushAllowed(userId, payload.tag))) {
    return emptyResult("NO_SUBSCRIPTION", "PUSH_OPTED_OUT");
  }

  // 재시도면 실패했던 기기만(웹 id 와 "native:" id 를 나눠서)
  const retry = splitRetryIds(options?.subscriptionIds);

  let subscriptions: PushSubscriptionRow[] = [];
  if (webReady && !(retry.web && retry.web.length === 0)) {
    try {
      subscriptions = await prisma.$queryRawUnsafe<PushSubscriptionRow[]>(
        `SELECT id, endpoint, p256dh, auth FROM "PushSubscription"
         WHERE "userId" = $1 AND ($2::text[] IS NULL OR id = ANY($2::text[]))`,
        userId,
        retry.web,
      );
    } catch (error) {
      console.error("Push subscription lookup failed:", errorMessageOf(error));
      return { ...emptyResult("FAILED", "SUBSCRIPTION_LOOKUP_FAILED"), failedCount: 1 };
    }
  }
  // 앱 토큰 조회 실패(표가 아직 없는 등)는 «앱 토큰 0개»로 본다 — 웹푸시까지 막지 않는다
  const nativeRows = fcm ? await listNativeTokensForUser(userId, retry.native) : [];

  return deliver(
    [
      ...subscriptions.map((s) => webTarget(s, payload)),
      ...(fcm ? nativeRows.map((row) => nativeTarget(row, fcm, payload)) : []),
    ],
    true,
  );
}

/** 학부모 전원(전체 공지) — 웹푸시 구독 + 앱 토큰. 이 종류를 끈 학부모의 기기는 뺀다 */
export async function sendPushToAllParents(payload: PushPayload): Promise<PushDeliveryResult> {
  const webReady = webPushReady();
  const fcm = fcmServiceAccount();
  if (!webReady && !fcm) {
    return emptyResult("NOT_CONFIGURED", "VAPID_NOT_CONFIGURED");
  }

  try {
    const allSubscriptions = webReady
      ? await prisma.$queryRawUnsafe<PushSubscriptionRow[]>(
        `SELECT ps.id, ps."userId", ps.endpoint, ps.p256dh, ps.auth
         FROM "PushSubscription" ps
         JOIN "User" u ON u.id = ps."userId"
         WHERE u.role = 'PARENT'`,
      )
      : [];
    const allNative = fcm ? await listNativeTokensForParents() : [];
    // 이 종류(예: 공지)를 끈 학부모의 기기는 뺀다
    const optedOut = await optedOutUserIds(payload.tag);
    const subscriptions = allSubscriptions.filter((s) => !s.userId || !optedOut.has(s.userId));
    const nativeRows = allNative.filter((row) => !row.userId || !optedOut.has(row.userId));

    // 전체 발송은 예전처럼 재시도 목록을 만들지 않는다(대기열을 거치지 않는 베스트에포트)
    return await deliver(
      [
        ...subscriptions.map((s) => webTarget(s, payload)),
        ...(fcm ? nativeRows.map((row) => nativeTarget(row, fcm, payload)) : []),
      ],
      false,
    );
  } catch (error) {
    console.error("Parent push delivery failed:", errorMessageOf(error));
    return { ...emptyResult("FAILED", "PARENT_PUSH_FAILED"), failedCount: 1 };
  }
}
