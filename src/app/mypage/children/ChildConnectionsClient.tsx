"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getStizIdentityBypass } from "@/lib/identity/brand";
import { childLinkRequest, isChildLinkState, type ChildLinkRow, type ChildLinkState } from "@/components/account/child-link-api";
// 요청일 표시는 KST 달력 모듈로만(서버·휴대폰 시간대 차이로 하루 밀리지 않게)
import { kstLabel } from "@/lib/datetime/kst";

const PENDING_KEY = "stiz:child-link-verification:v1";
const REDIRECT_PARAMS = ["identityVerificationId", "identityVerificationTxId", "code", "message", "pgCode", "pgMessage", "transactionType"];
const STATUS_LABELS: Record<ChildLinkRow["status"], string> = { PENDING: "가족 확인 대기", APPROVED: "연결 완료", REJECTED: "연결되지 않음", CANCELED: "요청 취소", EXPIRED: "요청 만료" };
type Decision = { id: string; decision: "APPROVE" | "REJECT" };

function cleanUrl() {
  const url = new URL(window.location.href);
  for (const key of REDIRECT_PARAMS) url.searchParams.delete(key);
  return url.toString();
}

async function loadIdentitySdk() {
  if (window.PortOne) return window.PortOne;
  return new Promise<NonNullable<Window["PortOne"]>>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.portone.io/v2/browser-sdk.js";
    script.async = true;
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error("본인인증 화면 연결이 지연되고 있습니다. 다시 시도해 주세요."));
    }, 15000);
    script.onload = () => {
      window.clearTimeout(timeout);
      if (window.PortOne) resolve(window.PortOne);
      else { script.remove(); reject(new Error("본인인증 화면을 열지 못했습니다. 다시 시도해 주세요.")); }
    };
    script.onerror = () => { window.clearTimeout(timeout); script.remove(); reject(new Error("본인인증 화면을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.")); };
    document.head.appendChild(script);
  });
}

