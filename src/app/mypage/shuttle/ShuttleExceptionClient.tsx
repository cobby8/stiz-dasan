"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  SHUTTLE_DIRECTIONS,
  SHUTTLE_DIRECTION_LABEL,
  SHUTTLE_EXCEPTION_KINDS,
  SHUTTLE_EXCEPTION_KIND_LABEL,
  type ShuttleDirection,
  type ShuttleExceptionKind,
} from "@/lib/shuttle/dayExceptionRules";
import type { ShuttleExceptionOptions } from "@/lib/shuttle/parent-shuttle-exception";
import { deliveryStatusText, matchesShuttleChange, type DeliveryStatusSummary } from "@/lib/parent-staff-status";

export default function ShuttleExceptionClient({ initial }: { initial: ShuttleExceptionOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [studentId, setStudentId] = useState(initial.children[0]?.studentId ?? "");
  const [serviceDate, setServiceDate] = useState(initial.today);
  const [direction, setDirection] = useState<ShuttleDirection>("PICKUP");
  const [kind, setKind] = useState<ShuttleExceptionKind>("SKIP");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [uncertain, setUncertain] = useState<Record<string, unknown> | null>(null);

  async function reconcile(body: Record<string, unknown>) {
    try {
      const response = await fetch(`/api/mypage/shuttle-exception${body.action === "cancel" ? `?id=${encodeURIComponent(String(body.id))}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error("LOOKUP_FAILED");
      const data = await response.json();
      const found = body.action === "cancel" ? (data.record?.canceled ? data.record : null) :
        (data.upcoming as ShuttleExceptionOptions["upcoming"]).find((row) => matchesShuttleChange(row, body));
      if (!found) throw new Error("NOT_CONFIRMED");
      setDone(`${body.action === "cancel" ? "취소" : "변경"} 저장 완료 · 운행 명단 변경 기록 저장됨. ${deliveryStatusText(found.notificationStatus)}`);
      setUncertain(null);
      setError("");
      router.refresh();
      return true;
    } catch {
      setError("결과 확인 필요: 저장 여부를 아직 확인하지 못했습니다. 다시 제출하지 말고 저장 결과를 확인해 주세요.");
      setUncertain(body);
      return false;
    }
  }

  async function send(body: Record<string, unknown>) {
    setError("");
    setDone("");
    try {
    const response = await fetch("/api/mypage/shuttle-exception", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status >= 500) return reconcile(body);
      setError(data?.error || "처리에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      return false;
    }
    if (!data.ok) return reconcile(body);
    const status: DeliveryStatusSummary | null = data.notificationStatus ?? null;
    setDone(`${body.action === "cancel" ? "취소" : "변경"} 저장 완료 · 운행 명단 변경 기록 저장됨.${data.noOp ? " 동일한 내용이 이미 저장되어 있습니다." : ""} ${deliveryStatusText(status)}${status && !status.driverLinked ? " · 담당 기사 연결·알림 확인 필요" : ""}`);
    setUncertain(null);
    return true;
    } catch {
      return reconcile(body);
    }
  }

  function submit() {
    startTransition(async () => {
      const ok = await send({
        studentId,
        serviceDate,
        direction,
        kind,
        location: kind === "LOCATION" ? location : undefined,
        note,
      });
      if (!ok) return;
      setLocation("");
      setNote("");
      router.refresh();
    });
  }

  function cancel(id: string) {
    startTransition(async () => {
      if (!(await send({ action: "cancel", id }))) return;
      router.refresh();
    });
  }

  if (initial.children.length === 0) {
    return (
      <main className="mx-auto max-w-lg px-4 py-6">
        <h1 className="text-xl font-black text-brand-navy-900 dark:text-white">셔틀 당일 변경</h1>
        <p className="mt-3 rounded-2xl bg-white p-5 text-sm text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-300">
          지금 다니고 있는 반이 없습니다. 학원으로 문의해 주세요.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-black text-brand-navy-900 dark:text-white">셔틀 당일 변경</h1>
        {/* 결석과 헷갈리지 않게 선을 긋는다. 안 그러면 결석인데 여기에 적는다. */}
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          수업은 오지만 <b>셔틀만</b> 바꿀 때 쓰세요. 변경은 운행 명단에 사용할 기록으로 저장됩니다.
          <br />
          수업 자체를 빠지시면 <b>결석 미리 알리기</b>에서 신고해 주세요.
        </p>
      </div>

      {done && <p role="status" className="rounded-xl bg-green-50 p-3 text-sm font-bold text-green-800">{done}</p>}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
      {uncertain && <button type="button" disabled={pending} onClick={() => startTransition(async () => { await reconcile(uncertain); })} className="min-h-11 rounded-xl border px-3 text-sm font-bold">저장 결과 다시 확인</button>}

      {initial.upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="px-1 text-sm font-black text-gray-700 dark:text-gray-200">예정된 변경</h2>
          {initial.upcoming.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-2 rounded-2xl bg-blue-50 p-3 dark:bg-blue-950/30">
              <div className="min-w-0">
                <p className="text-sm font-black text-blue-900 dark:text-blue-200">
                  {item.serviceDate} · {item.studentName}
                </p>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">변경 저장 완료 · {deliveryStatusText(item.notificationStatus)}</p>
                {item.notificationStatus && !item.notificationStatus.driverLinked && <p className="text-xs text-gray-600 dark:text-gray-300">담당 기사 연결·알림 확인 필요</p>}
                <p className="text-xs font-bold text-blue-800 dark:text-blue-300">
                  {SHUTTLE_DIRECTION_LABEL[item.direction as ShuttleDirection] ?? item.direction} ·{" "}
                  {SHUTTLE_EXCEPTION_KIND_LABEL[item.kind as ShuttleExceptionKind] ?? item.kind}
                  {item.location ? ` · ${item.location}` : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={pending || Boolean(uncertain)}
                onClick={() => cancel(item.id)}
                className="min-h-11 shrink-0 rounded-xl border border-blue-300 px-3 text-xs font-bold text-blue-900 disabled:opacity-50 dark:border-blue-800 dark:text-blue-200"
              >
                취소
              </button>
            </div>
          ))}
        </section>
      )}

      <fieldset disabled={pending || Boolean(uncertain)} aria-label="셔틀 변경 내용" className="min-w-0 space-y-4 rounded-2xl border-0 bg-white p-5 shadow-sm dark:bg-gray-800">
        {initial.children.length > 1 && (
          <select
            value={studentId}
            onChange={(event) => setStudentId(event.target.value)}
            className="min-h-11 w-full rounded-xl border border-gray-200 px-3 dark:border-gray-700 dark:bg-gray-900"
          >
            {initial.children.map((child) => (
              <option key={child.studentId} value={child.studentId}>{child.studentName}</option>
            ))}
          </select>
        )}

        <div>
          <label htmlFor="service-date" className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
            어느 날인가요?
          </label>
          <input
            id="service-date"
            type="date"
            value={serviceDate}
            min={initial.today}
            max={initial.maxDate}
            onChange={(event) => setServiceDate(event.target.value)}
            className="min-h-11 w-full rounded-xl border border-gray-200 px-3 dark:border-gray-700 dark:bg-gray-900"
          />
        </div>

        <div>
          <p className="mb-1 text-xs font-bold text-gray-500 dark:text-gray-400">등원인가요, 하원인가요?</p>
          <div className="grid grid-cols-3 gap-1.5">
            {SHUTTLE_DIRECTIONS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setDirection(value)}
                className={`min-h-11 rounded-lg border px-1 text-xs font-bold ${
                  direction === value
                    ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
                    : "border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-200"
                }`}
              >
                {SHUTTLE_DIRECTION_LABEL[value]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-bold text-gray-500 dark:text-gray-400">무엇을 바꾸시나요?</p>
          <div className="grid grid-cols-2 gap-1.5">
            {SHUTTLE_EXCEPTION_KINDS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={`min-h-11 rounded-lg border text-sm font-bold ${
                  kind === value
                    ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
                    : "border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-200"
                }`}
              >
                {SHUTTLE_EXCEPTION_KIND_LABEL[value]}
              </button>
            ))}
          </div>
        </div>

        {kind === "LOCATION" && (
          <div>
            <label htmlFor="shuttle-location" className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
              어디에서 타나요?
            </label>
            {/* 기사님이 읽고 찾아갈 수 있게 적어야 한다. 좌표가 아니라 사람이 읽는 글이다. */}
            <input
              id="shuttle-location"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              maxLength={200}
              placeholder="예: 다산초 정문 앞"
              className="min-h-11 w-full rounded-xl border border-gray-200 px-3 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
        )}

        <div>
          <label htmlFor="shuttle-note" className="mb-1 block text-xs font-bold text-gray-500 dark:text-gray-400">
            기사님께 한마디 (선택)
          </label>
          <textarea
            id="shuttle-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            maxLength={300}
            className="w-full rounded-xl border border-gray-200 p-3 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>

        <button
          type="button"
          disabled={pending || Boolean(uncertain) || !studentId || (kind === "LOCATION" && !location.trim())}
          onClick={submit}
          className="min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)] disabled:opacity-50"
        >
          {pending ? "저장·알림 결과 확인 중..." : "변경 저장하고 알림 요청"}
        </button>
      </fieldset>
    </main>
  );
}
