"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PhoneChangeButton from "@/components/account/PhoneChangeButton";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
// 남은 자리는 숫자 대신 3단계(여유/임박/마감)로(재원생 수 비공개 · 2026-11-13 f9)
import { SEAT_LEVEL_LABEL, SEAT_LEVEL_TEXT_CLASS } from "@/lib/seats/seatLevel";
import { REQUEST_TONE, TONE_BADGE_CLASS, toneFor } from "@/lib/ui/statusTones";

const STATUS_LABEL: Record<string, string> = { REQUESTED: "승인 대기", SCHEDULED: "보강 확정", ATTENDED: "보강 완료", NO_SHOW: "미출석" };

// 결석 사유 선택지 + 각 사유의 안내문(학부모에게 처리방향 미리 안내)
const ABSENCE_REASONS: { value: string; label: string; hint: string }[] = [
  { value: "ILLNESS_INJURY", label: "질병·부상", hint: "질병·부상은 이월 또는 환불 검토 대상이에요." },
  { value: "PERSONAL", label: "개인 사정", hint: "보강 대상이에요." },
  { value: "FAMILY_TRIP", label: "가족 여행", hint: "보강 대상이에요." },
  { value: "SCHOOL_EVENT", label: "학교 행사", hint: "보강 대상이에요." },
  { value: "ETC", label: "기타", hint: "보강 대상이에요." },
];

