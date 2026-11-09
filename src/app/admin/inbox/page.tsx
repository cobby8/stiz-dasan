import { requireAdmin } from "@/lib/auth-guard";
import { getInboxCounts, getInboxRows } from "@/lib/requests/admin-inbox";
import { INBOX_BUCKETS, isRequestKind, type InboxBucket, type RequestKind } from "@/lib/requests/catalog";
import InboxClient from "./InboxClient";

// 신청함 — 14종류 신청을 한 곳에서(2026-11-10 원장 결정 d1~d4). 실시간 처리 화면이라 캐시하지 않는다.
export const dynamic = "force-dynamic";

type SearchParams = { bucket?: string; kind?: string; from?: string; to?: string };

export default async function AdminInboxPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireAdmin();
  const params = (await searchParams) ?? {};
  // 주소 값은 그대로 믿지 않는다 — 알려진 칸·종류·날짜 모양만 통과
  const bucket: InboxBucket = INBOX_BUCKETS.includes(params.bucket as InboxBucket) ? (params.bucket as InboxBucket) : "ACTION";
  const kinds = (params.kind ?? "").split(",").filter(isRequestKind) as RequestKind[];
  const ymd = (value?: string) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const from = ymd(params.from);
  const to = ymd(params.to);

  const [{ rows, failedKinds }, counts] = await Promise.all([
    getInboxRows({ bucket, kinds, from, to }),
    getInboxCounts(),
  ]);

  return (
    <InboxClient
      bucket={bucket}
      kinds={kinds}
      from={from}
      to={to}
      rows={rows}
      counts={counts}
      failedKinds={failedKinds}
    />
  );
}
