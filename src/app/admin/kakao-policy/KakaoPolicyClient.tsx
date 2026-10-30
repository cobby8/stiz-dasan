"use client";
import { adminMessageText } from "@/components/admin/adminDisplayText";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveKakaoPolicyDocument, setKakaoPolicyQaEnabled } from "@/app/actions/kakao-policy-qa-admin";

export type PolicyVersionView = { id: string; content: string; editorName: string | null; createdAt: string };
export type PolicyLogView = {
  id: string; question: string; answer: string | null; outcome: string; mode: string;
  linked: boolean; latencyMs: number; callbackOk: boolean | null; createdAt: string;
};

const OUTCOME_LABEL: Record<string, string> = { ANSWERED: "답함", ESCALATE: "원장님 확인", TIMEOUT: "시간 초과", ERROR: "오류" };
const OUTCOME_STYLE: Record<string, string> = {
  ANSWERED: "bg-emerald-50 text-emerald-800",
  ESCALATE: "bg-amber-50 text-amber-900",
  TIMEOUT: "bg-gray-100 text-gray-700",
  ERROR: "bg-red-50 text-red-700",
};
const ENV_BLOCK_LABEL: Record<string, string> = {
  ENV_DISABLED: "긴급 정지 상태라 켜도 동작하지 않습니다.",
  NO_GEMINI_KEY: "답변 도우미(AI) 연결 키가 등록되지 않아 켜도 동작하지 않습니다.",
};
// 날짜·시간 표시는 한국 시간으로(서버는 UTC)
const formatDate = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(new Date(value));

const TEMPLATE = `# 스티즈농구교실 정책 안내 (챗봇용)
※ 이 문서에 적힌 내용만 챗봇이 답합니다. 정해지지 않은 항목은 "확인 중"이라고 적어 두면 챗봇이 원장님 확인으로 넘깁니다.

## 수강료·납부

## 결석·보강

## 환불·휴원·퇴원

## 셔틀

## 수업 시간·장소
`;

