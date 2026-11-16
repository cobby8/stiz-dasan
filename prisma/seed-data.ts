/**
 * 시드 데이터 — 프로그램 목록 영구 보존용
 *
 * ⚠️ 이 파일에 프로그램 데이터를 기록해 두세요.
 *    DB 데이터 소실 시 /api/admin/seed POST 로 복구합니다.
 *
 * days: "Mon","Tue","Wed","Thu","Fri","Sat","Sun" 중 쉼표 구분
 * shuttleFeeOverride: null=자동계산, 0=셔틀없음(주말), 숫자=직접지정
 */

export interface SeedProgram {
    id: string;          // 고정 UUID — DB 복구 시 동일 ID로 복원되어야 슬롯 연결 유지됨
    name: string;
    targetAge: string | null;
    description: string | null;
    days: string | null;          // e.g. "Mon,Tue,Wed,Thu,Fri"
    priceWeek1: number | null;    // 주1회 수강료
    priceWeek2: number | null;    // 주2회 수강료
    priceWeek3: number | null;    // 주3회 수강료
    priceDaily: number | null;    // 매일반 수강료
    shuttleFeeOverride: number | null;
    order: number;
    // 아래 다섯 칸은 없어도 된다 — «새로 넣는 줄»에만 쓰고, 없으면 기본값(숨김 아님·셔틀 운행)
    frequency?: string | null;
    weeklyFrequency?: string | null;
    imageUrl?: string | null;
    runsShuttle?: boolean;
    deletedAt?: string | null;    // 숨긴 시각(ISO 글자)
}

/**
 * ★ 아래 PROGRAMS 배열에 실제 프로그램 데이터를 입력하세요 ★
 *
 * 관리자 페이지 → 프로그램·이용약관 관리에서 프로그램 추가 후,
 * 추가된 프로그램의 ID를 /api/admin/backup 으로 확인해 id 필드에 기입하세요.
 * 이후 이 파일이 영구 백업 역할을 합니다.
 */
export const PROGRAMS: SeedProgram[] = [
    // ─────────────────────────────────────────────────────────────────────────
    // 아래 예시를 실제 데이터로 교체하세요
    // ─────────────────────────────────────────────────────────────────────────
    // {
    //     id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",  // 실제 UUID
    //     name: "유아반",
    //     targetAge: "6~7세",
    //     description: "농구를 처음 접하는 유아를 위한 기초 동작 및 체력 발달 프로그램입니다.",
    //     days: "Mon,Wed,Fri",
    //     priceWeek1: 130000,
    //     priceWeek2: 150000,
    //     priceWeek3: 180000,
    //     priceDaily: null,
    //     shuttleFeeOverride: null,  // null = 자동 계산
    //     order: 0,
    // },
    // {
    //     id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    //     name: "초등반",
    //     targetAge: "초1~초6",
    //     description: "체계적인 기초기 훈련과 농구 규칙을 익히는 초등학생 전용 프로그램입니다.",
    //     days: "Mon,Tue,Wed,Thu,Fri",
    //     priceWeek1: 130000,
    //     priceWeek2: 160000,
    //     priceWeek3: 190000,
    //     priceDaily: 220000,
    //     shuttleFeeOverride: null,
    //     order: 1,
    // },
    // {
    //     id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    //     name: "중등반",
    //     targetAge: "중1~중3",
    //     description: "전술과 팀플레이를 중심으로 실력을 향상시키는 중학생 전용 프로그램입니다.",
    //     days: "Mon,Tue,Wed,Thu,Fri",
    //     priceWeek1: 130000,
    //     priceWeek2: 160000,
    //     priceWeek3: 190000,
    //     priceDaily: 220000,
    //     shuttleFeeOverride: null,
    //     order: 2,
    // },
];

/**
 * ClassSlotOverride 시드 (수업별 코치/시간 배정)
 *
 * 관리자 → "시드 데이터 내보내기" 버튼 → 생성된 코드를 붙여넣으세요.
 */
export const CLASS_SLOT_OVERRIDES: any[] = [
    // 예시:
    // {
    //     id: "...",
    //     slotKey: "Mon-3",
    //     label: null,
    //     note: null,
    //     isHidden: false,
    //     capacity: 12,
    //     startTimeOverride: null,
    //     endTimeOverride: null,
    //     coachId: "...",   // 코치 UUID
    //     programId: "...", // 프로그램 UUID
    // },
];

/**
 * 이용약관 (AcademySettings.termsOfService)
 *
 * 관리자 → "시드 데이터 내보내기" 버튼 → 생성된 코드를 붙여넣으세요.
 */
export const TERMS_OF_SERVICE: string | null = null;