export default function ChildConnectionsClient({ backHref = "/mypage" }: { backHref?: string }) {
  const router = useRouter();
  const [state, setState] = useState<ChildLinkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [form, setForm] = useState({ familyName: "", familyPhone: "", childName: "", childBirthDate: "", relation: "PARENT" });
  const locked = useRef(false);
  const redirected = useRef(false);
  const sequence = useRef(0);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const current = ++sequence.current;
    const data = await childLinkRequest(undefined, signal);
    if (!isChildLinkState(data)) throw new Error("연결 정보를 확인하지 못했습니다. 다시 시도해 주세요.");
    if (!signal?.aborted && current === sequence.current) setState(data);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "연결 정보를 확인하지 못했습니다.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  const confirmVerification = useCallback(async (id: string) => {
    const result = await childLinkRequest({ action: "verify", identityVerificationId: id });
    if (result.verified !== true || !Number.isInteger(result.linkedCount) || result.linkedCount < 0) throw new Error("본인인증 결과를 확인하지 못했습니다. 다시 시도해 주세요.");
    setNotice(result.linkedCount > 0 ? "등록된 수강 정보가 연결되었습니다. 홈에서 확인해 주세요." : "본인인증을 확인했습니다. 등록된 가족이 있다면 아래에서 연결을 요청할 수 있습니다.");
    await reload();
    router.refresh();
  }, [reload, router]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returnedId = params.get("identityVerificationId");
    if (redirected.current || (!returnedId && !params.has("code"))) return;
    redirected.current = true;
    let pending = "";
    try { pending = sessionStorage.getItem(PENDING_KEY) ?? ""; sessionStorage.removeItem(PENDING_KEY); } catch { /* 대조할 수 없는 인증은 승인하지 않는다. */ }
    window.history.replaceState(null, "", cleanUrl());
    if (!returnedId || pending !== returnedId || params.get("code")) {
      setError("본인인증이 취소되었거나 확인되지 않았습니다. 다시 시도해 주세요.");
      return;
    }
    locked.current = true;
    setBusy(true);
    confirmVerification(returnedId).catch((reason) => setError(reason instanceof Error ? reason.message : "본인인증을 확인하지 못했습니다.")).finally(() => { locked.current = false; setBusy(false); });
  }, [confirmVerification]);

  async function run(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : "처리하지 못했습니다. 다시 시도해 주세요."); }
    finally { locked.current = false; setBusy(false); }
  }

  function startVerification() {
    void run(async () => {
      const storeId = process.env.NEXT_PUBLIC_PORTONE_STORE_ID;
      const channelKey = process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY;
      if (!storeId || !channelKey) throw new Error("본인인증을 준비하고 있습니다. 잠시 후 다시 확인해 주세요.");
      const result = await childLinkRequest({ action: "start-verification" });
      if (typeof result.identityVerificationId !== "string") throw new Error("본인인증을 시작하지 못했습니다. 다시 시도해 주세요.");
      const sdk = await loadIdentitySdk();
      // 이 탭에서 시작한 인증 번호만 복귀 후 확인한다. 개인 입력은 저장하지 않는다.
      try { sessionStorage.setItem(PENDING_KEY, result.identityVerificationId); } catch { throw new Error("이 브라우저에서는 인증을 이어갈 수 없습니다. Safari나 Chrome에서 다시 시도해 주세요."); }
      const response = await sdk.requestIdentityVerification({ storeId, channelKey, identityVerificationId: result.identityVerificationId, redirectUrl: cleanUrl(), bypass: getStizIdentityBypass() });
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* 서버도 인증 건과 로그인 계정을 함께 확인한다. */ }
      if (response?.code) throw new Error("본인인증이 취소되었습니다. 다시 시도할 수 있습니다.");
      if (response?.identityVerificationId && response.identityVerificationId !== result.identityVerificationId) throw new Error("본인인증 결과가 일치하지 않습니다. 다시 시도해 주세요.");
      await confirmVerification(result.identityVerificationId);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state?.enabled || !state.verified) return;
    void run(async () => {
      const result = await childLinkRequest({ action: "request", ...form, childBirthDate: form.childBirthDate || undefined });
      if (result.ok !== true) throw new Error("요청 결과를 확인하지 못했습니다. 다시 확인해 주세요.");
      // 실제 요청이 저장된 응답만 완료로 표시한다. 후보 정보는 공개하지 않는다.
      setNotice("가족에게 연결을 요청했습니다. 기존 보호자가 승인하면 자녀 정보를 확인할 수 있습니다.");
      await reload();
    });
  }

  function resolveRequest() {
    if (!decision) return;
    const selected = decision;
    void run(async () => {
      const result = await childLinkRequest({ action: "decide", requestId: selected.id, decision: selected.decision });
      if (result.ok !== true) throw new Error("처리 결과를 확인하지 못했습니다. 다시 확인해 주세요.");
      setDecision(null);
      setNotice(selected.decision === "APPROVE" ? "가족 연결을 승인했습니다." : "연결 요청을 거절했습니다.");
      await reload(); router.refresh();
    });
  }

  const pendingIncoming = state?.incoming.filter((row) => row.status === "PENDING") ?? [];
  return (
    <div className="mx-auto grid max-w-2xl gap-4 py-2">
      <div><Link href={backHref} className="inline-flex min-h-11 items-center text-sm text-[var(--color-academy-muted)]">← {backHref === "/mypage" ? "학부모 홈" : "내 화면으로"}</Link><h1 className="academy-heading">자녀·가족 연결</h1><p className="mt-2 text-sm text-[var(--color-academy-muted)]">본인 명의 휴대폰으로 확인하고, 같은 가족의 수업 정보를 안전하게 연결합니다.</p></div>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button type="button" disabled={busy} onClick={() => void run(async () => { await reload(); setLoading(false); })} className="ml-2 min-h-11 font-bold underline">다시 확인</button></div>}
      {notice && <p role="status" className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3 text-sm">{notice} <Link href="/mypage" className="font-bold underline">홈 보기</Link></p>}
      {loading ? <p role="status" className="text-sm">연결 정보를 확인하고 있습니다.</p> : state?.enabled === false ? <section className="academy-panel p-4"><h2 className="academy-section-title">가족 연결을 준비하고 있습니다</h2><p className="mt-2 text-sm text-[var(--color-academy-muted)]">잠시 후 다시 확인해 주세요. 기존 수업과 신청 내역은 그대로 이용할 수 있습니다.</p></section> : state ? <>
        <section className="academy-panel p-4" aria-labelledby="identity-title"><h2 id="identity-title" className="academy-section-title">1. 내 등록 정보 확인</h2><p className="mt-2 text-sm text-[var(--color-academy-muted)]">등록된 보호자 번호·이름이 일치하면 자녀가 연결됩니다. 성인 수강생은 본인의 이름·생년월일·등록된 휴대폰 번호를 함께 확인합니다.</p><button type="button" disabled={busy} onClick={startVerification} className="academy-button-primary mt-3">{busy ? "확인 중…" : state.verified ? "본인인증 다시 하기" : "본인인증하기"}</button>{state.verified && <p className="mt-2 text-sm font-bold">본인인증 확인됨</p>}</section>
        {pendingIncoming.length > 0 && <section className="academy-panel p-4" aria-labelledby="incoming-title"><h2 id="incoming-title" className="academy-section-title">우리 가족 연결 요청 {pendingIncoming.length}건</h2><p className="mt-2 text-sm text-[var(--color-academy-muted)]">승인하면 요청한 가족도 자녀의 수업·출결·납부 정보를 확인할 수 있습니다. 아는 가족인지 확인해 주세요.</p><ul className="mt-2 divide-y divide-[var(--color-academy-line)]">{pendingIncoming.map((row) => <li key={row.id} className="py-3"><p className="flex flex-wrap items-baseline gap-x-2 text-sm">{/* 자녀 · 요청자 · 연락처 끝 — 이어 붙인 글을 요소로 나눔(문구 그대로) */}<b>{row.childName ?? "연결된 자녀"}</b><span>{row.requesterName ?? "가족"}님의 요청</span><span className="tabular-nums text-[var(--color-academy-muted)]">연락처 끝 {/^\d{4}$/.test(row.requesterPhoneLast4 ?? "") ? row.requesterPhoneLast4 : "확인 필요"}</span></p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} className="academy-button-primary" onClick={() => setDecision({ id: row.id, decision: "APPROVE" })}>승인 검토</button><button type="button" disabled={busy} className="academy-button-secondary" onClick={() => setDecision({ id: row.id, decision: "REJECT" })}>거절 검토</button></div>{decision?.id === row.id && <div className="mt-3 rounded-lg border border-[var(--color-academy-line)] p-3"><p className="mb-2 text-sm font-bold">{row.requesterName ?? "가족"} · 연락처 끝 {/^\d{4}$/.test(row.requesterPhoneLast4 ?? "") ? row.requesterPhoneLast4 : "확인 필요"}</p><p className="text-sm">{decision.decision === "APPROVE" ? "이 가족에게 자녀 정보 열람을 허용할까요?" : "이 연결 요청을 거절할까요?"}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={resolveRequest} className="academy-button-primary">{decision.decision === "APPROVE" ? "가족 연결 승인" : "요청 거절"}</button><button type="button" disabled={busy} onClick={() => setDecision(null)} className="academy-button-secondary">돌아가기</button></div></div>}</li>)}</ul></section>}
        <section className="academy-panel p-4" aria-labelledby="request-title"><h2 id="request-title" className="academy-section-title">2. 이미 연결된 가족에게 요청</h2><p className="mt-2 text-sm text-[var(--color-academy-muted)]">다른 보호자가 먼저 연결했다면 그 가족의 이름·등록된 연락처와 자녀 이름을 입력해 주세요. 기존 보호자가 승인해야 자녀 정보를 볼 수 있습니다.</p>{!state.verified ? <p className="mt-3 text-sm font-bold">먼저 위에서 본인인증을 완료해 주세요.</p> : <form onSubmit={submit} className="mt-4 grid gap-3"><fieldset disabled={busy} className="grid gap-3 disabled:opacity-60"><label className="grid gap-1 text-sm font-bold">기존 보호자·가족 이름<input required maxLength={60} autoComplete="off" value={form.familyName} onChange={(event) => setForm({ ...form, familyName: event.target.value })} className="min-h-11 min-w-0 rounded-md border border-[var(--color-academy-line)] bg-white px-3 text-base" /></label><label className="grid gap-1 text-sm font-bold">그 가족의 등록된 휴대폰 번호<input required type="tel" inputMode="tel" maxLength={20} autoComplete="off" value={form.familyPhone} onChange={(event) => setForm({ ...form, familyPhone: event.target.value })} className="min-h-11 min-w-0 rounded-md border border-[var(--color-academy-line)] bg-white px-3 text-base" /></label><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm font-bold">자녀 이름<input required maxLength={60} autoComplete="off" value={form.childName} onChange={(event) => setForm({ ...form, childName: event.target.value })} className="min-h-11 min-w-0 rounded-md border border-[var(--color-academy-line)] bg-white px-3 text-base" /></label><label className="grid gap-1 text-sm font-bold">자녀 생년월일 (선택)<input type="date" value={form.childBirthDate} onChange={(event) => setForm({ ...form, childBirthDate: event.target.value })} className="min-h-11 min-w-0 max-w-full rounded-md border border-[var(--color-academy-line)] bg-white px-3 text-base" /></label></div><label className="grid gap-1 text-sm font-bold">자녀와의 관계<select value={form.relation} onChange={(event) => setForm({ ...form, relation: event.target.value })} className="min-h-11 min-w-0 rounded-md border border-[var(--color-academy-line)] bg-white px-3 text-base"><option value="PARENT">부모</option><option value="OTHER">가족·보호자</option></select></label><button type="submit" className="academy-button-primary justify-self-start">가족에게 연결 요청</button></fieldset></form>}<p className="mt-3 text-xs text-[var(--color-academy-muted)]">먼저 연결된 보호자가 없는 미성년 자녀는 이 요청으로 연결되지 않습니다. 등록 내용이나 가족관계 확인이 어려우면 학원에 문의해 주세요.</p></section>
        {state.outgoing.length > 0 && <section className="academy-panel p-4" aria-labelledby="outgoing-title"><h2 id="outgoing-title" className="academy-section-title">내 연결 요청</h2><ul className="mt-2 divide-y divide-[var(--color-academy-line)]">{state.outgoing.map((row) => <li key={row.id} className="flex min-h-11 items-center gap-2 py-2 text-sm">{/* 한 줄 행: 상태 칩 · 요청일(오른쪽, 숫자 폭 고정) · 요청 취소 */}<span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${row.status === "APPROVED" ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" : row.status === "PENDING" ? "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>{STATUS_LABELS[row.status] ?? "상태 확인 필요"}</span><span className="ml-auto text-right tabular-nums text-[var(--color-academy-muted)]">{kstLabel(row.createdAt)}</span>{row.status === "PENDING" && <button type="button" disabled={busy} className="academy-button-secondary" onClick={() => void run(async () => { const result = await childLinkRequest({ action: "cancel", requestId: row.id }); if (result.ok !== true) throw new Error("취소 결과를 확인하지 못했습니다."); setNotice("연결 요청을 취소했습니다."); await reload(); })}>요청 취소</button>}</li>)}</ul></section>}
      </> : null}
    </div>
  );
}
