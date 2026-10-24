/**
 * 토스플레이스(POS) ↔ 사이트 결제 대사(對査) — 순수 로직 모듈
 *
 * 왜 따로 떼어냈나:
 *  - 돈을 맞추는 계산은 "네트워크·DB 없이" 그대로 재현할 수 있어야 검증이 된다.
 *  - 그래서 이 파일에는 I/O(파일·네트워크·DB)도, 환경변수도, 비밀키도 전혀 없다.
 *    테스트(tests/tossplace-match.test.mjs)가 이 파일을 "실제로 실행"해서 규칙을 검증한다.
 *
 * 왜 src/ 안에 있고 확장자가 .mjs 인가(2026-09-29):
 *  - CLI(scripts/tossplace-reconcile.mjs)와 웹앱(src/lib/pos/reconcileService.ts)이
 *    **같은 한 벌**을 써야 한다. 사본이 두 벌이 되는 순간 한쪽만 고쳐져 금액이 갈린다.
 *  - 순수 ESM(.mjs)이면 node 가 그대로 실행하고 Next 도 그대로 번들한다.
 *
 * 설계 원칙: **절대 추측하지 않는다.** 애매하면 자동으로 묶지 말고 "확인 필요(HELD)"로 빼서
 *           사람이 보게 한다. 잘못 묶인 1건은 못 찾지만, 보류된 1건은 눈에 띈다.
 *
 * 시간대 규칙(프로젝트 공통): 날짜는 'YYYY-MM-DD' 문자열로만 들고 다닌다.
 *   - KST 변환은 Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }) 로만 한다.
 *   - toISOString().slice(0,10) / getDay() / getHours() 같은 로컬시간 의존 코드는 쓰지 않는다.
 */

// ───────────────────────────── 상수 ─────────────────────────────

/** 대사 결과 분류 코드 (CSV 에 그대로 들어간다) */
export const CATEGORY = {
  MATCHED_BY_ID: "MATCHED_BY_ID",
  MATCHED_BY_MEMO_NAME: "MATCHED_BY_MEMO_NAME",
  MATCHED_BY_MEMO_EXISTING_RECORD: "MATCHED_BY_MEMO_EXISTING_RECORD",
  POS_PAID_SITE_UNPAID: "POS_PAID_SITE_UNPAID",
  POS_ONLY_NO_SITE_INVOICE: "POS_ONLY_NO_SITE_INVOICE",
  HELD_MEMO_INVOICE_CONFLICT: "HELD_MEMO_INVOICE_CONFLICT",
  HELD_MEMO_NAME_AMOUNT_MISMATCH: "HELD_MEMO_NAME_AMOUNT_MISMATCH",
  HELD_MEMO_NAME_AMBIGUOUS: "HELD_MEMO_NAME_AMBIGUOUS",
  HELD_MULTI_STUDENT_ORDER: "HELD_MULTI_STUDENT_ORDER",
  MATCHED_BY_DATE_AMOUNT: "MATCHED_BY_DATE_AMOUNT",
  MATCHED_AS_GROUP: "MATCHED_AS_GROUP",
  HELD_AMOUNT_MISMATCH: "HELD_AMOUNT_MISMATCH",
  HELD_ID_MULTIPLE: "HELD_ID_MULTIPLE",
  HELD_DUPLICATE_SURPLUS: "HELD_DUPLICATE_SURPLUS",
  HELD_NEAR_DATE: "HELD_NEAR_DATE",
  HELD_AMOUNT_DIFF_SAME_DATE: "HELD_AMOUNT_DIFF_SAME_DATE",
  SITE_ONLY: "SITE_ONLY",
  POS_ONLY: "POS_ONLY",
};

/** 사람이 읽는 분류 이름 (원장님이 읽는 리포트용) */
export const CATEGORY_LABEL = {
  MATCHED_BY_ID: "정상 매칭 — 주문번호 일치",
  MATCHED_BY_MEMO_NAME: "정상 매칭 — POS 메모의 원생 이름 + 금액 일치",
  MATCHED_BY_MEMO_EXISTING_RECORD: "사이트에 이미 납부 기록 있음 — 결제수단이 카드로 표시되지 않음",
  POS_PAID_SITE_UNPAID: "POS로 받았는데 사이트는 아직 미납",
  POS_ONLY_NO_SITE_INVOICE: "사이트에 그 달 청구서가 아직 없음 (랠리즈→사이트 미반영)",
  HELD_MEMO_INVOICE_CONFLICT: "확인 필요 — 원생의 그 달 청구서와 금액·건수가 맞지 않음",
  HELD_MEMO_NAME_AMOUNT_MISMATCH: "확인 필요 — 메모 이름은 맞는데 금액이 다름",
  HELD_MEMO_NAME_AMBIGUOUS: "확인 필요 — 메모 이름만으로 원생을 특정할 수 없음",
  HELD_MULTI_STUDENT_ORDER: "확인 필요 — 한 결제에 원생이 여럿(형제·합산 결제)",
  MATCHED_BY_DATE_AMOUNT: "정상 매칭 — 같은 날·같은 금액 1:1",
  MATCHED_AS_GROUP: "정상 매칭 — 같은 날·같은 금액 묶음",
  HELD_AMOUNT_MISMATCH: "확인 필요 — 주문번호는 같은데 금액이 다름",
  HELD_ID_MULTIPLE: "확인 필요 — 한 주문번호에 여러 건이 얽힘",
  HELD_DUPLICATE_SURPLUS: "확인 필요 — 같은 날·같은 금액인데 건수가 안 맞음",
  HELD_NEAR_DATE: "확인 필요 — 금액은 같은데 날짜가 최대 3일 차이",
  HELD_AMOUNT_DIFF_SAME_DATE: "확인 필요 — 같은 날인데 금액이 다름",
  SITE_ONLY: "사이트에만 있음",
  POS_ONLY: "토스POS에만 있음",
};

/** 매칭으로 인정하는 분류 (합계 검증에서 "맞춰진 돈"으로 본다) */
export const MATCHED_CATEGORIES = new Set([
  CATEGORY.MATCHED_BY_ID,
  CATEGORY.MATCHED_BY_MEMO_NAME,
  // 사이트의 기존 납부 기록(카드 표시 없음)과 짝지은 건. 합계 검증에서 양쪽 모두에 들어간다(summarize 참고).
  CATEGORY.MATCHED_BY_MEMO_EXISTING_RECORD,
  CATEGORY.MATCHED_BY_DATE_AMOUNT,
  CATEGORY.MATCHED_AS_GROUP,
]);

/** 근접 후보로 인정하는 날짜 차이(일). 이 범위여도 자동 매칭은 하지 않고 "확인 필요"로만 둔다. */
export const NEAR_DATE_DAYS = 3;

/** 토스플레이스 Open API 에서 이 스크립트가 호출을 허용하는 단 하나의 경로 */
export const TOSS_API_BASE = "https://open-api.tossplace.com/api-public/openapi/v1";
const ORDER_LIST_PATH_RE = /^\/merchants\/\d+\/order\/orders$/;
// 주문 한 건 조회(웹훅이 알려준 주문을 다시 확인할 때). 주문 ID 는 영숫자·-·_ 만 허용한다
// — "/orders/1/cancel" 같은 하위 경로가 끼어들 틈을 원천적으로 막는다.
const ORDER_ONE_PATH_RE = /^\/merchants\/\d+\/order\/orders\/[A-Za-z0-9_-]{1,100}$/;

// ───────────────────────── 날짜 유틸 (순수) ─────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** '2026-09' 형식인지 엄격히 검사한다(월 01~12 까지 확인). */
export function isValidMonth(month) {
  if (typeof month !== "string" || !MONTH_RE.test(month)) return false;
  const m = Number(month.slice(5, 7));
  return m >= 1 && m <= 12;
}

/** 'YYYY-MM-DD' 를 시간대 개입 없이 UTC 기준 숫자로 바꾼다(날짜 계산 전용). */
function ymdToUtcMs(ymd) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

function utcMsToYmd(ms) {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, "0");
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 날짜 문자열에 n일을 더한다. 시간대를 아예 개입시키지 않으므로 서머타임·UTC/KST 사고가 없다. */
export function addDays(ymd, n) {
  if (!YMD_RE.test(ymd)) throw new Error(`날짜 형식이 올바르지 않습니다: ${ymd}`);
  return utcMsToYmd(ymdToUtcMs(ymd) + n * 86_400_000);
}

/** 두 날짜의 차이(일). a - b */
export function dayDiff(a, b) {
  return Math.round((ymdToUtcMs(a) - ymdToUtcMs(b)) / 86_400_000);
}

/** 해당 월의 마지막 날짜 문자열 */
export function lastDayOfMonth(month) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return utcMsToYmd(Date.UTC(y, m, 0));
}

/**
 * 대사 대상 기간을 계산한다.
 *  - 본 구간: 해당 월 1일 ~ 말일 (KST 기준)
 *  - 버퍼 구간: 앞뒤 3일. 월 경계에서 하루 이틀 밀려 기록된 건을 "후보"로만 보여주기 위한 것.
 */
export function monthRange(month, bufferDays = NEAR_DATE_DAYS) {
  if (!isValidMonth(month)) throw new Error(`월 형식이 올바르지 않습니다(YYYY-MM): ${month}`);
  const first = `${month}-01`;
  const last = lastDayOfMonth(month);
  return {
    month,
    first,
    last,
    bufferFrom: addDays(first, -bufferDays),
    bufferTo: addDays(last, bufferDays),
    // 토스 API 조회용(끝은 열린 구간이라 하루 더 뒤 00:00 을 준다)
    fetchFromIso: `${addDays(first, -bufferDays)}T00:00:00+09:00`,
    fetchToIso: `${addDays(last, bufferDays + 1)}T00:00:00+09:00`,
  };
}

/**
 * 청구월 기준으로 불러올 사이트 청구서의 달 목록: 전달·이번 달·다음 달.
 *  - 다음 달: 랠리즈는 다음 달 청구서를 이번 달 셋째 주쯤 발행한다 → 월말 POS 결제는 대개 다음 달분.
 *  - 전달: 월초에 밀린 전달분을 내는 경우("8월" 메모로 9/2 결제).
 * @returns {{ month: string, year: number, monthNo: number }[]}
 */
