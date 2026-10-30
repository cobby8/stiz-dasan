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
      <span className="shrink-0 text-[12px] font-bold text-gray-400">{label}</span>
      <span className="text-right text-[13px] font-semibold text-gray-800 dark:text-gray-100">{value ?? "-"}</span>
    </div>
  );
}

function ContactRow({ label, phone }: { label: string; phone: string | null }) {
  const d = digits(phone);
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
      <div><div className="text-[11px] font-bold text-gray-400">{label}</div><div className="text-[13px] font-bold text-gray-800 dark:text-gray-100">{phone || "미등록"}</div></div>
      {d && (
        <div className="flex gap-1.5">
          <a href={`tel:${d}`} className="rounded-lg bg-green-600 px-3 py-1.5 text-[12px] font-black text-white">전화</a>
          <a href={`sms:${d}`} className="rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-black text-white">문자</a>
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
      <div className="flex max-h-[94dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl dark:bg-gray-800 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5 dark:border-gray-700">
          <div>
            <p className="text-[11px] font-bold text-brand-orange-500 dark:text-brand-neon-lime">수강생 상세</p>
            <h2 className="text-lg font-black text-gray-900 dark:text-white">{c?.name ?? "학생"} {c?.grade ? <span className="text-sm font-bold text-gray-400">· {c.grade}{c.gender ? ` · ${c.gender}` : ""}</span> : null}</h2>
          </div>
          <button onClick={onClose} aria-label="닫기" className="grid size-9 place-items-center rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">✕</button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {loading && <div className="py-10 text-center text-sm text-gray-400">불러오는 중…</div>}
          {err && <div className="rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-600">⚠ {err}</div>}

          {detail && (
            <>
              <section className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="mb-1 text-[13px] font-black text-gray-900 dark:text-white">학생 정보</h3>
                <div className="divide-y divide-gray-100 dark:divide-gray-700/60">
                  <Field label="이름" value={c?.name} />
                  <Field label="학년 · 성별" value={[c?.grade, c?.gender].filter(Boolean).join(" · ") || "-"} />
                  <Field label="생년월일" value={c?.birthDate} />
                  <Field label="학교" value={c?.school} />
                </div>
              </section>

              <section className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="mb-2 text-[13px] font-black text-gray-900 dark:text-white">연락처</h3>
                <div className="space-y-2">
                  <ContactRow label={`보호자${detail.parent.name ? ` · ${detail.parent.name}${detail.parent.relation ? `(${detail.parent.relation})` : ""}` : ""}`} phone={detail.parent.phone} />
                  <ContactRow label="학생" phone={c?.phone ?? null} />
                </div>
              </section>

              <section className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
                <h3 className="mb-2 text-[13px] font-black text-gray-900 dark:text-white">수강 수업</h3>
                {detail.classes.length === 0 ? <p className="text-[12px] text-gray-400">수강 수업 없음</p> : (
                  <ul className="space-y-1.5">
                    {detail.classes.map((cl, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-900/50">
                        <span className="text-[13px] font-bold text-gray-800 dark:text-gray-100">{cl.title}</span>
                        <span className="text-[12px] font-semibold text-gray-500">{[detail.application.weekdayLabel, cl.classStart && cl.classEnd ? `${cl.classStart}~${cl.classEnd}` : cl.classStart].filter(Boolean).join(" · ")}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {detail.application.applicantType && <p className="mt-2 text-[11px] text-gray-400">신청자 구분: {detail.application.applicantType === "EXISTING" ? "기존 회원" : detail.application.applicantType === "NEW" ? "신규 회원" : detail.application.applicantType}</p>}
              </section>

              <section className="rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-[13px] font-black text-gray-900 dark:text-white">셔틀 · 승하차 위치</h3>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {canEdit && sh && sh.ride && !shIsHub && (
                      <button onClick={placeAtHub} disabled={savingPin} className="rounded-lg border border-green-300 px-2.5 py-1.5 text-[11px] font-bold text-green-700 disabled:opacity-50 dark:border-green-500/40 dark:text-green-300">🆓 무료 거점 배치</button>
                    )}
                    {shIsHub && <span className="rounded-lg bg-green-100 px-2 py-1 text-[11px] font-black text-green-700 dark:bg-green-900/40 dark:text-green-300">🆓 거점 배치됨</span>}
                    {canEdit && sh && (
                      sh.ride
                        ? <button onClick={() => saveRide(false)} disabled={savingPin} className="rounded-lg border border-red-300 px-2.5 py-1.5 text-[11px] font-bold text-red-600 disabled:opacity-50 dark:border-red-500/40 dark:text-red-300">🚫 셔틀 미이용(배정 취소)</button>
                        : <button onClick={() => saveRide(true)} disabled={savingPin} className="rounded-lg border border-green-300 px-2.5 py-1.5 text-[11px] font-bold text-green-700 disabled:opacity-50 dark:border-green-500/40 dark:text-green-300">🚌 셔틀 이용으로 변경</button>
                    )}
                  </div>
                </div>
                {!sh || !sh.ride ? <p className="text-[12px] text-gray-400">셔틀 미이용{canEdit && sh ? " · 위 버튼으로 이용으로 바꿀 수 있습니다" : ""}</p> : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-900/50">
                      <div className="min-w-0">
                        <div className="text-[11px] font-bold text-gray-400">등원(승차)</div>
                        <div className="text-[13px] font-bold text-gray-800 dark:text-gray-100">{sh.pickupLocation || "미지정"} {sh.pickupPinned ? <span className="ml-1 rounded bg-green-100 px-1 text-[10px] font-black text-green-700">핀</span> : sh.pickupApprox ? <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-black text-amber-700">추정</span> : null}</div>
                      </div>
                      {canEdit && <button onClick={() => setPinEdit("pickup")} className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] font-bold text-brand-orange-600 dark:border-gray-600 dark:text-brand-neon-lime">지도에서 변경</button>}
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-900/50">
                      <div className="min-w-0">
                        <div className="text-[11px] font-bold text-gray-400">하원(하차)</div>
                        <div className="text-[13px] font-bold text-gray-800 dark:text-gray-100">{sh.dropoffSameAsPickup ? "등원과 동일" : <>{sh.dropoffLocation || "미지정"} {sh.dropoffPinned ? <span className="ml-1 rounded bg-green-100 px-1 text-[10px] font-black text-green-700">핀</span> : sh.dropoffApprox ? <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-black text-amber-700">추정</span> : null}</>}</div>
                      </div>
                      {canEdit && !sh.dropoffSameAsPickup && <button onClick={() => setPinEdit("dropoff")} className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] font-bold text-brand-orange-600 dark:border-gray-600 dark:text-brand-neon-lime">지도에서 변경</button>}
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
