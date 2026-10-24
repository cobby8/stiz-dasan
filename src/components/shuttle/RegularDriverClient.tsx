"use client";

import { useEffect, useRef, useState } from "react";
import { tmapNavigationCoordinateUrl } from "@/lib/maps/coordinate-links";
import DriverDateNav from "@/components/shuttle/DriverDateNav";
import GpsShareBar from "@/components/shuttle/GpsShareBar";
import { useGpsShare } from "@/hooks/useGpsShare";
import DriverRequestModal from "@/components/shuttle/DriverRequestModal";
// 표시 계약은 순수 모듈 한 곳에서만 정의한다(서버 조립부와 화면이 어긋나지 않게).
import type { DriverRow, DriverStop, DriverClass } from "@/lib/shuttle/regularDriverRouteLogic";

export type { DriverRow, DriverStop, DriverClass };

// 정규 셔틀 기사님 운행 화면 — 로그인 없이 토큰으로 접근. 오늘 요일의 수업별 등원·하원 타임라인.
// ★ 기사님 연세를 고려해 항상 '라이트 모드' + 큰 글자·큰 버튼(dark: 미사용). 탭 한 번으로 즉시 저장.

// PWA 설치 이벤트 타입 (브라우저 전용, 표준 미포함)
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void> }

// SELF = 자차(부모 차) 등·하원. 셔틀 미탑승이지만 결석(사전 신고)과는 구분한다.
type Status = "BOARDED" | "NOSHOW" | "SELF";

type ReqModal = { targetId?: string; targetName?: string; defaultType?: "REMOVE" | "LOCATION" | "ORDER" | "OTHER"; orderPayload?: unknown };

