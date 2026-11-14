"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import type { RegularChangeChild, RegularChangeOptions, RegularChangePlace } from "@/lib/shuttle/regularChangeRequest";
import {
  REGULAR_CHANGE_DIRECTIONS,
  REGULAR_CHANGE_DIRECTION_LABEL,
  REGULAR_CHANGE_KIND_LABEL,
  REGULAR_CHANGE_NOTE_MAX,
  defaultDirections,
  koreanMonthDay,
  selectableWeekdays,
  startableWeekdays,
  weekdayLabel,
  type RegularChangeContext,
  type RegularChangeDirection,
  type RegularChangeKind,
} from "@/lib/shuttle/regularChangeRules";

// 셔틀 «계속 바꾸기» 신청 화면(2026-11-14 결정표 c5).
// 하루만 바꾸는 «셔틀 변경»과 달리 셔틀 명단을 앞으로 계속 바꾼다 → 학부모가 신청하고 원장이 승인한다.
// 고를 수 있는 종류·요일은 규칙 함수(regularChangeRules) 한 곳에서 나온다 — 서버 접수도 같은 함수로 다시 판정한다.

const TONE_CLASS: Record<string, string> = {
  warning: "text-[var(--color-academy-warning)]",
  success: "text-[var(--color-academy-success)]",
  danger: "text-[var(--color-academy-danger)]",
  muted: "text-[var(--color-academy-faint)]",
};

/** 저장돼 있던 위치 → 지도 부품 첫 값 */
function toMapValue(place: RegularChangePlace | null): MapLocationData | undefined {
  if (!place) return undefined;
  return {
    address: place.address ?? place.roadAddress ?? "", roadAddress: place.roadAddress ?? undefined,
    placeName: place.name ?? undefined, latitude: place.latitude, longitude: place.longitude, source: "MAP_PIN",
  };
}

/** 지도 부품 값 → 서버가 받는 모양(토큰 링크 제출과 같은 칸) */
function toServer(value: MapLocationData) {
  return {
    name: value.placeName ?? null, address: value.address, roadAddress: value.roadAddress ?? null,
    latitude: value.latitude, longitude: value.longitude, placeId: value.placeId ?? null,
    source: value.source, accuracyMeters: value.accuracyMeters ?? null, note: null,
  };
}

function placeTitle(value: MapLocationData | null): string {
  return value?.placeName || value?.roadAddress || value?.address || "";
}

/** 그 아이에게 열려 있는 종류 — 타고 있으면 위치 바꾸기·이용 중단, 안 타는 수업 요일이 있으면 이용 시작 */
function kindsFor(child: RegularChangeChild, ctx: RegularChangeContext): RegularChangeKind[] {
  const kinds: RegularChangeKind[] = [];
  if (child.roster.length > 0) kinds.push("CHANGE");
  if (startableWeekdays(ctx, REGULAR_CHANGE_DIRECTIONS).length > 0) kinds.push("START");
  if (child.roster.length > 0) kinds.push("STOP");
  return kinds;
}

