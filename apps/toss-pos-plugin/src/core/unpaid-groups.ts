// POS 탭 미납 검색 결과를 학생별로 묶는다(2026-11-17 원장: 밀린 달을 한 건씩 세 번 결제했다).
// 순수 로직 — 탭 화면은 묶음마다 «N건 합계 [전체 결제]» 머리줄을 그린다. 결제 가능 여부는 서버가 다시 확인한다.
import type { UnpaidItem } from "./contract.ts";
import { MAX_AMOUNT, MAX_ITEMS } from "./order.ts";

export type UnpaidGroup = {
  key: string;
  studentName: string;
  /** 서버 순서 그대로(학생 안에서 오래된 달부터) */
  items: UnpaidItem[];
  /** 결제 한 번으로 보낼 청구 — 열린 요청이 없는 것, 앞에서부터 최대 10건·500만원 */
  payable: UnpaidItem[];
  payableTotal: number;
  /** 한도 때문에 결제 가능한 청구 일부만 담았나 */
  capped: boolean;
  /** «10~12월» 처럼 달 범위(제목에서 읽음). 모르면 빈 글자 */
  rangeText: string;
};

/** «2026년 11월 수강료» → 2026*12+10. 못 읽으면 null */
function monthIndex(title: string): number | null {
  const m = /(\d{4})년\s*(\d{1,2})월/.exec(title);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? y * 12 + (mo - 1) : null;
}

/** 달 범위 글자 — 한 달 «11월», 같은 해 «10~12월», 해가 바뀌면 «2026년 12월~2027년 1월» */
export function monthRangeText(titles: string[]): string {
  const idx = titles.map(monthIndex).filter((v): v is number => v !== null);
  if (idx.length === 0) return "";
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);
  const a = { y: Math.floor(lo / 12), m: (lo % 12) + 1 };
  const b = { y: Math.floor(hi / 12), m: (hi % 12) + 1 };
  if (lo === hi) return `${a.m}월`;
  return a.y === b.y ? `${a.m}~${b.m}월` : `${a.y}년 ${a.m}월~${b.y}년 ${b.m}월`;
}

/**
 * 학생 열쇠(studentKey)로 묶는다. 열쇠가 없으면(옛 서버) 묶지 않고 한 건씩. 처음 나온 순서를 지킨다.
 */
export function groupUnpaidByStudent(items: UnpaidItem[]): UnpaidGroup[] {
  const groups = new Map<string, UnpaidItem[]>();
  for (const u of items) {
    const key = u.studentKey ? `s:${u.studentKey}` : `p:${u.paymentId}`;
    const list = groups.get(key);
    if (list) list.push(u);
    else groups.set(key, [u]);
  }
  const out: UnpaidGroup[] = [];
  for (const [key, list] of groups) {
    const open = list.filter((u) => !u.hasOpenRequest);
    const payable: UnpaidItem[] = [];
    let total = 0;
    for (const u of open) {
      if (payable.length >= MAX_ITEMS || total + u.amount > MAX_AMOUNT) break;
      payable.push(u);
      total += u.amount;
    }
    out.push({
      key,
      studentName: list[0].studentName,
      items: list,
      payable,
      payableTotal: total,
      capped: payable.length < open.length,
      rangeText: monthRangeText(list.map((u) => u.title)),
    });
  }
  return out;
}