export function billingMonthsToLoad(month) {
  if (!isValidMonth(month)) throw new Error(`월 형식이 올바르지 않습니다(YYYY-MM): ${month}`);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return [-1, 0, 1].map((delta) => {
    const index = y * 12 + (m - 1) + delta; // 달력 숫자만으로 계산(시간대 무관)
    const year = Math.floor(index / 12);
    const monthNo = (index % 12) + 1;
    return { month: `${year}-${pad2(monthNo)}`, year, monthNo };
  });
}

export function isInMonth(ymd, month) {
  return typeof ymd === "string" && ymd.slice(0, 7) === month;
}

const KST_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Date 객체 → KST 'YYYY-MM-DD HH:MM:SS' (프로젝트 규칙: Intl 로만 변환) */
export function formatKstDateTime(date) {
  const p = Object.fromEntries(KST_PARTS.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;
const NAIVE_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?$/;

/**
 * 토스 응답의 시각 문자열을 KST 로 바꾼다.
 *
 * ⚠️ 토스 문서가 엇갈린다: 한쪽 예시는 '2025-09-01T00:00:00Z'(UTC 표기), 다른 쪽은
 *    '2025-09-01T00:00:00'(시간대 없음)다. 그래서:
 *      - Z 나 +09:00 같은 오프셋이 "있으면" 그대로 해석한다(확실하다).
 *      - 오프셋이 "없으면" naiveTz 옵션(KST 기본 / UTC)으로 해석하고, 리포트에
 *        "미검증 가정"이라고 반드시 표시한다. 실제 결제 1건과 대조하기 전까지는 확정이 아니다.
 *
 * @returns {{kstDate:string,kstDateTime:string,assumed:boolean}|null} 해석 불가면 null
 */
export function toKst(value, naiveTz = "KST") {
  if (value == null || value === "") return null;
  if (naiveTz !== "KST" && naiveTz !== "UTC") {
    throw new Error(`--toss-naive-tz 는 KST 또는 UTC 만 됩니다: ${naiveTz}`);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return null;
    const s = formatKstDateTime(dt);
    return { kstDate: s.slice(0, 10), kstDateTime: s, assumed: false };
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();

  const withOffset = OFFSET_RE.exec(raw);
  if (withOffset) {
    const normalized = raw.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const dt = new Date(normalized);
    if (Number.isNaN(dt.getTime())) return null;
    const s = formatKstDateTime(dt);
    return { kstDate: s.slice(0, 10), kstDateTime: s, assumed: false };
  }

  const naive = NAIVE_RE.exec(raw);
  if (!naive) return null;
  const [, ymd, hh, mm, ss = "00"] = naive;
  if (naiveTz === "KST") {
    // 이미 KST 라고 가정 → 변환 없이 형식만 정리한다.
    return { kstDate: ymd, kstDateTime: `${ymd} ${hh}:${mm}:${ss}`, assumed: true };
  }
  const dt = new Date(`${ymd}T${hh}:${mm}:${ss}Z`);
  if (Number.isNaN(dt.getTime())) return null;
  const s = formatKstDateTime(dt);
  return { kstDate: s.slice(0, 10), kstDateTime: s, assumed: true };
}

// ───────────────────── 토스 주문 → 결제 단위로 펴기 ─────────────────────

/** 카드번호는 API 가 이미 마스킹해서 준다. 혹시라도 안 가려진 값이 오면 여기서 한 번 더 가린다. */
export function maskCardNo(cardNo) {
  if (typeof cardNo !== "string" || cardNo === "") return "";
  if (/[*x·]/i.test(cardNo)) return cardNo; // 이미 마스킹됨
  const digits = cardNo.replace(/\D/g, "");
  if (digits.length < 8) return "****";
  return `${digits.slice(0, 4)}****${digits.slice(-4)}`;
}

function joinLineItems(order) {
  const items = Array.isArray(order?.lineItems) ? order.lineItems : [];
  return items
    .map((li) => {
      const title = li?.item?.title ?? li?.title ?? li?.name ?? "";
      const qty = Number(li?.quantity ?? 1);
      if (!title) return "";
      return qty > 1 ? `${title} x${qty}` : String(title);
    })
    .filter(Boolean)
    .join(", ");
}

// ───────────────── POS 메모에서 원생 이름 읽기 ─────────────────
//
// 현장에서 POS 에 "토4 이시윤 9월" 처럼 반 · 이름 · 청구월을 적어 둔다.
// 이름은 날짜·금액보다 훨씬 강한 단서라서 매칭 2순위로 쓴다.
// 다만 "루나루희"(자매를 한 칸에 적음)처럼 규칙 밖 표기가 섞이므로,
// **해석되지 않으면 조용히 버리지 말고 리포트에 그대로 드러낸다.**

const CLASS_PREFIX_RE = /^(?:[월화수목금토일]요일\s*\d{1,2}교시|[월화수목금토일]\s*\d{1,2})\s*/;
const MONTH_SUFFIX_RE = /\s*(?:\d{1,2}\s*월|\d{4}-\d{2})\s*$/;
const WEEK_TOKEN_RE = /\s*\d{1,2}\s*주\s*/g;
const NAME_RE = /^[가-힣]{2,5}$/;

/** 메모 조각 하나에서 이름 후보만 남긴다(반 토큰·청구월·주차 토큰 제거). */
export function cleanMemoFragment(fragment) {
  let text = String(fragment ?? "").trim();
  if (!text) return "";
  // "박상원 9월 2주" 처럼 토큰이 겹쳐 붙는 경우가 있어 더 지워지지 않을 때까지 반복한다.
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    text = text.replace(CLASS_PREFIX_RE, "");
    text = text.replace(WEEK_TOKEN_RE, " ").trim();
    text = text.replace(MONTH_SUFFIX_RE, "").trim();
    if (text === before) break;
  }
  return text.replace(/\s+/g, " ").trim();
}

// ───────────────── 청구월(어느 달 수강료인가) 판정 ─────────────────
//
// 랠리즈가 청구서의 원본이다. 다음 달 청구서는 이번 달 셋째 주쯤 발행되므로,
// 9월 말 POS 결제는 대개 **10월분**이다. 그래서 결제일의 달로만 비교하면 틀린다.
// 현장에서 메모에 "10월" 을 적어 두므로, 메모의 달을 결제일보다 우선한다.

const MEMO_YEAR_MONTH_RE = /(?<!\d)(\d{4})\s*[-.]\s*(\d{1,2})(?!\d)/g;
// "월요일" 의 '월' 은 달이 아니다 → 뒤에 '요' 가 오면 제외한다.
const MEMO_MONTH_RE = /(?<!\d)(\d{1,2})\s*월(?!요)/g;

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * 메모 원문에서 달 표기를 모두 뽑는다. 예: "토4 이시윤 10월" → [{year:null, month:10}]
 * "2026-10" 처럼 연도가 붙어 있으면 연도까지 돌려준다.
 */
export function extractMemoMonths(memoText) {
  const found = [];
  const seen = new Set();
  const push = (year, month) => {
    if (!(month >= 1 && month <= 12)) return;
    const key = `${year ?? ""}-${month}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ year, month });
  };
  // 여러 메모는 " / " 로 이어 붙어 있다(parseMemoNames 참고).
  for (const fragment of String(memoText ?? "").split(/[\n\r,]+|\s+\/\s+/)) {
    // "월4"(월요일 4교시) 같은 반 표기를 먼저 떼야 달로 오인하지 않는다.
    let text = fragment.trim().replace(CLASS_PREFIX_RE, "");
    for (const m of text.matchAll(MEMO_YEAR_MONTH_RE)) push(Number(m[1]), Number(m[2]));
    text = text.replace(MEMO_YEAR_MONTH_RE, " ");
    for (const m of text.matchAll(MEMO_MONTH_RE)) push(null, Number(m[1]));
  }
  return found;
}

/**
 * 토스 결제 1건의 청구월("YYYY-MM")을 정한다.
 *  1) 메모에 달 표기가 있으면 그 달. 연도는 결제일(KST)의 연도를 쓰되,
 *     메모 달이 결제 달보다 6개월 넘게 **앞서면** 다음 해로 본다(12월에 "1월" → 다음 해 1월),
 *     6개월 넘게 **뒤면** 전년도로 본다(1월에 "12월" → 작년 12월, 밀린 납부).
 *  2) 메모에 달이 없으면 결제일(KST)의 달.
 * 메모에 달이 여럿이면(예: "9월, 10월") months 에 모두 담는다 — 한 달로 고르지 않는다.
 * @returns {{ month: string, months: string[], source: "MEMO"|"PAID_DATE"|"UNKNOWN" }}
 */
export function resolveTargetBillingMonth(memoText, kstDate) {
  const valid = typeof kstDate === "string" && YMD_RE.test(kstDate);
  const payYear = valid ? Number(kstDate.slice(0, 4)) : NaN;
  const payMonth = valid ? Number(kstDate.slice(5, 7)) : NaN;
  const tokens = extractMemoMonths(memoText);

  const months = [];
  for (const token of tokens) {
    let year = token.year;
    if (year == null) {
      if (!valid) continue;
      year = payYear;
      if (payMonth - token.month > 6) year += 1;
      else if (token.month - payMonth > 6) year -= 1;
    }
    const ym = `${year}-${pad2(token.month)}`;
    if (!months.includes(ym)) months.push(ym);
  }
  if (months.length > 0) return { month: months[0], months, source: "MEMO" };
  if (!valid) return { month: "", months: [], source: "UNKNOWN" };
  const ym = kstDate.slice(0, 7);
  return { month: ym, months: [ym], source: "PAID_DATE" };
}

/**
 * 주문(order)의 메모를 모아 이름 후보를 뽑는다.
 * 줄바꿈과 쉼표로 자른다 — 한 줄에 여러 원생이 적히는 경우가 실제로 있다("정우준 9월\n정지유 9월").
 */
export function parseMemoNames(order) {
  const rawMemos = [];
  const pushMemo = (memo) => {
    const text = String(memo ?? "").trim();
    if (text) rawMemos.push(text);
  };
  pushMemo(order?.memo);
  for (const li of Array.isArray(order?.lineItems) ? order.lineItems : []) {
    pushMemo(li?.memo);
    pushMemo(li?.item?.memo);
  }

  const names = [];
  const unparsed = [];
  for (const memo of rawMemos) {
    for (const fragment of memo.split(/[\n\r,]+/)) {
      const cleaned = cleanMemoFragment(fragment);
      if (!cleaned) continue;
      if (NAME_RE.test(cleaned)) {
        if (!names.includes(cleaned)) names.push(cleaned);
      } else if (!unparsed.includes(cleaned)) {
        unparsed.push(cleaned);
      }
    }
  }
  // 같은 메모가 주문·품목에 중복으로 달리는 경우가 있어 원문도 중복을 없앤다.
  return { memoRaw: [...new Set(rawMemos)].join(" / "), names, unparsed };
}

const normName = (value) => String(value ?? "").replace(/\s+/g, "").toLowerCase();
/** 동명이인 표기(이현준A/이현준B)의 꼬리 글자를 떼서 비교용 이름을 만든다. */
const baseName = (value) => normName(value).replace(/[a-z]$/, "");

/**
 * 메모 이름 → 원생. 성을 뺀 표기("대건" ← 김대건)도 받아 주되,
 * **후보가 둘 이상이면 절대 고르지 않는다**(실제로 "시우"는 강시우·김시우·양시우 셋이 걸린다).
 */
export function resolveStudentName(name, students) {
  const target = normName(name);
  if (!target) return { status: "EMPTY", students: [] };
  const list = Array.isArray(students) ? students : [];

  const exact = list.filter((s) => normName(s.name) === target || baseName(s.name) === target);
  if (exact.length === 1) return { status: "EXACT", students: exact };
  if (exact.length > 1) return { status: "AMBIGUOUS", matchKind: "EXACT", students: exact };

  const suffix = list.filter((s) => baseName(s.name).endsWith(target) && baseName(s.name) !== target);
  if (suffix.length === 1) return { status: "SUFFIX", students: suffix };
  if (suffix.length > 1) return { status: "AMBIGUOUS", matchKind: "SUFFIX", students: suffix };

  return { status: "NONE", students: [] };
}

/** 토스 결제 행에 메모 해석 결과(원생·상태)를 붙인다. */
export function attachStudentResolution(tossRows, students) {
  return tossRows.map((row) => {
    const resolutions = row.memoNames.map((name) => ({ name, ...resolveStudentName(name, students) }));
    const resolved = resolutions.filter((r) => r.status === "EXACT" || r.status === "SUFFIX");
    const unknownNames = resolutions.filter((r) => r.status === "NONE").map((r) => r.name);
    const ambiguous = resolutions.filter((r) => r.status === "AMBIGUOUS");
    return {
      ...row,
      memoResolutions: resolutions,
      resolvedStudents: resolved.map((r) => r.students[0]),
      unknownMemoNames: unknownNames,
      ambiguousMemoNames: ambiguous,
    };
  });
}

function toIntAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function billingFields(target) {
  return { targetBillingMonth: target.month, billingMonths: target.months, billingMonthSource: target.source };
}

/**
 * 토스 주문 배열(Order[]) → 결제 1건 = 1행으로 펴낸다.
 * 취소 건은 승인 시각(approvedAt)을 날짜 기준으로 삼는다(사이트의 paidDate 와 같은 성격).
 */
export function flattenTossOrders(orders, options = {}) {
  const naiveTz = options.naiveTz ?? "KST";
  const rows = [];
  const invalid = [];
  const seen = new Set();
  const list = Array.isArray(orders) ? orders : [];

  for (const order of list) {
    const orderId = String(order?.id ?? order?.orderId ?? "");
    const items = joinLineItems(order);
    const memo = parseMemoNames(order);
    const payments = Array.isArray(order?.payments) ? order.payments : [];
    if (payments.length === 0) {
      invalid.push({ orderId, reason: "주문에 결제 정보가 없습니다", orderState: order?.orderState ?? "" });
      continue;
    }
    payments.forEach((payment, index) => {
      const paymentId = String(payment?.id ?? `${orderId}#${index}`);
      if (seen.has(paymentId)) return; // 페이지 중복 수집 방지
      seen.add(paymentId);

      const state = String(payment?.state ?? "").toUpperCase();
      const baseTime = payment?.approvedAt ?? payment?.createdAt ?? order?.completedAt ?? order?.createdAt;
      const kst = toKst(baseTime, naiveTz);
      const cancelled = toKst(payment?.cancelledAt ?? order?.cancelledAt, naiveTz);
      const amount = toIntAmount(payment?.amount);

      if (!kst || amount == null) {
        invalid.push({
          orderId,
          paymentId,
          reason: !kst ? "결제 시각을 해석할 수 없습니다" : "결제 금액을 해석할 수 없습니다",
          orderState: order?.orderState ?? "",
        });
        return;
      }

      rows.push({
        side: "TOSS",
        orderId,
        orderNumber: String(order?.orderNumber ?? ""),
        orderState: String(order?.orderState ?? ""),
        source: String(order?.source ?? ""),
        paymentId,
        state,
        sourceType: String(payment?.sourceType ?? "").toUpperCase(),
        paymentMethod: String(payment?.paymentMethod ?? ""),
        van: String(payment?.van ?? ""),
        approvedNo: String(payment?.approvedNo ?? payment?.cardDetails?.approvalNo ?? ""),
        amount,
        kstDate: kst.kstDate,
        kstDateTime: kst.kstDateTime,
        timeAssumed: kst.assumed,
        cancelledKstDateTime: cancelled ? cancelled.kstDateTime : "",
        cardMasked: maskCardNo(payment?.cardDetails?.cardNo ?? ""),
        cardType: String(payment?.cardDetails?.cardType ?? ""),
        installmentMonth: payment?.cardDetails?.installmentMonth ?? null,
        items,
        memoRaw: memo.memoRaw,
        // 어느 달 수강료인지(메모 우선 → 없으면 결제일의 달)
        ...billingFields(resolveTargetBillingMonth(memo.memoRaw, kst.kstDate)),
        memoNames: memo.names,
        memoUnparsed: memo.unparsed,
        // 아래 세 필드는 원생 명단을 받은 뒤 attachStudentResolution 이 채운다.
        memoResolutions: [],
        resolvedStudents: [],
        unknownMemoNames: [],
      });
    });
  }
  return { rows, invalid };
}

