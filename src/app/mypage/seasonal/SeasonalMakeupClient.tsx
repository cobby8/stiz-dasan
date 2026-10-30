"use client";

import { useCallback, useEffect, useState } from "react";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";

const STATUS_LABEL: Record<string, string> = { REQUESTED: "신청 접수 (승인 대기)", SCHEDULED: "보강 확정", ATTENDED: "보강 완료", NO_SHOW: "미출석" };

// 결석 사유 선택지 + 각 사유의 안내문(학부모에게 처리방향 미리 안내)
const ABSENCE_REASONS: { value: string; label: string; hint: string }[] = [
  { value: "ILLNESS_INJURY", label: "질병·부상", hint: "질병·부상은 이월 또는 환불 검토 대상이에요." },
  { value: "PERSONAL", label: "개인 사정", hint: "보강 대상이에요." },
  { value: "FAMILY_TRIP", label: "가족 여행", hint: "보강 대상이에요." },
  { value: "SCHOOL_EVENT", label: "학교 행사", hint: "보강 대상이에요." },
  { value: "ETC", label: "기타", hint: "보강 대상이에요." },
];

// 세 목록(보강 필요한 결석·예정 회차·보강 신청 현황)이 같은 «한 목록 + 행 구분선» 틀을 쓴다
const LIST_CLASS = "divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800";

