import { requireAdmin } from "@/lib/auth-guard";
import { getInboxCounts, getInboxRows, type InboxRow } from "@/lib/requests/admin-inbox";
import { listConsultInboxRows } from "@/lib/requests/consult-inbox";
import {
  INBOX_TABS,
  KIND_TAB,
  TAB_SUBS,
  isInboxTab,
  isRequestKind,
  kindsOfTab,
  subOf,
  type InboxTab,
  type RequestKind,
} from "@/lib/requests/catalog";
import { getCachedAdminTrialPayload } from "@/lib/adminReadPayloads";
import { getAdminRentalRequests, getAdminRentalSmsContext } from "@/app/actions/rental";
import { countOpenPauseSettlements } from "@/lib/enrollment/admin-change-request";
import InboxClient, { type InboxTabData } from "./InboxClient";

// 신청함 — 체험·수강·상담·대관·변경·기타 6탭(2026-11-10 원장 결정 k1~k4). 실시간 처리 화면이라 캐시하지 않는다.
export const dynamic = "force-dynamic";

type SearchParams = { tab?: string; sub?: string; done?: string; from?: string; to?: string; kind?: string };

const ymd = (value?: string) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

/** «?kind=종류»(옛 오늘 업무 카드·북마크) → 그 종류가 사는 작은 분류(변경 탭이면 결석·보강/셔틀/수강) */
function subOfKind(tab: InboxTab, kind: RequestKind): string | null {
  return TAB_SUBS[tab]?.find((entry) => entry.kinds?.includes(kind))?.key ?? null;
}

export default async function AdminInboxPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireAdmin();
  const params = (await searchParams) ?? {};
  // 주소 값은 그대로 믿지 않는다 — 알려진 탭·분류·종류·날짜 모양만 통과
  const kindParam = isRequestKind(params.kind) ? params.kind : null;
  const explicitTab = isInboxTab(params.tab) ? params.tab : kindParam ? KIND_TAB[kindParam] : null;
  const from = ymd(params.from);
  const to = ymd(params.to);
  const showDone = params.done === "1";

  // «?kind=종류» = 그 종류만 걸러 보기(탭 안 필터). 그 탭의 종류이고, 탭에 종류가 여럿일 때만 의미가 있다
  const scope = (tab: InboxTab) => {
    const kind = kindParam && KIND_TAB[kindParam] === tab && kindsOfTab(tab).length > 1 ? kindParam : null;
    const sub = kind ? subOfKind(tab, kind) : subOf(tab, params.sub)?.key ?? null;
    return { kind, sub };
  };

  let counts: Awaited<ReturnType<typeof getInboxCounts>>;
  let tab: InboxTab;
  let data: InboxTabData;
  if (explicitTab) {
    // 탭이 주소에 있으면 개수와 탭 데이터를 동시에 읽는다(서로 기다릴 이유가 없다)
    tab = explicitTab;
    const { kind, sub } = scope(tab);
    [counts, data] = await Promise.all([getInboxCounts(), loadTabData(tab, sub, kind, { from, to, showDone })]);
  } else {
    // 탭을 안 골랐으면 처리할 게 있는 첫 탭부터(없으면 체험) — 개수를 먼저 봐야 한다
    counts = await getInboxCounts();
    tab = INBOX_TABS.find((entry) => (counts?.byTab[entry.tab] ?? 0) > 0)?.tab ?? "TRIAL";
    const { kind, sub } = scope(tab);
    data = await loadTabData(tab, sub, kind, { from, to, showDone });
  }
  const { kind, sub } = scope(tab);

  return (
    <InboxClient
      tab={tab}
      sub={sub}
      kind={kind}
      showDone={showDone}
      from={from}
      to={to}
      counts={counts}
      data={data}
    />
  );
}

/** 탭마다 필요한 것만 읽는다(다른 탭 데이터는 그 탭을 열 때) */
async function loadTabData(
  tab: InboxTab,
  sub: string | null,
  kind: RequestKind | null,
  { from, to, showDone }: { from: string | null; to: string | null; showDone: boolean },
): Promise<InboxTabData> {
  if (tab === "TRIAL") {
    // 체험 = /admin/apply «체험 문의» 화면 그대로(같은 첫 50건 캐시)
    const trial = await getCachedAdminTrialPayload({ limit: 50, offset: 0 });
    return { type: "TRIAL", trial };
  }
  if (tab === "ENROLL") {
    // 수강 = /admin/apply «수강신청»·«대기자» 화면 그대로 — 두 화면이 스스로 목록을 읽는다
    return { type: "ENROLL" };
  }
  if (tab === "RENTAL") {
    // 대관 = 기존 대관 화면 그대로(확인 창·문자 미리보기·환불 금액 입력까지)
    const [rows, sms] = await Promise.all([getAdminRentalRequests(), getAdminRentalSmsContext()]);
    return { type: "RENTAL", rows, bankAccount: sms.bankAccount, smsOn: sms.smsOn };
  }
  if (tab === "CONSULT") {
    // 상담 = 신설 — consult-inbox.ts 한 파일이 채운다. 실패해도 다른 탭은 산다
    try {
      // 다른 탭과 같은 순서: 처리 필요 → 진행 중, 완료는 «완료 보기»를 눌렀을 때만
      const [action, ongoing, done] = await Promise.all([
        listConsultInboxRows({ bucket: "ACTION", from, to }),
        listConsultInboxRows({ bucket: "ONGOING", from, to }),
        showDone ? listConsultInboxRows({ bucket: "DONE", from, to, limitPerKind: 100 }) : Promise.resolve([] as InboxRow[]),
      ]);
      return { type: "ROWS", open: [...action, ...ongoing], done, failedKinds: [], consultFailed: false };
    } catch (error) {
      console.error("[admin-inbox] 상담 목록 조회 실패:", error);
      return { type: "ROWS", open: [], done: [], failedKinds: [], consultFailed: true };
    }
  }
  // 변경·기타 = catalog 어댑터 공통 한 줄. 처리 필요 → 진행 중 순서, 완료는 «완료 보기»를 눌렀을 때만 읽는다
  // «?kind=» 로 한 종류만 고른 경우 그 종류만
  const kinds = kind ? [kind] : kindsOfTab(tab, sub);
  const [action, ongoing, done, openSettlementCount] = await Promise.all([
    getInboxRows({ bucket: "ACTION", kinds, from, to }),
    getInboxRows({ bucket: "ONGOING", kinds, from, to }),
    showDone ? getInboxRows({ bucket: "DONE", kinds, from, to, limitPerKind: 100 }) : Promise.resolve({ rows: [] as InboxRow[], failedKinds: [] as RequestKind[] }),
    // 수강 변경이 보이는 «변경» 탭이면 휴원 수강료 처리 남은 일 건수(표가 없거나 실패하면 0 — 화면은 그대로 열린다)
    kinds.includes("ENROLLMENT_CHANGE") ? countOpenPauseSettlements() : Promise.resolve(0),
  ]);
  const failedKinds = [...new Set([...action.failedKinds, ...ongoing.failedKinds, ...done.failedKinds])];
  return { type: "ROWS", open: [...action.rows, ...ongoing.rows], done: done.rows, failedKinds, consultFailed: false, openSettlementCount };
}