// ───────────────────── 사이트(DB) 행 정규화 ─────────────────────

/** 지점 분류: 2호점(대사 대상) / 미상(대사에 포함하되 표시) / 타지점(제외) */
export function classifyBranch(branch) {
  if (branch == null) return "UNKNOWN";
  const value = String(branch).trim();
  if (value === "") return "UNKNOWN";
  return value.startsWith("2호점") ? "IN" : "OTHER";
}

/**
 * DB 행(문자열로 받은 KST 시각 포함)을 대사용 구조로 정규화한다.
 * kstDateTimeRaw 예: '2026-09-03 14:22:11.000' (SQL 에서 KST 로 변환해 넘겨준 값)
 */
export function normalizeSiteRow(row) {
  const raw = String(row.kstDateTimeRaw ?? row.kst_date_time ?? "").trim();
  const kstDateTime = raw.slice(0, 19);
  const flags = [];
  // 09:00:00 KST = UTC 00:00 → 시각 없이 "날짜만" 저장된 것으로 본다.
  if (/^09:00:00(\.0+)?$/.test(raw.slice(11))) flags.push("시각 없음(날짜만 기록)");
  // 결제일이 비어 있는 기록(수기 동기화분)은 시각 판정을 하지 않는다 — 빈 문자열이 0시로 읽혀 "새벽"으로 오탐된다.
  const hour = kstDateTime.length >= 13 ? Number(kstDateTime.slice(11, 13)) : NaN;
  if (Number.isFinite(hour) && hour >= 0 && hour <= 6) flags.push("새벽 시각 — 시간대 입력 오류 의심");
  if (row.mergedIntoStudentId) flags.push("병합된 원생");

  const branchClass = classifyBranch(row.branch);
  if (branchClass === "UNKNOWN") flags.push("지점 미상");

  return {
    side: "SITE",
    id: String(row.id ?? ""),
    studentId: String(row.studentId ?? row.student_id ?? ""),
    amount: toIntAmount(row.amount) ?? 0,
    status: String(row.status ?? "").toUpperCase(),
    method: row.method == null ? "" : String(row.method),
    paidProvider: row.paidProvider == null ? "" : String(row.paidProvider),
    providerOrderId: row.providerOrderId == null ? "" : String(row.providerOrderId).trim(),
    providerPaymentKey: row.providerPaymentKey == null ? "" : String(row.providerPaymentKey).trim(),
    year: row.year ?? null,
    month: row.month ?? null,
    // 청구월(year/month 칸). 결제일과 다를 수 있다 — 9월 말에 낸 10월분 등.
    billingMonth: billingMonthOf(row.year, row.month),
    type: row.type == null ? "" : String(row.type),
    description: row.description == null ? "" : String(row.description),
    studentName: String(row.studentName ?? row.student_name ?? ""),
    branch: row.branch == null ? "" : String(row.branch),
    branchClass,
    kstDate: kstDateTime.slice(0, 10),
    kstDateTime,
    flags,
  };
}

function billingMonthOf(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || y < 2000 || m < 1 || m > 12) return "";
  return `${y}-${pad2(m)}`;
}

const CANCEL_STATUSES = new Set(["CANCELED", "CANCELLED", "REFUNDED"]);
/** 사이트 청구서 중 "아직 돈을 못 받은" 상태 */
const UNPAID_STATUSES = new Set(["PENDING", "OVERDUE", "UNPAID"]);