function digits(p: string | null): string | null { if (!p) return null; const d = p.replace(/[^0-9]/g, ""); return d.length >= 9 ? d : null; }
function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${iso}T12:00:00+09:00`).getUTCDay()] ?? "";
  return `${Number(m[2])}/${Number(m[3])}${dow ? ` (${dow})` : ""}`;
}

function StopList({ stops, boarding, setStatus, isEditing, onMoveStop, onReqStudent, onReqStop }: {
  stops: DriverStop[];
  boarding: Record<string, Status>;
  setStatus: (rowId: string, name: string, next: Status) => void;
  isEditing: boolean;
  onMoveStop: (si: number, dir: -1 | 1) => void;
  onReqStudent: (modal: ReqModal) => void;
  onReqStop: (stop: DriverStop) => void;
}) {
  const [menuKey, setMenuKey] = useState<string | null>(null);
  return (
    <ol className="space-y-2.5">
      {stops.map((s, si) => {
        const isPickup = s.direction === "BOARD";
        const url = tmapNavigationCoordinateUrl({ latitude: s.lat, longitude: s.lng, name: s.label });
        return (
          <li key={si} className={`rounded-2xl border-2 p-3.5 ${isEditing ? "border-blue-200 bg-blue-50" : "border-gray-200 bg-white"}`}>
            <div className="flex items-center gap-2.5">
              {isEditing ? (
                <div className="flex shrink-0 flex-col gap-0.5">
                  <button type="button" disabled={si === 0} onClick={() => onMoveStop(si, -1)}
                    className="h-7 w-7 rounded-lg border border-gray-300 text-[16px] font-black text-gray-600 disabled:opacity-30">▲</button>
                  <button type="button" disabled={si === stops.length - 1} onClick={() => onMoveStop(si, 1)}
                    className="h-7 w-7 rounded-lg border border-gray-300 text-[16px] font-black text-gray-600 disabled:opacity-30">▼</button>
                </div>
              ) : (
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-orange-500 text-[15px] font-black text-white">{si + 1}</span>
              )}
              <span className="min-w-0 flex-1 text-[18px] font-black leading-tight text-gray-900">{s.label}</span>
              {s.arriveTime && !isEditing && <span className="shrink-0 text-[16px] font-black text-blue-600">{s.arriveTime}</span>}
              {!isEditing && (
                <button type="button" onClick={() => onReqStop(s)}
                  className="shrink-0 rounded-lg border border-gray-300 px-2 py-1 text-[12px] font-black text-gray-500 active:bg-gray-100">
                  요청
                </button>
              )}
            </div>
            {!isEditing && url && <a href={url} className="mt-2 flex h-12 items-center justify-center gap-1.5 rounded-xl bg-blue-600 text-[16px] font-black text-white active:bg-blue-700">🧭 T맵 길안내</a>}
            <div className="mt-2.5 space-y-2.5">
              {s.rows.map((st) => {
                const status = boarding[st.rowId] ?? null;
                const parent = digits(st.parentPhone), child = digits(st.studentPhone);
                const selfLabel = isPickup ? "자차등원" : "자차하원";
                return (
                  <div key={st.rowId} className={`rounded-xl p-2.5 ${st.absent ? "bg-red-50" : "bg-gray-50"}`}>
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <span className={`text-[19px] font-black ${st.absent ? "text-gray-400 line-through" : "text-gray-900"}`}>{st.name}</span>
                        {st.absent && <span className="ml-2 rounded-md bg-red-500 px-2 py-0.5 text-[13px] font-black text-white align-middle">오늘 결석</span>}
                        {!st.absent && status === "NOSHOW" && <span className="ml-2 rounded-md bg-red-500 px-2 py-0.5 text-[13px] font-black text-white align-middle">결석</span>}
                        {!st.absent && status === "SELF" && <span className="ml-2 rounded-md bg-violet-600 px-2 py-0.5 text-[13px] font-black text-white align-middle">{selfLabel}</span>}
                        {!st.absent && (
                          <div className="mt-1 flex gap-3">
                            {parent && <a href={`tel:${parent}`} className="text-[15px] font-black text-blue-600">📞 학부모</a>}
                            {child && <a href={`tel:${child}`} className="text-[15px] font-black text-green-600">📞 학생</a>}
                          </div>
                        )}
                      </div>
                      {st.absent ? (
                        <span className="rounded-xl border-2 border-red-300 px-3 py-2 text-[15px] font-black text-red-500">미{isPickup ? "탑승" : "하차"}(결석)</span>
                      ) : (
                        <>
                          {/* 요청 버튼 */}
                          <button type="button" onClick={() => onReqStudent({ targetId: st.rowId, targetName: st.name, defaultType: "REMOVE" })}
                            className="h-14 min-w-[48px] rounded-xl border-2 border-gray-200 text-[13px] font-black text-gray-500 active:bg-gray-100">
                            요청
                          </button>
                          <button type="button" onClick={() => { setMenuKey(null); setStatus(st.rowId, st.name, "BOARDED"); }}
                            className={`h-14 min-w-[68px] rounded-xl text-[16px] font-black ${status === "BOARDED" ? "bg-green-600 text-white" : "border-2 border-green-400 text-green-700"}`}>{isPickup ? "탑승" : "하차"}</button>
                          <button type="button" onClick={() => setMenuKey(menuKey === st.rowId ? null : st.rowId)}
                            className={`h-14 min-w-[68px] rounded-xl text-[16px] font-black ${status === "NOSHOW" || status === "SELF" ? "bg-gray-700 text-white" : "border-2 border-gray-300 text-gray-600"}`}>미{isPickup ? "탑승" : "하차"}</button>
                        </>
                      )}
                    </div>
                    {!st.absent && menuKey === st.rowId && (
                      <div className="mt-2 flex gap-2">
                        <button type="button" onClick={() => { setStatus(st.rowId, st.name, "NOSHOW"); setMenuKey(null); }}
                          className={`flex-1 rounded-xl py-3 text-[16px] font-black ${status === "NOSHOW" ? "bg-red-500 text-white" : "border-2 border-red-300 text-red-600"}`}>❌ 결석(안 옴)</button>
                        <button type="button" onClick={() => { setStatus(st.rowId, st.name, "SELF"); setMenuKey(null); }}
                          className={`flex-1 rounded-xl py-3 text-[16px] font-black ${status === "SELF" ? "bg-violet-600 text-white" : "border-2 border-violet-300 text-violet-700"}`}>🚗 {selfLabel}</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default function RegularDriverClient({ token, date, classes, initialBoarding, prevDate, nextDate, today }: {
  token: string; date: string; classes: DriverClass[]; initialBoarding: Record<string, Status>;
  prevDate: string; nextDate: string; today: string;
}) {
  const [boarding, setBoarding] = useState<Record<string, Status>>(initialBoarding);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [runState, setRunState] = useState<"idle" | "running" | "ended">("idle");

  const { state: gpsState, lastSentAt, accuracy, start: gpsStart, stop: gpsStop } = useGpsShare(token, "정규 셔틀 기사님");

  function handleRunStart() { setRunState("running"); gpsStart(); }
  async function handleRunEnd() { await gpsStop(); setRunState("ended"); }

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

  // 정류장 순서 변경 — 섹션 키 `"${classTime}:${direction}"` 단위로 편집 모드 관리
  const [editSectionKey, setEditSectionKey] = useState<string | null>(null);
  const [reorderedSections, setReorderedSections] = useState<Record<string, DriverStop[]>>({});

  function getSectionStops(key: string, original: DriverStop[]): DriverStop[] {
    return reorderedSections[key] ?? original;
  }
  function moveStop(key: string, original: DriverStop[], si: number, dir: -1 | 1) {
    const stops = [...getSectionStops(key, original)];
    const next = si + dir;
    if (next < 0 || next >= stops.length) return;
    [stops[si], stops[next]] = [stops[next]!, stops[si]!];
    setReorderedSections((r) => ({ ...r, [key]: stops }));
  }

  // 관리자 요청 모달
  const [reqModal, setReqModal] = useState<ReqModal | null>(null);

  async function setStatus(rowId: string, name: string, next: Status) {
    if (busy[rowId]) return;
    const cur = boarding[rowId] ?? null;
    const target: Status | null = cur === next ? null : next;
    setBoarding((b) => { const n = { ...b }; if (target) n[rowId] = target; else delete n[rowId]; return n; });
    setBusy((x) => ({ ...x, [rowId]: true }));
    try {
      const r = await fetch("/api/shuttle/regular-boarding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 화면이 표시 중인 날짜(date)를 함께 보내, 그 날짜에 저장·조회되도록 한다(날짜 네비 이동 시 어긋남 방지).
        body: JSON.stringify({ token, rowId, status: target, studentName: name, date }),
      });
      if (!r.ok) throw new Error();
    } catch {
      setBoarding((b) => { const n = { ...b }; if (cur) n[rowId] = cur; else delete n[rowId]; return n; });
    } finally {
      setBusy((x) => ({ ...x, [rowId]: false }));
    }
  }

  const allRows = classes.flatMap((c) => [...c.board, ...c.alight].flatMap((s) => s.rows));
  const boarded = allRows.filter((r) => boarding[r.rowId] === "BOARDED").length;

  return (
    <div className="mx-auto max-w-lg px-3 pb-28 text-gray-900" style={{ colorScheme: "light" }}>
      <header className="sticky top-0 z-10 -mx-3 mb-3 border-b border-gray-200 bg-white px-4 py-4">
        <p className="text-[20px] font-black text-gray-900">🚌 스티즈 정규 셔틀</p>
        <p className="mt-0.5 text-[15px] font-bold text-gray-600">{fmtDate(date)} · 체크 {boarded}/{allRows.length}</p>
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

      <DriverDateNav date={date} prevDate={prevDate} nextDate={nextDate} today={today} />

      {classes.length === 0 && <p className="rounded-2xl bg-gray-50 px-4 py-6 text-center text-[16px] font-bold text-gray-400">이 날은 운행이 없습니다.</p>}

      {classes.map((c) => (
        <section key={c.classTime} className="mb-6">
          {/* 저장 노선(원장 확정)이면 차량·회차 제목, 폴백이면 종전대로 수업시간 제목 */}
          <div className="sticky top-[68px] z-[5] -mx-1 mb-3 rounded-2xl bg-brand-navy-900 px-4 py-3 text-[18px] font-black text-white">
            {c.title ?? `🕒 ${c.classTime} 수업`}
          </div>

          {c.board.length > 0 && (() => {
            const key = `${c.classTime}:BOARD`;
            const isEditing = editSectionKey === key;
            const stops = getSectionStops(key, c.board);
            return (
              <div className="mb-3">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <p className="flex-1 text-[16px] font-black text-blue-700">
                    ⬆ 등원(승차)
                    {/* 원장이 아직 노선을 확정하지 않은 요일 — 셔틀 명단 순서라는 걸 기사님께 알린다 */}
                    {c.pending && <span className="ml-1.5 rounded-md bg-amber-100 px-1.5 py-0.5 text-[12px] font-black text-amber-700">임시 순서 · 확정 전</span>}
                  </p>
                  {!isEditing && (
                    <button type="button" onClick={() => setEditSectionKey(key)}
                      className="rounded-xl border-2 border-gray-300 px-3 py-1 text-[13px] font-black text-gray-600">↕ 순서 편집</button>
                  )}
                  {isEditing && (
                    <div className="flex gap-2">
                      <button type="button" onClick={() => {
                        setReqModal({ defaultType: "ORDER", orderPayload: stops, targetId: key, targetName: `${c.classTime} 등원 순서` });
                        setEditSectionKey(null);
                      }} className="rounded-xl bg-blue-600 px-3 py-1 text-[13px] font-black text-white">📨 순서 고정 요청</button>
                      <button type="button" onClick={() => { setEditSectionKey(null); setReorderedSections((r) => { const n = { ...r }; delete n[key]; return n; }); }}
                        className="rounded-xl border-2 border-gray-300 px-3 py-1 text-[13px] font-black text-gray-600">취소</button>
                    </div>
                  )}
                </div>
                {isEditing && <p className="mb-2 rounded-xl bg-blue-50 px-3 py-2 text-[13px] font-bold text-blue-700">↕ 버튼으로 순서를 바꾼 뒤 &quot;순서 고정 요청&quot;을 눌러주세요</p>}
                <StopList stops={stops} boarding={boarding} setStatus={setStatus}
                  isEditing={isEditing}
                  onMoveStop={(si, dir) => moveStop(key, c.board, si, dir)}
                  onReqStudent={setReqModal}
                  onReqStop={(s) => setReqModal({ targetName: s.label, defaultType: "LOCATION" })}
                />
              </div>
            );
          })()}

          {c.alight.length > 0 && (() => {
            const key = `${c.classTime}:ALIGHT`;
            const isEditing = editSectionKey === key;
            const stops = getSectionStops(key, c.alight);
            return (
              <div>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <p className="flex-1 text-[16px] font-black text-orange-700">
                    ⬇ 하원(하차)
                    {c.pending && <span className="ml-1.5 rounded-md bg-amber-100 px-1.5 py-0.5 text-[12px] font-black text-amber-700">임시 순서 · 확정 전</span>}
                  </p>
                  {!isEditing && (
                    <button type="button" onClick={() => setEditSectionKey(key)}
                      className="rounded-xl border-2 border-gray-300 px-3 py-1 text-[13px] font-black text-gray-600">↕ 순서 편집</button>
                  )}
                  {isEditing && (
                    <div className="flex gap-2">
                      <button type="button" onClick={() => {
                        setReqModal({ defaultType: "ORDER", orderPayload: stops, targetId: key, targetName: `${c.classTime} 하원 순서` });
                        setEditSectionKey(null);
                      }} className="rounded-xl bg-blue-600 px-3 py-1 text-[13px] font-black text-white">📨 순서 고정 요청</button>
                      <button type="button" onClick={() => { setEditSectionKey(null); setReorderedSections((r) => { const n = { ...r }; delete n[key]; return n; }); }}
                        className="rounded-xl border-2 border-gray-300 px-3 py-1 text-[13px] font-black text-gray-600">취소</button>
                    </div>
                  )}
                </div>
                {isEditing && <p className="mb-2 rounded-xl bg-blue-50 px-3 py-2 text-[13px] font-bold text-blue-700">↕ 버튼으로 순서를 바꾼 뒤 &quot;순서 고정 요청&quot;을 눌러주세요</p>}
                <StopList stops={stops} boarding={boarding} setStatus={setStatus}
                  isEditing={isEditing}
                  onMoveStop={(si, dir) => moveStop(key, c.alight, si, dir)}
                  onReqStudent={setReqModal}
                  onReqStop={(s) => setReqModal({ targetName: s.label, defaultType: "LOCATION" })}
                />
              </div>
            );
          })()}
        </section>
      ))}

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
