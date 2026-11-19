"use client";

// 체험 셔틀 배정 패널(2026-11-19 원장 결정) — 체험 상세 창 안에 한 줄로 끼우는 독립 부품.
//   <TrialShuttleAssignPanel leadId={lead.id} onChanged={reload} />
// 필요한 값은 이 패널이 자기 API(/api/admin/trial-shuttle)로 읽는다(상세 창이 넘겨줄 것은 leadId 뿐).
//
// 하는 일: 요청 내용 보기 → (체험 날짜가 확정되면) 방향별로 그날 운행 묶음·끼울 자리·위치·예상 시각을 골라 «배정 확정»
//          → 배정 뒤 «학부모에게 문자»(미리보기 창에서 직접 보내기를 눌러야 나간다)·«배정 풀기»·«셔틀 어려움으로 표시».
// ⚠️ 이 패널은 창(AdminModal) 안에서 쓰인다 — 여기서 useBackToClose 를 또 걸지 않는다(기록 칸이 두 번 쌓인다).
//    지도 창·문자 창은 각자 «뒤로 = 그 창만 닫기»를 이미 갖고 있다.
// ⚠️ 브라우저 기본 alert/confirm 을 쓰지 않는다 — 확인은 askConfirm, 결과는 패널 안 한 줄.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ManualSmsModal from "@/app/admin/apply/ManualSmsModal";
import { sendManualSms } from "@/app/actions/admin";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import { askConfirm } from "@/components/ui/feedback";
import { suggestTrialPlacement, trialPlacementChoices, type TrialRunOption } from "@/lib/shuttle/trialShuttlePlacement";
import {
  CONVERTED_RELEASE_CONFIRM_TEXT,
  requestedRideDirections,
  trialRideDirectionLabel,
  trialShuttleDateLabel,
  TRIAL_STOP_NAME_MAX,
  type TrialRideDirection,
  type TrialShuttlePlace,
} from "@/lib/shuttle/trialShuttleRules";
import type { TrialShuttlePanelData, TrialShuttleRideView } from "@/lib/shuttle/trialShuttle";

type Props = { leadId: string; onChanged: () => void };

/** 방향 한 줄의 입력값 */
type LegForm = {
  enabled: boolean;
  classTime: string;
  /** 끼울 자리 = «이 정류장 다음»(빈 글자 = 맨 앞) */
  after: string;
  stopName: string;
  address: string;
  lat: number | null;
  lng: number | null;
  arriveTime: string;
  /** 추천 이유(화면 안내) */
  reason: string;
};

const DIRECTIONS: TrialRideDirection[] = ["BOARD", "ALIGHT"];
const INPUT_CLASS = "min-h-11 w-full rounded-lg border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 text-sm text-[var(--color-academy-ink)]";

function optionOf(options: readonly TrialRunOption[], classTime: string): TrialRunOption | null {
  return options.find((o) => o.classTime === classTime) ?? null;
}

/** 요청 위치·그날 운행표로 방향 한 줄의 처음 값을 만든다(이미 배정된 줄이 있으면 그 값). */
function initialLeg(panel: TrialShuttlePanelData, direction: TrialRideDirection, ride: TrialShuttleRideView | undefined): LegForm {
  const lead = panel.lead!;
  const run = panel.run;
  if (ride) {
    return {
      enabled: true, classTime: ride.classTime, after: ride.afterStopName ?? "", stopName: ride.stopName, address: ride.address ?? "",
      lat: ride.latitude, lng: ride.longitude, arriveTime: ride.arriveTime, reason: "",
    };
  }
  const place: TrialShuttlePlace = direction === "BOARD" ? lead.pickup : lead.dropoff;
  const classTime = run?.defaultClassTime[direction] ?? "";
  const leg: LegForm = {
    enabled: requestedRideDirections(lead.shuttleDirection).includes(direction),
    classTime, after: "", stopName: place.name, address: place.address, lat: place.lat, lng: place.lng, arriveTime: "", reason: "",
  };
  return withSuggestion(panel, direction, leg);
}