export default function KakaoPolicyClient(props: {
  tab: "document" | "logs";
  schemaReady: boolean;
  enabled: boolean;
  settingUpdatedBy: string | null;
  settingUpdatedAt: string | null;
  envBlock: string | null;
  versions: PolicyVersionView[];
  logs: PolicyLogView[];
  fallbackPreview: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = props.versions[0]?.content ?? "";
  const [draft, setDraft] = useState(current);
  const [message, setMessage] = useState<string | null>(null);
  const [viewing, setViewing] = useState<PolicyVersionView | null>(null);
  const dirty = draft.trim() !== current.trim();

  const save = () => startTransition(async () => {
    setMessage(null);
    const result = await saveKakaoPolicyDocument(draft);
    setMessage(result.ok ? "저장했어요. 다음 질문부터 새 문서로 답합니다." : adminMessageText(result.error, "저장하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    router.refresh();
  });
  const toggle = () => {
    // 켜기 전에 한 번 더 묻는다(학부모에게 바로 답이 나가기 시작한다)
    if (!props.enabled && !window.confirm("정책 답변을 켜면 카카오 채널 질문에 챗봇이 바로 답합니다. 켤까요?")) return;
    startTransition(async () => {
      setMessage(null);
      await setKakaoPolicyQaEnabled(!props.enabled);
      router.refresh();
    });
  };

  const tabClass = (active: boolean) => `inline-flex min-h-11 items-center gap-1 rounded-xl px-4 text-sm font-bold ${active ? "bg-brand-navy-900 text-white" : "border bg-white text-gray-600 dark:bg-gray-900 dark:text-gray-300"}`;

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-4">
      <header>
        <p className="text-sm font-bold text-yellow-600">학부모 채널</p>
        <h1 className="mt-1 text-2xl font-black dark:text-white">카카오 정책 답변</h1>
        <p className="mt-2 text-sm text-gray-500">카카오 채널에 들어온 학원 정책 질문(요금·환불·보강·셔틀 등)에 아래 문서 내용만으로 짧게 답합니다. 문서에 없거나 학생 개인 정보가 필요한 질문은 답하지 않고 원장님 확인(카카오 접수함)으로 넘깁니다.</p>
      </header>

      {!props.schemaReady && (
        <section role="alert" className="rounded-2xl bg-amber-50 p-5 text-amber-950">
          <b>상담 안내 설정을 준비 중입니다.</b>
          <p className="mt-2 text-sm">설정 준비가 끝나면 이용할 수 있습니다. 챗봇은 기존 안내를 계속 사용합니다.</p>
        </section>
      )}

      <nav className="flex gap-2" aria-label="정책 답변 탭">
        <Link href="/admin/kakao-policy" className={tabClass(props.tab === "document")}>
          <span className="material-symbols-outlined text-lg">description</span>정책 문서
        </Link>
        <Link href="/admin/kakao-policy?tab=logs" className={tabClass(props.tab === "logs")}>
          <span className="material-symbols-outlined text-lg">history</span>답변 기록
        </Link>
      </nav>

      {message && <p role="status" className="rounded-xl bg-gray-50 p-3 text-sm font-bold dark:bg-gray-800 dark:text-white">{message}</p>}

      {props.schemaReady && props.tab === "document" && (
        <>
          <section className="flex flex-wrap items-center gap-3 rounded-2xl border bg-white p-5 shadow-sm dark:bg-gray-900">
            <span className="material-symbols-outlined text-2xl text-[var(--brand-accent)]">{props.enabled ? "toggle_on" : "toggle_off"}</span>
            <div className="min-w-0 flex-1">
              <p className="font-black dark:text-white">정책 답변 {props.enabled ? "켜짐" : "꺼짐"}</p>
              <p className="text-xs text-gray-500">
                {props.enabled ? "질문으로 보이는 말에 챗봇이 답합니다." : "꺼져 있으면 챗봇은 기존과 똑같이 동작합니다."}
                {props.settingUpdatedBy && props.settingUpdatedAt ? ` · 마지막 변경 ${props.settingUpdatedBy} ${formatDate(props.settingUpdatedAt)}` : ""}
              </p>
              {props.envBlock && <p className="mt-1 text-xs font-bold text-red-700">{ENV_BLOCK_LABEL[props.envBlock] ?? props.envBlock}</p>}
            </div>
            <button type="button" disabled={pending} onClick={toggle} className={`min-h-11 rounded-xl px-4 text-sm font-black disabled:opacity-40 ${props.enabled ? "border text-gray-700 dark:text-gray-200" : "bg-[var(--brand-accent)] text-white"}`}>
              {props.enabled ? "끄기" : "켜기"}
            </button>
          </section>

          <section className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm dark:bg-gray-900">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="flex-1 text-lg font-black dark:text-white">정책 문서</h2>
              {!draft.trim() && <button type="button" onClick={() => setDraft(TEMPLATE)} className="min-h-11 rounded-xl border px-3 text-sm">빈 양식 넣기</button>}
              <button type="button" disabled={pending || !dirty} onClick={save} className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-[var(--brand-accent)] px-4 text-sm font-black text-white disabled:opacity-40">
                <span className="material-symbols-outlined text-lg">save</span>저장
              </button>
            </div>
            <p className="text-xs text-gray-500">마크다운으로 적어 주세요. 정해지지 않은 항목은 「확인 중」이라고 적으면 챗봇이 지어내지 않고 원장님 확인으로 넘깁니다. 저장할 때마다 이전 내용이 이력에 남습니다. ({[...draft].length.toLocaleString()} / 30,000자)</p>
            <textarea
              aria-label="정책 문서"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[28rem] w-full rounded-xl border p-3 font-mono text-sm dark:bg-gray-950 dark:text-white"
              placeholder="아직 정책 문서가 없습니다. 비어 있는 동안에는 이용약관과 공개 FAQ를 대신 사용합니다."
            />
            {!current.trim() && (
              <details className="rounded-xl bg-gray-50 p-3 text-sm dark:bg-gray-800">
                <summary className="cursor-pointer font-bold dark:text-white">지금 대신 쓰는 내용(이용약관 + 공개 FAQ) 보기</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-300">{props.fallbackPreview || "이용약관과 FAQ도 비어 있어, 모든 질문을 원장님 확인으로 넘깁니다."}</pre>
              </details>
            )}
          </section>

          <section className="space-y-2 rounded-2xl border bg-white p-5 shadow-sm dark:bg-gray-900">
            <h2 className="text-lg font-black dark:text-white">저장 이력 (최근 20개)</h2>
            {props.versions.length === 0 ? <p className="text-sm text-gray-500">아직 저장한 적이 없습니다.</p> : (
              <ul className="divide-y">
                {props.versions.map((version, index) => (
                  <li key={version.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <span className="flex-1 dark:text-white">{formatDate(version.createdAt)} · {version.editorName ?? "알 수 없음"} · {[...version.content].length.toLocaleString()}자{index === 0 ? " (현재)" : ""}</span>
                    <button type="button" onClick={() => setViewing(viewing?.id === version.id ? null : version)} className="min-h-9 rounded-lg border px-3 text-xs">{viewing?.id === version.id ? "닫기" : "내용 보기"}</button>
                    {index > 0 && <button type="button" onClick={() => { setDraft(version.content); setMessage("이전 내용을 편집 칸에 불러왔어요. 저장해야 반영됩니다."); }} className="min-h-9 rounded-lg border px-3 text-xs">이 내용으로 되돌리기</button>}
                    {viewing?.id === version.id && <pre className="mt-2 max-h-80 w-full overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-800 dark:text-gray-200">{version.content || "(빈 문서)"}</pre>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {props.schemaReady && props.tab === "logs" && (
        <section className="space-y-3">
          <p className="text-sm text-gray-500">최근 100건 · 질문은 500자까지만, 카카오 사용자는 해시로만 남고 180일 뒤 자동 삭제됩니다. 「원장님 확인」 건 중 연결된 학부모는 카카오 접수함에 접수로 이어집니다.</p>
          {props.logs.length === 0 ? <p className="rounded-2xl border bg-white p-8 text-center text-sm text-gray-500">아직 기록이 없습니다.</p> : (
            <ul className="space-y-3">
              {props.logs.map((log) => (
                <li key={log.id} className="rounded-2xl border bg-white p-4 shadow-sm dark:bg-gray-900">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded-full px-2 py-1 font-black ${OUTCOME_STYLE[log.outcome] ?? "bg-gray-100"}`}>{OUTCOME_LABEL[log.outcome] ?? log.outcome}</span>
                    <span className="font-bold text-gray-500">{log.linked ? "연결된 학부모" : "미연결 사용자"}</span>
                    <span className="text-gray-400">{log.mode === "CALLBACK" ? `콜백${log.callbackOk === false ? "(전송 실패)" : ""}` : "즉시"} · {(log.latencyMs / 1000).toFixed(1)}초</span>
                    <time className="ml-auto text-gray-400">{formatDate(log.createdAt)}</time>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm font-bold dark:text-white">Q. {log.question}</p>
                  {log.answer && <p className="mt-1 whitespace-pre-wrap rounded-xl bg-gray-50 p-3 text-sm dark:bg-gray-800 dark:text-gray-200">A. {log.answer}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