/** 사이트 행을 월/상태/지점 기준으로 나눈다. */
export function partitionSiteRows(rows, month) {
  const paid = [];
  const canceled = [];
  const otherStatus = [];
  const paidBuffer = [];
  const canceledBuffer = [];
  const otherBranch = [];

  for (const row of rows) {
    if (row.branchClass === "OTHER") {
      if (isInMonth(row.kstDate, month)) otherBranch.push(row);
      continue;
    }
    const inMonth = isInMonth(row.kstDate, month);
    if (row.status === "PAID") (inMonth ? paid : paidBuffer).push(row);
    else if (CANCEL_STATUSES.has(row.status)) (inMonth ? canceled : canceledBuffer).push(row);
    else if (inMonth) otherStatus.push(row);
  }
  return { paid, canceled, otherStatus, paidBuffer, canceledBuffer, otherBranch };
}

/** 토스 결제 행을 카드/상태/월 기준으로 나눈다. 카드(CARD) 가 아닌 건 대사에서 제외하고 참고 목록으로만 둔다. */
export function partitionTossPayments(rows, month) {
  const approved = [];
  const cancelled = [];
  const approvedBuffer = [];
  const cancelledBuffer = [];
  const nonCard = [];
  const otherState = [];

  for (const row of rows) {
    const inMonth = isInMonth(row.kstDate, month);
    if (row.sourceType !== "CARD") {
      if (inMonth) nonCard.push(row);
      continue;
    }
    if (row.state === "APPROVED") (inMonth ? approved : approvedBuffer).push(row);
    else if (row.state === "CANCELLED") (inMonth ? cancelled : cancelledBuffer).push(row);
    else if (inMonth) otherState.push(row);
  }
  return { approved, cancelled, approvedBuffer, cancelledBuffer, nonCard, otherState };
}

