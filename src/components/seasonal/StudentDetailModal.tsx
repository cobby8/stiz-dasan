"use client";

import { publicErrorText } from "@/components/ui/public-error-text";
import { useCallback, useEffect, useState } from "react";
import type { StudentDetail } from "@/lib/seasonal/student-detail";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";

// 방학특강 수강생 상세 — 여러 화면에서 공통으로 쓰는 모달.
// applicationId만 주면 서버에서 학생·보호자·수강 수업·셔틀 정보를 불러와 정리해 보여준다.

function digits(p: string | null): string | null { if (!p) return null; const d = p.replace(/[^0-9]/g, ""); return d.length >= 9 ? d : null; }

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5">
      <span className="shrink-0 text-xs text-[var(--color-academy-muted)]">{label}</span>
      <span className="text-right text-sm text-[var(--color-academy-ink)]">{value ?? "-"}</span>
    </div>
  );
}

function ContactRow({ label, phone }: { label: string; phone: string | null }) {
  const d = digits(phone);
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--color-academy-line)] px-3 py-2">
      <div className="min-w-0"><div className="text-xs text-[var(--color-academy-muted)]">{label}</div><div className="text-sm tabular-nums text-[var(--color-academy-ink)]">{phone || "미등록"}</div></div>
      {/* 전화·문자 = 보조 버튼(흰 바탕·테두리·검정 글자) — 전화 버튼 색을 화면마다 같게(2026-11-09) */}
      {d && (
        <div className="flex shrink-0 gap-1.5">
          <a href={`tel:${d}`} className="academy-button-secondary academy-button-sm">전화</a>
          <a href={`sms:${d}`} className="academy-button-secondary academy-button-sm">문자</a>
        </div>
      )}
    </div>
  );
}

