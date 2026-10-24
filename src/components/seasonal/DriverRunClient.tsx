"use client";

import { useEffect, useRef, useState } from "react";
import { tmapNavigationCoordinateUrl } from "@/lib/maps/coordinate-links";
import DriverDateNav from "@/components/shuttle/DriverDateNav";
import GpsShareBar from "@/components/shuttle/GpsShareBar";
import { useGpsShare } from "@/hooks/useGpsShare";
import DriverRequestModal from "@/components/shuttle/DriverRequestModal";

// PWA 설치 이벤트 타입 (브라우저 전용, 표준 미포함)
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void> }

// 기사님 운행 화면(모바일) — 그 날 등원 → 하원 타임라인. 각 구간에서 정차 순서대로 학생을 보고 탑승/미탑승을 탭으로 체크한다.
// 로그인 없이 토큰으로 접근하며, 체크는 즉시 서버에 저장한다(구간=방향별).
// ★ 기사님 연세를 고려해 항상 '라이트 모드' + 큰 글자·큰 버튼으로 고정한다(dark: 스타일 미사용).

export type DriverStudent = { requestId: string; name: string; grade: string | null; parentPhone: string | null; childPhone: string | null; isAbsent?: boolean };
export type DriverStop = { label: string; isHub: boolean; etaLabel: string | null; lat: number | null; lng: number | null; students: DriverStudent[] };
export type DriverVehicle = { vehicleName: string; tripLabel: string | null; departTime: string | null; arriveTime: string | null; depotTime: string | null; stops: DriverStop[] };
export type DriverSection = { direction: "PICKUP" | "DROPOFF"; time: string | null; startName: string; endName: string; vehicles: DriverVehicle[] };
// SELF = 자차(부모 차) 등·하원. 셔틀엔 안 탔지만 결석(안 옴)과는 구분한다.
type Status = "BOARDED" | "NOSHOW" | "SELF";
type BoardingByDir = { PICKUP: Record<string, Status>; DROPOFF: Record<string, Status> };

