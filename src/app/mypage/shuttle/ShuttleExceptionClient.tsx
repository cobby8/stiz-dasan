"use client";

import { useState, useTransition, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  SHUTTLE_DIRECTIONS,
  PARENT_SHUTTLE_DIRECTION_LABEL,
  SHUTTLE_EXCEPTION_KINDS,
  PARENT_SHUTTLE_EXCEPTION_KIND_LABEL,
  PARENT_SHUTTLE_SKIP_LABEL,
  parentShuttleChangeLabel,
  type ShuttleDirection,
  type ShuttleExceptionKind,
} from "@/lib/shuttle/dayExceptionRules";
import type { ShuttleExceptionOptions } from "@/lib/shuttle/parent-shuttle-exception";
import { matchesShuttleChange, parentDeliveryView, type DeliveryStatusSummary, type ParentDeliveryView } from "@/lib/parent-staff-status";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { groupByUpcomingDate } from "@/components/admin/list/upcomingDateGroups";
import { kstLabel } from "@/lib/datetime/kst";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { resumeNotice } from "@/lib/enrollment/resumeWindow";
import { academyTel } from "@/lib/academyPhoneRules";
// 마감 안내 글자(«1시간»)는 마감 상수에서 나온다 — 상수를 바꾸면 안내도 같이 바뀐다
import { CHANGE_CLOSED_MESSAGE, PARENT_CHANGE_CUTOFF_TEXT } from "@/lib/parent/changeDeadline";

// 예정된 변경의 날짜 묶음 이름(오늘 → 이번 주 → 다음 주 → 이후)
const DATE_GROUP_LABELS = { today: "오늘", thisWeek: "이번 주", nextWeek: "다음 주", later: "이후", past: "지난 변경" };

// 선생님·기사님께 간 알림 결과를 학부모가 읽는 말 한 줄로 바꾼다(2026-11-14 문구 정리).
// 예전엔 알림함·휴대폰 알림 건수를 길게 늘어놓았다 — 학부모가 알고 싶은 것은 «알렸나, 못 알렸나» 하나다.
// 관리자 화면용 deliveryStatusText 는 «푸시 구독 미등록» 같은 개발 용어를 써서 고객 화면에는 쓰지 않는다.

// 판정은 순수 규칙 parentDeliveryView(실행 테스트 있음) 한 곳 — «기사님께 실제로 갔는지»를 본다(2026-11-15 리뷰 반영).
//  기사님 휴대폰 알림 나감 → «기사님께 알렸어요» / 알림함에만 → «기사님 알림함에 남겼어요…» + 전화 버튼
//  선생님만 받음 → «학원에 알렸어요» / 아무에게도 못 감 → «알림을 못 보냈어요…» + 전화 버튼 / 아직 모름 → 줄 없음
function parentDeliveryText(summary: DeliveryStatusSummary | null | undefined): string {
  return parentDeliveryView(summary)?.text ?? "";
}

/** «학원에 전화하기» — 번호(설정값)가 있으면 전화 버튼, 없으면 아무것도 그리지 않는다(문장이 이미 할 일을 말한다) */
function CallAcademy({ phone, className = "academy-button-secondary shrink-0" }: { phone: string | null | undefined; className?: string }) {
  const tel = academyTel(phone); // 걸 수 있는 번호인지는 규칙 한 곳(academyPhoneRules)이 정한다
  if (!tel) return null;
  return <a href={`tel:${tel}`} className={className}>학원에 전화하기</a>;
}

// 저장 결과 한마디 — 취소 / 그 밖(신청·날짜 바꾸기)
function savedText(body: Record<string, unknown>): string {
  return body.action === "cancel" ? "취소했어요" : "저장했어요";
}