export default function SeasonalMakeupClient({ initial }: { initial: any }) {
  const [ctx, setCtx] = useState<any>(initial);
  const [open, setOpen] = useState<string>("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try { const r = await fetch("/api/mypage/seasonal-makeup", { cache: "no-store" }); const j = await r.json(); if (r.ok) setCtx(j); }
    catch { /* noop */ }
  }, []);

  async function request(enrollmentDateId: string, targetType: string, target: any) {
    setErr(""); setMsg(""); setBusy(true);
    try {
      const body: any = { enrollmentDateId, targetType };
      if (targetType === "SEASONAL") body.targetSessionDateId = target.sessionDateId;
      else { body.targetClassId = target.classId; body.targetDate = target.nextDate; }
      const r = await fetch("/api/mypage/seasonal-makeup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error || "신청 실패");
      setMsg("보강 신청이 접수되었습니다. 학원 승인 후 확정됩니다."); setOpen(""); await reload();
    } catch (e) { setErr(customerMessage(e, "보강 신청을 접수하지 못했습니다. 잠시 후 다시 시도해 주세요.")); } finally { setBusy(false); }
  }

  // ── 예정 회차 · 사전 결석 신고 ──────────────────────────────────────────
  const [seats, setSeats] = useState<any[]>([]);          // 미래 회차 목록
  const [seatReason, setSeatReason] = useState<Record<string, string>>({}); // 회차별 선택 사유
  const [seatOpen, setSeatOpen] = useState<string>("");   // 열린 신고 폼

  // 예정 회차는 페이지 로드 후 별도 API로 조회(마이페이지 보강 컨텍스트와 소스가 다름)
  const reloadSeats = useCallback(async () => {
    try {
      const r = await fetch("/api/mypage/seasonal-absence", { cache: "no-store" });
      const j = await r.json();
      if (r.ok) setSeats(j.seats || []);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { reloadSeats(); }, [reloadSeats]);

  // 결석 신고
  async function reportAbsence(enrollmentDateId: string) {
    const reason = seatReason[enrollmentDateId];
    if (!reason) { setErr("결석 사유를 선택해 주세요."); return; }
    setErr(""); setMsg(""); setBusy(true);
    try {
      const r = await fetch("/api/mypage/seasonal-absence", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "report", enrollmentDateId, reason }),
      });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error || "신고 실패");
      setMsg("결석 신고가 접수되었습니다. 최종 처리는 학원과 협의됩니다."); setSeatOpen(""); await reloadSeats();
    } catch (e) { setErr(customerMessage(e, "결석 신고를 접수하지 못했습니다. 잠시 후 다시 시도해 주세요.")); } finally { setBusy(false); }
  }

  // 결석 신고 취소
  async function cancelAbsence(enrollmentDateId: string) {
    setErr(""); setMsg(""); setBusy(true);
    try {
      const r = await fetch("/api/mypage/seasonal-absence", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", enrollmentDateId }),
      });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error || "취소 실패");
      setMsg("결석 신고가 취소되었습니다."); await reloadSeats();
    } catch (e) { setErr(customerMessage(e, "결석 신고를 취소하지 못했습니다. 잠시 후 다시 시도해 주세요.")); } finally { setBusy(false); }
  }

  if (!ctx.phoneKnown) {
    return <div className="mx-auto max-w-lg p-4"><h1 className="mb-2 text-lg font-black">방학특강 보강</h1><div className="rounded-xl bg-gray-50 p-4 text-sm font-bold text-gray-500 dark:bg-gray-900">계정에 등록된 전화번호로 신청 내역을 찾을 수 없습니다. 학원에 문의해 주세요.</div></div>;
  }

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 text-lg font-black">🏀 방학특강 결석 신고 · 보강</h1>
      <p className="mb-4 text-sm font-bold text-gray-500">앞으로 못 오는 회차는 <b>미리 결석 신고</b>(셔틀 자동 제외), 이미 결석한 회차는 <b>보강 신청</b>을 할 수 있어요. (보강은 결석일로부터 2개월 이내)</p>

      {msg && <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm font-bold text-green-700 dark:bg-green-950 dark:text-green-300">{msg}</div>}
      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700 dark:bg-red-950 dark:text-red-300">{err}</div>}

      <div className="mb-2 text-sm font-black">보강이 필요한 결석</div>
      {/* 카드 묶음 대신 한 목록의 행(divide-y) — 휴대폰 첫 화면에 더 많이 보이게 */}
      {(ctx.absences || []).length > 0 && (
        <ul className={LIST_CLASS}>
          {(ctx.absences || []).map((ab: any) => (
            <li key={ab.enrollmentDateId} className="px-3 py-2">
              {/* 한 줄 행: 자녀 · 특강 이름(줄바꿈 허용) · 결석일(오른쪽) · 보강 신청 버튼 — «·»로 잇던 글을 요소로 나눔 */}
              <div className="flex min-h-11 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black">{ab.childName}</p>
                  <p className="break-keep text-xs font-bold text-gray-500">{ab.offeringTitle}</p>
                </div>
                <span className="shrink-0 text-right text-xs font-bold tabular-nums text-red-600">{ab.absentLabel} 결석</span>
                {/* 행의 «여는» 버튼 = 옅은 바탕(tonal), 열린 뒤 «닫기» = 글자 버튼(M-08) */}
                <button onClick={() => setOpen(open === ab.enrollmentDateId ? "" : ab.enrollmentDateId)}
                  className={`${open === ab.enrollmentDateId ? "academy-button-text" : "academy-button-tonal"} shrink-0`}>{open === ab.enrollmentDateId ? "닫기" : "보강 신청"}</button>
              </div>
              {/* 보강 후보 고르기 — 기존 그대로(후보를 누르면 바로 신청, 학원 승인 후 확정) */}
              {open === ab.enrollmentDateId && (
                <div className="mb-1 mt-2 border-t border-gray-100 pt-2 dark:border-gray-700">
                  <div className="mb-1 text-xs font-black text-gray-500">① 같은 특강 다른 날짜</div>
                  {ab.seasonalCandidates.length === 0 && <div className="mb-2 text-xs text-gray-400">여유 있는 날짜가 없습니다.</div>}
                  <div className="mb-2 flex flex-wrap gap-2">
                    {ab.seasonalCandidates.map((s: any) => (
                      <button key={s.sessionDateId} disabled={busy} onClick={() => request(ab.enrollmentDateId, "SEASONAL", s)}
                        className="min-h-11 rounded-lg border border-gray-200 px-3 text-xs font-black tabular-nums hover:border-[var(--brand-accent)] disabled:opacity-50 dark:border-gray-600">{s.label} <span className="text-gray-400">여유{s.remaining}</span></button>
                    ))}
                  </div>
                  {ab.regularCandidates.length > 0 && <>
                    <div className="mb-1 mt-2 text-xs font-black text-gray-500">② 정규수업 보강 (추천)</div>
                    <div className="flex flex-wrap gap-2">
                      {ab.regularCandidates.map((c: any) => (
                        <button key={c.classId} disabled={busy} onClick={() => request(ab.enrollmentDateId, "REGULAR", c)}
                          className="min-h-11 rounded-lg border border-gray-200 px-3 py-1.5 text-left text-xs font-black hover:border-[var(--brand-accent)] disabled:opacity-50 dark:border-gray-600">
                          {/* 날짜와 반 이름을 요소로 나눔 */}
                          <div className="flex flex-wrap gap-x-1.5"><span className="tabular-nums">{c.nextLabel}</span><span className="break-keep">{c.name}</span></div>
                          <div className="font-bold text-gray-400">{c.schedule}</div>
                        </button>
                      ))}
                    </div>
                  </>}
                  <p className="mt-2 text-xs font-bold text-gray-400">신청 후 학원 승인 시 확정됩니다.</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(ctx.absences || []).length === 0 && <div className="rounded-xl bg-gray-50 p-4 text-sm font-bold text-gray-500 dark:bg-gray-900">현재 보강이 필요한 결석이 없습니다.</div>}

      {/* ── 예정 회차 · 결석 미리 신고 ── */}
      <div className="mb-2 mt-6 text-sm font-black">예정 회차 · 결석 미리 신고</div>
      <p className="mb-2 text-xs font-bold text-gray-400">앞으로의 수업에 못 오게 되면 미리 신고할 수 있어요. 신고하면 그날 셔틀 배차에서도 자동 제외됩니다.</p>
      {seats.length > 0 && (
        <ul className={LIST_CLASS}>
          {seats.map((s: any) => {
            const reasonInfo = ABSENCE_REASONS.find((x) => x.value === (seatReason[s.enrollmentDateId] || ""));
            return (
              <li key={s.enrollmentDateId} className="px-3 py-2">
                {/* 한 줄 행: 자녀 · 특강 이름 · (상태 배지·사유) | 회차 날짜(오른쪽) · 동작 */}
                <div className="flex min-h-11 flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-black">{s.childName}</p>
                    <p className="break-keep text-xs font-bold text-gray-500">{s.offeringTitle}</p>
                    {/* 신고됨(본인이 사전 신고) → 상태 배지와 사유를 나눠 표시 */}
                    {s.reported && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-black text-amber-700 dark:bg-amber-950 dark:text-amber-300">결석 신고됨</span>
                        {s.reasonLabel && <span className="text-xs font-bold text-gray-600 dark:text-gray-300">{s.reasonLabel}</span>}
                        {s.locked && <span className="text-xs font-bold text-gray-400">학원 확정 — 변경은 문의</span>}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-right text-xs font-bold tabular-nums text-gray-600 dark:text-gray-300">{s.dateLabel}</span>
                  {/* 동작 — 기존과 같은 조건·같은 함수 */}
                  {s.reported ? (
                    !s.locked && (
                      // 신고 취소 = 그 자리 확인(C-M1) 후 기존 cancelAbsence(s.enrollmentDateId) 그대로
                      <InlineConfirm label="신고 취소" question="이 결석 신고를 취소할까요?" confirmLabel="신고 취소하기"
                        onConfirm={() => cancelAbsence(s.enrollmentDateId)} pending={busy} openClassName="basis-full" />
                    )
                  ) : s.locked ? (
                    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-1 text-xs font-black text-gray-500 dark:bg-gray-700 dark:text-gray-300">출결 확정됨</span>
                  ) : (
                    <button onClick={() => setSeatOpen(seatOpen === s.enrollmentDateId ? "" : s.enrollmentDateId)}
                      className={`${seatOpen === s.enrollmentDateId ? "academy-button-text" : "academy-button-tonal"} shrink-0`}>{seatOpen === s.enrollmentDateId ? "닫기" : "결석 신고"}</button>
                  )}
                </div>
                {/* 신고 폼: 사유 드롭다운 + 안내문 + 제출 (기존 그대로) */}
                {seatOpen === s.enrollmentDateId && !s.reported && !s.locked && (
                  <div className="mb-1 mt-2 border-t border-gray-100 pt-2 dark:border-gray-700">
                    <div className="mb-1 text-xs font-black text-gray-500">결석 사유</div>
                    <select
                      value={seatReason[s.enrollmentDateId] || ""}
                      onChange={(e) => setSeatReason((prev) => ({ ...prev, [s.enrollmentDateId]: e.target.value }))}
                      className="mb-2 min-h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold dark:border-gray-600 dark:bg-gray-900">
                      <option value="">사유를 선택하세요</option>
                      {ABSENCE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    {reasonInfo && <p className="mb-2 text-xs font-bold text-gray-400">{reasonInfo.hint} 최종 처리는 학원과 협의됩니다.</p>}
                    <button onClick={() => reportAbsence(s.enrollmentDateId)} disabled={busy || !seatReason[s.enrollmentDateId]}
                      className="academy-button-primary w-full">결석 신고하기</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {seats.length === 0 && <div className="rounded-xl bg-gray-50 p-4 text-sm font-bold text-gray-500 dark:bg-gray-900">예정된 방학특강 회차가 없습니다.</div>}

      {(ctx.makeups || []).length > 0 && <>
        <div className="mb-2 mt-6 text-sm font-black">보강 신청 현황</div>
        <ul className={LIST_CLASS}>
          {ctx.makeups.map((m: any) => (
            // 한 줄 행: 자녀 · 특강 이름 / 결석 → 보강 대상 | 상태(오른쪽)
            <li key={m.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-sm font-black">{m.childName}</span>
                  <span className="break-keep text-xs font-bold text-gray-500">{m.offeringTitle}</span>
                </p>
                <p className="break-keep text-xs font-bold tabular-nums text-gray-500">{m.absentLabel} 결석 → {m.targetLabel || (m.targetType === "REGULAR" ? "정규수업" : "-")}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-black ${m.status === "REQUESTED" ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" : m.status === "ATTENDED" ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"}`}>{STATUS_LABEL[m.status] || "상태 확인 중"}</span>
            </li>
          ))}
        </ul>
      </>}
    </div>
  );
}