// ───────────────────────────── 매칭 ─────────────────────────────

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortSite = (a, b) => cmp(a.kstDateTime, b.kstDateTime) || cmp(a.id, b.id);
const sortToss = (a, b) => cmp(a.kstDateTime, b.kstDateTime) || cmp(a.paymentId, b.paymentId);

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (key === "" || key == null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export const rowKey = (row) => (row.side === "SITE" ? row.id : row.paymentId);
export const sumAmount = (rows) => rows.reduce((acc, r) => acc + r.amount, 0);

function candidateOf(row, base, kind, outOfMonth = false) {
  return { kind, outOfMonth, row, dayDiff: dayDiff(row.kstDate, base.kstDate) };
}

/**
 * 핵심 매칭. 한쪽 행은 정확히 하나의 분류를 받는다.
 * 순서: ①주문번호 ②같은 날·같은 금액 ③근접 후보(보류) ④한쪽에만 존재
 */
export function matchSets(siteRows, tossRows, options = {}) {
  const siteBuffer = options.siteBuffer ?? [];
  const tossBuffer = options.tossBuffer ?? [];
  const sites = [...siteRows].sort(sortSite);
  const tosses = [...tossRows].sort(sortToss);

  const siteResult = new Map();
  const tossResult = new Map();
  const groups = [];

  const assign = (map, row, category, reason, candidates = [], groupId = "") => {
    map.set(rowKey(row), { row, category, reason, candidates, groupId });
  };

  // ① 주문번호(providerOrderId ↔ 토스 orderId) 매칭
  const tossByOrder = groupBy(tosses, (t) => t.orderId);
  const sitesByOrder = groupBy(sites, (s) => s.providerOrderId);
  for (const [orderId, siteGroup] of sitesByOrder) {
    const tossGroup = tossByOrder.get(orderId);
    if (!tossGroup || tossGroup.length === 0) continue;
    const groupId = `ID:${orderId}`;
    if (siteGroup.length === 1 && tossGroup.length === 1) {
      const s = siteGroup[0];
      const t = tossGroup[0];
      if (s.amount === t.amount) {
        assign(siteResult, s, CATEGORY.MATCHED_BY_ID, "주문번호와 금액이 모두 일치", [], groupId);
        assign(tossResult, t, CATEGORY.MATCHED_BY_ID, "주문번호와 금액이 모두 일치", [], groupId);
        groups.push({ id: groupId, kind: "ID", kstDate: t.kstDate, amount: t.amount, siteRows: [s], tossRows: [t] });
      } else {
        const reason = `주문번호는 같은데 금액이 다릅니다 (사이트 ${formatWon(s.amount)} / 토스 ${formatWon(t.amount)})`;
        assign(siteResult, s, CATEGORY.HELD_AMOUNT_MISMATCH, reason, [candidateOf(t, s, "ID")], groupId);
        assign(tossResult, t, CATEGORY.HELD_AMOUNT_MISMATCH, reason, [candidateOf(s, t, "ID")], groupId);
      }
      continue;
    }
    // 합계가 같으면 "한 번 결제를 사이트에서 나눠 기록한 것"일 가능성이 높다.
    // 그래도 자동 매칭은 하지 않는다(추측 금지). 대신 판단에 필요한 사실만 문장에 담아 준다.
    const siteSum = sumAmount(siteGroup);
    const tossSum = sumAmount(tossGroup);
    const reason =
      `같은 주문번호에 사이트 ${siteGroup.length}건(합 ${formatWon(siteSum)})·` +
      `토스 ${tossGroup.length}건(합 ${formatWon(tossSum)})이 얽혀 있어 자동으로 짝지을 수 없습니다 — ` +
      (siteSum === tossSum
        ? "합계는 일치합니다(한 건을 나눠 기록한 것으로 보이나, 확인은 사람이 해야 합니다)"
        : `합계가 ${formatWon(tossSum - siteSum)} 차이 납니다`);
    for (const s of siteGroup) {
      assign(siteResult, s, CATEGORY.HELD_ID_MULTIPLE, reason, tossGroup.map((t) => candidateOf(t, s, "ID")), groupId);
    }
    for (const t of tossGroup) {
      assign(tossResult, t, CATEGORY.HELD_ID_MULTIPLE, reason, siteGroup.map((s) => candidateOf(s, t, "ID")), groupId);
    }
  }

  // ② POS 메모의 원생 이름 — 날짜·금액보다 강한 단서라 여기서 먼저 본다.
  //    단, 이름이 한 명으로 특정되고 금액까지 맞을 때만 자동 매칭한다.
  const sameStudent = (siteRow, student) =>
    (siteRow.studentId && student.id && siteRow.studentId === student.id) ||
    baseName(siteRow.studentName) === baseName(student.name);

  // 메모로 청구월을 알면 **다른 달 기록과는 짝짓지 않는다**
  // (예: 9/28 "10월" 결제가 9월분 기록을 가져가면 9월분 결제가 엉뚱하게 '토스에만 있음'이 된다).
  // 청구월을 결제일로 추정한 경우엔 확실하지 않으므로 종전처럼 막지 않는다.
  const billingCompatible = (siteRow, t) =>
    t.billingMonthSource !== "MEMO" || !siteRow.billingMonth || (t.billingMonths ?? []).includes(siteRow.billingMonth);

  // ②-b 사이트 청구서(청구월 기준) 대조 — invoiceRows 를 받았을 때만 켠다.
  //   사이트 "Payment" 는 랠리즈를 뒤따라 채워지는 사본이라, 카드로 표시되지 않았거나(결제수단 NULL·MANUAL)
  //   결제일이 비어 있는 납부 기록이 있다. 카드 범위 조회에 안 잡혀 "토스에만 있음"으로 잘못 나오던 것을
  //   원생 + 청구월로 다시 찾아본다.
  const invoiceMode = Array.isArray(options.invoiceRows);
  const invoiceRows = invoiceMode ? options.invoiceRows : [];
  const invoiceMonths = new Set(options.invoiceMonths ?? []);
  // 카드 범위(sites·버퍼)에 이미 들어 있는 기록은 합계에 이미 잡혀 있으므로 여기서 다시 끌어오지 않는다.
  const universeIds = new Set([...sites, ...siteBuffer].map((row) => row.id));
  const usedInvoiceIds = new Set();
  const extraSiteEntries = [];

  const matchByInvoice = (t, student) => {
    const months = t.billingMonths ?? [];
    // 불러오지 않은 달이면 "청구서가 없다"고 단정할 수 없다 → 종전 흐름(③·④)에 맡긴다.
    if (months.length === 0 || !months.every((m) => invoiceMonths.has(m))) return false;

    const inMonths = (r) => r.billingMonth && months.includes(r.billingMonth) && !CANCEL_STATUSES.has(r.status);
    const byId = new Map();
    for (const r of [...invoiceRows, ...sites, ...siteBuffer]) {
      if (!byId.has(r.id) && sameStudent(r, student) && inMonths(r)) byId.set(r.id, r);
    }
    const monthRows = [...byId.values()].sort(sortSite);
    const monthLabel = months.join("·");

    if (monthRows.length === 0) {
      assign(
        tossResult,
        t,
        CATEGORY.POS_ONLY_NO_SITE_INVOICE,
        `원생 ${student.name} 의 ${monthLabel} 청구서가 사이트에 아직 없습니다(랠리즈에서 옮겨지지 않은 것으로 보입니다)`,
      );
      return true;
    }

    const claimable = monthRows.filter((r) => !universeIds.has(r.id) && !usedInvoiceIds.has(r.id));
    const paidSame = claimable.filter((r) => r.status === "PAID" && r.amount === t.amount);
    const unpaidSame = claimable.filter((r) => UNPAID_STATUSES.has(r.status) && r.amount === t.amount);

    if (paidSame.length === 1 && unpaidSame.length === 0) {
      const s = paidSame[0];
      usedInvoiceIds.add(s.id);
      const groupId = `EXISTING:${t.paymentId}`;
      const reason =
        `POS 메모 "${t.memoRaw}" → 원생 ${student.name} · ${s.billingMonth} 청구서가 사이트에 이미 납부로 기록돼 있습니다 ` +
        `(결제수단 ${s.method || "(없음)"}, 결제일 ${s.kstDateTime || "(없음)"}, 결제ID ${s.id.slice(0, 8)})`;
      // 사이트 쪽 결과에도 넣는다 — 합계 검증이 양쪽에서 같은 돈을 "맞춰진 돈"으로 봐야 균형이 맞는다(summarize 참고).
      extraSiteEntries.push({ row: s, category: CATEGORY.MATCHED_BY_MEMO_EXISTING_RECORD, reason, candidates: [], groupId });
      assign(tossResult, t, CATEGORY.MATCHED_BY_MEMO_EXISTING_RECORD, reason, [], groupId);
      groups.push({ id: groupId, kind: "EXISTING", kstDate: t.kstDate, amount: t.amount, siteRows: [s], tossRows: [t] });
      return true;
    }

    if (paidSame.length === 0 && unpaidSame.length === 1) {
      const s = unpaidSame[0];
      usedInvoiceIds.add(s.id); // 같은 청구서를 두 번째 POS 결제가 또 가져가지 못하게
      const reason =
        `POS로 ${formatWon(t.amount)} 받았는데 사이트의 ${student.name} ${s.billingMonth} 청구서는 아직 ${s.status} 입니다 ` +
        `(결제ID ${s.id.slice(0, 8)})`;
      assign(tossResult, t, CATEGORY.POS_PAID_SITE_UNPAID, reason, [candidateOf(s, t, "INVOICE")]);
      return true;
    }

    // 여기부터는 사람이 봐야 한다(추측 금지).
    let why;
    if (paidSame.length + unpaidSame.length > 1) {
      why = `같은 금액(${formatWon(t.amount)})의 청구서가 ${paidSame.length + unpaidSame.length}건이라 어느 건인지 고를 수 없습니다`;
    } else if (claimable.length === 0) {
      why = "그 달 청구서가 이미 다른 결제와 짝지어져 있습니다(중복 결제 여부 확인)";
    } else {
      why = `금액이 다릅니다(토스 ${formatWon(t.amount)} / 사이트 ${claimable
        .map((r) => `${r.status} ${formatWon(r.amount)}`)
        .join(", ")})`;
    }
    assign(
      tossResult,
      t,
      CATEGORY.HELD_MEMO_INVOICE_CONFLICT,
      `메모 이름 → 원생 ${student.name} · ${monthLabel} 청구서와 맞지 않습니다 — ${why}`,
      monthRows.map((r) => candidateOf(r, t, "INVOICE")),
    );
    return true;
  };

  for (const t of tosses) {
    if (tossResult.has(t.paymentId)) continue;
    const names = t.memoNames ?? [];
    const resolutions = t.memoResolutions ?? [];
    if (names.length === 0) continue;

    // 한 결제에 원생이 여럿(형제 합산 결제) → 절대 자동 매칭하지 않는다.
    if (names.length > 1) {
      const related = sites.filter(
        (s) => !siteResult.has(s.id) && resolutions.some((r) => r.students.some((st) => sameStudent(s, st))),
      );
      const reason =
        `한 결제(${formatWon(t.amount)})에 원생 이름이 ${names.length}명 적혀 있습니다: ${names.join(", ")} — ` +
        `형제 합산 결제로 보이며, 어느 원생에게 얼마인지는 사람이 나눠야 합니다`;
      assign(tossResult, t, CATEGORY.HELD_MULTI_STUDENT_ORDER, reason, related.map((s) => candidateOf(s, t, "MEMO_NAME")));
      for (const s of related) {
        assign(siteResult, s, CATEGORY.HELD_MULTI_STUDENT_ORDER, reason, [candidateOf(t, s, "MEMO_NAME")]);
      }
      continue;
    }

    const resolution = resolutions[0];
    if (!resolution) continue;
    if (resolution.status === "AMBIGUOUS") {
      // 동명이인은 "수강 중인 반"을 함께 보여줘야 원장님이 바로 고를 수 있다(퇴원생이 섞여 후보가 늘어난다).
      const who = resolution.students
        .map((s) => `${s.name}${s.classes ? `(${s.classes})` : "(수강 중인 반 없음 — 퇴원 가능성)"}`)
        .join(", ");
      const reason =
        `메모 이름 "${resolution.name}" 에 해당하는 원생이 ${resolution.students.length}명입니다 ` +
        `(${who}) — 누구인지 특정할 수 없습니다`;
      const related = sites.filter((s) => !siteResult.has(s.id) && resolution.students.some((st) => sameStudent(s, st)));
      assign(tossResult, t, CATEGORY.HELD_MEMO_NAME_AMBIGUOUS, reason, related.map((s) => candidateOf(s, t, "MEMO_NAME")));
      continue;
    }
    if (resolution.status !== "EXACT" && resolution.status !== "SUFFIX") continue; // 명단에 없는 이름은 뒤 단계로

    const student = resolution.students[0];
    const candidates = sites.filter((s) => !siteResult.has(s.id) && sameStudent(s, student) && billingCompatible(s, t));
    if (candidates.length === 0) {
      // 카드 범위에 이 원생의 (그 달) 기록이 없다 → 청구월 기준으로 사이트 청구서를 다시 찾아본다.
      // 청구서 자료를 안 받았으면 종전처럼 뒤 단계(③·④)로 넘어가 "토스POS에만 있음" 등이 된다.
      if (invoiceMode) matchByInvoice(t, student);
      continue;
    }

    let exactAmount = candidates.filter((s) => s.amount === t.amount);
    if (exactAmount.length > 1) {
      // 같은 금액이 여러 달치 있으면(9월분·10월분) 메모의 청구월로 좁혀 본다.
      const sameMonth = exactAmount.filter((s) => s.billingMonth && (t.billingMonths ?? []).includes(s.billingMonth));
      if (sameMonth.length === 1) exactAmount = sameMonth;
    }
    if (exactAmount.length === 1) {
      const s = exactAmount[0];
      const groupId = `MEMO:${t.paymentId}`;
      const reason = `POS 메모 "${t.memoRaw}" → 원생 ${student.name} · 금액도 일치`;
      assign(siteResult, s, CATEGORY.MATCHED_BY_MEMO_NAME, reason, [], groupId);
      assign(tossResult, t, CATEGORY.MATCHED_BY_MEMO_NAME, reason, [], groupId);
      groups.push({ id: groupId, kind: "MEMO", kstDate: t.kstDate, amount: t.amount, siteRows: [s], tossRows: [t] });
      continue;
    }
    if (exactAmount.length > 1) {
      const reason =
        `메모 이름은 ${student.name} 로 특정됐지만 같은 금액(${formatWon(t.amount)})의 사이트 기록이 ` +
        `${exactAmount.length}건이라 어느 건인지 고를 수 없습니다`;
      assign(tossResult, t, CATEGORY.HELD_MEMO_NAME_AMBIGUOUS, reason, exactAmount.map((s) => candidateOf(s, t, "MEMO_NAME")));
      continue;
    }

    const siteSum = sumAmount(candidates);
    const reason =
      `메모 이름 → 원생 ${student.name} 은(는) 맞는데 금액이 다릅니다 ` +
      `(토스 ${formatWon(t.amount)} / 사이트 ${candidates.length}건 합 ${formatWon(siteSum)}` +
      `${candidates.length > 1 ? `: ${candidates.map((s) => formatWon(s.amount)).join(" + ")}` : ""}) — ` +
      (siteSum === t.amount ? "합계는 일치합니다(나눠 기록한 것으로 보이나 확인이 필요합니다)" : `차이 ${formatWon(t.amount - siteSum)}`);
    assign(
      tossResult,
      t,
      CATEGORY.HELD_MEMO_NAME_AMOUNT_MISMATCH,
      reason,
      candidates.map((s) => candidateOf(s, t, "MEMO_NAME")),
    );
    for (const s of candidates) {
      assign(siteResult, s, CATEGORY.HELD_MEMO_NAME_AMOUNT_MISMATCH, reason, [candidateOf(t, s, "MEMO_NAME")]);
    }
  }

  // ③ 같은 날 + 같은 금액
  const freeSites = sites.filter((s) => !siteResult.has(s.id));
  const freeTosses = tosses.filter((t) => !tossResult.has(t.paymentId));
  const keyOf = (r) => `${r.kstDate}|${r.amount}`;
  const siteByKey = groupBy(freeSites, keyOf);
  const tossByKey = groupBy(freeTosses, keyOf);
  for (const [key, siteGroup] of siteByKey) {
    const tossGroup = tossByKey.get(key);
    if (!tossGroup || tossGroup.length === 0) continue;
    const [kstDate, amountStr] = key.split("|");
    const amount = Number(amountStr);
    const groupId = `DA:${key}`;
    if (siteGroup.length === 1 && tossGroup.length === 1) {
      assign(siteResult, siteGroup[0], CATEGORY.MATCHED_BY_DATE_AMOUNT, "같은 날·같은 금액 1건씩", [], groupId);
      assign(tossResult, tossGroup[0], CATEGORY.MATCHED_BY_DATE_AMOUNT, "같은 날·같은 금액 1건씩", [], groupId);
      groups.push({ id: groupId, kind: "DATE_AMOUNT", kstDate, amount, siteRows: [siteGroup[0]], tossRows: [tossGroup[0]] });
      continue;
    }
    const paired = Math.min(siteGroup.length, tossGroup.length);
    const matchedSites = siteGroup.slice(0, paired);
    const matchedTosses = tossGroup.slice(0, paired);
    const groupReason =
      `${kstDate} ${formatWon(amount)} — 사이트 ${siteGroup.length}건 · 토스 ${tossGroup.length}건을 ` +
      `${paired}건까지 묶음으로 처리(개별 짝은 특정할 수 없어 묶음으로만 봅니다)`;
    for (const s of matchedSites) assign(siteResult, s, CATEGORY.MATCHED_AS_GROUP, groupReason, [], groupId);
    for (const t of matchedTosses) assign(tossResult, t, CATEGORY.MATCHED_AS_GROUP, groupReason, [], groupId);
    groups.push({
      id: groupId,
      kind: "GROUP",
      kstDate,
      amount,
      siteRows: matchedSites,
      tossRows: matchedTosses,
      siteTotalCount: siteGroup.length,
      tossTotalCount: tossGroup.length,
    });

    const surplusReason =
      `${kstDate} ${formatWon(amount)} — 사이트 ${siteGroup.length}건 · 토스 ${tossGroup.length}건으로 개수가 맞지 않습니다. ` +
      `어느 건이 남는 건인지는 데이터만으로 특정할 수 없습니다(표시된 건은 시간순 정렬상 뒤쪽일 뿐입니다)`;
    for (const s of siteGroup.slice(paired)) {
      assign(siteResult, s, CATEGORY.HELD_DUPLICATE_SURPLUS, surplusReason, tossGroup.map((t) => candidateOf(t, s, "SAME_DATE_AMOUNT")), groupId);
    }
    for (const t of tossGroup.slice(paired)) {
      assign(tossResult, t, CATEGORY.HELD_DUPLICATE_SURPLUS, surplusReason, siteGroup.map((s) => candidateOf(s, t, "SAME_DATE_AMOUNT")), groupId);
    }
  }

  // ④ 남은 건의 근접 후보 — 자동 매칭하지 않고 "확인 필요"로만 둔다
  const isMatched = (entry) => entry && MATCHED_CATEGORIES.has(entry.category);
  const tossPool = [
    ...tosses.filter((t) => !isMatched(tossResult.get(t.paymentId))).map((row) => ({ row, outOfMonth: false })),
    ...tossBuffer.map((row) => ({ row, outOfMonth: true })),
  ];
  const sitePool = [
    ...sites.filter((s) => !isMatched(siteResult.get(s.id))).map((row) => ({ row, outOfMonth: false })),
    ...siteBuffer.map((row) => ({ row, outOfMonth: true })),
  ];

  const resolveLeftover = (row, pool, result) => {
    const near = [];
    const sameDate = [];
    for (const { row: other, outOfMonth } of pool) {
      if (rowKey(other) === rowKey(row) && other.side === row.side) continue;
      const diff = dayDiff(other.kstDate, row.kstDate);
      if (other.amount === row.amount && Math.abs(diff) <= NEAR_DATE_DAYS) {
        near.push(candidateOf(other, row, "NEAR_DATE", outOfMonth));
      } else if (diff === 0) {
        sameDate.push(candidateOf(other, row, "SAME_DATE_DIFF_AMOUNT", outOfMonth));
      }
    }
    if (near.length > 0) {
      assign(
        result,
        row,
        CATEGORY.HELD_NEAR_DATE,
        `금액이 같은 건이 ±${NEAR_DATE_DAYS}일 안에 ${near.length}건 있습니다 — 같은 건인지 사람이 확인해야 합니다(자동 매칭하지 않음)`,
        [...near, ...sameDate],
      );
      return;
    }
    if (sameDate.length > 0) {
      assign(
        result,
        row,
        CATEGORY.HELD_AMOUNT_DIFF_SAME_DATE,
        `같은 날짜에 금액이 다른 건이 ${sameDate.length}건 있습니다 — 금액 수정/부분결제 여부를 확인하세요`,
        sameDate,
      );
      return;
    }
    assign(result, row, row.side === "SITE" ? CATEGORY.SITE_ONLY : CATEGORY.POS_ONLY, "짝이 될 만한 건을 찾지 못했습니다");
  };

  for (const s of sites) if (!siteResult.has(s.id)) resolveLeftover(s, tossPool, siteResult);
  for (const t of tosses) if (!tossResult.has(t.paymentId)) resolveLeftover(t, sitePool, tossResult);

  return {
    // 기존 납부 기록으로 짝지은 사이트 행(카드 범위 밖)을 뒤에 붙인다 — 합계 검증 균형용.
    siteResults: [...sites.map((s) => siteResult.get(s.id)), ...extraSiteEntries],
    tossResults: tosses.map((t) => tossResult.get(t.paymentId)),
    groups,
  };
}

/** 분류별 건수·금액 집계와 "차이 설명"까지 계산한다. */
export function summarize(matchResult) {
  const byCategory = new Map();
  const touch = (category) => {
    if (!byCategory.has(category)) {
      byCategory.set(category, { category, siteCount: 0, siteSum: 0, tossCount: 0, tossSum: 0 });
    }
    return byCategory.get(category);
  };
  for (const entry of matchResult.siteResults) {
    const bucket = touch(entry.category);
    bucket.siteCount += 1;
    bucket.siteSum += entry.row.amount;
  }
  for (const entry of matchResult.tossResults) {
    const bucket = touch(entry.category);
    bucket.tossCount += 1;
    bucket.tossSum += entry.row.amount;
  }

  const siteTotal = matchResult.siteResults.reduce((a, e) => a + e.row.amount, 0);
  const tossTotal = matchResult.tossResults.reduce((a, e) => a + e.row.amount, 0);
  const unmatchedSiteSum = matchResult.siteResults
    .filter((e) => !MATCHED_CATEGORIES.has(e.category))
    .reduce((a, e) => a + e.row.amount, 0);
  const unmatchedTossSum = matchResult.tossResults
    .filter((e) => !MATCHED_CATEGORIES.has(e.category))
    .reduce((a, e) => a + e.row.amount, 0);
  // 합계 검증: 전체 차이(토스 − 사이트) == 짝 못 찾은 토스 − 짝 못 찾은 사이트.
  // "기존 납부 기록" 매칭은 카드 범위 밖의 사이트 행을 끌어온 것이라, 토스 쪽만 '맞춰짐'으로 빼면
  // 사이트 합계에는 그 돈이 없어 식이 어긋난다. 그래서 matchSets 가 그 사이트 행을 siteResults 에도
  // 같은 분류로 넣는다 → 양쪽 합계에 같은 금액이 더해지고 양쪽 '못 찾은 돈'에서는 똑같이 빠져 균형이 맞는다.
  // 미납 청구서(POS_PAID_SITE_UNPAID)·청구서 없음(POS_ONLY_NO_SITE_INVOICE)은 사이트가 돈을 기록하지
  // 않은 것이므로 사이트 쪽에 넣지 않는다(토스 쪽 '못 찾은 돈'으로만 남는다).
  const difference = tossTotal - siteTotal;
  const itemLevelDifference = unmatchedTossSum - unmatchedSiteSum;

  return {
    categories: [...byCategory.values()],
    siteCount: matchResult.siteResults.length,
    tossCount: matchResult.tossResults.length,
    siteTotal,
    tossTotal,
    unmatchedSiteSum,
    unmatchedTossSum,
    difference,
    itemLevelDifference,
    // 전체 차이가 개별 항목 차이의 합과 같아야 한다. 다르면 집계 로직에 구멍이 있다는 뜻.
    reconciles: difference === itemLevelDifference,
  };
}

/** 사이트 데이터 품질 경고(시각 없음·새벽 시각·지점 미상·병합 원생) */
export function collectQualityWarnings(siteRows) {
  const pick = (flag) => siteRows.filter((r) => r.flags.includes(flag));
  return {
    dateOnly: pick("시각 없음(날짜만 기록)"),
    dawn: pick("새벽 시각 — 시간대 입력 오류 의심"),
    unknownBranch: pick("지점 미상"),
    merged: pick("병합된 원생"),
  };
}

/**
 * 대사 전체를 한 번에 계산한다(CLI·테스트 공용 진입점).
 *
 * invoiceRows(선택): 청구월(year/month) 기준으로 불러온 사이트 월 수강료 기록(결제수단·결제일 무관, NULL 포함).
 * invoiceMonths(선택): invoiceRows 를 불러온 청구월 목록. 이 밖의 달은 "청구서 없음"이라고 단정하지 않는다.
 * 둘 다 없으면 종전 동작(카드 범위만 대조)과 같다.
 */
export function buildReconciliation({ month, siteRows, tossPayments, students = [], invoiceRows, invoiceMonths }) {
  if (!isValidMonth(month)) throw new Error(`월 형식이 올바르지 않습니다(YYYY-MM): ${month}`);
  const range = monthRange(month);
  const site = partitionSiteRows(siteRows, month);
  // POS 메모의 이름을 원생 명단에 대조해 붙인다(명단이 없으면 이름 매칭은 그냥 건너뛴다).
  const toss = partitionTossPayments(attachStudentResolution(tossPayments, students), month);

  const main = matchSets(site.paid, toss.approved, {
    siteBuffer: site.paidBuffer,
    tossBuffer: toss.approvedBuffer,
    // 다른 지점 원생의 청구서는 이름이 같아도 쓰지 않는다.
    invoiceRows: Array.isArray(invoiceRows) ? invoiceRows.filter((r) => r.branchClass !== "OTHER") : undefined,
    invoiceMonths: invoiceMonths ?? [],
  });
  const cancel = matchSets(site.canceled, toss.cancelled, {
    siteBuffer: site.canceledBuffer,
    tossBuffer: toss.cancelledBuffer,
  });

  return {
    month,
    range,
    site,
    toss,
    main,
    mainSummary: summarize(main),
    cancel,
    cancelSummary: summarize(cancel),
    quality: {
      ...collectQualityWarnings([...site.paid, ...site.canceled, ...site.otherStatus]),
      // 메모로 찾은 기존 납부 기록 — 결제수단/결제일을 나중에 바로잡아야 할 목록
      existingRecords: main.siteResults
        .filter((e) => e.category === CATEGORY.MATCHED_BY_MEMO_EXISTING_RECORD)
        .map((e) => e.row),
    },
    // 메모에 적힌 이름이 원생 명단에 아예 없는 건 — 리포트에서 크게 드러낸다.
    unknownMemoNamePayments: [...toss.approved, ...toss.cancelled].filter(
      (row) => (row.unknownMemoNames ?? []).length > 0 || (row.memoUnparsed ?? []).length > 0,
    ),
    // 메모 자체가 없어 이름 단서가 없는 건
    noMemoPayments: toss.approved.filter((row) => !row.memoRaw),
  };
}

// ───────────────────── 리포트 렌더링 (순수) ─────────────────────

export function formatWon(amount) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? "-" : "";
  return `${sign}₩${Math.abs(n).toLocaleString("en-US")}`;
}