// presetStudentId = 수업 탭 반 카드에서 온 아이 — 그 아이를 미리 고른다(내 자녀 목록에 있을 때만)
// academyPhone = 학원 대표 번호(설정값) — 알림이 기사님께 못 갔을 때의 «학원에 전화하기» 버튼용. 없으면 글자만 보인다
// regularChangeHref = 타는 곳·내리는 곳을 «앞으로 계속» 바꾸는 신청 화면(2026-11-14 c5). 없으면(표 미적용) 입구를 보이지 않는다
export default function ShuttleExceptionClient({ initial, presetStudentId = null, academyPhone = null, regularChangeHref = null }: { initial: ShuttleExceptionOptions; presetStudentId?: string | null; academyPhone?: string | null; regularChangeHref?: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [studentId, setStudentId] = useState(
    initial.children.find((c) => c.studentId === presetStudentId)?.studentId ?? initial.children[0]?.studentId ?? "",
  );
  // 복귀 예정뿐인 자녀는 복귀일부터 신청할 수 있다(2026-11-14) — 날짜 칸의 가장 이른 날을 복귀일로 올린다(서버도 다시 막는다)
  const earliestDateOf = (id: string) => {
    const from = initial.children.find((c) => c.studentId === id)?.usableFrom ?? null;
    return from && from > initial.today ? from : initial.today;
  };
  const [serviceDate, setServiceDate] = useState(() => earliestDateOf(studentId));
  const usableFrom = initial.children.find((c) => c.studentId === studentId)?.usableFrom ?? null;
  const minDate = earliestDateOf(studentId);
  // 복귀일이 신청할 수 있는 기간(오늘부터 14일)보다 뒤면 지금은 고를 날짜가 없다
  const noDateYet = minDate > initial.maxDate;
  const [direction, setDirection] = useState<ShuttleDirection>("PICKUP");
  const [kind, setKind] = useState<ShuttleExceptionKind>("SKIP");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // 저장은 됐지만 학부모가 전화해야 할 수 있는 알림 결과(기사님 알림함에만 / 아무에게도 못 감) — 경고 줄 + «학원에 전화하기»
  const [notifyCall, setNotifyCall] = useState<ParentDeliveryView | null>(null);
  const [uncertain, setUncertain] = useState<Record<string, unknown> | null>(null);
  // 하단 시트로 자세히 보고 있는 예정 변경 id (없으면 닫힘)
  const [detailId, setDetailId] = useState<string | null>(null);
  // 날짜 바꾸기(2026-11-15): 날짜 칸이 열린 예정 변경 id · 고른 새 날짜
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveDate, setMoveDate] = useState("");

  // 행 키보드(Enter·Space) = 상세 시트. 행 안의 «취소» 버튼에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  // 저장 결과 한 줄 — «저장했어요. 기사님께 알렸어요». 전화가 필요할 수 있는 결과(call)는 따로 경고 줄 + «학원에 전화하기»로 보인다
  function showSaved(body: Record<string, unknown>, status: DeliveryStatusSummary | null | undefined) {
    const view = parentDeliveryView(status);
    setDone(view && !view.call ? `${savedText(body)}. ${view.text}` : savedText(body));
    setNotifyCall(view?.call ? view : null);
  }

  async function reconcile(body: Record<string, unknown>) {
    try {
      const response = await fetch(`/api/mypage/shuttle-exception${body.action === "cancel" ? `?id=${encodeURIComponent(String(body.id))}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error("LOOKUP_FAILED");
      const data = await response.json();
      const found = body.action === "cancel" ? (data.record?.canceled ? data.record : null) :
        (data.upcoming as ShuttleExceptionOptions["upcoming"]).find((row) => matchesShuttleChange(row, body));
      if (!found) throw new Error("NOT_CONFIRMED");
      showSaved(body, found.notificationStatus);
      setUncertain(null);
      setError("");
      router.refresh();
      return true;
    } catch {
      setError("저장됐는지 확인하지 못했어요. 아래 «다시 확인»을 눌러 주세요");
      setUncertain(body);
      return false;
    }
  }

  async function send(body: Record<string, unknown>) {
    setError("");
    setDone("");
    setNotifyCall(null);
    try {
    const response = await fetch("/api/mypage/shuttle-exception", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status >= 500) return reconcile(body);
      setError(customerMessage(data?.error, "처리하지 못했어요. 잠시 후 다시 시도해 주세요."));
      return false;
    }
    if (!data.ok) return reconcile(body);
    const status: DeliveryStatusSummary | null = data.notificationStatus ?? null;
    showSaved(body, status);
    setUncertain(null);
    return true;
    } catch {
      return reconcile(body);
    }
  }

  function submit() {
    startTransition(async () => {
      const ok = await send({
        studentId,
        serviceDate,
        direction,
        kind,
        location: kind === "LOCATION" ? location : undefined,
        note,
      });
      if (!ok) return;
      setLocation("");
      setNote("");
      router.refresh();
    });
  }

  function cancel(id: string) {
    startTransition(async () => {
      if (!(await send({ action: "cancel", id }))) return;
      router.refresh();
    });
  }

  // 날짜 바꾸기 — 서버가 «옛 신청 취소 + 새 날짜 신청»을 한 번에 한다(내용은 그대로, 날짜만. 실패하면 옛 신청이 남는다).
  // 방향·종류·장소·한마디를 함께 싣는 것은 «저장 결과 다시 확인»(reconcile)이 새 날짜 줄을 찾을 수 있게 하려는 것 — 서버는 id·날짜만 본다.
  function move(item: ShuttleExceptionOptions["upcoming"][number]) {
    if (!moveDate) return;
    startTransition(async () => {
      const ok = await send({
        action: "move",
        id: item.id,
        serviceDate: moveDate,
        studentId: item.studentId,
        direction: item.direction,
        kind: item.kind,
        location: item.location ?? undefined,
        note: item.note ?? "",
      });
      if (!ok) return;
      setMoveId(null);
      router.refresh();
    });
  }

  if (initial.children.length === 0) {
    return (
      <main className="mx-auto max-w-lg px-4 py-6">
        <h1 className="academy-heading">셔틀 변경</h1>
        <p className="mt-3 rounded-2xl bg-white p-5 text-sm text-[var(--color-academy-muted)] shadow-sm">
          지금 다니고 있는 반이 없어요. 학원에 문의해 주세요.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
      <div>
        <h1 className="academy-heading">셔틀 변경</h1>
        {/* 결석과 헷갈리지 않게 선을 긋는다. 안 그러면 결석인데 여기에 적는다. */}
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
          수업에 빠지면 <Link href="/mypage/regular-absence" className="font-semibold underline">결석 알리기</Link>로 알려 주세요
        </p>
        {/* 여기는 하루만 바꾸는 곳 — 이사처럼 계속 바뀌면 따로 신청한다(원장 승인 뒤 반영) */}
        {regularChangeHref && (
          <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
            타는 곳·내리는 곳이 앞으로 계속 바뀌면 <Link href={regularChangeHref} className="font-semibold underline">계속 바꾸기</Link>
          </p>
        )}
        {/* 마감 안내(2026-11-15) — 서버가 같은 규칙으로 막는다 */}
        <p className="mt-1 break-keep text-xs text-[var(--color-academy-muted)]">
          신청·취소·날짜 바꾸기는 수업 시작 {PARENT_CHANGE_CUTOFF_TEXT} 전까지 할 수 있어요. 수업이 없는 날은 전날까지예요.
        </p>
      </div>

      {done && <p role="status" className="rounded-xl bg-[var(--color-academy-success-soft)] p-3 text-sm font-medium text-[var(--color-academy-success)]">{done}</p>}
      {/* 저장은 됐지만 기사님이 휴대폰 알림을 못 받았을 때만 — 학부모가 할 일(학원에 전화)과 그 버튼. 번호가 없으면 글자만 */}
      {done && notifyCall && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-sm font-medium text-[var(--color-academy-warning)]">
          <span className="min-w-0 flex-1 break-keep">{notifyCall.text}</span>
          <CallAcademy phone={academyPhone} />
        </div>
      )}
      {error && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
      {uncertain && <button type="button" disabled={pending} onClick={() => startTransition(async () => { await reconcile(uncertain); })} className="academy-button-secondary">다시 확인</button>}

      {initial.upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="academy-section-title px-1">예정된 변경</h2>
          {/* 날짜 묶음(오늘/이번 주/다음 주/이후). 오늘은 서버가 KST 로 준 initial.today 를 쓴다 */}
          {groupByUpcomingDate(initial.upcoming, (item) => item.serviceDate, initial.today, DATE_GROUP_LABELS).map((group) => (
            <div key={group.key} className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
              <h3 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--color-academy-muted)]">
                <span>{group.label}</span>
                <span className="font-normal tabular-nums">{group.items.length}</span>
              </h3>
              <ul className="divide-y divide-[var(--color-academy-line)]">
                {group.items.map((item) => (
                  <li key={item.id}>
                    {/* 행 탭 = 하단 시트(알림 결과·장소·한마디 전체). 긴 글은 행에서 자르지 않고 시트로 보낸다 */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${kstLabel(item.serviceDate)} ${item.studentName} 셔틀 변경 자세히 보기`}
                      onClick={() => setDetailId(item.id)}
                      onKeyDown={(event) => handleRowKeyDown(event, item.id)}
                      className="flex min-h-14 cursor-pointer flex-wrap items-center gap-2 px-3 py-2 hover:bg-[var(--color-academy-soft)]"
                    >
                      <div className="min-w-0 flex-1">
                        {/* 1줄: 학생 · 방향 칩 · 변경 종류 칩 — «·»로 잇던 글을 요소로 나눔 */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-[var(--color-academy-ink)]">{item.studentName}</span>
                          <span className="rounded-full bg-[var(--color-academy-neutral-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-neutral)]">
                            {PARENT_SHUTTLE_DIRECTION_LABEL[item.direction as ShuttleDirection] ?? "등원·하원 확인 필요"}
                          </span>
                          <span className="rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-info)]">
                            {parentShuttleChangeLabel(item.kind, item.direction) ?? "변경 내용 확인 필요"}
                          </span>
                        </div>
                        {/* 2줄: 바뀐 장소(줄바꿈 허용) — 목록에 있다는 것이 곧 «저장됨»이라 저장 상태 꼬리표는 뺐다 */}
                        {item.location && (
                          <p className="mt-0.5 break-keep text-xs font-medium text-[var(--color-academy-ink)]">{item.location}</p>
                        )}
                      </div>
                      <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)]">{kstLabel(item.serviceDate)}</span>
                      {item.changeOpen === false ? (
                        // 마감 뒤 — 버튼 대신 안내 글(서버도 같은 규칙으로 막는다 · 2026-11-15)
                        <span className="basis-full text-xs text-[var(--color-academy-muted)]">{CHANGE_CLOSED_MESSAGE}</span>
                      ) : (
                        // 동작 버튼 한 묶음(날짜 바꾸기 · 취소) — 행의 flex-wrap 으로 좁은 화면(360px)에서는 다음 줄로 내려간다.
                        // 감싸는 칸을 두지 않는다: «취소» 확인 칸이 펼쳐질 때 행 한 줄을 다 써야 한다(basis-full)
                        <>
                          {/* 날짜 바꾸기 = 아래에 날짜 칸을 연다(글자 버튼). 행 탭(시트 열기)으로 번지지 않게 막는다 */}
                          {moveId !== item.id && (
                            <button
                              type="button"
                              disabled={pending || Boolean(uncertain)}
                              onClick={(event) => {
                                event.stopPropagation();
                                setMoveDate("");
                                setMoveId(item.id);
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                              className="academy-button-text shrink-0"
                            >
                              날짜 바꾸기
                            </button>
                          )}
                          {/* 취소 = 그 자리 확인(C-M1) 후 기존 cancel(item.id) 그대로. 행 탭(시트 열기)으로 번지지 않게 stopPropagation 유지 */}
                          <InlineConfirm
                            label="취소"
                            question="이 셔틀 변경을 취소할까요?"
                            confirmLabel="취소하기"
                            onConfirm={() => cancel(item.id)}
                            disabled={Boolean(uncertain)}
                            pending={pending}
                            stopPropagation
                            openClassName="basis-full"
                          />
                        </>
                      )}
                      {/* 날짜 바꾸기 칸 — 날짜만 새로 고른다(방향·내용은 그대로 옮겨진다) */}
                      {moveId === item.id && item.changeOpen !== false && (
                        <span
                          role="group"
                          aria-label="셔틀 변경 날짜 바꾸기"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          className="flex basis-full cursor-default flex-wrap items-center gap-2"
                        >
                          <input
                            type="date"
                            value={moveDate}
                            min={earliestDateOf(item.studentId)}
                            max={initial.maxDate}
                            onChange={(event) => setMoveDate(event.target.value)}
                            aria-label="바꿀 날짜"
                            className="academy-input min-w-36 flex-1"
                          />
                          <button
                            type="button"
                            disabled={pending || Boolean(uncertain) || !moveDate || moveDate === item.serviceDate}
                            onClick={() => move(item)}
                            className="academy-button-primary"
                          >
                            {pending ? "바꾸는 중…" : "바꾸기"}
                          </button>
                          <button type="button" disabled={pending} onClick={() => setMoveId(null)} className="academy-button-text">
                            닫기
                          </button>
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <fieldset disabled={pending || Boolean(uncertain)} aria-label="셔틀 변경 내용" className="min-w-0 space-y-4 rounded-2xl border-0 bg-white p-5 shadow-sm">
        {initial.children.length > 1 && (
          <select
            value={studentId}
            onChange={(event) => {
              setStudentId(event.target.value);
              // 아이를 바꾸면 그 아이가 고를 수 있는 가장 이른 날보다 앞선 날짜는 올려 준다
              const earliest = earliestDateOf(event.target.value);
              if (serviceDate < earliest) setServiceDate(earliest);
            }}
            className="academy-input"
          >
            {initial.children.map((child) => (
              <option key={child.studentId} value={child.studentId}>{child.studentName}</option>
            ))}
          </select>
        )}

        <div>
          <label htmlFor="service-date" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
            어느 날인가요?
          </label>
          <input
            id="service-date"
            type="date"
            value={serviceDate}
            min={minDate}
            max={initial.maxDate}
            onChange={(event) => setServiceDate(event.target.value)}
            className="academy-input"
          />
          {/* 복귀 예정 안내 한 줄 — 글자만 */}
          {usableFrom && (
            <p className="mt-1 break-keep text-xs text-[var(--color-academy-info)]">
              {resumeNotice(usableFrom)}.{noDateYet ? " 복귀일이 가까워지면 여기서 고를 수 있어요." : ""}
            </p>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">등원인가요, 하원인가요?</p>
          <div className="grid grid-cols-3 gap-1.5">
            {SHUTTLE_DIRECTIONS.map((value) => (
              <button
                key={value}
                type="button"
                // 고른 칩 = academy-choice(연한 바탕+테두리+체크). 꽉 찬 색은 아래 제출 버튼만(C-M2)
                aria-pressed={direction === value}
                onClick={() => setDirection(value)}
                className="academy-choice break-keep px-1!"
              >
                {PARENT_SHUTTLE_DIRECTION_LABEL[value]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">무엇을 바꾸시나요?</p>
          <div className="grid grid-cols-2 gap-1.5">
            {SHUTTLE_EXCEPTION_KINDS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className="academy-choice break-keep"
              >
                {/* 안 타는 날 = 보호자가 직접 — 고른 방향에 맞춰 «직접 데려다줘요 / 직접 데리러 가요(자차)» */}
                {value === "SKIP" ? PARENT_SHUTTLE_SKIP_LABEL[direction] : PARENT_SHUTTLE_EXCEPTION_KIND_LABEL[value]}
              </button>
            ))}
          </div>
        </div>

        {kind === "LOCATION" && (
          <div>
            <label htmlFor="shuttle-location" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
              어디에서 타나요?
            </label>
            {/* 기사님이 읽고 찾아갈 수 있게 적어야 한다. 좌표가 아니라 사람이 읽는 글이다. */}
            <input
              id="shuttle-location"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              maxLength={200}
              placeholder="예: 다산초 정문 앞"
              className="academy-input"
            />
          </div>
        )}

        <div>
          <label htmlFor="shuttle-note" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">
            기사님께 한마디 (선택)
          </label>
          <textarea
            id="shuttle-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            maxLength={300}
            className="academy-input"
          />
        </div>

        <button
          type="button"
          disabled={pending || Boolean(uncertain) || !studentId || noDateYet || (kind === "LOCATION" && !location.trim())}
          onClick={submit}
          className="academy-button-primary w-full"
        >
          {pending ? "저장 중…" : "변경 신청"}
        </button>
      </fieldset>

      {/* 예정 변경 상세 하단 시트(보기 전용) — 취소는 목록 행의 버튼 그대로 */}
      {(() => {
        const item = detailId ? initial.upcoming.find((row) => row.id === detailId) : null;
        if (!item) return null;
        return (
          <ListDetailPanel onClose={() => setDetailId(null)} titleId="shuttle-change-detail-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center gap-2">
              <h3 id="shuttle-change-detail-title" className="academy-section-title min-w-0 break-keep">
                {item.studentName}
              </h3>
              <span className="text-sm tabular-nums text-[var(--color-academy-muted)]">{kstLabel(item.serviceDate)}</span>
              <button
                type="button"
                onClick={() => setDetailId(null)}
                aria-label="닫기"
                className="academy-button-text academy-button-sm ml-auto shrink-0"
              >
                닫기
              </button>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-[var(--color-academy-muted)]">등원·하원</dt>
              <dd className="font-medium">{PARENT_SHUTTLE_DIRECTION_LABEL[item.direction as ShuttleDirection] ?? "등원·하원 확인 필요"}</dd>
              <dt className="text-[var(--color-academy-muted)]">변경</dt>
              <dd className="font-medium">{parentShuttleChangeLabel(item.kind, item.direction) ?? "변경 내용 확인 필요"}</dd>
              {item.location && (
                <>
                  <dt className="text-[var(--color-academy-muted)]">장소</dt>
                  <dd className="break-keep">{item.location}</dd>
                </>
              )}
              {item.note && (
                <>
                  <dt className="text-[var(--color-academy-muted)]">기사님께 한마디</dt>
                  <dd className="whitespace-pre-wrap break-keep">{item.note}</dd>
                </>
              )}
              {/* 알림 결과 한 줄 — 결과를 아직 모르면 줄째 숨긴다 */}
              {parentDeliveryText(item.notificationStatus) && (
                <>
                  <dt className="text-[var(--color-academy-muted)]">알림</dt>
                  <dd className="break-keep">
                    {parentDeliveryText(item.notificationStatus)}
                    {/* 전화가 필요할 수 있는 결과면 그 자리에 전화 버튼 */}
                    {parentDeliveryView(item.notificationStatus)?.call && <CallAcademy phone={academyPhone} className="academy-button-secondary mt-2" />}
                  </dd>
                </>
              )}
            </dl>
          </ListDetailPanel>
        );
      })()}
    </main>
  );
}
