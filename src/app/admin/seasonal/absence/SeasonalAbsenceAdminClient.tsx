"use client";

import { useCallback, useMemo, useState } from "react";
import type { SeasonalAbsenceRow } from "@/lib/seasonal/admin-absence";
import {
  resolveSeasonalAbsence,
  confirmSeasonalAbsence,
  revertSeasonalAbsenceConfirm,
  loadSeasonalAbsences,
} from "@/app/actions/seasonal-absence-admin";

type Season = { id: string; title: string; status: string };

// 처리방식 드롭다운 옵션 — 관리자가 지정 가능한 3가지(+현재값이 PENDING이면 "미정"도 표시).
const RESOLUTION_OPTIONS = [
  { value: "MAKEUP", label: "보강" },
  { value: "CARRYOVER", label: "이월" },
  { value: "REFUND", label: "환불" },
];

// 원 단위 콤마 포맷: 15000 → "15,000원"
function won(n: number | null) {
  if (n == null) return "-";
  return `${n.toLocaleString("ko-KR")}원`;
}

export default function SeasonalAbsenceAdminClient({
  initial,
}: {
  initial: { seasons: Season[]; absences: SeasonalAbsenceRow[] };
}) {
  const [seasonId, setSeasonId] = useState<string>(""); // "" = 전체 시즌
  const [rows, setRows] = useState<SeasonalAbsenceRow[]>(initial.absences);
  const [busyId, setBusyId] = useState<string>(""); // 처리 중인 건 id(중복 클릭 방지)
  const [err, setErr] = useState("");

  // 시즌 필터 변경 → 서버에서 재조회.
  const reload = useCallback(async (sid: string) => {
    setErr("");
    try {
      const res = await loadSeasonalAbsences({ seasonId: sid || undefined });
      setRows(res.rows);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const onSeasonChange = useCallback(
    (sid: string) => {
      setSeasonId(sid);
      void reload(sid);
    },
    [reload],
  );

  // 처리방식 변경(협의)
  const onResolution = useCallback(
    async (absenceId: string, resolution: string) => {
      setErr("");
      setBusyId(absenceId);
      try {
        await resolveSeasonalAbsence({ absenceId, resolution });
        await reload(seasonId);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId("");
      }
    },
    [reload, seasonId],
  );

  // 확정 / 확정 취소
  const onConfirm = useCallback(
    async (absenceId: string) => {
      setErr("");
      setBusyId(absenceId);
      try {
        await confirmSeasonalAbsence({ absenceId });
        await reload(seasonId);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId("");
      }
    },
    [reload, seasonId],
  );
  const onRevert = useCallback(
    async (absenceId: string) => {
      setErr("");
      setBusyId(absenceId);
      try {
        await revertSeasonalAbsenceConfirm({ absenceId });
        await reload(seasonId);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId("");
      }
    },
    [reload, seasonId],
  );

  const reportedCount = useMemo(() => rows.filter((r) => r.status === "REPORTED").length, [rows]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {/* 헤더 + 시즌 필터 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="academy-section-title">결석 신고 처리</h2>
          {/* 설명문만 제거하고 '미확정 N건' 배지는 그대로 유지한다(처리해야 할 건수 표시) */}
          <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
            {reportedCount > 0 && <span className="font-medium text-[var(--color-academy-warning)]">미확정 {reportedCount}건</span>}
          </p>
        </div>
        <select
          value={seasonId}
          onChange={(e) => onSeasonChange(e.target.value)}
          className="min-h-11 rounded-md border border-[var(--color-academy-line-input)] bg-white px-3 text-sm text-[var(--color-academy-ink)]"
        >
          <option value="">전체 시즌</option>
          {initial.seasons.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>

      {err && (
        <div className="mb-3 rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] px-4 py-3 text-sm text-[var(--color-academy-danger)]">
          {err}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-academy-line-input)] bg-white px-6 py-16 text-center text-sm text-[var(--color-academy-muted)]">
          처리할 결석 신고가 없습니다.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const busy = busyId === r.absenceId;
            const confirmed = r.status === "CONFIRMED";
            return (
              <div
                key={r.absenceId}
                className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* 좌: 학생·회차·사유 */}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold text-[var(--color-academy-ink)]">{r.childName}</span>
                      <span className="text-sm text-[var(--color-academy-muted)]">{r.offeringTitle}</span>
                      {/* 상태 배지 */}
                      {confirmed ? (
                        <span className="inline-flex items-center gap-1 rounded bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-success)]">
                          {r.statusLabel}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-warning)]">
                          {r.statusLabel}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-sm text-[var(--color-academy-muted)]">
                      <span className="font-medium tabular-nums">{r.dateLabel ?? "-"}</span>
                      {r.reasonLabel && <span className="ml-2">· 사유: {r.reasonLabel}</span>}
                      {r.reportedAtLabel && (
                        <span className="ml-2 text-[var(--color-academy-faint)]">· 신고 {r.reportedAtLabel}</span>
                      )}
                    </div>
                    {/* 결제여부 + 회차금액 */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      {r.paid ? (
                        <span className="inline-flex items-center gap-1 rounded bg-[var(--color-academy-soft)] px-2 py-0.5 text-[var(--color-academy-muted)]">
                          결제완료
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-[var(--color-academy-danger)]">
                          미결제 — 결제 후 이월/환불 확정
                        </span>
                      )}
                      <span className="tabular-nums text-[var(--color-academy-muted)]">회차 금액 {won(r.perSessionAmount)}</span>
                    </div>
                  </div>

                  {/* 우: 처리방식 드롭다운 + 확정/취소 */}
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <select
                      value={RESOLUTION_OPTIONS.some((o) => o.value === r.resolution) ? r.resolution : ""}
                      disabled={busy}
                      onChange={(e) => e.target.value && onResolution(r.absenceId, e.target.value)}
                      className="min-h-10 rounded-md border border-[var(--color-academy-line-input)] bg-white px-3 text-sm text-[var(--color-academy-ink)] disabled:opacity-50"
                      aria-label="처리방식"
                    >
                      {/* 현재값이 PENDING이면 "미정"을 선택지로 보여준다(관리자가 아직 지정 안 함) */}
                      {r.resolution === "PENDING" && <option value="">미정 — 선택</option>}
                      {RESOLUTION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>

                    {confirmed ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRevert(r.absenceId)}
                        className="academy-button-secondary academy-button-sm"
                      >
                        확정 취소
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || r.resolution === "PENDING"}
                        onClick={() => onConfirm(r.absenceId)}
                        title={r.resolution === "PENDING" ? "먼저 처리방식을 지정하세요" : undefined}
                        // 행마다 반복되는 작업이라 꽉 찬 주 버튼 대신 옅은 버튼(tonal)
                        className="academy-button-tonal academy-button-sm"
                      >
                        확정
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