function siteLabel(row) {
  const parts = [row.kstDateTime || "(결제일 없음)", formatWon(row.amount), row.studentName || "이름 없음"];
  if (row.billingMonth) parts.push(`청구월: ${row.billingMonth}`);
  if (row.status && row.status !== "PAID") parts.push(`상태 ${row.status}`);
  if (row.description) parts.push(row.description);
  const provider = row.paidProvider || `${row.method || "-"}(제공자 없음)`;
  parts.push(provider);
  parts.push(`결제ID ${row.id.slice(0, 8)}`);
  return parts.join(" · ");
}

/** 토스 결제 1건의 "원생" 표시 — 메모에서 특정되면 이름, 아니면 미확인 */
export function resolvedStudentLabel(row) {
  const resolved = row.resolvedStudents ?? [];
  if (resolved.length === 1) return resolved[0].name;
  if (resolved.length > 1) return resolved.map((s) => s.name).join(" + ");
  if ((row.ambiguousMemoNames ?? []).length > 0) {
    return `미확인(동명 후보 ${row.ambiguousMemoNames.map((a) => a.students.map((s) => s.name).join("/")).join(", ")})`;
  }
  if ((row.unknownMemoNames ?? []).length > 0) return `미확인(명단에 없음: ${row.unknownMemoNames.join(", ")})`;
  return "미확인";
}

