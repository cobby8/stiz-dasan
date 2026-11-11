"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { readEnrollmentChangesForInbox } from "@/app/actions/enrollment-changes";
import EnrollmentChangesClient from "./EnrollmentChangesClient";

type Detail = Awaited<ReturnType<typeof readEnrollmentChangesForInbox>>;

export default function EnrollmentChangeInboxDetail({ requestIds }: { requestIds: string[] }) {
  const idsKey = JSON.stringify(requestIds);
  const readVersion = useRef(0);
  const [result, setResult] = useState<{ key: string; detail: Detail | null }>();
  const [retrying, retry] = useTransition();

  const refresh = useCallback(async () => {
    const version = ++readVersion.current;
    try {
      const ids: string[] = JSON.parse(idsKey);
      const detail = await readEnrollmentChangesForInbox(ids);
      if (version !== readVersion.current) return;
      const byId = new Map(detail.rows.map((row) => [row.id, row]));
      // 처음 표시한 반 순서로 유지하고, 읽지 못한 반이 있다면 부분 처리 화면을 열지 않는다.
      const rows = ids.map((id) => byId.get(id));
      setResult({ key: idsKey, detail: rows.every((row) => row !== undefined) ? { ...detail, rows } : null });
    } catch {
      if (version === readVersion.current) setResult({ key: idsKey, detail: null });
    }
  }, [idsKey]);

  useEffect(() => {
    void refresh();
    return () => { readVersion.current++; };
  }, [refresh]);

  if (!result || result.key !== idsKey) return <p role="status" className="mt-3 text-sm">수강 변경 상세를 불러오는 중입니다.</p>;
  if (!result.detail) {
    return (
      <div className="mt-3 space-y-2">
        <p role="alert" className="text-sm">수강 변경 상세를 읽지 못했습니다.</p>
        <button type="button" className="academy-button-secondary" disabled={retrying} onClick={() => retry(refresh)}>다시 조회</button>
      </div>
    );
  }
  return <EnrollmentChangesClient key={idsKey} {...result.detail} inline onRefresh={refresh} />;
}
