"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  createParentOperationsRequestLink,
  getActiveParentOperationsRequestLinks,
  revokeParentOperationsRequestLink,
  type ActiveParentOperationsLink,
} from "@/app/actions/parent-operations-request";

export default function ParentRequestLinkPanel({ studentId, studentName }: { studentId: string; studentName: string }) {
  const [activeLinks, setActiveLinks] = useState<ActiveParentOperationsLink[]>([]);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const refreshLinks = useCallback(async () => {
    const links = await getActiveParentOperationsRequestLinks(studentId);
    setActiveLinks(links);
  }, [studentId]);

  useEffect(() => {
    void refreshLinks().catch(() => setMessage("활성 링크를 불러오지 못했습니다."));
  }, [refreshLinks]);

  function createLink() {
    startTransition(async () => {
      try {
        const result = await createParentOperationsRequestLink(studentId);
        const url = `${window.location.origin}/request/${result.token}`;
        setCreatedUrl(url);
        setMessage("7일 동안 사용할 수 있는 요청 링크를 만들었습니다.");
        await refreshLinks();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "요청 링크를 만들지 못했습니다.");
      }
    });
  }

  async function copyLink() {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setMessage("링크를 복사했습니다.");
    } catch {
      setMessage("자동 복사가 막혔습니다. 링크를 직접 선택해 복사해 주세요.");
    }
  }

  function revokeLink(linkId: string) {
    startTransition(async () => {
      try {
        await revokeParentOperationsRequestLink(linkId);
        setActiveLinks((links) => links.filter((link) => link.id !== linkId));
        setMessage("요청 링크를 취소했습니다.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "링크를 취소하지 못했습니다.");
      }
    });
  }

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-extrabold text-gray-900 dark:text-white">학부모 요청 링크</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">학부모가 요청 내용을 확인해 제출하며, 관리자 승인 전에는 반영되지 않습니다.</p>
        </div>
        <button type="button" disabled={isPending} onClick={createLink} className="min-h-9 shrink-0 rounded-lg bg-brand-orange-500 px-3 text-xs font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">
          {isPending ? "처리 중…" : "링크 생성"}
        </button>
      </div>

      {createdUrl && <div className="mt-3 flex gap-2">
        <input readOnly aria-label="학부모 요청 링크" value={createdUrl} className="min-h-10 min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs dark:border-gray-700 dark:bg-gray-900" />
        <button type="button" onClick={() => void copyLink()} className="min-h-10 rounded-lg border border-gray-200 px-3 text-xs font-black dark:border-gray-700">복사</button>
      </div>}

      {activeLinks.length > 0 && <ul className="mt-3 space-y-2 border-t border-gray-100 pt-3 dark:border-gray-700">
        {activeLinks.map((link) => <li key={link.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-gray-500 dark:text-gray-400">{new Date(link.expiresAt).toLocaleString("ko-KR")} 만료</span>
          <button type="button" disabled={isPending} onClick={() => revokeLink(link.id)} className="min-h-8 rounded-lg border border-red-200 px-2 font-black text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-300">취소</button>
        </li>)}
      </ul>}
      <p role="status" className="mt-2 text-xs font-bold text-gray-500 dark:text-gray-400">{message}</p>
    </div>
  );
}