function tossLabel(row) {
  const parts = [row.kstDateTime, formatWon(row.amount)];
  parts.push(`원생 ${resolvedStudentLabel(row)}`);
  // 어느 달 수강료로 보고 대조했는지 — 메모에서 읽었는지, 결제일로 추정했는지까지 밝힌다.
  if (row.targetBillingMonth) {
    const how = row.billingMonthSource === "MEMO" ? "메모" : "결제일 기준";
    const months = (row.billingMonths ?? []).length > 1 ? row.billingMonths.join("·") : row.targetBillingMonth;
    parts.push(`청구월: ${months}(${how})`);
  }
  if (row.memoRaw) parts.push(`메모 "${row.memoRaw.replace(/\n/g, " / ")}"`);
  if (row.items) parts.push(row.items);
  if (row.approvedNo) parts.push(`승인번호 ${row.approvedNo}`);
  if (row.cardMasked) parts.push(row.cardMasked);
  parts.push(`주문 ${row.orderId}`);
  return parts.join(" · ");
}

export function describeRow(row) {
  return row.side === "SITE" ? siteLabel(row) : tossLabel(row);
}

function candidateLines(candidates) {
  return candidates.map((c) => {
    // 청구서 후보는 결제일이 비어 있을 수 있어 날짜 차이 대신 청구월·상태로 보여준다.
    if (c.kind === "INVOICE") return `    - (사이트 청구서) ${describeRow(c.row)}`;
    const where = c.outOfMonth ? " [이번 달 밖]" : "";
    const diff = c.dayDiff === 0 ? "같은 날" : `${c.dayDiff > 0 ? "+" : ""}${c.dayDiff}일`;
    const kind = c.kind === "SAME_DATE_DIFF_AMOUNT" ? "금액 다름" : "금액 같음";
    return `    - (${diff} · ${kind})${where} ${describeRow(c.row)}`;
  });
}

function entriesOf(matchResult, category) {
  return [
    ...matchResult.siteResults.filter((e) => e.category === category),
    ...matchResult.tossResults.filter((e) => e.category === category),
  ];
}

const HELD_ORDER = [
  CATEGORY.HELD_MEMO_INVOICE_CONFLICT,
  CATEGORY.HELD_MEMO_NAME_AMOUNT_MISMATCH,
  CATEGORY.HELD_MULTI_STUDENT_ORDER,
  CATEGORY.HELD_MEMO_NAME_AMBIGUOUS,
  CATEGORY.HELD_AMOUNT_MISMATCH,
  CATEGORY.HELD_ID_MULTIPLE,
  CATEGORY.HELD_DUPLICATE_SURPLUS,
  CATEGORY.HELD_NEAR_DATE,
  CATEGORY.HELD_AMOUNT_DIFF_SAME_DATE,
];