// 세 목록(보강 필요한 결석·예정 회차·보강 신청 현황)이 같은 «한 목록 + 행 구분선» 틀을 쓴다
const LIST_CLASS = "divide-y divide-[var(--color-academy-line)] overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-white";

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

  // ── 예정 회차 · 결석 알리기 ──────────────────────────────────────────
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
      const j = await r.json(); if (!r.ok) throw new Error(j?.error || "결석을 알리지 못했어요");
      setMsg("결석을 알렸어요"); setSeatOpen(""); await reloadSeats();
    } catch (e) { setErr(customerMessage(e, "결석을 알리지 못했어요. 잠시 후 다시 시도해 주세요.")); } finally { setBusy(false); }
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
      setMsg("결석 알림을 취소했어요"); await reloadSeats();
    } catch (e) { setErr(customerMessage(e, "결석 알림을 취소하지 못했어요. 잠시 후 다시 시도해 주세요.")); } finally { setBusy(false); }
  }

  if (!ctx.phoneKnown) {
    // 막다른 안내 대신 그 자리에서 해결(2026-11-14 원장 c1): 본인인증으로 연락처 등록 → 신청 내역이 번호로 이어진다. 안 되면 홈 문의 폼
    return (
      <div className="mx-auto max-w-lg p-4">
        <h1 className="academy-heading mb-2">방학특강 보강</h1>
        <div className="rounded-xl bg-[var(--color-academy-soft)] p-4 text-sm text-[var(--color-academy-muted)]">
          <p>계정에 연락처가 없어 신청 내역을 찾지 못했어요.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <PhoneChangeButton label="연락처 바꾸기" className="academy-button-primary" messageClassName="text-xs" />
            <Link href="/mypage#parent-request-form" className="academy-button-secondary">학원에 문의</Link>
          </div>
        </div>
      </div>
    );
  }

  const hasAbsences = (ctx.absences || []).length > 0;

  return (
    <div className="mx-auto max-w-lg p-4">
      {/* 제목 아래 설명 문단은 없앴다(2026-11-14 문구 정리) — 아래 칸 제목과 버튼(«결석 알리기»·«보강 신청»)이 같은 말을 한다 */}
      <h1 className="academy-heading mb-4">방학특강 결석 알리기 · 보강</h1>

      {msg && <div className="mb-3 rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm text-[var(--color-academy-success)]">{msg}</div>}
      {err && <div className="mb-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">{err}</div>}

      {/* 셋(보강할 결석·예정 회차·보강 신청 현황)이 모두 비면 빈 화면이 되지 않게 한 줄만 */}
      {!hasAbsences && seats.length === 0 && (ctx.makeups || []).length === 0 && (
        <p className="text-sm text-[var(--color-academy-muted)]">예정된 회차나 보강할 결석이 없어요</p>
      )}

      {/* 보강이 필요한 결석 — 없으면 칸째(제목 포함) 그리지 않는다(원장 결정 d7) */}
      {hasAbsences && <div className="academy-section-title mb-2">보강이 필요한 결석</div>}
      {/* 카드 묶음 대신 한 목록의 행(divide-y) — 휴대폰 첫 화면에 더 많이 보이게 */}
      {hasAbsences && (
        <ul className={LIST_CLASS}>
          {(ctx.absences || []).map((ab: any) => (
            <li key={ab.enrollmentDateId} className="px-3 py-2">
              {/* 한 줄 행: 자녀 · 특강 이름(줄바꿈 허용) · 결석일(오른쪽) · 보강 신청 버튼 — «·»로 잇던 글을 요소로 나눔 */}
              <div className="flex min-h-11 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{ab.childName}</p>
                  <p className="break-keep text-xs text-[var(--color-academy-muted)]">{ab.offeringTitle}</p>
                </div>
                <span className="shrink-0 text-right text-xs tabular-nums text-[var(--color-academy-danger)]">{ab.absentLabel} 결석</span>
                {/* 행의 «여는» 버튼 = 옅은 바탕(tonal), 열린 뒤 «닫기» = 글자 버튼(M-08) */}
                <button onClick={() => setOpen(open === ab.enrollmentDateId ? "" : ab.enrollmentDateId)}
                  className={`${open === ab.enrollmentDateId ? "academy-button-text" : "academy-button-tonal"} shrink-0`}>{open === ab.enrollmentDateId ? "닫기" : "보강 신청"}</button>
              </div>
              {/* 보강 후보 고르기 — 기존 그대로(후보를 누르면 바로 신청, 학원 승인 후 확정) */}
              {open === ab.enrollmentDateId && (
                <div className="mb-1 mt-2 border-t border-[var(--color-academy-line)] pt-2">
                  <div className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">① 같은 특강 다른 날짜</div>
                  {ab.seasonalCandidates.length === 0 && <div className="mb-2 text-xs text-[var(--color-academy-faint)]">여유 있는 날짜가 없습니다.</div>}
                  <div className="mb-2 flex flex-wrap gap-2">
                    {ab.seasonalCandidates.map((s: any) => (
                      <button key={s.sessionDateId} disabled={busy} onClick={() => request(ab.enrollmentDateId, "SEASONAL", s)}
                        className="academy-button-secondary tabular-nums">{s.label} <span className={SEAT_LEVEL_TEXT_CLASS[s.seatLevel as keyof typeof SEAT_LEVEL_TEXT_CLASS] ?? SEAT_LEVEL_TEXT_CLASS.AVAILABLE}>{SEAT_LEVEL_LABEL[s.seatLevel as keyof typeof SEAT_LEVEL_LABEL] ?? "여유"}</span></button>
                    ))}
                  </div>
                  {ab.regularCandidates.length > 0 && <>
                    <div className="mb-1 mt-2 text-xs font-medium text-[var(--color-academy-muted)]">② 정규수업 보강 (추천)</div>
                    <div className="flex flex-wrap gap-2">
                      {ab.regularCandidates.map((c: any) => (
                        <button key={c.classId} disabled={busy} onClick={() => request(ab.enrollmentDateId, "REGULAR", c)}
                          className="academy-button-secondary">
                          {/* 날짜와 반 이름을 요소로 나눔(두 줄 — 버튼 안에서 왼쪽 정렬) */}
                          <span className="block text-left">
                            <span className="flex flex-wrap gap-x-1.5"><span className="tabular-nums">{c.nextLabel}</span><span className="break-keep">{c.name}</span></span>
                            <span className="block text-xs font-normal text-[var(--color-academy-faint)]">{c.schedule}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ── 예정 회차 · 결석 알리기 — 예정 회차가 없으면 칸째(제목 포함) 그리지 않는다 ── */}
      {seats.length > 0 && <div className={`academy-section-title mb-2 ${hasAbsences ? "mt-6" : ""}`}>예정 회차 · 결석 알리기</div>}
      {seats.length > 0 && (
        <ul className={LIST_CLASS}>
          {seats.map((s: any) => {
            const reasonInfo = ABSENCE_REASONS.find((x) => x.value === (seatReason[s.enrollmentDateId] || ""));
            return (
              <li key={s.enrollmentDateId} className="px-3 py-2">
                {/* 한 줄 행: 자녀 · 특강 이름 · (상태 배지·사유) | 회차 날짜(오른쪽) · 동작 */}
                <div className="flex min-h-11 flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{s.childName}</p>
                    <p className="break-keep text-xs text-[var(--color-academy-muted)]">{s.offeringTitle}</p>
                    {/* 신고됨(본인이 사전 신고) → 상태 배지와 사유를 나눠 표시 */}
                    {s.reported && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className={`rounded px-2 py-0.5 text-xs ${TONE_BADGE_CLASS.warning}`}>결석 알림</span>
                        {s.reasonLabel && <span className="text-xs text-[var(--color-academy-muted)]">{s.reasonLabel}</span>}
                        {s.locked && <span className="text-xs text-[var(--color-academy-faint)]">학원 확정 — 변경은 문의</span>}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-right text-xs tabular-nums text-[var(--color-academy-muted)]">{s.dateLabel}</span>
                  {/* 동작 — 기존과 같은 조건·같은 함수 */}
                  {s.reported ? (
                    !s.locked && (
                      // 신고 취소 = 그 자리 확인(C-M1) 후 기존 cancelAbsence(s.enrollmentDateId) 그대로
                      <InlineConfirm label="알림 취소" question="이 결석 알림을 취소할까요?" confirmLabel="취소하기"
                        onConfirm={() => cancelAbsence(s.enrollmentDateId)} pending={busy} openClassName="basis-full" />
                    )
                  ) : s.locked ? (
                    <span className="academy-status shrink-0">출결 확정됨</span>
                  ) : (
                    <button onClick={() => setSeatOpen(seatOpen === s.enrollmentDateId ? "" : s.enrollmentDateId)}
                      className={`${seatOpen === s.enrollmentDateId ? "academy-button-text" : "academy-button-tonal"} shrink-0`}>{seatOpen === s.enrollmentDateId ? "닫기" : "결석 알리기"}</button>
                  )}
                </div>
                {/* 신고 폼: 사유 드롭다운 + 안내문 + 제출 (기존 그대로) */}
                {seatOpen === s.enrollmentDateId && !s.reported && !s.locked && (
                  <div className="mb-1 mt-2 border-t border-[var(--color-academy-line)] pt-2">
                    <div className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">결석 사유</div>
                    <select
                      value={seatReason[s.enrollmentDateId] || ""}
                      onChange={(e) => setSeatReason((prev) => ({ ...prev, [s.enrollmentDateId]: e.target.value }))}
                      className="academy-input mb-2">
                      <option value="">사유를 선택하세요</option>
                      {ABSENCE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    {reasonInfo && <p className="mb-2 text-xs text-[var(--color-academy-faint)]">{reasonInfo.hint}</p>}
                    <button onClick={() => reportAbsence(s.enrollmentDateId)} disabled={busy || !seatReason[s.enrollmentDateId]}
                      className="academy-button-primary w-full">결석 알리기</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(ctx.makeups || []).length > 0 && <>
        <div className="academy-section-title mb-2 mt-6">보강 신청 현황</div>
        <ul className={LIST_CLASS}>
          {ctx.makeups.map((m: any) => (
            // 한 줄 행: 자녀 · 특강 이름 / 결석 → 보강 대상 | 상태(오른쪽)
            <li key={m.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-sm font-semibold">{m.childName}</span>
                  <span className="break-keep text-xs text-[var(--color-academy-muted)]">{m.offeringTitle}</span>
                </p>
                <p className="break-keep text-xs tabular-nums text-[var(--color-academy-muted)]">{m.absentLabel} 결석 → {m.targetLabel || (m.targetType === "REGULAR" ? "정규수업" : "-")}</p>
              </div>
              <span className={`shrink-0 rounded px-2 py-1 text-xs ${TONE_BADGE_CLASS[toneFor(REQUEST_TONE, m.status, "info")]}`}>{STATUS_LABEL[m.status] || "상태 확인 중"}</span>
            </li>
          ))}
        </ul>
      </>}
    </div>
  );
}