/** 운행 묶음·위치가 바뀌면 끼울 자리와 예상 시각을 다시 추천한다(정규 «학생 추가»와 같은 규칙). */
function withSuggestion(panel: TrialShuttlePanelData, direction: TrialRideDirection, leg: LegForm): LegForm {
  const run = panel.run;
  if (!run) return leg;
  const option = optionOf(run.options[direction], leg.classTime);
  if (!option) return { ...leg, after: "", reason: leg.classTime ? "이 수업 시간에는 정규 운행 줄이 없어 첫 정차로 넣습니다. 예상 시각을 직접 적어 주세요." : "" };
  const suggestion = suggestTrialPlacement({
    stops: option.stops, direction, stopName: leg.stopName,
    point: leg.lat != null && leg.lng != null ? { lat: leg.lat, lng: leg.lng } : null,
    academy: run.academy, depot: run.depot,
  });
  return { ...leg, after: suggestion.afterStopName ?? "", arriveTime: suggestion.arriveTime ?? leg.arriveTime, reason: suggestion.reason };
}

export default function TrialShuttleAssignPanel({ leadId, onChanged }: Props) {
  const [panel, setPanel] = useState<TrialShuttlePanelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [legs, setLegs] = useState<Record<TrialRideDirection, LegForm> | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [mapFor, setMapFor] = useState<TrialRideDirection | null>(null);
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);
  const [unavailableOpen, setUnavailableOpen] = useState(false);
  const [unavailableNote, setUnavailableNote] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // 서버가 돌려준 패널 값으로 화면을 다시 맞춘다(배정 줄이 있으면 그 값, 없으면 요청 + 추천)
  const apply = useCallback((next: TrialShuttlePanelData) => {
    setPanel(next);
    if (!next.lead) { setLegs(null); return; }
    const sameDay = next.rides.filter((ride) => ride.serviceDate === next.lead!.scheduledYmd);
    setLegs({
      BOARD: initialLeg(next, "BOARD", sameDay.find((ride) => ride.direction === "BOARD")),
      ALIGHT: initialLeg(next, "ALIGHT", sameDay.find((ride) => ride.direction === "ALIGHT")),
    });
    // 이미 배정된 줄이 있는데 이번 배정에 없는 방향은 꺼 둔다
    if (sameDay.length > 0) {
      setLegs((current) => current && ({
        BOARD: { ...current.BOARD, enabled: sameDay.some((ride) => ride.direction === "BOARD") },
        ALIGHT: { ...current.ALIGHT, enabled: sameDay.some((ride) => ride.direction === "ALIGHT") },
      }));
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch(`/api/admin/trial-shuttle?${new URLSearchParams({ leadId })}`, { cache: "no-store" });
      const data = await response.json().catch(() => null) as { ok?: boolean; panel?: TrialShuttlePanelData; error?: string } | null;
      if (!alive.current) return;
      if (!response.ok || !data?.ok || !data.panel) { setLoadError(data?.error || "셔틀 정보를 불러오지 못했습니다."); return; }
      apply(data.panel);
    } catch {
      if (alive.current) setLoadError("셔틀 정보를 불러오지 못했습니다. 연결을 확인해 주세요.");
    }
  }, [leadId, apply]);
  useEffect(() => { setPanel(null); setEditing(false); setMessage(null); void load(); }, [load]);

  /** 저장 요청 공통 — 성공하면 서버가 준 새 패널 값으로 화면을 맞추고 상세 창에도 알린다. */
  async function post(action: string, extra: Record<string, unknown>, okText: (data: { driversNotified?: number }) => string): Promise<boolean> {
    if (busy) return false;
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/trial-shuttle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, leadId, ...extra }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; panel?: TrialShuttlePanelData; error?: string; code?: string; driversNotified?: number } | null;
      if (!alive.current) return false;
      if (!response.ok || !data?.ok || !data.panel) {
        setMessage({ tone: "error", text: data?.error || "저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요." });
        // 요청 내용이 바뀌어 거절된 경우 — 바뀐 요청으로 입력값을 다시 채우고 상세 창의 요청 요약도 새로 읽게 한다
        if (data?.code === "REQUEST_CHANGED") { void load(); onChanged(); }
        return false;
      }
      apply(data.panel);
      setMessage({ tone: "ok", text: okText(data) });
      onChanged();
      return true;
    } catch {
      if (alive.current) setMessage({ tone: "error", text: "저장 결과를 확인하지 못했습니다. 창을 다시 열어 상태를 확인해 주세요." });
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  function updateLeg(direction: TrialRideDirection, patch: Partial<LegForm>, resuggest = false) {
    setLegs((current) => {
      if (!current || !panel) return current;
      const next = { ...current[direction], ...patch };
      return { ...current, [direction]: resuggest ? withSuggestion(panel, direction, next) : next };
    });
  }

  async function submitAssign() {
    if (!legs) return;
    const chosen = DIRECTIONS.filter((direction) => legs[direction].enabled);
    if (chosen.length === 0) { setMessage({ tone: "error", text: "배정할 방향을 하나 이상 골라 주세요." }); return; }
    for (const direction of chosen) {
      const leg = legs[direction];
      const word = trialRideDirectionLabel(direction);
      if (!leg.classTime.trim()) { setMessage({ tone: "error", text: `${word}: 끼울 운행(수업 시간)을 골라 주세요.` }); return; }
      if (!leg.stopName.trim()) { setMessage({ tone: "error", text: `${word}: 위치명을 적어 주세요(예: 롯데캐슬 정문).` }); return; }
      if (!leg.arriveTime) { setMessage({ tone: "error", text: `${word}: 예상 시각을 적어 주세요.` }); return; }
    }
    const done = await post("assign", {
      // 이 화면이 열 때 받은 요청 도장 — 그 뒤 요청(방향·위치)이 바뀌었으면 서버가 거절하고 새 내용으로 다시 읽는다
      requestStamp: panel?.lead?.requestStamp ?? null,
      legs: chosen.map((direction) => {
        const leg = legs[direction];
        return {
          direction, classTime: leg.classTime, afterStopName: leg.after || null, stopName: leg.stopName,
          address: leg.address, latitude: leg.lat, longitude: leg.lng, arriveTime: leg.arriveTime,
        };
      }),
    }, (data) => (data.driversNotified ?? 0) > 0
      ? `배정했습니다. 기사님 ${data.driversNotified}명에게 알림을 보냈습니다.`
      : "배정했습니다. (새로 보낸 기사님 알림은 없습니다 — 내용이 그대로이거나 기사님 계정이 없습니다)");
    if (done) setEditing(false);
  }

  async function submitRelease() {
    // 등록 전환된 신청은 풀면 다시 배정할 수 없다(배정 게이트가 막는다) — 확인 문구에 그 사실을 적는다
    const text = panel?.lead?.closed ? CONVERTED_RELEASE_CONFIRM_TEXT : "셔틀 배정을 풀까요? 기사님 운행표에서 빠지고 «배정 대기»로 돌아갑니다.";
    if (!(await askConfirm(text, { tone: "danger" }))) return;
    await post("release", {}, (data) => (data.driversNotified ?? 0) > 0 ? "배정을 풀었습니다. 기사님께 취소를 알렸습니다." : "배정을 풀었습니다.");
  }

  async function submitUnavailable() {
    const done = await post("unavailable", { note: unavailableNote }, (data) =>
      (data.driversNotified ?? 0) > 0 ? "«셔틀 어려움»으로 표시했습니다. 기사님께 취소를 알렸습니다." : "«셔틀 어려움»으로 표시했습니다.");
    if (done) { setUnavailableOpen(false); setUnavailableNote(""); }
  }

  async function handleSendSms(text: string) {
    const lead = panel?.lead;
    if (!lead?.parentPhone || smsBusy) return;
    setSmsBusy(true);
    try {
      // 기존 수동 문자 장치 그대로(체험 화면 «문자» 버튼과 같은 함수·같은 장부). 관리자가 보내기를 눌렀을 때만 나간다.
      const result = await sendManualSms([lead.parentPhone], text, {
        requestId: `trial-shuttle-${lead.id}-${Date.now()}`,
        purpose: "체험 셔틀 안내 문자",
        reason: "체험 셔틀 배정 뒤 관리자가 직접 발송",
        audienceScope: "EXTERNAL",
      });
      if (!alive.current) return;
      setSmsOpen(false);
      if (result.success > 0 && result.failed === 0 && result.uncertain === 0) {
        await post("smsSent", {}, () => `${lead.childName} 보호자에게 셔틀 안내 문자를 보냈습니다.`);
      } else if (result.success > 0) {
        setMessage({ tone: "error", text: "문자 일부만 발송됐습니다. 문자 발송 장부를 확인해 주세요." });
      } else {
        setMessage({ tone: "error", text: result.results[0]?.reason || "문자 발송에 실패했습니다. 연락처와 문자 설정을 확인해 주세요." });
      }
    } catch (error) {
      if (alive.current) setMessage({ tone: "error", text: error instanceof Error && error.message ? error.message : "문자 발송 중 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요." });
    } finally {
      if (alive.current) setSmsBusy(false);
    }
  }

  const lead = panel?.lead ?? null;
  const sameDayRides = useMemo(
    () => (panel && lead ? panel.rides.filter((ride) => ride.serviceDate === lead.scheduledYmd) : []),
    [panel, lead],
  );
  const mapLeg = mapFor && legs ? legs[mapFor] : null;
  const mapInitial: MapLocationData | undefined = mapLeg && mapLeg.lat != null && mapLeg.lng != null
    ? { address: mapLeg.address, placeName: mapLeg.stopName, latitude: mapLeg.lat, longitude: mapLeg.lng, source: "MAP_PIN" }
    : undefined;

  // ── 그리기 ──
  const frame = "rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3";
  if (loadError) {
    return (
      <section aria-label="체험 셔틀" className={frame}>
        <p role="alert" className="text-sm font-medium text-[var(--color-academy-danger)]">{loadError}</p>
        <button type="button" onClick={() => void load()} className="academy-button-secondary academy-button-sm mt-2">다시 불러오기</button>
      </section>
    );
  }
  if (!panel) {
    return <section aria-label="체험 셔틀" className={frame}><p role="status" className="text-sm text-[var(--color-academy-muted)]">셔틀 정보를 불러오는 중…</p></section>;
  }
  if (!panel.ready || !lead) {
    return <section aria-label="체험 셔틀" className={frame}><p role="status" className="text-sm text-[var(--color-academy-muted)]">{panel.gate.ok ? "셔틀 정보를 찾지 못했습니다." : panel.gate.reason}</p></section>;
  }

  const status = lead.shuttleStatus;
  const requested = lead.shuttleNeeded || status !== "NONE";
  const showForm = requested && status !== "UNAVAILABLE" && panel.gate.ok && (status !== "ASSIGNED" || editing || sameDayRides.length === 0);
  const showAssigned = status === "ASSIGNED" && sameDayRides.length > 0 && !editing;
  // 취소·이탈·등록 전환된 신청 — 배정 내용은 보이되 행동 버튼(문자·수정·풀기·셔틀 어려움·다시 대기)은 숨긴다
  const closed = lead.closed;

  return (
    <section aria-label="체험 셔틀" className={frame}>
      {/* 상태 배지·요청 내용 요약은 여기서 그리지 않는다 — 체험 상세의 셔틀 칸(TrialShuttleSection)이 이미 보여 준다(같은 글이 두 번 나오지 않게).
          이 패널은 «배정» 내용과 그 행동만 둔다. */}
      {!requested && <p className="text-sm text-[var(--color-academy-muted)]">셔틀 요청이 없습니다.</p>}

      {/* 체험 날이 연간일정 휴무면 경고 한 줄 — 막지는 않는다(휴무일에도 체험·운행을 따로 잡을 수 있다) */}
      {requested && !closed && panel.run?.holidayTitle && (showForm || showAssigned) && (
        <p role="note" className="mb-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-ink)]">
          {trialShuttleDateLabel(lead.scheduledYmd ?? "")}은 휴무({panel.run.holidayTitle})입니다. 정규 셔틀이 운행하지 않을 수 있으니 확인하고 배정해 주세요.
        </p>
      )}

      {/* 배정할 수 없는 이유(일정 미확정·지난 날짜 등) */}
      {requested && status !== "UNAVAILABLE" && !panel.gate.ok && (
        <p role="status" className="mt-2 rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-muted)]">{panel.gate.reason}</p>
      )}

      {/* 배정된 내용 */}
      {showAssigned && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-[var(--color-academy-muted)]">{trialShuttleDateLabel(lead.scheduledYmd ?? "")} 운행표에 «체험»으로 나옵니다.</p>
          {sameDayRides.map((ride) => (
            <p key={ride.id} className="flex min-h-11 flex-wrap items-center gap-x-2 rounded-lg bg-[var(--color-academy-soft)] px-3 text-sm text-[var(--color-academy-ink)]">
              <span className="font-medium">{trialRideDirectionLabel(ride.direction)} {ride.arriveTime}</span>
              <span className="min-w-0 break-words">{ride.stopName}</span>
              <span className="text-xs text-[var(--color-academy-muted)]">{ride.classTime} 운행 · {ride.afterStopName ? `${ride.afterStopName} 다음` : "맨 앞"}</span>
              <span className="text-xs text-[var(--color-academy-muted)]">기사님 알림 {ride.driverNotified ? "보냄" : "안 감"} · 학부모 문자 {ride.parentSmsSent ? "보냄" : "전"}</span>
            </p>
          ))}
          {!closed && <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" disabled={Boolean(busy) || !lead.parentPhone} onClick={() => setSmsOpen(true)} className="academy-button-primary academy-button-sm">학부모에게 문자</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => { setMessage(null); setEditing(true); }} className="academy-button-secondary academy-button-sm">배정 수정</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void submitRelease()} className="academy-button-secondary academy-button-sm">{busy === "release" ? "푸는 중…" : "배정 풀기"}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => setUnavailableOpen((open) => !open)} aria-expanded={unavailableOpen} className="academy-button-text academy-button-sm">셔틀 어려움으로 표시</button>
          </div>}
          {/* 등록 전환된 신청 — «배정 풀기» 하나만(전환 당일 부모 차로 가는 경우 하원 셔틀을 뺀다). 문자·수정·셔틀 어려움은 없다 */}
          {closed && lead.canReleaseAfterConvert && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" disabled={Boolean(busy)} onClick={() => void submitRelease()} className="academy-button-secondary academy-button-sm">{busy === "release" ? "푸는 중…" : "배정 풀기"}</button>
            </div>
          )}
        </div>
      )}

      {/* 배정 입력 */}
      {showForm && legs && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-[var(--color-academy-muted)]">
            {trialShuttleDateLabel(lead.scheduledYmd ?? "")}{lead.scheduledHm && lead.scheduledHm !== "00:00" ? ` ${lead.scheduledHm}` : ""}{lead.className ? ` · ${lead.className}` : ""} 체험 — 그날 정규 운행표에 하루만 끼웁니다.
          </p>
          {DIRECTIONS.map((direction) => {
            const leg = legs[direction];
            const word = trialRideDirectionLabel(direction);
            const options = panel.run?.options[direction] ?? [];
            const option = optionOf(options, leg.classTime);
            return (
              <fieldset key={direction} className="rounded-lg border border-[var(--color-academy-line)] p-2">
                <legend className="px-1">
                  <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--color-academy-ink)]">
                    <input type="checkbox" className="h-5 w-5" checked={leg.enabled} disabled={Boolean(busy)} onChange={(event) => updateLeg(direction, { enabled: event.target.checked })} />
                    {word} 태우기
                  </label>
                </legend>
                {leg.enabled && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)]">
                      끼울 운행(수업 시간)
                      {options.length > 0 ? (
                        <select value={leg.classTime} disabled={Boolean(busy)} onChange={(event) => updateLeg(direction, { classTime: event.target.value }, true)} className={`${INPUT_CLASS} mt-1`}>
                          {!option && <option value={leg.classTime}>{leg.classTime || "고르기"}</option>}
                          {options.map((o) => <option key={o.classTime} value={o.classTime}>{o.classTime} · 정차 {o.stops.length}곳</option>)}
                        </select>
                      ) : (
                        // 그 요일에 정규 운행 줄이 없으면 수업 시간을 직접 적는다(운행표에 그 이름의 묶음으로 나온다)
                        <input value={leg.classTime} disabled={Boolean(busy)} maxLength={40} placeholder="예: 16:00~17:00" onChange={(event) => updateLeg(direction, { classTime: event.target.value })} className={`${INPUT_CLASS} mt-1`} />
                      )}
                    </label>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)]">
                      끼울 자리
                      <select value={leg.after} disabled={Boolean(busy)} onChange={(event) => updateLeg(direction, { after: event.target.value })} className={`${INPUT_CLASS} mt-1`}>
                        {trialPlacementChoices(option?.stops ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                      </select>
                    </label>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)]">
                      위치명 (필수)
                      <input value={leg.stopName} disabled={Boolean(busy)} maxLength={TRIAL_STOP_NAME_MAX} placeholder="예: 롯데캐슬 정문" onChange={(event) => updateLeg(direction, { stopName: event.target.value })} className={`${INPUT_CLASS} mt-1`} />
                    </label>
                    <label className="block text-xs font-medium text-[var(--color-academy-muted)]">
                      예상 시각
                      <input type="time" value={leg.arriveTime} disabled={Boolean(busy)} onChange={(event) => updateLeg(direction, { arriveTime: event.target.value })} className={`${INPUT_CLASS} mt-1`} />
                    </label>
                    <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                      <button type="button" disabled={Boolean(busy)} onClick={() => setMapFor(direction)} className="academy-button-secondary academy-button-sm">지도에서 위치 지정</button>
                      <span className="min-w-0 break-words text-xs text-[var(--color-academy-muted)]">
                        {leg.address || "주소 없음"} · {leg.lat != null && leg.lng != null ? "지도 위치 있음" : "지도 위치 없음(길안내·자리 추천 불가)"}
                      </span>
                    </div>
                    {leg.reason && <p className="text-xs text-[var(--color-academy-muted)] sm:col-span-2">추천: {leg.reason}</p>}
                  </div>
                )}
              </fieldset>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy)} onClick={() => void submitAssign()} className="academy-button-primary">{busy === "assign" ? "배정하는 중…" : "배정 확정"}</button>
            {editing && <button type="button" disabled={Boolean(busy)} onClick={() => { setEditing(false); apply(panel); }} className="academy-button-secondary">취소</button>}
            {!editing && <button type="button" disabled={Boolean(busy)} onClick={() => setUnavailableOpen((open) => !open)} aria-expanded={unavailableOpen} className="academy-button-text">셔틀 어려움으로 표시</button>}
          </div>
          <p className="text-xs text-[var(--color-academy-muted)]">배정을 확정하면 기사님께 알림이 갑니다. 학부모 문자는 배정 뒤 «학부모에게 문자»를 눌러 직접 보냅니다.</p>
        </div>
      )}

      {/* 일정이 아직 없어 배정 입력이 안 보일 때도 «셔틀 어려움» 표시는 할 수 있다(운행 지역 판단) */}
      {requested && !closed && status === "REQUESTED" && !showForm && (
        <button type="button" disabled={Boolean(busy)} onClick={() => setUnavailableOpen((open) => !open)} aria-expanded={unavailableOpen} className="academy-button-text academy-button-sm mt-2">셔틀 어려움으로 표시</button>
      )}

      {/* 셔틀 어려움 — 메모(선택)를 적고 표시 */}
      {unavailableOpen && !closed && status !== "UNAVAILABLE" && (
        <div className="mt-2 rounded-lg border border-[var(--color-academy-line-input)] p-2">
          <label className="block text-xs font-medium text-[var(--color-academy-muted)]">
            메모 (선택 — 예: 운행 지역 밖)
            <input value={unavailableNote} disabled={Boolean(busy)} maxLength={500} onChange={(event) => setUnavailableNote(event.target.value)} className={`${INPUT_CLASS} mt-1`} />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy)} onClick={() => void submitUnavailable()} className="academy-button-secondary academy-button-sm">{busy === "unavailable" ? "표시하는 중…" : "셔틀 어려움으로 표시"}</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => setUnavailableOpen(false)} className="academy-button-text academy-button-sm">취소</button>
          </div>
        </div>
      )}

      {status === "UNAVAILABLE" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-sm text-[var(--color-academy-muted)]">셔틀 운행이 어렵다고 표시한 신청입니다.</p>
          {!closed && <button type="button" disabled={Boolean(busy)} onClick={() => void post("reopen", {}, () => "다시 «배정 대기»로 돌렸습니다.")} className="academy-button-secondary academy-button-sm">{busy === "reopen" ? "바꾸는 중…" : "다시 배정 대기로"}</button>}
        </div>
      )}

      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm font-medium ${message.tone === "error" ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-success)]"}`}>{message.text}</p>
      )}

      {mapFor && (
        <LocationPickerModal
          title={`체험 셔틀 ${trialRideDirectionLabel(mapFor)} 위치`}
          initialValue={mapInitial}
          requirePlaceName
          onClose={() => setMapFor(null)}
          onConfirm={(location) => {
            const direction = mapFor;
            setMapFor(null);
            // 지도에서 고른 이름·주소·좌표를 넣고, 그 위치로 끼울 자리·시각을 다시 추천한다
            updateLeg(direction, {
              stopName: (location.placeName ?? "").trim() || legs?.[direction].stopName || "",
              address: location.roadAddress || location.address || "",
              lat: location.latitude,
              lng: location.longitude,
            }, true);
          }}
        />
      )}

      {smsOpen && panel.smsDraft && (
        <ManualSmsModal
          title="체험 셔틀 안내 문자"
          recipientLabel={`${lead.childName} 보호자`}
          recipientPhone={lead.parentPhone ?? ""}
          defaultMessage={panel.smsDraft}
          busy={smsBusy}
          onClose={() => setSmsOpen(false)}
          onSubmit={handleSendSms}
        />
      )}
    </section>
  );
}