/** 원장님이 읽는 마크다운 리포트 */
export function renderMarkdown(result, meta = {}) {
  const L = [];
  const s = result.mainSummary;
  const naive = meta.naiveTz ?? "KST";
  L.push(`# 토스POS ↔ 사이트 결제 대사 — ${result.month}`);
  L.push("");
  L.push(`- 생성 시각(KST): ${meta.generatedAtKst ?? "-"}`);
  L.push(`- 가맹점: ${meta.merchantLabel ?? "-"} (ID ${meta.merchantId ?? "-"})`);
  L.push(`- 토스 자료 출처: ${meta.tossSource ?? "-"}`);
  L.push(`- 대사 기간(KST): ${result.range.first} ~ ${result.range.last} (앞뒤 ${NEAR_DATE_DAYS}일은 후보 조회용으로만 사용)`);
  L.push(
    `- 시간대: 토스 실제 응답은 **UTC(Z) 표기**입니다(예: 2026-09-01T06:11:52Z = KST 15:11). 2026-09-18 실측 확인. ` +
      `이 리포트의 모든 시각은 KST 로 바꾼 값입니다.`,
  );
  L.push(
    `- ⚠️ 예비 가정: 혹시 시간대 표시가 없는 시각이 섞여 오면 **${naive}** 로 해석합니다(이 경우는 미검증 가정입니다). ` +
      `이번 회차 해당 건수: ${meta.assumedCount ?? 0}건`,
  );
  L.push(
    `- 조회 방식 주의: 토스는 '결제 변경 시각' 기준으로 걸러 줍니다. 조회 기간 이후에 취소된 건은 이 리포트에 반영되지 않을 수 있습니다.`,
  );
  L.push(`- 쓰기 없음 증빙: ${meta.noWriteProof ?? "-"}`);
  L.push("");
  L.push("## 요약");
  L.push("");
  L.push("| 분류 | 사이트 건수 | 사이트 금액 | 토스 건수 | 토스 금액 |");
  L.push("|---|---:|---:|---:|---:|");
  for (const c of s.categories) {
    L.push(
      `| ${CATEGORY_LABEL[c.category] ?? c.category} | ${c.siteCount} | ${formatWon(c.siteSum)} | ${c.tossCount} | ${formatWon(c.tossSum)} |`,
    );
  }
  L.push(`| **합계** | **${s.siteCount}** | **${formatWon(s.siteTotal)}** | **${s.tossCount}** | **${formatWon(s.tossTotal)}** |`);
  L.push("");
  L.push(`- 토스 카드 승인 합계 − 사이트 결제완료 합계 = **${formatWon(s.difference)}**`);
  L.push(
    `- 차이 설명: 짝을 못 찾은 토스 ${formatWon(s.unmatchedTossSum)} − 짝을 못 찾은 사이트 ${formatWon(s.unmatchedSiteSum)} = ` +
      `${formatWon(s.itemLevelDifference)} ${s.reconciles ? "(전체 차이와 일치)" : "(❗ 전체 차이와 불일치 — 집계 오류)"}`,
  );
  L.push("");

  const section = (title, entries, render) => {
    L.push(`## ${title} (${entries.length}건)`);
    L.push("");
    if (entries.length === 0) L.push("- 없음");
    else entries.forEach((e) => render(e));
    L.push("");
  };

  // 토스에만 있는 건은 "누구 결제인지"가 가장 급하다. 메모 이름과 그 원생의 수강 반까지 붙여서
  // 원장님이 DB 를 열지 않고도 바로 처리할 수 있게 한다.
  section("토스POS에만 있음", entriesOf(result.main, CATEGORY.POS_ONLY), (e) => {
    const row = e.row;
    L.push(`- ${describeRow(row)}`);
    const student = (row.resolvedStudents ?? [])[0];
    if (student) {
      L.push(`  - 원생: **${student.name}**${student.classes ? ` · 수강 중: ${student.classes}` : " · 수강 반 정보 없음"}`);
      L.push("  - → 사이트에 이 결제가 없습니다. 수납 기록을 추가할지 확인이 필요합니다.");
    } else if ((row.unknownMemoNames ?? []).length > 0) {
      L.push(`  - ⚠️ 메모 이름 "${row.unknownMemoNames.join(", ")}" 이(가) 원생 명단에 없습니다.`);
    } else if ((row.ambiguousMemoNames ?? []).length > 0) {
      const alt = row.ambiguousMemoNames.map((a) => `${a.name} → ${a.students.map((s) => s.name).join("/")}`).join(", ");
      L.push(`  - ⚠️ 메모 이름으로 원생을 특정할 수 없습니다: ${alt}`);
    } else if ((row.memoUnparsed ?? []).length > 0) {
      L.push(`  - ⚠️ 메모를 이름으로 읽지 못했습니다: ${row.memoUnparsed.join(" / ")}`);
    } else if (!row.memoRaw) {
      L.push("  - ⚠️ POS 메모가 없어 누구 결제인지 단서가 없습니다.");
    }
  });
  // 앞으로 자동 처리 후보가 될 목록 — 돈은 받았는데 사이트 청구서가 아직 미납인 건
  section("POS로 받았는데 사이트는 미납", entriesOf(result.main, CATEGORY.POS_PAID_SITE_UNPAID), (e) => {
    L.push(`- ${describeRow(e.row)}`);
    for (const c of e.candidates) {
      L.push(`  - 사이트 청구서: 결제ID ${c.row.id.slice(0, 8)} · 청구월 ${c.row.billingMonth || "-"} · ${c.row.status} · ${formatWon(c.row.amount)}`);
    }
  });

  const noInvoice = entriesOf(result.main, CATEGORY.POS_ONLY_NO_SITE_INVOICE);
  L.push(`## 사이트에 그 달 청구서가 아직 없음 (랠리즈→사이트 미반영) (${noInvoice.length}건)`);
  L.push("");
  L.push("랠리즈에서 발행된 청구서가 아직 사이트로 옮겨지지 않은 경우입니다.");
  L.push("");
  if (noInvoice.length === 0) L.push("- 없음");
  noInvoice.forEach((e) => L.push(`- ${describeRow(e.row)}`));
  L.push("");

  section("사이트에만 있음", entriesOf(result.main, CATEGORY.SITE_ONLY), (e) => L.push(`- ${describeRow(e.row)}`));

  const held = HELD_ORDER.flatMap((cat) => entriesOf(result.main, cat));
  L.push(`## 확인 필요 (${held.length}건)`);
  L.push("");
  if (held.length === 0) L.push("- 없음");
  for (const cat of HELD_ORDER) {
    const list = entriesOf(result.main, cat);
    if (list.length === 0) continue;
    L.push(`### ${CATEGORY_LABEL[cat]} (${list.length}건)`);
    for (const e of list) {
      L.push(`- [${e.row.side === "SITE" ? "사이트" : "토스POS"}] ${describeRow(e.row)}`);
      L.push(`  - 사유: ${e.reason}`);
      if (e.candidates.length > 0) {
        L.push("  - 후보:");
        candidateLines(e.candidates).forEach((line) => L.push(line));
      }
    }
    L.push("");
  }
  L.push("");

  L.push(`## 정상 매칭 (${result.main.groups.length}묶음)`);
  L.push("");
  if (result.main.groups.length === 0) L.push("- 없음");
  for (const g of result.main.groups) {
    const kind =
      {
        ID: "주문번호 일치",
        MEMO: "메모 이름 + 금액",
        EXISTING: "메모 이름 + 사이트 기존 납부 기록",
        DATE_AMOUNT: "날짜·금액 1:1",
      }[g.kind] ?? "날짜·금액 묶음";
    L.push(`- ${g.kstDate} · ${formatWon(g.amount)} · ${kind}`);
    g.siteRows.forEach((r) => L.push(`  - 사이트: ${describeRow(r)}`));
    g.tossRows.forEach((r) => L.push(`  - 토스POS: ${describeRow(r)}`));
  }
  L.push("");

  const cancelEntries = [...result.cancel.siteResults, ...result.cancel.tossResults];
  L.push(`## 취소 건 (사이트 ${result.cancel.siteResults.length} · 토스 ${result.cancel.tossResults.length})`);
  L.push("");
  if (cancelEntries.length === 0) L.push("- 없음");
  for (const e of cancelEntries) {
    L.push(`- [${e.row.side === "SITE" ? "사이트" : "토스POS"}] ${CATEGORY_LABEL[e.category] ?? e.category} — ${describeRow(e.row)}`);
  }
  L.push("");

  L.push(`## 메모 이름이 원생 명단에 없음 (${result.unknownMemoNamePayments.length}건)`);
  L.push("");
  if (result.unknownMemoNamePayments.length === 0) L.push("- 없음");
  for (const row of result.unknownMemoNamePayments) {
    L.push(`- ${describeRow(row)}`);
    if ((row.unknownMemoNames ?? []).length > 0) {
      L.push(`  - 명단에 없는 이름: **${row.unknownMemoNames.join(", ")}** (퇴원·타지점·오타·가족 명의 여부 확인 필요)`);
    }
    if ((row.memoUnparsed ?? []).length > 0) {
      L.push(`  - 이름으로 읽히지 않은 메모 조각: ${row.memoUnparsed.join(" / ")}`);
    }
  }
  L.push("");

  const noMemo = result.noMemoPayments;
  L.push(`## POS 메모가 없는 결제 (${noMemo.length}건)`);
  L.push("");
  if (noMemo.length === 0) L.push("- 없음");
  noMemo.forEach((row) => L.push(`- ${describeRow(row)}`));
  L.push("");

  const other = result.site.otherBranch;
  L.push("## 지점 제외 건수");
  L.push("");
  L.push(`- 다른 지점 원생의 결제 ${other.length}건 (합 ${formatWon(sumAmount(other))}) 은 대사에서 제외했습니다.`);
  L.push("");

  L.push("## 데이터 품질 경고");
  L.push("");
  const q = result.quality;
  const qBlock = (title, rows) => {
    L.push(`- ${title}: ${rows.length}건`);
    rows.forEach((r) => L.push(`  - ${describeRow(r)}`));
  };
  qBlock("시각 없음(09:00 KST = 날짜만 기록)", q.dateOnly);
  qBlock("새벽(00~06시) 시각 — 시간대 입력 오류 의심", q.dawn);
  qBlock("지점 미상", q.unknownBranch);
  qBlock("병합된 원생", q.merged);
  // 대사로는 "맞음"이지만 사이트 기록의 결제수단/결제일이 비어 있거나 카드가 아닌 건 — 나중에 바로잡을 목록
  const existing = q.existingRecords ?? [];
  L.push(`- 사이트에 납부 기록은 있으나 카드결제로 표시되지 않음(메모 이름으로 찾음): ${existing.length}건`);
  existing.forEach((r) =>
    L.push(
      `  - 결제ID ${r.id.slice(0, 8)} · ${r.studentName || "이름 없음"} · 청구월 ${r.billingMonth || "-"} · ${formatWon(r.amount)} · ` +
        `결제수단 ${r.method || "(없음)"} · 결제일 ${r.kstDateTime || "(없음)"}`,
    ),
  );
  L.push("");

  L.push("## 참고 (대사 대상 아님)");
  L.push("");
  L.push(`- 토스 카드 외 결제(현금·간편결제 등): ${result.toss.nonCard.length}건 (합 ${formatWon(sumAmount(result.toss.nonCard))})`);
  result.toss.nonCard.forEach((r) => L.push(`  - ${r.sourceType} · ${describeRow(r)}`));
  L.push(`- 토스 상태 미정(UNDEFINED 등): ${result.toss.otherState.length}건`);
  result.toss.otherState.forEach((r) => L.push(`  - ${r.state} · ${describeRow(r)}`));
  L.push(`- 사이트 기타 상태(미납 등): ${result.site.otherStatus.length}건`);
  result.site.otherStatus.forEach((r) => L.push(`  - ${r.status} · ${describeRow(r)}`));
  L.push("");
  return L.join("\n");
}

const CSV_HEADER = [
  "category",
  "side",
  "kstDateTime",
  "amount",
  "student_name",
  "branch_flag",
  "site_payment_id",
  "toss_order_id",
  "toss_payment_id",
  "approvedNo",
  "card_masked",
  "items",
  "note",
  "memo",
  "resolved_student",
  "billing_month",
];

function csvCell(value) {
  let text = value == null ? "" : String(value);
  // 엑셀 수식 주입 방지(이름이 '=' 로 시작하는 경우 등)
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRowFor(entry, categoryPrefix = "") {
  const row = entry.row;
  const note = [entry.reason, ...(row.flags ?? [])].filter(Boolean).join(" / ");
  if (row.side === "SITE") {
    return [
      `${categoryPrefix}${entry.category}`,
      "사이트",
      row.kstDateTime,
      row.amount,
      row.studentName,
      row.branchClass === "IN" ? "2호점" : row.branchClass === "UNKNOWN" ? "지점 미상" : "타지점",
      row.id,
      row.providerOrderId,
      row.providerPaymentKey,
      "",
      "",
      row.description,
      note,
      "",
      row.studentName,
      row.billingMonth ?? "",
    ];
  }
  return [
    `${categoryPrefix}${entry.category}`,
    "토스POS",
    row.kstDateTime,
    row.amount,
    "",
    "",
    "",
    row.orderId,
    row.paymentId,
    row.approvedNo,
    row.cardMasked,
    row.items,
    note,
    (row.memoRaw ?? "").replace(/\n/g, " / "),
    resolvedStudentLabel(row),
    row.targetBillingMonth ?? "",
  ];
}

/** 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 을 앞에 붙인다. */
export function renderCsv(result) {
  const lines = [CSV_HEADER.join(",")];
  const push = (entry, prefix) => lines.push(csvRowFor(entry, prefix).map(csvCell).join(","));
  result.main.siteResults.forEach((e) => push(e, ""));
  result.main.tossResults.forEach((e) => push(e, ""));
  result.cancel.siteResults.forEach((e) => push(e, "CANCEL_"));
  result.cancel.tossResults.forEach((e) => push(e, "CANCEL_"));
  result.toss.nonCard.forEach((row) => push({ row, category: "INFO_NON_CARD", reason: `카드 외 결제(${row.sourceType})` }, ""));
  result.toss.otherState.forEach((row) => push({ row, category: "INFO_TOSS_STATE", reason: `상태 ${row.state}` }, ""));
  result.site.otherStatus.forEach((row) => push({ row, category: "INFO_SITE_STATUS", reason: `상태 ${row.status}` }, ""));
  result.site.otherBranch.forEach((row) => push({ row, category: "INFO_OTHER_BRANCH", reason: "다른 지점 — 대사 제외" }, ""));
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ───────────────── 토스 API 호출 안전장치 (순수 검사 함수) ─────────────────

/**
 * 이 스크립트는 "조회 전용"이다. GET 이 아닌 요청, 주문 목록 외의 경로는
 * 보내기 "전에" 예외로 막는다. 실수로라도 POS 데이터를 건드릴 수 없게 하는 안전장치.
 */
export function assertReadOnlyTossRequest(method, path) {
  if (method !== "GET") {
    throw new Error(`이 스크립트는 조회 전용입니다. ${method} 요청은 보낼 수 없습니다.`);
  }
  if (!ORDER_LIST_PATH_RE.test(path) && !ORDER_ONE_PATH_RE.test(path)) {
    throw new Error(`허용되지 않은 경로입니다(주문 목록·주문 1건 조회만 가능): ${path}`);
  }
  return true;
}

/** 비밀값이 로그·리포트·에러에 새어 나가지 않게 가린다. */
export function redactSecrets(text, secrets = []) {
  let out = text == null ? "" : String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 6) continue;
    out = out.split(secret).join("[숨김]");
  }
  // 접속 문자열에 비밀번호가 섞여 있는 경우까지 방어
  out = out.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[숨김]@");
  return out;
}
