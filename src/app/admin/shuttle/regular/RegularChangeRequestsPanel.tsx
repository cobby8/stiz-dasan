"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { decideShuttleRegularChange } from "@/app/actions/shuttle-regular-change";
import type { AdminRegularChangeRow } from "@/lib/shuttle/regularChangeRequest";
import { koreanMonthDay } from "@/lib/shuttle/regularChangeRules";

// 학부모 «셔틀 계속 바꾸기» 신청(2026-11-14 결정표 c5) — 셔틀 명단 화면 맨 위 승인 목록.
// 한 건 = 한 줄: 학생 · 무엇을 · 언제부터 · [승인] [반려]. 승인 전에는 명단이 바뀌지 않는다.
//  · 위치 바꾸기: 승인하면 적용 시작일에 그 아이 칸의 정류장이 새 위치로 바뀐다(순서·시각은 그대로 — 확인 필요).
//  · 이용 시작·중단: 명단에 넣고 빼는 일은 아래 명단에서 직접 한다 — 끝나면 이 줄은 저절로 닫힌다.
export default function RegularChangeRequestsPanel({ rows }: { rows: AdminRegularChangeRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  // 반려 사유를 적는 중인 신청
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const open = rows.filter((row) => row.status === "PENDING" || row.status === "APPROVED");
  if (open.length === 0) return null;
  const waiting = open.filter((row) => row.status === "PENDING").length;

  function decide(row: AdminRegularChangeRow, approve: boolean, note?: string) {
    if (approve) {
      const how = row.kind === "CHANGE"
        ? `${koreanMonthDay(row.effectiveFrom)}에 셔틀 명단의 정류장이 새 위치로 바뀝니다(순서·시각은 그대로).`
        : "명단은 자동으로 바뀌지 않습니다 — 아래 명단에서 직접 고쳐 주세요.";
      if (!window.confirm(`${row.studentName} · ${row.summary}\n승인할까요? 학부모에게 앱 알림이 갑니다.\n${how}`)) return;
    }
    setError("");
    startTransition(async () => {
      try {
        const result = await decideShuttleRegularChange({ requestId: row.id, approve, note });
        if (!result.ok) { setError(result.message); return; }
        setRejecting(null);
        router.refresh();
      } catch (e) { setError(adminErrorText(e, "처리하지 못했습니다.")); }
    });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      <details open className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
        <summary className="cursor-pointer font-medium">
          학부모 셔틀 계속 바꾸기 신청 <span className="tabular-nums">{open.length}</span>건
          {waiting > 0 ? <> · 승인 대기 <span className="tabular-nums">{waiting}</span></> : null}
        </summary>
        {error && <p role="alert" className="mt-2 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs text-[var(--color-academy-danger)]">{error}</p>}
        <ul className="mt-2 divide-y divide-[var(--color-academy-line)]">
          {open.map((row) => (
            <li key={row.id} className="py-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold">{row.studentName}</span>
                <span>{row.summary}</span>
                <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">{koreanMonthDay(row.effectiveFrom)}부터 · {row.createdOn} 신청</span>
                {row.status === "APPROVED" && (
                  <span className="rounded bg-[var(--color-academy-success-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-success)]">승인됨{row.todo ? ` · ${row.todo}` : ""}</span>
                )}
                <span className="ml-auto flex flex-wrap justify-end gap-1">
                  {/* 명단 화면이 ?studentId= 를 받아 그 학생을 찾는다(기존 기능). 이용 시작은 «학생 추가»를 바로 연다 */}
                  <Link
                    href={`/admin/shuttle/regular?studentId=${encodeURIComponent(row.studentId)}${row.kind === "START" ? "&add=1" : ""}`}
                    prefetch={false}
                    className="academy-button-secondary academy-button-sm"
                  >
                    {row.kind === "START" ? "명단에 넣기" : "명단에서 보기"}
                  </Link>
                  {row.status === "PENDING" && (
                    <>
                      <button type="button" disabled={pending} onClick={() => setRejecting({ id: row.id, note: "" })} className="academy-button-secondary academy-button-sm">반려</button>
                      <button type="button" disabled={pending} onClick={() => decide(row, true)} className="academy-button-primary academy-button-sm">승인</button>
                    </>
                  )}
                </span>
              </div>
              {/* 새 위치·지금 정류장·학부모 말 — 승인 전에 견줘 볼 것만 */}
              <p className="mt-0.5 break-keep text-xs text-[var(--color-academy-muted)]">
                {row.pickupName && <>새 타는 곳 {row.pickupName}{row.pickupAddress && row.pickupAddress !== row.pickupName ? `(${row.pickupAddress})` : ""} · </>}
                {row.dropoffName && <>새 내리는 곳 {row.dropoffName}{row.dropoffAddress && row.dropoffAddress !== row.dropoffName ? `(${row.dropoffAddress})` : ""} · </>}
                지금 {row.currentStops.length > 0 ? row.currentStops.join(", ") : "명단에 없음"}
                {row.note ? ` · 학부모: ${row.note}` : ""}
              </p>
              {rejecting?.id === row.id && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <input
                    value={rejecting.note}
                    onChange={(event) => setRejecting({ id: row.id, note: event.target.value })}
                    maxLength={300}
                    placeholder="반려 사유(학부모에게 그대로 보입니다)"
                    aria-label="반려 사유"
                    className="academy-input min-w-0 flex-1"
                  />
                  <button type="button" disabled={pending || !rejecting.note.trim()} onClick={() => decide(row, false, rejecting.note)} className="academy-button-danger academy-button-sm">반려 보내기</button>
                  <button type="button" disabled={pending} onClick={() => setRejecting(null)} className="academy-button-secondary academy-button-sm">닫기</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