// save: 승하차 위치 편집 저장 대상. rosterId(확정 후) 우선, 없으면 requestId(확정 전). 둘 다 없으면 편집 버튼을 숨긴다.
// onChanged: 위치가 바뀌면 호출(배차 화면이 노선을 다시 읽게 한다).
export default function StudentDetailModal({ applicationId, onClose, save, onChanged }: {
  applicationId: string; onClose: () => void;
  save?: { rosterId: string | null; requestId: string | null };
  onChanged?: () => void;
}) {
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pinEdit, setPinEdit] = useState<"pickup" | "dropoff" | null>(null);
  const [savingPin, setSavingPin] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true); setErr(null);
    fetch(`/api/admin/seasonal/student-detail?applicationId=${encodeURIComponent(applicationId)}`, { cache: "no-store" })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!alive) return; if (!ok) throw new Error(j?.error || "실패"); setDetail(j.detail); })
      .catch((e) => { if (alive) setErr(publicErrorText(e, "학생 정보를 불러오지 못했습니다.")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [applicationId]);
  useEffect(() => load(), [load]);

  const canEdit = Boolean(save && (save.rosterId || save.requestId));
  async function savePin(kind: "pickup" | "dropoff", loc: MapLocationData) {
    if (!save) return;
    setSavingPin(true); setErr(null);
    try {
      const target = save.rosterId ? { rosterId: save.rosterId } : { requestId: save.requestId };
      const patch = { [`${kind}Pin`]: { latitude: loc.latitude, longitude: loc.longitude, address: loc.address, roadAddress: loc.roadAddress, source: loc.source, placeId: loc.placeId, accuracyMeters: loc.accuracyMeters } };
      const r = await fetch("/api/admin/seasonal/shuttle-roster", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, patch }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "저장 실패");
      setPinEdit(null);
      load(); // 상세 다시 읽어 반영
      onChanged?.();
    } catch (e: any) { setErr(publicErrorText(e, "위치를 저장하지 못했습니다.")); }
    finally { setSavingPin(false); }
  }

  // 셔틀 이용/미이용 토글(배정 취소·복원). ride=false면 그 학생은 배차에서 빠진다.
  async function saveRide(ride: boolean) {
    if (!save || savingPin) return;
    if (!ride && typeof window !== "undefined" && !window.confirm("이 학생을 셔틀 미이용으로 바꿀까요? 배차 명단에서 빠집니다.")) return;
    setSavingPin(true); setErr(null);
    try {
      const target = save.rosterId ? { rosterId: save.rosterId } : { requestId: save.requestId };
      const r = await fetch("/api/admin/seasonal/shuttle-roster", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, patch: { ride } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "저장 실패");
      load(); onChanged?.();
    } catch (e: any) { setErr(publicErrorText(e, "셔틀 이용 여부를 저장하지 못했습니다.")); }
    finally { setSavingPin(false); }
  }

  // 무료 거점으로 직접 배치(관리자). 서버가 거점 좌표·라벨·셔틀비(청구 전 0원)를 한 번에 처리한다.
  async function placeAtHub() {
    if (!save || savingPin) return;
    if (typeof window !== "undefined" && !window.confirm("이 학생을 무료 탑승 거점(1호점)으로 배치할까요?\n탑승·하차가 거점으로 바뀌고, 청구 전이면 셔틀비가 0원이 됩니다.")) return;
    setSavingPin(true); setErr(null);
    try {
      const target = save.rosterId ? { rosterId: save.rosterId } : { requestId: save.requestId };
      const r = await fetch("/api/admin/seasonal/shuttle-roster", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...target, action: "placeAtHub" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "배치 실패");
      load(); onChanged?.();
    } catch (e: any) { setErr(publicErrorText(e, "거점으로 배치하지 못했습니다.")); }
    finally { setSavingPin(false); }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const c = detail?.child;
  const sh = detail?.shuttle;
  const shIsHub = (sh?.pickupLocation ?? "").replace(/\s/g, "").includes("무료탑승");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[94dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-5 py-3.5">
          <div>
            <p className="text-xs text-[var(--color-academy-muted)]">수강생 상세</p>
            <h2 className="text-lg font-bold text-[var(--color-academy-ink)]">{c?.name ?? "학생"} {c?.grade ? <span className="text-sm font-normal text-[var(--color-academy-muted)]">· {c.grade}{c.gender ? ` · ${c.gender}` : ""}</span> : null}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기" className="grid size-11 shrink-0 place-items-center rounded-md text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">✕</button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {loading && <div className="py-10 text-center text-sm text-[var(--color-academy-faint)]">불러오는 중…</div>}
          {err && <div className="rounded-xl bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">{err}</div>}

          {detail && (
            <>
              <section className="rounded-2xl border border-[var(--color-academy-line)] p-4">
                <h3 className="mb-1 text-sm font-semibold text-[var(--color-academy-ink)]">학생 정보</h3>
                <div className="divide-y divide-[var(--color-academy-line)]">
                  <Field label="이름" value={c?.name} />
                  <Field label="학년 · 성별" value={[c?.grade, c?.gender].filter(Boolean).join(" · ") || "-"} />
                  <Field label="생년월일" value={c?.birthDate} />
                  <Field label="학교" value={c?.school} />
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--color-academy-line)] p-4">
                <h3 className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">연락처</h3>
                <div className="space-y-2">
                  <ContactRow label={`보호자${detail.parent.name ? ` · ${detail.parent.name}${detail.parent.relation ? `(${detail.parent.relation})` : ""}` : ""}`} phone={detail.parent.phone} />
                  <ContactRow label="학생" phone={c?.phone ?? null} />
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--color-academy-line)] p-4">
                <h3 className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수강 수업</h3>
                {detail.classes.length === 0 ? <p className="text-xs text-[var(--color-academy-faint)]">수강 수업 없음</p> : (
                  <ul className="space-y-1.5">
                    {detail.classes.map((cl, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 rounded-xl bg-[var(--color-academy-soft)] px-3 py-2">
                        <span className="text-sm font-medium text-[var(--color-academy-ink)]">{cl.title}</span>
                        <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">{[detail.application.weekdayLabel, cl.classStart && cl.classEnd ? `${cl.classStart}~${cl.classEnd}` : cl.classStart].filter(Boolean).join(" · ")}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {detail.application.applicantType && <p className="mt-2 text-xs text-[var(--color-academy-faint)]">신청자 구분: {detail.application.applicantType === "EXISTING" ? "기존 회원" : detail.application.applicantType === "NEW" ? "신규 회원" : detail.application.applicantType}</p>}
              </section>

              <section className="rounded-2xl border border-[var(--color-academy-line)] p-4">
                {/* 버튼이 글자로 넓어져 좁은 화면에서는 다음 줄로 넘어가게 한다 */}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[var(--color-academy-ink)]">셔틀 · 승하차 위치</h3>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {canEdit && sh && sh.ride && !shIsHub && (
                      <button type="button" onClick={placeAtHub} disabled={savingPin} className="academy-button-secondary academy-button-sm">무료 거점 배치</button>
                    )}
                    {shIsHub && <span className="rounded bg-[var(--color-academy-success-soft)] px-2 py-1 text-xs text-[var(--color-academy-success)]">거점 배치됨</span>}
                    {canEdit && sh && (
                      sh.ride
                        ? <button type="button" onClick={() => saveRide(false)} disabled={savingPin} className="academy-button-danger academy-button-sm">셔틀 미이용(배정 취소)</button>
                        : <button type="button" onClick={() => saveRide(true)} disabled={savingPin} className="academy-button-secondary academy-button-sm">셔틀 이용으로 변경</button>
                    )}
                  </div>
                </div>
                {!sh || !sh.ride ? <p className="text-xs text-[var(--color-academy-faint)]">셔틀 미이용{canEdit && sh ? " · 위 버튼으로 이용으로 바꿀 수 있습니다" : ""}</p> : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2 rounded-xl bg-[var(--color-academy-soft)] px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-xs text-[var(--color-academy-muted)]">등원(승차)</div>
                        <div className="text-sm font-medium text-[var(--color-academy-ink)]">{sh.pickupLocation || "미지정"} {sh.pickupPinned ? <span className="ml-1 rounded bg-[var(--color-academy-success-soft)] px-1 text-xs font-normal text-[var(--color-academy-success)]">핀</span> : sh.pickupApprox ? <span className="ml-1 rounded bg-[var(--color-academy-warning-soft)] px-1 text-xs font-normal text-[var(--color-academy-warning)]">추정</span> : null}</div>
                      </div>
                      {canEdit && <button type="button" onClick={() => setPinEdit("pickup")} className="academy-button-tonal academy-button-sm shrink-0">지도에서 변경</button>}
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-xl bg-[var(--color-academy-soft)] px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-xs text-[var(--color-academy-muted)]">하원(하차)</div>
                        <div className="text-sm font-medium text-[var(--color-academy-ink)]">{sh.dropoffSameAsPickup ? "등원과 동일" : <>{sh.dropoffLocation || "미지정"} {sh.dropoffPinned ? <span className="ml-1 rounded bg-[var(--color-academy-success-soft)] px-1 text-xs font-normal text-[var(--color-academy-success)]">핀</span> : sh.dropoffApprox ? <span className="ml-1 rounded bg-[var(--color-academy-warning-soft)] px-1 text-xs font-normal text-[var(--color-academy-warning)]">추정</span> : null}</>}</div>
                      </div>
                      {canEdit && !sh.dropoffSameAsPickup && <button type="button" onClick={() => setPinEdit("dropoff")} className="academy-button-tonal academy-button-sm shrink-0">지도에서 변경</button>}
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {pinEdit && sh && (
        <LocationPickerModal
          title={`${pinEdit === "pickup" ? "등원(승차)" : "하원(하차)"} 위치 변경`}
          initialValue={(() => {
            const lat = pinEdit === "pickup" ? sh.pickupLat : sh.dropoffLat;
            const lng = pinEdit === "pickup" ? sh.pickupLng : sh.dropoffLng;
            const addr = pinEdit === "pickup" ? sh.pickupLocation : sh.dropoffLocation;
            return lat != null && lng != null ? { address: addr ?? "", latitude: lat, longitude: lng, source: "MAP_PIN" as const } : undefined;
          })()}
          confirmPending={savingPin}
          onConfirm={(loc) => savePin(pinEdit, loc)}
          onClose={() => setPinEdit(null)}
        />
      )}
    </div>
  );
}
