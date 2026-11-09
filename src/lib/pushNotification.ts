import webpush from "web-push";
import { prisma } from "@/lib/prisma";
// 학부모가 «종류별 받기»에서 끈 종류(출결·청구·공지·셔틀)는 여기 한 곳에서 거른다 — 발송 경로가 여럿이라도 모두 이 두 함수를 지난다
import { isPushAllowed, optedOutUserIds } from "@/lib/parent-notification-preferences";

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
  subscriptionCount: number;
  sentCount: number;
  failedCount: number;
  removedCount: number;
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

function statusCodeOf(error: unknown) {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function errorMessageOf(error: unknown) {
  return error instanceof Error ? error.message : "PUSH_FAILED";
}

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  options?: { subscriptionIds?: string[] },
): Promise<PushDeliveryResult> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return {
      status: "NOT_CONFIGURED",
      subscriptionCount: 0,
      sentCount: 0,
      failedCount: 0,
      removedCount: 0,
      errorCode: "VAPID_NOT_CONFIGURED",
    };
  }

  // 받는 사람이 이 종류를 껐으면 보내지 않는다(종 목록 알림은 이미 저장됨 — 휴대폰 울림만 끈다).
  // 대기열(push-outbox)은 NO_SUBSCRIPTION 을 «건너뜀(SKIPPED)»으로 기록하고 다시 보내지 않는다.
  if (payload.tag && !(await isPushAllowed(userId, payload.tag))) {
    return {
      status: "NO_SUBSCRIPTION",
      subscriptionCount: 0,
      sentCount: 0,
      failedCount: 0,
      removedCount: 0,
      errorCode: "PUSH_OPTED_OUT",
    };
  }

  let subscriptions: PushSubscriptionRow[];
  try {
    subscriptions = await prisma.$queryRawUnsafe<PushSubscriptionRow[]>(
      `SELECT id, endpoint, p256dh, auth FROM "PushSubscription"
       WHERE "userId" = $1 AND ($2::text[] IS NULL OR id = ANY($2::text[]))`,
      userId,
      options?.subscriptionIds?.length ? options.subscriptionIds : null,
    );
  } catch (error) {
    console.error("Push subscription lookup failed:", errorMessageOf(error));
    return {
      status: "FAILED",
      subscriptionCount: 0,
      sentCount: 0,
      failedCount: 1,
      removedCount: 0,
      errorCode: "SUBSCRIPTION_LOOKUP_FAILED",
    };
  }

  if (subscriptions.length === 0) {
    return {
      status: "NO_SUBSCRIPTION",
      subscriptionCount: 0,
      sentCount: 0,
      failedCount: 0,
      removedCount: 0,
      errorCode: "NO_SUBSCRIPTION",
    };
  }

  let sentCount = 0;
  let failedCount = 0;
  let removedCount = 0;
  const failedSubscriptionIds: string[] = [];

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
        );
        sentCount += 1;
      } catch (error) {
        failedCount += 1;
        const statusCode = statusCodeOf(error);
        if (statusCode === 404 || statusCode === 410) {
          try {
            await prisma.$executeRawUnsafe(
              `DELETE FROM "PushSubscription" WHERE id = $1`,
              subscription.id,
            );
            removedCount += 1;
          } catch (deleteError) {
            console.error("Expired push subscription cleanup failed:", errorMessageOf(deleteError));
          }
          return;
        }
        failedSubscriptionIds.push(subscription.id);
        console.error("Push delivery failed:", errorMessageOf(error));
      }
    }),
  );

  const status: PushDeliveryStatus =
    sentCount === subscriptions.length ? "SENT" : sentCount > 0 ? "PARTIAL" : "FAILED";

  return {
    status,
    subscriptionCount: subscriptions.length,
    sentCount,
    failedCount,
    removedCount,
    ...(failedSubscriptionIds.length ? { failedSubscriptionIds } : {}),
    ...(status === "PARTIAL" ? { errorCode: "PARTIAL_DELIVERY" } : {}),
    ...(status === "FAILED" ? { errorCode: "PUSH_DELIVERY_FAILED" } : {}),
  };
}

export async function sendPushToAllParents(payload: PushPayload): Promise<PushDeliveryResult> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return {
      status: "NOT_CONFIGURED",
      subscriptionCount: 0,
      sentCount: 0,
      failedCount: 0,
      removedCount: 0,
      errorCode: "VAPID_NOT_CONFIGURED",
    };
  }

  try {
    const allSubscriptions = await prisma.$queryRawUnsafe<PushSubscriptionRow[]>(
      `SELECT ps.id, ps."userId", ps.endpoint, ps.p256dh, ps.auth
       FROM "PushSubscription" ps
       JOIN "User" u ON u.id = ps."userId"
       WHERE u.role = 'PARENT'`,
    );
    // 이 종류(예: 공지)를 끈 학부모의 기기는 뺀다
    const optedOut = await optedOutUserIds(payload.tag);
    const subscriptions = allSubscriptions.filter((s) => !s.userId || !optedOut.has(s.userId));
    if (subscriptions.length === 0) {
      return {
        status: "NO_SUBSCRIPTION",
        subscriptionCount: 0,
        sentCount: 0,
        failedCount: 0,
        removedCount: 0,
        errorCode: "NO_SUBSCRIPTION",
      };
    }

    let sentCount = 0;
    let failedCount = 0;
    let removedCount = 0;
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            JSON.stringify(payload),
          );
          sentCount += 1;
        } catch (error) {
          failedCount += 1;
          const statusCode = statusCodeOf(error);
          if (statusCode === 404 || statusCode === 410) {
            await prisma
              .$executeRawUnsafe(`DELETE FROM "PushSubscription" WHERE id = $1`, subscription.id)
              .then(() => { removedCount += 1; })
              .catch((cleanupError: unknown) => {
                console.error("Expired push subscription cleanup failed:", errorMessageOf(cleanupError));
              });
          }
        }
      }),
    );

    const status: PushDeliveryStatus =
      sentCount === subscriptions.length ? "SENT" : sentCount > 0 ? "PARTIAL" : "FAILED";
    return {
      status,
      subscriptionCount: subscriptions.length,
      sentCount,
      failedCount,
      removedCount,
      ...(status === "PARTIAL" ? { errorCode: "PARTIAL_DELIVERY" } : {}),
      ...(status === "FAILED" ? { errorCode: "PUSH_DELIVERY_FAILED" } : {}),
    };
  } catch (error) {
    console.error("Parent push delivery failed:", errorMessageOf(error));
    return {
      status: "FAILED",
      subscriptionCount: 0,
      sentCount: 0,
      failedCount: 1,
      removedCount: 0,
      errorCode: "PARENT_PUSH_FAILED",
    };
  }
}