function digits(p: string | null): string | null { if (!p) return null; const d = p.replace(/[^0-9]/g, ""); return d.length >= 9 ? d : null; }
function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${iso}T00:00:00+09:00`).getDay()] ?? "";
  return `${Number(m[2])}/${Number(m[3])}${dow ? ` (${dow})` : ""}`;
}

export default function DriverRunClient({
  token, date, sections, initialBoarding, prevDate, nextDate, today,
}: {
  token: string;
  date: string;
  sections: DriverSection[];
  initialBoarding: BoardingByDir;
  prevDate: string | null; // 운행 가능일 기준 이전 날짜(없으면 비활성)
  nextDate: string | null; // 운행 가능일 기준 다음 날짜
  today: string;
}) {
  const [boarding, setBoarding] = useState<BoardingByDir>(initialBoarding);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [runState, setRunState] = useState<"idle" | "running" | "ended">("idle");

  // 정류장 순서 변경 — 차량 키 `"${direction}:${vi}"` 단위로 편집 모드 관리
  const [editVehicleKey, setEditVehicleKey] = useState<string | null>(null);
  const [reorderedStops, setReorderedStops] = useState<Record<string, DriverStop[]>>({});

  // PWA 설치 배너
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  async function installPwa() {
    if (!deferredPromptRef.current) return;
    await deferredPromptRef.current.prompt();
    setShowInstallBanner(false);
  }

  // 관리자 요청 모달
  const [reqModal, setReqModal] = useState<{
    targetId?: string; targetName?: string;
    defaultType?: "REMOVE" | "LOCATION" | "ORDER" | "OTHER";
    orderPayload?: unknown;
  } | null>(null);

  function getStops(vKey: string, sec: (typeof sections)[0], vi: number): DriverStop[] {
    return reorderedStops[vKey] ?? sec.vehicles[vi]?.stops ?? [];
  }

  function moveStop(vKey: string, sec: (typeof sections)[0], vi: number, si: number, dir: -1 | 1) {
    const stops = [...getStops(vKey, sec, vi)];
    const next = si + dir;
    if (next < 0 || next >= stops.length) return;
    [stops[si], stops[next]] = [stops[next]!, stops[si]!];
    setReorderedStops((r) => ({ ...r, [vKey]: stops }));
  }

  const label = sections[0]?.vehicles[0]?.vehicleName ?? "방학특강 기사님";
  const { state: gpsState, lastSentAt, accuracy, start: gpsStart, stop: gpsStop } = useGpsShare(token, label);

  async function handleRunStart() {
    setRunState("running");
    gpsStart();
  }
  async function handleRunEnd() {
    await gpsStop();
    setRunState("ended");
  }

  async function toggle(direction: "PICKUP" | "DROPOFF", reqId: string, name: string, next: Status) {
    const key = `${direction}:${reqId}`;
    if (busy[key]) return;
    const cur = boarding[direction][reqId] ?? null;
    const target: Status | null = cur === next ? null : next;
    setBoarding((b) => {
      const dirMap = { ...b[direction] };
      if (target) dirMap[reqId] = target; else delete dirMap[reqId];
      return { ...b, [direction]: dirMap };
    });
    setBusy((x) => ({ ...x, [key]: true }));
    try {
      const r = await fetch("/api/shuttle/boarding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 화면이 표시 중인 날짜(date)를 함께 보내, 그 날짜에 저장·조회되도록 한다(링크 날짜와 어긋남 방지).
        body: JSON.stringify({ token, direction, shuttleRequestId: reqId, status: target, studentName: name, date }),
      });
      if (!r.ok) throw new Error();
    } catch {
      setBoarding((b) => {
        const dirMap = { ...b[direction] };
        if (cur) dirMap[reqId] = cur; else delete dirMap[reqId];
        return { ...b, [direction]: dirMap };
      });
    } finally {
      setBusy((x) => ({ ...x, [key]: false }));
    }
  }

  return (
    <div className="mx-auto max-w-lg px-3 pb-28 text-gray-900" style={{ colorScheme: "light" }}>
      <header className="sticky top-0 z-10 -mx-3 mb-3 border-b border-gray-200 bg-white px-4 py-4">
        <p className="text-[20px] font-black text-gray-900">🚌 스티즈 셔틀 운행</p>
        <p className="mt-0.5 text-[15px] font-bold text-gray-600">{fmtDate(date)} · 등원 → 하원</p>
      </header>

      {/* PWA 설치 배너 */}
      {showInstallBanner && (
        <div className="mb-3 flex items-center gap-3 rounded-2xl border-2 border-indigo-300 bg-indigo-50 px-4 py-3">
          <span className="text-[28px]">📲</span>
          <div className="flex-1">
            <p className="text-[15px] font-black text-indigo-900">홈 화면에 추가하세요</p>
            <p className="text-[12px] font-semibold text-indigo-700">앱처럼 빠르게 열 수 있어요</p>
          </div>
          <button type="button" onClick={installPwa}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-[14px] font-black text-white active:bg-indigo-700">설치</button>
          <button type="button" onClick={() => setShowInstallBanner(false)} className="text-[20px] text-indigo-300">✕</button>
        </div>
      )}

      {/* 운행 시작 전 */}
      {runState === "idle" && (
        <div className="mb-4 rounded-2xl border-2 border-yellow-400 bg-yellow-50 p-5 text-center">
          <p className="mb-3 text-[15px] font-bold text-gray-700">운행을 시작하면 위치가 관리자에게 공유됩니다</p>
          <button type="button" onClick={handleRunStart}
            className="h-16 w-full rounded-2xl bg-green-600 text-[20px] font-black text-white active:bg-green-700">
            🚦 운행 시작
          </button>
        </div>
      )}

      {/* 운행 중 */}
      {runState === "running" && (
        <div className="mb-3">
          <GpsShareBar gpsState={gpsState} lastSentAt={lastSentAt} accuracy={accuracy} />
          <button type="button" onClick={handleRunEnd}
            className="mt-2 h-13 w-full rounded-2xl border-2 border-red-300 bg-white py-3 text-[17px] font-black text-red-600 active:bg-red-50">
            🏁 운행 종료
          </button>
        </div>
      )}

      {/* 운행 종료 후 */}
      {runState === "ended" && (
        <div className="mb-4 rounded-2xl bg-gray-100 px-4 py-5 text-center">
          <p className="text-[17px] font-black text-gray-600">✅ 운행이 종료되었습니다</p>
        </div>
      )}

      {/* 날짜 이동 네비 — 운행 가능일 기준 이전/다음 */}
      <DriverDateNav date={date} prevDate={prevDate} nextDate={nextDate} today={today} />

      {/* 선택한 날짜에 배차가 아예 없으면 안내(운행 가능일끼리 넘기도록) */}
      {sections.every((s) => s.vehicles.length === 0) && (
        <p className="mb-3 rounded-2xl bg-gray-50 px-4 py-6 text-center text-[16px] font-bold text-gray-400">이 날짜는 운행이 없습니다.<br />‹ 이전 · 다음 › 으로 운행일을 넘겨보세요.</p>
      )}

      {sections.map((sec) => {
        const isPickup = sec.direction === "PICKUP";
        const map = boarding[sec.direction];
        const all = sec.vehicles.flatMap((v) => v.stops.flatMap((s) => s.students));
        const boarded = all.filter((s) => map[s.requestId] === "BOARDED").length;
        const noshow = all.filter((s) => map[s.requestId] === "NOSHOW").length;
        const self = all.filter((s) => map[s.requestId] === "SELF").length; // 자차 등·하원 수
        let seq = 0;
        return (
          <section key={sec.direction} className="mb-6">
            {/* 구간 헤더: 시간 · 방향 */}
            <div className={`sticky top-[68px] z-[5] -mx-1 mb-3 flex items-center justify-between gap-2 rounded-2xl px-4 py-3 ${isPickup ? "bg-blue-600" : "bg-orange-600"} text-white`}>
              <span className="text-[19px] font-black">{isPickup ? "⬆" : "⬇"} {sec.time ?? "-"} · {isPickup ? "등원" : "하원"}</span>
              <span className="text-[16px] font-black">{boarded}/{all.length} 탑승{noshow > 0 ? ` · 결석 ${noshow}` : ""}{self > 0 ? ` · 자차 ${self}` : ""}</span>
            </div>

            {sec.vehicles.length === 0 && <p className="rounded-2xl bg-gray-50 px-4 py-5 text-center text-[16px] font-bold text-gray-400">이 구간에 배차된 학생이 없습니다.</p>}

            {sec.vehicles.map((v, vi) => {
              const vKey = `${sec.direction}:${vi}`;
              const isEditing = editVehicleKey === vKey;
              const stops = getStops(vKey, sec, vi);
              return (
              <div key={vi} className="mb-3">
                <div className="mb-1.5 flex items-center gap-2">
                  {sec.vehicles.length > 1 && <p className="flex-1 text-[15px] font-black text-gray-600">🚐 {v.vehicleName}{v.tripLabel ? ` · ${v.tripLabel}` : ""}</p>}
                  {!isEditing && (
                    <button type="button" onClick={() => setEditVehicleKey(vKey)}
                      className="ml-auto rounded-xl border-2 border-gray-300 px-3 py-1.5 text-[13px] font-black text-gray-600 active:bg-gray-100">
                      ↕ 순서 편집
                    </button>
                  )}
                  {isEditing && (
                    <div className="ml-auto flex gap-2">
                      <button type="button" onClick={() => {
                        setReqModal({ defaultType: "ORDER", orderPayload: stops, targetId: vKey, targetName: `${v.vehicleName} 정류장 순서` });
                        setEditVehicleKey(null);
                      }}
                        className="rounded-xl bg-blue-600 px-3 py-1.5 text-[13px] font-black text-white active:bg-blue-700">
                        📨 순서 고정 요청
                      </button>
                      <button type="button" onClick={() => { setEditVehicleKey(null); setReorderedStops((r) => { const n = { ...r }; delete n[vKey]; return n; }); }}
                        className="rounded-xl border-2 border-gray-300 px-3 py-1.5 text-[13px] font-black text-gray-600">
                        취소
                      </button>
                    </div>
                  )}
                </div>
                <div className="mb-2 flex items-center gap-2 rounded-xl bg-gray-100 px-4 py-2.5 text-[15px] font-bold text-gray-700">
                  <span className="text-[18px]">{isPickup ? "🚏" : "🏫"}</span>{sec.startName} 출발{v.departTime ? ` · ${v.departTime}` : ""}
                </div>
                {isEditing && (
                  <p className="mb-2 rounded-xl bg-blue-50 px-3 py-2 text-[13px] font-bold text-blue-700">↕ 버튼으로 순서를 바꾼 뒤 &quot;순서 고정 요청&quot;을 눌러주세요</p>
                )}
                <ol className="space-y-2.5">
                  {stops.map((s, si) => {
                    if (!s.isHub) seq += 1;
                    return (
                      <li key={si} className={`rounded-2xl border-2 p-3.5 ${s.isHub ? "border-green-300 bg-green-50" : isEditing ? "border-blue-200 bg-blue-50" : "border-gray-200 bg-white"}`}>
                        <div className="flex items-center gap-2.5">
                          {isEditing ? (
                            <div className="flex shrink-0 flex-col gap-0.5">
                              <button type="button" disabled={si === 0} onClick={() => moveStop(vKey, sec, vi, si, -1)}
                                className="h-7 w-7 rounded-lg border border-gray-300 text-[16px] font-black text-gray-600 disabled:opacity-30">▲</button>
                              <button type="button" disabled={si === stops.length - 1} onClick={() => moveStop(vKey, sec, vi, si, 1)}
                                className="h-7 w-7 rounded-lg border border-gray-300 text-[16px] font-black text-gray-600 disabled:opacity-30">▼</button>
                            </div>
                          ) : (
                            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px] font-black text-white ${s.isHub ? "bg-green-600" : "bg-brand-orange-500"}`}>{s.isHub ? "🆓" : seq}</span>
                          )}
                          <span className="min-w-0 flex-1 text-[18px] font-black leading-tight text-gray-900">{s.label}</span>
                          {s.etaLabel && !isEditing && <span className="shrink-0 text-[16px] font-black text-blue-600">{s.etaLabel}</span>}
                          {!isEditing && !s.isHub && (
                            <button type="button" onClick={() => setReqModal({ targetName: s.label, defaultType: "LOCATION" })}
                              className="shrink-0 rounded-lg border border-gray-300 px-2 py-1 text-[12px] font-black text-gray-500 active:bg-gray-100">
                              요청
                            </button>
                          )}
                        </div>
                        {(() => {
                          const url = tmapNavigationCoordinateUrl({ latitude: s.lat, longitude: s.lng, name: s.label });
                          return url ? <a href={url} className="mt-2 flex h-12 items-center justify-center gap-1.5 rounded-xl bg-blue-600 text-[16px] font-black text-white active:bg-blue-700">🧭 T맵 길안내</a> : null;
                        })()}
                        {s.isHub && s.students.length === 0 && <p className="mt-1.5 text-[15px] font-bold text-green-700">무료 거점(워크인, 정원 별도)</p>}
                        {s.students.length > 0 && (
                          <div className="mt-2.5 overflow-hidden rounded-xl bg-gray-50 divide-y divide-gray-200">
                            {s.students.map((st) => {
                              const status = map[st.requestId] ?? null;
                              const parent = digits(st.parentPhone), child = digits(st.childPhone);
                              const rowKey = `${sec.direction}:${st.requestId}`;
                              const isBusy = busy[rowKey];
                              const selfLabel = isPickup ? "자차등원" : "자차하원";
                              return (
                                <div key={st.requestId} className="p-2.5">
                                  <div className="flex items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-baseline gap-1.5">
                                        <span className="text-[19px] font-black text-gray-900">{st.name}</span>
                                        {st.grade && <span className="text-[14px] text-gray-500">{st.grade}</span>}
                                        {st.isAbsent && status !== "BOARDED" && status !== "SELF" && <span className="rounded-md bg-amber-400 px-2 py-0.5 text-[13px] font-black text-white">결석예정</span>}
                                        {status === "NOSHOW" && <span className="rounded-md bg-red-500 px-2 py-0.5 text-[13px] font-black text-white">결석</span>}
                                        {status === "SELF" && <span className="rounded-md bg-violet-600 px-2 py-0.5 text-[13px] font-black text-white">{selfLabel}</span>}
                                      </div>
                                      <div className="mt-1 flex gap-3">
                                        {parent && <a href={`tel:${parent}`} className="text-[15px] font-black text-blue-600">📞 학부모</a>}
                                        {child && <a href={`tel:${child}`} className="text-[15px] font-black text-green-600">📞 학생</a>}
                                      </div>
                                    </div>
                                    <button type="button" onClick={() => setReqModal({ targetId: st.requestId, targetName: st.name, defaultType: "REMOVE" })}
                                      className="h-14 min-w-[48px] rounded-xl border-2 border-gray-200 text-[13px] font-black text-gray-500 active:bg-gray-100">
                                      요청
                                    </button>
                                    <button type="button" disabled={isBusy} onClick={() => { setMenuKey(null); toggle(sec.direction, st.requestId, st.name, "BOARDED"); }}
                                      className={`h-14 min-w-[68px] rounded-xl text-[16px] font-black ${status === "BOARDED" ? "bg-green-600 text-white" : "border-2 border-green-400 text-green-700"}`}>{isPickup ? "탑승" : "하차"}</button>
                                    <button type="button" onClick={() => setMenuKey(menuKey === rowKey ? null : rowKey)}
                                      className={`h-14 min-w-[68px] rounded-xl text-[16px] font-black ${status === "NOSHOW" || status === "SELF" ? "bg-gray-700 text-white" : "border-2 border-gray-300 text-gray-600"}`}>미{isPickup ? "탑승" : "하차"}</button>
                                  </div>
                                  {menuKey === rowKey && (
                                    <div className="mt-2 flex gap-2">
                                      <button type="button" disabled={isBusy} onClick={() => { toggle(sec.direction, st.requestId, st.name, "NOSHOW"); setMenuKey(null); }}
                                        className={`h-13 flex-1 rounded-xl py-3 text-[16px] font-black ${status === "NOSHOW" ? "bg-red-500 text-white" : "border-2 border-red-300 text-red-600"}`}>❌ 결석(안 옴)</button>
                                      <button type="button" disabled={isBusy} onClick={() => { toggle(sec.direction, st.requestId, st.name, "SELF"); setMenuKey(null); }}
                                        className={`h-13 flex-1 rounded-xl py-3 text-[16px] font-black ${status === "SELF" ? "bg-violet-600 text-white" : "border-2 border-violet-300 text-violet-700"}`}>🚗 {selfLabel}</button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <div className="mt-2 flex items-center gap-2 rounded-xl bg-gray-100 px-4 py-2.5 text-[15px] font-bold text-gray-700">
                  <span className="text-[18px]">{isPickup ? "🏫" : "🚏"}</span>{sec.endName} {isPickup ? "도착" : "복귀"}{(isPickup ? v.arriveTime : v.depotTime) ? ` · ${isPickup ? v.arriveTime : v.depotTime}` : ""}
                </div>
              </div>
              );
            })}
          </section>
        );
      })}
      <p className="mt-3 text-center text-[14px] font-semibold text-gray-400">탭 한 번으로 저장됩니다 · 다시 누르면 대기로 돌아갑니다</p>

      {/* 관리자 요청 모달 */}
      {reqModal && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <DriverRequestModal
            token={token}
            serviceDate={date}
            targetId={reqModal.targetId}
            targetName={reqModal.targetName}
            defaultType={reqModal.defaultType}
            orderPayload={reqModal.orderPayload}
            onClose={() => setReqModal(null)}
          />
        </div>
      )}
    </div>
  );
}
