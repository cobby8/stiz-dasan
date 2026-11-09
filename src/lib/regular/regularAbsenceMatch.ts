// 정규 셔틀 명단(텍스트)과 결석 신고(학생 계정 기반)를 best-effort로 잇는 순수 매칭 로직.
// ─────────────────────────────────────────────────────────────────────────
// 왜 이렇게 하는가?
//   정규 셔틀 명단(RegularShuttleStop)은 학생 계정과 FK로 연결돼 있지 않고
//   이름·전화가 그냥 "텍스트"로만 들어있다. 반면 결석 신고(RegularAbsence)는
//   학생 계정(Student)에 걸려 있어 학생 이름 + 학부모 전화를 얻을 수 있다.
//   그래서 둘을 "이름 + 전화" 근사 매칭으로 이어 붙인다.
//
// ⚠️ best-effort 한계: 동명이인이면서 양쪽 다 전화가 없으면 오매칭이 날 수 있다.
//    전화가 양쪽 다 있으면 전화까지 대조해 오매칭을 최소화한다.
//    완전 정합(명단 ↔ Student.id 백필)은 이 작업 범위 밖이다.

// 결석자(학생 계정에서 뽑은 이름 + 학부모 전화)
export type AbsentPerson = { name: string; phone: string | null };
// 셔틀 명단 승객(텍스트 이름 + 학부모 전화)
export type Passenger = { name: string | null; phone: string | null };

// 이름 정규화: 모든 공백 제거 + 소문자화(영문 대비). 한글은 그대로 유지된다.
export function normalizeName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, "").toLowerCase();
}

// 전화 정규화: 숫자만 남긴다. 9자리 미만은 신뢰할 수 없어 null 처리(부분 입력·오타 방지).
export function normalizePhone(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/[^0-9]/g, "");
  return d.length >= 9 ? d : null;
}

// 승객 한 명이 결석자 목록과 매칭되는지 판정한다. 매칭되면 그 결석자를, 아니면 null.
// 규칙:
//   1) 이름(정규화)이 반드시 일치해야 한다.
//   2) 승객·결석자 양쪽 다 전화가 있으면 전화도 일치해야 매칭(동명이인 오매칭 방지).
//      - 이름은 같은데 전화가 다르면 → 다른 사람으로 보고 건너뛴다.
//   3) 한쪽이라도 전화가 없으면 이름만으로 매칭한다(best-effort).
export function matchAbsentee(passenger: Passenger, absentees: AbsentPerson[]): AbsentPerson | null {
  const pName = normalizeName(passenger.name);
  if (!pName) return null; // 이름이 없으면 매칭 불가(안전)
  const pPhone = normalizePhone(passenger.phone);

  for (const a of absentees) {
    if (normalizeName(a.name) !== pName) continue; // 이름 불일치 → 후보 아님
    const aPhone = normalizePhone(a.phone);
    if (pPhone && aPhone) {
      // 양쪽 다 전화 있음 → 전화까지 일치해야 확정(동명이인 구분)
      if (pPhone === aPhone) return a;
      continue; // 이름 같지만 전화 다름 → 동명이인, 스킵
    }
    // 한쪽 전화 없음 → 이름만으로 매칭(best-effort)
    return a;
  }
  return null;
}

// 승객이 오늘 결석자인지 여부만 반환하는 편의 함수(표시용).
export function isPassengerAbsent(passenger: Passenger, absentees: AbsentPerson[]): boolean {
  return matchAbsentee(passenger, absentees) !== null;
}

// 기사님 화면 결석 뱃지 문구 — 항상 «결석» 하나뿐이다.
// 🔒 사유(질병·부상 등)는 건강 민감정보라 로그인 없는 기사님 토큰 화면에 절대 싣지 않는다(검수 2026-11-09).
//    기사님은 «오늘 이 아이는 안 태워도 된다»만 알면 충분하다.
export const DRIVER_ABSENCE_LABEL = "결석";
