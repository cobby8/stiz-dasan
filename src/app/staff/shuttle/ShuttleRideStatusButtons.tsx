"use client";

import { useState, useTransition } from "react";
import { StatusChoiceButton, StatusUndoButton } from "@/components/staff/StatusChoiceButton";
import { userErrorMessage } from "@/components/staff/userErrorMessage";

type Direction = "PICKUP" | "DROPOFF";
type RideStatus = "PENDING" | "BOARDED" | "DROPPED_OFF" | "NO_SHOW";

const STATUS_LABEL: Record<RideStatus, string> = {
  PENDING: "대기",
  BOARDED: "탑승",
  DROPPED_OFF: "하차",
  NO_SHOW: "미탑승",
};

export default function ShuttleRideStatusButtons({
  routeId,
  passengerId,
  direction,
  status,
  onStatusChange,
  onMutationStateChange,
}: {
  routeId: string;
  passengerId: string;
  direction: Direction;
  status: RideStatus;
  onStatusChange: (status: RideStatus) => void;
  onMutationStateChange?: (isPending: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const primaryStatus: RideStatus = direction === "PICKUP" ? "BOARDED" : "DROPPED_OFF";

  function update(nextStatus: RideStatus) {
    const previous = status;
    onStatusChange(nextStatus);
    onMutationStateChange?.(true);
    setMessage("저장 중...");
    startTransition(async () => {
      try {
        const response = await fetch("/api/staff/shuttle", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeId, passengerId, status: nextStatus }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "상태를 저장하지 못했습니다.");
        setMessage(`${STATUS_LABEL[nextStatus]} 저장 완료`);
      } catch (error) {
        onStatusChange(previous);
        setMessage(userErrorMessage(error, "상태를 저장하지 못했습니다."));
      } finally {
        onMutationStateChange?.(false);
      }
    });
  }

  const isFailure = message.includes("못했습니다");

  return (
    <div className="mt-2">
      {/* 게슈탈트 T-02: 주인공(탑승/하차)은 넓게, 위험 쪽(미탑승)은 12px 떼어 오른쪽 좁게.
          «대기»는 상태 버튼 줄에서 빼고 아래 작은 글자 버튼으로 둬서 실수로 누르지 않게 한다. */}
      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <StatusChoiceButton tone="success" icon="check" active={status === primaryStatus} disabled={isPending} onClick={() => update(primaryStatus)}>
          {STATUS_LABEL[primaryStatus]}
        </StatusChoiceButton>
        <StatusChoiceButton tone="danger" icon="close" active={status === "NO_SHOW"} disabled={isPending} onClick={() => update("NO_SHOW")}>
          미탑승
        </StatusChoiceButton>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <p className={`text-xs font-bold ${isFailure ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`} role={isFailure ? "alert" : "status"}>
          {message || `현재 ${STATUS_LABEL[status]}`}
        </p>
        {/* 이미 대기면 되돌릴 것이 없으므로 숨긴다. 저장 경로는 다른 버튼과 같은 update() */}
        {status !== "PENDING" && <StatusUndoButton disabled={isPending} onClick={() => update("PENDING")} />}
      </div>
    </div>
  );
}
