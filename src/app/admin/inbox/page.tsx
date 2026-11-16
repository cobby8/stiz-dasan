import { requireAdmin } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import { isKstYmd } from "@/lib/datetime/kst";
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
import { isRallyzSyncRetired } from "@/lib/operations-sync/rallyzRetirement";
import InboxClient, { type InboxTabData } from "./InboxClient";
// 조회 묶음의 소요 시간 기록(느릴 때만 서버 로그 한 줄 — 2026-11-16 속도 개선). 조회 순서·화면은 그대로
import { reportTiming, startTiming, timed, type TimingSink } from "@/lib/perf/timed";

// 신청함 — 체험·수강·상담·대관·변경·기타 6탭(2026-11-10 원장 결정 k1~k4). 실시간 처리 화면이라 캐시하지 않는다.
export const dynamic = "force-dynamic";

type SearchParams = { tab?: string; sub?: string; done?: string; from?: string; to?: string; kind?: string; open?: string };

const ymd = (value?: string) => (value && isKstYmd(value) ? value : null);

/** «?kind=종류»(옛 오늘 업무 카드·북마크) → 그 종류가 사는 작은 분류(변경 탭이면 결석·보강/셔틀/수강) */
function subOfKind(tab: InboxTab, kind: RequestKind): string | null {
  return TAB_SUBS[tab]?.find((entry) => entry.kinds?.includes(kind))?.key ?? null;
}

export default async function AdminInboxPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const admin = await requireAdmin();
  const params = (await searchParams) ?? {};
  // 주소 값은 그대로 믿지 않는다 — 알려진 탭·분류·종류·날짜 모양만 통과
  const kindParam = isRequestKind(params.kind) ? params.kind : null;
  const explicitTab = isInboxTab(params.tab) ? params.tab : kindParam ? KIND_TAB[kindParam] : null;
  const from = ymd(params.from);
  const end = ymd(params.to);
  const to = from && end && from > end ? null : end;
  const showDone = params.done === "1";

  // «?kind=종류» = 그 종류만 걸러 보기(탭 안 필터). 그 탭의 종류이고, 탭에 종류가 여럿일 때만 의미가 있다
  const scope = (tab: InboxTab) => {
    const kind = kindParam && KIND_TAB[kindParam] === tab && kindsOfTab(tab).length > 1 ? kindParam : null;
    const sub = kind ? subOfKind(tab, kind) : subOf(tab, params.sub)?.key ?? null;
    return { kind, sub };
  };

  // 어느 조회가 느린지 보려는 시계 — 이름과 ms 숫자만 남긴다(개인정보·id 없음)
  const timing = startTiming();
  let counts: Awaited<ReturnType<typeof getInboxCounts>>;
  let tab: InboxTab;
  let data: InboxTabData;
  if (explicitTab) {
    // 탭이 주소에 있으면 개수와 탭 데이터를 동시에 읽는다(서로 기다릴 이유가 없다)
    tab = explicitTab;
    const { kind, sub } = scope(tab);
    [counts, data] = await Promise.all([
      timed("counts", getInboxCounts(), timing),
      timed(`tab:${tab}`, loadTabData(tab, sub, kind, { from, to, showDone, role: admin.appUserRole }, timing), timing),
    ]);
  } else {
    // 탭을 안 골랐으면 처리할 게 있는 첫 탭부터(없으면 체험) — 개수를 먼저 봐야 한다.
    // 대부분 첫 탭(체험)으로 정해지므로, 개수를 세는 동안 체험 탭 자료를 미리 함께 읽어 둔다(2026-11-14 속도 개선).
    // 다른 탭으로 정해지면 미리 읽은 값은 버리고 예전처럼 그 탭을 읽는다. 미리 읽기 실패는 무시한다(결과에 영향 없음).
    const trialScope = scope("TRIAL");
    const [countsRead, trialData] = await Promise.all([
      timed("counts", getInboxCounts(), timing),
      timed("tab:TRIAL(미리)", loadTabData("TRIAL", trialScope.sub, trialScope.kind, { from, to, showDone, role: admin.appUserRole }).catch(() => null), timing),
    ]);
    counts = countsRead;
    tab = INBOX_TABS.find((entry) => (counts?.byTab[entry.tab] ?? 0) > 0)?.tab ?? "TRIAL";
    const { kind, sub } = scope(tab);
    data = tab === "TRIAL" && trialData ? trialData : await timed(`tab:${tab}`, loadTabData(tab, sub, kind, { from, to, showDone, role: admin.appUserRole }, timing), timing);
  }
  // 전체가 500ms 를 넘을 때만 한 줄
  reportTiming("[admin inbox timing]", timing, 500);
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
      canDecideStaffRoles={admin.appUserRole === "ADMIN"}
      // 랠리즈 은퇴(2026-11-14 원장 결정) — 기본 은퇴, STIZ_RALLYZ_SYNC_RETIRED 가 "0" 일 때만 옛 «랠리즈 반영 확인» 화면
      rallyzRetired={isRallyzSyncRetired(process.env)}
      // «?kind=종류&open=id» — 그 줄 상세를 열어 둔다. 값은 목록에 있는 줄과 «같은지»만 비교하므로 길이만 본다
      initialOpenId={kind && typeof params.open === "string" && params.open.length > 0 && params.open.length <= 200 ? params.open : null}
    />
  );
}

/** 탭마다 필요한 것만 읽는다(다른 탭 데이터는 그 탭을 열 때) */
async function loadTabData(
  tab: InboxTab,
  sub: string | null,
  kind: RequestKind | null,
  // role = 보는 사람 역할 — 부원장이면 처리된 입금·현장 수납 금액과 휴원 수강료 처리 건수를 뺀다(2026-11-14 원장 결정)
  { from, to, showDone, role }: { from: string | null; to: string | null; showDone: boolean; role: string },
  // 소요 시간 그릇(있을 때만 안쪽 조회별 시간을 남긴다 — 미리 읽기에는 주지 않는다)
  timing?: TimingSink,
): Promise<InboxTabData> {
  // 그릇이 없으면 약속을 그대로 돌려준다(동작 차이 없음)
  const mark = <T,>(name: string, promise: Promise<T>): Promise<T> => (timing ? timed(name, promise, timing) : promise);
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
    mark("rows:action", getInboxRows({ bucket: "ACTION", kinds, from, to, viewerRole: role })),
    mark("rows:ongoing", getInboxRows({ bucket: "ONGOING", kinds, from, to, viewerRole: role })),
    mark("rows:done", showDone ? getInboxRows({ bucket: "DONE", kinds, from, to, limitPerKind: 100, viewerRole: role }) : Promise.resolve({ rows: [] as InboxRow[], failedKinds: [] as RequestKind[] })),
    // 수강 변경이 보이는 «변경» 탭이면 휴원 수강료 처리 남은 일 건수(표가 없거나 실패하면 0 — 화면은 그대로 열린다)
    // 부원장은 휴원 수강료 처리를 못 하므로 남은 일 건수도 보이지 않는다(0)
    mark("settlementCount", kinds.includes("ENROLLMENT_CHANGE") && canSeeAllMoney(role) ? countOpenPauseSettlements() : Promise.resolve(0)),
  ]);
  const failedKinds = [...new Set([...action.failedKinds, ...ongoing.failedKinds, ...done.failedKinds])];
  return { type: "ROWS", open: [...action.rows, ...ongoing.rows], done: done.rows, failedKinds, consultFailed: false, openSettlementCount };
}