// academyTel = 걸 수 있는 학원 번호(서버가 다듬은 값) — 하루 접수 상한 안내 옆 «학원에 전화하기». 없으면 글자만
export default function RegularChangeClient({ initial, presetStudentId = null, academyTel = null }: { initial: RegularChangeOptions; presetStudentId?: string | null; academyTel?: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const [studentId, setStudentId] = useState(
    initial.children.find((c) => c.studentId === presetStudentId)?.studentId ?? initial.children[0]?.studentId ?? "",
  );
  const [kindChoice, setKindChoice] = useState<RegularChangeKind | null>(null);
  // 고른 방향. null = 아직 손대지 않음 → 그 아이·종류의 기본값(실제 타는 쪽 / 아직 안 타는 쪽)을 쓴다
  const [directionChoice, setDirectionChoice] = useState<RegularChangeDirection[] | null>(null);
  // 빈 배열 = 모든 요일
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [pickup, setPickup] = useState<MapLocationData | null>(null);
  const [dropoff, setDropoff] = useState<MapLocationData | null>(null);
  const [picker, setPicker] = useState<RegularChangeDirection | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(initial.minEffectiveFrom);
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // 방금 접수한 아이 — 새 내역이 올 때까지 같은 신청을 다시 못 누르게 양식을 접는다
  const [submittedFor, setSubmittedFor] = useState<string | null>(null);
  // 방금 취소한 신청 — 새로고침이 늦어도 다시 보이지 않게
  const [canceledIds, setCanceledIds] = useState<string[]>([]);
  // 서버가 «오늘은 더 신청할 수 없어요»(하루 접수 상한)로 답했는가 — 안내 옆에 전화 버튼을 보인다
  const [limitHit, setLimitHit] = useState(false);

  const child = initial.children.find((c) => c.studentId === studentId) ?? null;
  const requests = initial.requests.filter((r) => !canceledIds.includes(r.id));
  const nameOf = (id: string) => initial.children.find((c) => c.studentId === id)?.studentName ?? "";

  if (!child) {
    return (
      <main className="mx-auto max-w-lg space-y-3 px-4 py-6">
        <h1 className="academy-heading">셔틀 계속 바꾸기</h1>
        <p className="rounded-2xl bg-white p-5 text-sm text-[var(--color-academy-muted)] shadow-sm">
          지금 다니고 있는 반이 없어요.{" "}
          <Link href="/mypage/classes" className="font-semibold underline">수업 보기</Link>
        </p>
      </main>
    );
  }

  const ctx: RegularChangeContext = {
    today: "", classWeekdays: child.classWeekdays,
    roster: child.roster.map((r) => ({ weekday: r.weekday, direction: r.direction })),
  };
  const kinds = kindsFor(child, ctx);
  const kind: RegularChangeKind | null = kindChoice && kinds.includes(kindChoice) ? kindChoice : kinds[0] ?? null;
  // 등원만 타는 아이에게 «하원 위치»까지 고르게 하면 신청이 거절된다 → 기본은 해당하는 쪽만(2026-11-15 리뷰 R7)
  const directions: RegularChangeDirection[] = directionChoice ?? (kind ? defaultDirections(kind, ctx) : [...REGULAR_CHANGE_DIRECTIONS]);
  const dayChoices = kind ? selectableWeekdays(kind, ctx, directions) : [];
  // 고른 요일 중 지금 고를 수 있는 것만(종류·방향을 바꾸면 못 고르는 요일이 빠진다)
  const chosenDays = weekdays.filter((w) => dayChoices.includes(w));
  const needsPlace = kind !== "STOP";
  const hasOpen = requests.some((r) => r.studentId === child.studentId && r.status === "PENDING");
  const locked = hasOpen || submittedFor === child.studentId;

  function reset() {
    setKindChoice(null); setDirectionChoice(null); setWeekdays([]);
    setPickup(null); setDropoff(null); setNote(""); setConsent(false);
    setEffectiveFrom(initial.minEffectiveFrom);
  }

  async function send(body: Record<string, unknown>): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true;
    setError(""); setDone(""); setLimitHit(false);
    try {
      const response = await fetch("/api/mypage/shuttle-regular", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) {
        setError(customerMessage(data?.error, "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요."));
        setLimitHit(data?.code === "DAILY_LIMIT");
        return false;
      }
      return true;
    } catch {
      setError("연결이 끊겼어요. 신청 내역을 확인한 뒤 다시 시도해 주세요.");
      return false;
    } finally {
      sending.current = false;
    }
  }

  function toggleDirection(direction: RegularChangeDirection) {
    const next = directions.includes(direction) ? directions.filter((d) => d !== direction) : [...directions, direction];
    // 하나는 남긴다(둘 다 끄면 바꿀 것이 없다)
    if (next.length > 0) setDirectionChoice(REGULAR_CHANGE_DIRECTIONS.filter((d) => next.includes(d)));
  }

  function submit() {
    if (!child || !kind) return;
    // 아이폰 날짜 고르기는 min·max 를 무시한다 — 벗어나면 보내기 전에 알려 준다(서버도 같은 규칙으로 다시 본다)
    if (effectiveFrom < initial.minEffectiveFrom || effectiveFrom > initial.maxEffectiveFrom) {
      setDone(""); setError(`적용 시작일은 ${initial.minEffectiveFrom}부터 ${initial.maxEffectiveFrom} 사이로 골라 주세요.`);
      return;
    }
    if (needsPlace && ((directions.includes("PICKUP") && !pickup) || (directions.includes("DROPOFF") && !dropoff))) {
      setDone(""); setError("새 위치를 지도에서 골라 주세요.");
      return;
    }
    if (needsPlace && !consent) {
      setDone(""); setError("위치정보 이용에 동의해 주세요.");
      return;
    }
    startTransition(async () => {
      const ok = await send({
        studentId: child.studentId, kind, directions, weekdays: chosenDays.length > 0 ? chosenDays : null,
        effectiveFrom, note,
        pickup: needsPlace && directions.includes("PICKUP") && pickup ? toServer(pickup) : null,
        dropoff: needsPlace && directions.includes("DROPOFF") && dropoff ? toServer(dropoff) : null,
        consentVersion: needsPlace && consent ? initial.consentVersion : null,
      });
      if (!ok) return;
      setSubmittedFor(child.studentId);
      setDone("신청했어요. 학원에서 확인하면 알려 드려요.");
      reset();
      router.refresh();
    });
  }

  function cancel(id: string) {
    startTransition(async () => {
      if (!(await send({ action: "cancel", id }))) return;
      setCanceledIds((ids) => [...ids, id]);
      setSubmittedFor(null);
      setDone("신청을 취소했어요.");
      router.refresh();
    });
  }

  const notice = (
    <>
      {error && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
      {/* 하루 접수 상한 — 문장이 «전화해 주세요»로 끝나므로 그 자리에서 걸 수 있게 */}
      {limitHit && academyTel && <a href={`tel:${academyTel}`} className="academy-button-secondary">학원에 전화하기</a>}
      {done && <p role="status" className="rounded-xl bg-[var(--color-academy-success-soft)] p-3 text-sm font-medium text-[var(--color-academy-success)]">{done}</p>}
    </>
  );

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
      <div>
        <h1 className="academy-heading">셔틀 계속 바꾸기</h1>
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
          학원 승인 뒤 반영돼요. 하루만 바꾸려면 <Link href="/mypage/shuttle" className="font-semibold underline">셔틀 변경</Link>
        </p>
      </div>

      {/* 신청 내역 — 한 줄씩(무엇을 · 언제부터 · 상태). 확인 중인 건은 그 자리에서 취소 */}
      {requests.length > 0 && (
        <section aria-labelledby="regular-change-requests" className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <h2 id="regular-change-requests" className="academy-section-title border-b border-[var(--color-academy-line)] px-4 py-2">신청 내역</h2>
          <ul className="divide-y divide-[var(--color-academy-line)]">
            {requests.map((r) => (
              <li key={r.id} className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1.5">
                <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-ink)]">
                  {initial.children.length > 1 ? `${nameOf(r.studentId)} · ` : ""}{r.summary}
                  {r.status === "PENDING" && <span className="ml-1 text-xs text-[var(--color-academy-muted)]">{koreanMonthDay(r.effectiveFrom)}부터</span>}
                </span>
                <span className={`shrink-0 break-keep text-sm font-medium ${TONE_CLASS[r.statusTone] ?? ""}`}>{r.statusText}</span>
                {r.canCancel && (
                  <InlineConfirm
                    label="신청 취소"
                    // 승인된 건은 적용 시작일 전까지만 취소할 수 있다(서버가 다시 확인) — 취소하면 학원에 알린다
                    question={r.status === "APPROVED" ? "승인된 신청이에요. 취소할까요? 학원에 알려요." : "이 신청을 취소할까요?"}
                    confirmLabel="신청 취소"
                    onConfirm={() => cancel(r.id)}
                    pending={pending}
                    openClassName="basis-full"
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {initial.children.length > 1 && (
        <select
          value={studentId}
          aria-label="아이 고르기"
          onChange={(event) => { setStudentId(event.target.value); reset(); setError(""); setDone(""); }}
          className="academy-input"
        >
          {initial.children.map((c) => <option key={c.studentId} value={c.studentId}>{c.studentName}</option>)}
        </select>
      )}

      {locked || !kind ? (
        <section className="space-y-2 rounded-2xl bg-white p-5 shadow-sm">
          {notice}
          <p className="text-sm text-[var(--color-academy-muted)]">
            {locked ? "확인 중인 신청이 있어요. 바꾸려면 위에서 취소한 뒤 다시 신청해 주세요." : "수업이 있는 요일이 없어 신청할 수 있는 것이 없어요."}
          </p>
          {!locked && <Link href="/mypage/classes" className="academy-button-text">수업 보기</Link>}
        </section>
      ) : (
        <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
          {/* 지금 타는 곳 — 무엇이 바뀌는지 알고 신청하게 */}
          {child.roster.length > 0 && (
            <div>
              <p className="text-xs font-medium text-[var(--color-academy-muted)]">지금 셔틀</p>
              <ul className="mt-1 space-y-0.5 text-sm text-[var(--color-academy-ink)]">
                {[...new Set(child.roster.map((r) => r.weekday))].sort((a, b) => a - b).map((weekday) => (
                  <li key={weekday} className="break-keep">
                    {weekdayLabel(weekday)}
                    {child.roster.filter((r) => r.weekday === weekday).map((r) => (
                      <span key={r.direction} className="ml-2">
                        <span className="text-xs text-[var(--color-academy-muted)]">{r.direction === "PICKUP" ? "등원" : "하원"}</span> {r.stopName ?? "-"}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {kinds.length > 1 && (
            <div className="grid grid-cols-3 gap-2">
              {kinds.map((value) => (
                <button key={value} type="button" aria-pressed={kind === value} onClick={() => { setKindChoice(value); setDirectionChoice(null); setWeekdays([]); }} className="academy-choice break-keep px-1!">
                  {REGULAR_CHANGE_KIND_LABEL[value]}
                </button>
              ))}
            </div>
          )}
          {kinds.length === 1 && <p className="text-sm font-semibold text-[var(--color-academy-ink)]">{REGULAR_CHANGE_KIND_LABEL[kind]}</p>}

          <fieldset>
            <legend className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">어느 쪽인가요?</legend>
            <div className="grid grid-cols-2 gap-2">
              {REGULAR_CHANGE_DIRECTIONS.map((direction) => (
                <button key={direction} type="button" aria-pressed={directions.includes(direction)} onClick={() => toggleDirection(direction)} className="academy-choice break-keep px-1!">
                  {REGULAR_CHANGE_DIRECTION_LABEL[direction]}
                </button>
              ))}
            </div>
          </fieldset>

          {/* 요일이 하나뿐이면 고를 것이 없다 → 칩을 보이지 않는다(모든 요일로 보낸다) */}
          {dayChoices.length > 1 && (
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">어느 요일인가요?</legend>
              <div className="flex flex-wrap gap-2">
                <button type="button" aria-pressed={chosenDays.length === 0} onClick={() => setWeekdays([])} className="academy-choice break-keep">모든 요일</button>
                {dayChoices.map((weekday) => (
                  <button
                    key={weekday}
                    type="button"
                    aria-pressed={chosenDays.includes(weekday)}
                    onClick={() => setWeekdays(chosenDays.includes(weekday) ? chosenDays.filter((w) => w !== weekday) : [...chosenDays, weekday])}
                    className="academy-choice min-w-11"
                  >
                    {weekdayLabel(weekday)}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {dayChoices.length === 0 && (
            <p className="text-sm text-[var(--color-academy-muted)]">고른 쪽으로는 신청할 요일이 없어요. 등원·하원을 다시 골라 주세요.</p>
          )}

          {needsPlace && REGULAR_CHANGE_DIRECTIONS.filter((d) => directions.includes(d)).map((direction) => {
            const value = direction === "PICKUP" ? pickup : dropoff;
            return (
              <div key={direction} className="flex min-h-11 items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-[var(--color-academy-muted)]">새 {direction === "PICKUP" ? "타는 곳" : "내리는 곳"}</p>
                  <p className="break-keep text-sm text-[var(--color-academy-ink)]">{placeTitle(value) || "아직 고르지 않았어요"}</p>
                </div>
                <button type="button" onClick={() => setPicker(direction)} className="academy-button-secondary shrink-0">
                  {value ? "위치 수정" : "지도에서 선택"}
                </button>
              </div>
            );
          })}

          <div>
            <label htmlFor="regular-change-from" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">언제부터인가요?</label>
            <input
              id="regular-change-from"
              type="date"
              value={effectiveFrom}
              min={initial.minEffectiveFrom}
              max={initial.maxEffectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              className="academy-input box-border min-w-0 max-w-full appearance-none"
            />
          </div>

          <div>
            <label htmlFor="regular-change-note" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">전할 말 (선택)</label>
            <textarea
              id="regular-change-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={REGULAR_CHANGE_NOTE_MAX}
              className="academy-input"
            />
          </div>

          {needsPlace && (
            <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--color-academy-ink)]">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="size-5 shrink-0" />
              셔틀 운행을 위한 위치정보 이용에 동의합니다
            </label>
          )}

          {notice}

          <button
            type="button"
            disabled={pending || dayChoices.length === 0}
            onClick={submit}
            className="academy-button-primary w-full"
          >
            {pending ? "접수 중..." : "신청하기"}
          </button>
        </section>
      )}

      {/* 장소명 필수 — 기사님 명단에 이 이름이 나온다(토큰 링크 화면과 같은 지도 부품) */}
      {picker && (
        <LocationPickerModal
          title={picker === "PICKUP" ? "새 타는 곳" : "새 내리는 곳"}
          initialValue={(picker === "PICKUP" ? pickup : dropoff) ?? toMapValue(picker === "PICKUP" ? child.pickup : child.dropoff)}
          requirePlaceName
          onClose={() => setPicker(null)}
          onConfirm={(value) => { if (picker === "PICKUP") setPickup(value); else setDropoff(value); setPicker(null); }}
        />
      )}
    </main>
  );
}
