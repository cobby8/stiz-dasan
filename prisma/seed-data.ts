/**
 * 시드 데이터 - 프로그램 목록 영구 보존용
 *
 * 이 파일은 프로그램 데이터를 기록합니다.
 * DB 데이터가 필요할 때 /api/admin/seed POST로 복구합니다.
 * (복구는 Storage 의 최신 자동 스냅샷을 먼저 쓰고, 없을 때만 이 파일을 씁니다.)
 *
 * 마지막 내보내기: 2026. 11. 16. 오후 6:01:25
 */

export interface SeedProgram {
    id: string;
    name: string;
    targetAge: string | null;
    description: string | null;
    days: string | null;
    priceWeek1: number | null;
    priceWeek2: number | null;
    priceWeek3: number | null;
    priceDaily: number | null;
    shuttleFeeOverride: number | null;
    order: number;
    frequency?: string | null;
    weeklyFrequency?: string | null;
    imageUrl?: string | null;
    runsShuttle?: boolean;
    deletedAt?: string | null;
}

export const PROGRAMS: SeedProgram[] = [
    {
        id: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
        name: `즐거운 주중취미반`,
        targetAge: `초등저~고 (일부 중학생 가능)`,
        description: `주중 6시 이전 60분 클래스로 효율적인 기본기 훈련과 즐거운 시합을 통해 농구의 재미를 알아가는 기본 클래스입니다.`,
        days: `Mon,Tue,Wed,Thu,Fri`,
        priceWeek1: 100000,
        priceWeek2: 160000,
        priceWeek3: 210000,
        priceDaily: null,
        shuttleFeeOverride: null,
        order: 0,
        frequency: `주1회~5회`,
        weeklyFrequency: `주1회`,
        imageUrl: `https://gpjdtkumqxzfgkixjamp.supabase.co/storage/v1/object/public/uploads/program/hobby-20261002.jpg`,
        runsShuttle: true,
        deletedAt: null,
    },
    {
        id: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
        name: `치열한 주중경기반`,
        targetAge: `초등고~중등`,
        description: `주중 6시 이후 80분 클래스로 경기에 필요한 실전응용기술을 습득하고 농구경기를 이해하고 농구에 대한 재미가 한층 깊어가는 클래스입니다.`,
        days: `Mon,Tue,Wed,Thu,Fri`,
        priceWeek1: 120000,
        priceWeek2: 180000,
        priceWeek3: 240000,
        priceDaily: null,
        shuttleFeeOverride: null,
        order: 1,
        frequency: null,
        weeklyFrequency: `주1회`,
        imageUrl: `https://gpjdtkumqxzfgkixjamp.supabase.co/storage/v1/object/public/uploads/program/weekday-20261002.jpg`,
        runsShuttle: true,
        deletedAt: null,
    },
    {
        id: `fea165ef-314a-47d1-8fda-7e1f0772cee4`,
        name: `통쾌한 주말경기반`,
        targetAge: `초등~중등`,
        description: `주중 시간이 부족한 친구들이 주말을 이용해 스트레스를 풀 수 있는 주말전용 클래스입니다. 70분 수업으로 주중취미반과 경기반 프로그램이 적절하게 혼합한 형태로 운영합니다.`,
        days: `Sat`,
        priceWeek1: 110000,
        priceWeek2: 180000,
        priceWeek3: 240000,
        priceDaily: null,
        shuttleFeeOverride: 0,
        order: 2,
        frequency: null,
        weeklyFrequency: `주1회`,
        imageUrl: `https://gpjdtkumqxzfgkixjamp.supabase.co/storage/v1/object/public/uploads/program/weekend-20261002.jpg`,
        runsShuttle: false,
        deletedAt: null,
    },
    {
        id: `sat7-120k-20261116`,
        name: `통쾌한 주말경기반 7교시`,
        targetAge: `초6~중등`,
        description: `토요일 저녁 7교시에 진행하는 주말 경기반입니다. 75분 수업으로 운영합니다.`,
        days: `Sat`,
        priceWeek1: 120000,
        priceWeek2: 180000,
        priceWeek3: 240000,
        priceDaily: null,
        shuttleFeeOverride: 0,
        order: 3,
        frequency: null,
        weeklyFrequency: `주1회`,
        imageUrl: `https://gpjdtkumqxzfgkixjamp.supabase.co/storage/v1/object/public/uploads/program/weekend-20261002.jpg`,
        runsShuttle: false,
        deletedAt: null,
    },
    {
        id: `88dbc742-9dad-48bd-908c-b8d58134b8cc`,
        name: `대회준비반`,
        targetAge: `초등`,
        description: `학업과 운동의 절묘한 조화! 농구를 사랑하는 친구들이 대회 출전을 목표로 하면서 최소한의 집중 트레이닝으로 심오한 농구의 세계를 경험하는 클래스입니다. 
대표팀의 타이들을 달고 활동하는 자부심이 있지만 부담 가질 필요는 없습니다 :) 스티즈농구교실은 아이들의 균형적인 성장을 추구하고 지나친 승부에 대한 집착은 지양합니다.`,
        days: null,
        priceWeek1: null,
        priceWeek2: null,
        priceWeek3: null,
        priceDaily: null,
        shuttleFeeOverride: null,
        order: 4,
        frequency: null,
        weeklyFrequency: null,
        imageUrl: `https://gpjdtkumqxzfgkixjamp.supabase.co/storage/v1/object/public/uploads/program/contest-20261002.jpg`,
        runsShuttle: true,
        deletedAt: null,
    },
    {
        id: `a111bce3-055a-4d91-9989-e7674060d46b`,
        name: `성인반`,
        targetAge: `성인`,
        description: `농구의 기본기와 기초 체력을 향상시킬 수 있는 성인전용 클래스입니다. 디테일한 개인별 맞춤 지도를 통해 빠르게 향상하는 자신의 실력을 확인하세요!
목요일은 첫째주 스포라운드에서 5:5 친선 교류전 진행 중입니다.`,
        days: `Tue,Thu`,
        priceWeek1: 120000,
        priceWeek2: 180000,
        priceWeek3: null,
        priceDaily: null,
        shuttleFeeOverride: 0,
        order: 5,
        frequency: null,
        weeklyFrequency: `주1회`,
        imageUrl: `https://gpjdtkumqxzfgkixjamp.supabase.co/storage/v1/object/public/uploads/program/adult-20261002.jpg`,
        runsShuttle: false,
        deletedAt: null,
    },
    {
        id: `446f4b29-e4f3-456b-8ad8-a8b747ca2650`,
        name: `목요 성인반(평내호평점 스포라운드)`,
        targetAge: `성인`,
        description: `동호회 형태로 운영되는 클래스로 친선 교류전, 자체경기를 통해 농구 경기 위주로 운영되며 5:5 농구에 대한 접근방식을 배우는 즐거운 클래스 입니다.`,
        days: null,
        priceWeek1: null,
        priceWeek2: null,
        priceWeek3: null,
        priceDaily: null,
        shuttleFeeOverride: null,
        order: 6,
        frequency: null,
        weeklyFrequency: null,
        imageUrl: null,
        runsShuttle: true,
        deletedAt: `2026-07-25T17:49:23.791Z`,
    },
    {
        id: `0940a989-cbcb-41dd-ae23-c7e666c835c5`,
        name: `슈팅 클래스`,
        targetAge: `초등`,
        description: `프로출신 한정훈 원장님의 슈팅 특화 클래스! 정원 6명으로 소규모 그룹트레이닝으로 최대의 성과를 보장합니다!`,
        days: null,
        priceWeek1: null,
        priceWeek2: null,
        priceWeek3: null,
        priceDaily: null,
        shuttleFeeOverride: null,
        order: 7,
        frequency: null,
        weeklyFrequency: null,
        imageUrl: `https://gpjdtkumqxzfgkixjamp.supabase.co/storage/v1/object/public/uploads/program/shooting-20261002.jpg`,
        runsShuttle: true,
        deletedAt: `2026-10-30T04:49:26.033Z`,
    },
    {
        id: `e1311379-0916-49db-a152-94c91b28fa72`,
        name: `2026 여름방학 특강`,
        targetAge: `초등~중등`,
        description: `방학특강 출석과 청구 연결을 위한 전용 프로그램`,
        days: null,
        priceWeek1: null,
        priceWeek2: null,
        priceWeek3: null,
        priceDaily: null,
        shuttleFeeOverride: null,
        order: 91,
        frequency: `방학특강`,
        weeklyFrequency: null,
        imageUrl: null,
        runsShuttle: true,
        deletedAt: null,
    },
];

export const CLASS_SLOT_OVERRIDES: any[] = [
    {
        id: `5fbced2f-96fb-446b-95db-8a86d6d53f78`,
        slotKey: `Fri-3`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `5122943d-36c6-457e-8b23-d57a5a3796d7`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `74318741-ac45-4cc0-8845-1bdcafb29a11`,
        slotKey: `Fri-4`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `5122943d-36c6-457e-8b23-d57a5a3796d7`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `bed5af8e-2a9b-4687-a42a-15b2ca3f3394`,
        slotKey: `Fri-5`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `5122943d-36c6-457e-8b23-d57a5a3796d7`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `e12ec94a-b54c-4f23-9475-25053000a4eb`,
        slotKey: `Fri-6`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `a5c47e5d-151a-40df-b92e-0b91a80fe47a`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `237a3b0e-8044-4a4a-96f8-c81214ab2963`,
        slotKey: `Fri-7`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `a5c47e5d-151a-40df-b92e-0b91a80fe47a`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `ee78bbf1-1103-4e20-8848-e058095b472f`,
        slotKey: `Mon-3`,
        label: null,
        note: null,
        isHidden: true,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `c559149a-5a86-4135-b066-fd8d722247eb`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `27a1f9bd-5f77-49cc-94a0-c60661f08093`,
        slotKey: `Mon-4`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `c559149a-5a86-4135-b066-fd8d722247eb`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `934f4ba9-32d8-48f8-b443-26562dd68a19`,
        slotKey: `Mon-5`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `c559149a-5a86-4135-b066-fd8d722247eb`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `4db0d7b6-e69e-44c4-b07a-1b8743350fd8`,
        slotKey: `Mon-6`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `a5c47e5d-151a-40df-b92e-0b91a80fe47a`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `5437faca-aa14-4dc1-b0f5-eeaf6e13d3e3`,
        slotKey: `Mon-7`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `a5c47e5d-151a-40df-b92e-0b91a80fe47a`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `285fa12a-87b5-491d-be4b-605851a357f1`,
        slotKey: `Sat-1`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `e46edab6-74fd-4814-99ef-a147b2564693`,
        programId: `fea165ef-314a-47d1-8fda-7e1f0772cee4`,
    },
    {
        id: `3a8c5cb1-2085-4fe1-9a8a-4cc79061b447`,
        slotKey: `Sat-2`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `e46edab6-74fd-4814-99ef-a147b2564693`,
        programId: `fea165ef-314a-47d1-8fda-7e1f0772cee4`,
    },
    {
        id: `e77dcae3-1253-457e-af6e-8036b7035534`,
        slotKey: `Sat-3`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `e46edab6-74fd-4814-99ef-a147b2564693`,
        programId: `fea165ef-314a-47d1-8fda-7e1f0772cee4`,
    },
    {
        id: `84fd4f38-a2d7-49c6-a7d8-13635906d853`,
        slotKey: `Sat-4`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `e46edab6-74fd-4814-99ef-a147b2564693`,
        programId: `fea165ef-314a-47d1-8fda-7e1f0772cee4`,
    },
    {
        id: `50df234d-4108-45ed-a96a-d64f22957dd9`,
        slotKey: `Sat-7`,
        label: null,
        note: `[2026-09-10 운영자확정] 토7 월수강료120,000원. 공통주말Program기본110,000원 적용대상아님. 셔틀없음.`,
        isHidden: false,
        capacity: 12,
        startTimeOverride: `17:10`,
        endTimeOverride: `18:25`,
        coachId: `f2080e21-5dd3-4aef-a448-ac3f00941c9a`,
        programId: `sat7-120k-20261116`,
    },
    {
        id: `11e722ef-2bd0-431b-b294-47c541094acd`,
        slotKey: `Sun-8`,
        label: null,
        note: null,
        isHidden: true,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `c559149a-5a86-4135-b066-fd8d722247eb`,
        programId: `88dbc742-9dad-48bd-908c-b8d58134b8cc`,
    },
    {
        id: `d337c753-7241-46ca-8161-00c81883b3b0`,
        slotKey: `Thu-2`,
        label: null,
        note: `한정훈 프로의 탄탄한 슈팅만들기! 슈팅의 기본을 확실히 잡아드립니다!`,
        isHidden: true,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `8e7b771c-eb05-404e-87c6-141ef8acb508`,
        programId: `0940a989-cbcb-41dd-ae23-c7e666c835c5`,
    },
    {
        id: `d306dfd6-6997-4520-964a-3cd4bbf1d334`,
        slotKey: `Thu-3`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `c559149a-5a86-4135-b066-fd8d722247eb`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `74d94165-86f0-4577-949c-a8540aa9a52c`,
        slotKey: `Thu-6`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `a5c47e5d-151a-40df-b92e-0b91a80fe47a`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `c60bec77-3982-4915-be5e-43a602340145`,
        slotKey: `Thu-7`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `a5c47e5d-151a-40df-b92e-0b91a80fe47a`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `137f94e3-751b-4bc2-9457-2f89a3c7f305`,
        slotKey: `Thu-8`,
        label: null,
        note: `5대5 농구의 이해와 농구의 기본을 익히는 즐거운 성인 클래스! 매월 첫째주는 평내호평점에서 5:5 농구로 진행합니다. 마치로 122, 스포라운드`,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `f2080e21-5dd3-4aef-a448-ac3f00941c9a`,
        programId: `a111bce3-055a-4d91-9989-e7674060d46b`,
    },
    {
        id: `a0aff453-e6e9-476c-8f71-c7d82aff41fd`,
        slotKey: `Tue-4`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `5122943d-36c6-457e-8b23-d57a5a3796d7`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `1f5078a7-1c5a-454f-9060-4f8824237664`,
        slotKey: `Tue-5`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `5122943d-36c6-457e-8b23-d57a5a3796d7`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `5a5d94c3-2039-4a39-8c28-579a10bb0e2f`,
        slotKey: `Tue-6`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `5122943d-36c6-457e-8b23-d57a5a3796d7`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `11787971-29a3-463f-a187-de1105b2d6eb`,
        slotKey: `Tue-7`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `f2080e21-5dd3-4aef-a448-ac3f00941c9a`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `3c94d75d-1544-4d6b-acc0-1040572843c2`,
        slotKey: `Tue-8`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `f2080e21-5dd3-4aef-a448-ac3f00941c9a`,
        programId: `a111bce3-055a-4d91-9989-e7674060d46b`,
    },
    {
        id: `f8fc5044-3fcd-4e0e-8c80-a1124106c48f`,
        slotKey: `Wed-3`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `c559149a-5a86-4135-b066-fd8d722247eb`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `39b4ff44-4678-4450-a417-0b5dd3167544`,
        slotKey: `Wed-4`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `c559149a-5a86-4135-b066-fd8d722247eb`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `f4a50764-4115-4380-8788-9295daafca05`,
        slotKey: `Wed-5`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `f2080e21-5dd3-4aef-a448-ac3f00941c9a`,
        programId: `4fa412fd-88d6-401d-9e03-89edf50b1355`,
    },
    {
        id: `deb0fa2c-71aa-4fc8-814c-7a70ed73f1f5`,
        slotKey: `Wed-6`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: null,
        coachId: `a5c47e5d-151a-40df-b92e-0b91a80fe47a`,
        programId: `e63fbd9d-3ec6-4352-88cb-10439a532746`,
    },
    {
        id: `38b856e4-8f67-4da2-a44b-5f1fc8e519fa`,
        slotKey: `Wed-7`,
        label: null,
        note: null,
        isHidden: false,
        capacity: 12,
        startTimeOverride: null,
        endTimeOverride: `20:55`,
        coachId: `a5c47e5d-151a-40df-b92e-0b91a80fe47a`,
        programId: `88dbc742-9dad-48bd-908c-b8d58134b8cc`,
    },
];

/** 이용약관 (AcademySettings.termsOfService) */
export const TERMS_OF_SERVICE: string | null = `"스티즈 농구교실에 오신 것을 환영합니다."

스티즈농구교실 다산점의 교육서비스 및 제품을 이용해 주셔서 감사합니다. 본 약관은 다양한 스 서비스의 이용과 관련하여 서비스를 제공하는 스티즈농구교실 다산점과 이를 이용하는  수강생과의 관계를 설명하며, 아울러 여러분의 스티즈농구교실 이용에 도움이 될 수 있는 유익한 정보를 포함하고 있습니다.

스티즈농구교실 다산점의 서비스를 이용하시거나 수강생으로 가입하실 경우 여러분은 본 약관 및 관련 운영 정책을 확인하거나 동의하게 되므로, 잠시 시간을 내시어 주의 깊게 살펴봐 주시기 바랍니다.

"교육프로그램 운영주기 및 일정"
스티즈농구교실 다산점의 교육프로그램은 4주 단위로 운영됩니다. 매주 일요일, 구정 연휴 및 추석 연휴는 휴무이며, 기타 공휴일에 따른 휴무 계획은 해당 년도의 연간 일정에 따라 운영되며, 미세한 변동이 있을 수 있습니다. 변동이 있는 경우는 사전에 반드시 안내드리니 걱정마세요

"수강료와 셔틀비"
수강료는 반(프로그램)별로, 그리고 주당 수업 횟수별로 정해집니다. 반별 금액표는 홈페이지 "프로그램 안내" 페이지에 항상 게시되어 있으며, 금액이 변경되는 경우에는 사전에 안내드립니다.

주당 수업 횟수가 많을수록 수업 1회당 금액이 낮아지도록 구성되어 있습니다. 주 1회보다 주 2회가, 주 2회보다 주 3회가 1회당 금액이 더 저렴합니다.

셔틀(차량) 이용료는 수강료에 포함되지 않는 별도의 비용입니다. 주당 이용 횟수에 따라 정해진 금액이 매월 부과되며, 셔틀을 이용하지 않는 수강생에게는 부과되지 않습니다. 반에 따라 셔틀이 운행되지 않는 경우도 있으며, 셔틀비 역시 "프로그램 안내" 페이지에서 함께 확인하실 수 있습니다.

"수강료 납부 주기 및 방법"
스티즈농구교실 다산점 수강료는 수강을 시작하기 2주 전부터 수강일 전까지 납부 받습니다. 수강 개시일 2주전부터 1주일 간은 우선등록 기간으로, 대기 수강생이 있는 경우 우선 등록 기간에 수강료 납부를 해주셔야 합니다. 수강 개시일 1주전부터는 신규 및 일반등록기간으로  대기가 없는 반의 수강생, 대기가 끝난 신규 수강생이 수강료를 납부하는 기간입니다. 수강생 개인의 사정에 의한 수강료 납부 지연의 경우, 원으로 연락주셔서 일정 조율하시기 바랍니다.

"출석 및 결석에 따른 수업 이월 및 환불"
스티즈농구교실 다산점 수업에 대한 출석은 반드시 수강하는 수업에 출석하는 것을 원칙으로 합니다. 개인사정(가족여행, 행사참여, 늦잠 등)으로 인한 결석은 수업이월 및 환불 사유에 해당하지 않습니다.  단, 수강생 본인의 질병 및 부상(진단서 제출이 가능한 정도), 직계존비속의 경조사로 인한 결석의 경우는 확인과정을 거쳐 수업 이월 및 수강료 환불이 가능합니다. 

이월을 인정받으시려면, 결석 사유를 확인할 수 있는 자료(진단서, 경조사 확인 자료 등)를 원에 제출해 주셔야 합니다. 원의 확인 절차가 끝난 뒤에 이월이 반영되며, 사전에 알려주지 않은 결석은 이월로 처리되지 않을 수 있습니다.

이월이 인정되면, 결석한 횟수만큼의 금액을 다음 달 수강료에서 빼고 청구해 드립니다. 이월 1회당 빼드리는 금액은 "해당 월 수강료를 그 달에 예정된 총 수업 횟수로 나눈 1회분 금액"입니다. 주 1회 반은 한 달 4회, 주 2회 반은 한 달 8회, 주 3회 반은 한 달 12회가 기준이 됩니다. 그 달의 일정에 따라 수업 횟수가 달라지는 경우에는 그 달에 예정된 실제 수업 횟수를 기준으로 계산합니다.

예를 들어 주 1회 반에서 한 달 수강료가 99,000원인 경우, 1회분은 99,000원을 4회로 나눈 24,750원입니다. 2회를 이월하시면 다음 달 청구액은 49,500원이 됩니다. 같은 주 1회 반에서 한 달 수강료가 100,000원인 경우에는 1회분이 25,000원이므로, 1회 이월 시 75,000원을 납부하시게 됩니다.

주 2회 반은 한 달 수업이 8회이므로 1회분 금액이 다릅니다. 예를 들어 한 달 수강료가 180,000원인 주 2회 반은 1회분이 180,000원을 8회로 나눈 22,500원이며, 1회 이월 시 157,500원, 2회 이월 시 135,000원을 납부하시게 됩니다.

셔틀 이용료는 이월 차감 대상이 아닙니다. 차량은 결석 여부와 관계없이 운행되기 때문에, 셔틀비는 이월과 무관하게 부과됩니다.

"수강료의 반환(환불) 기준"
수강료 반환은 「학원의 설립·운영 및 과외교습에 관한 법률 시행령」 별표 4(교습비등 반환기준)를 그대로 따릅니다. 스티즈농구교실 다산점의 교육프로그램은 4주 단위로 운영되므로, 교습기간이 1개월 이내인 경우의 기준이 적용됩니다.

수업을 시작하기 전 : 납부하신 금액 전액을 돌려드립니다
수업 시작 후 총 교습시간의 3분의 1이 지나기 전 : 납부하신 금액의 3분의 2
총 교습시간의 3분의 1이 지난 뒤부터 2분의 1이 지나기 전 : 납부하신 금액의 2분의 1
총 교습시간의 2분의 1이 지난 뒤 : 돌려드리지 않습니다

여기서 "총 교습시간"이란 그 달에 예정되어 있던 전체 수업을 말합니다. 예를 들어 주 2회 반은 4주 동안 총 8회, 주 1회 반은 총 4회입니다.

[예시 1] 주 2회 반, 한 달 수강료 180,000원 (총 8회)
수업을 한 번도 받지 않고 그만두는 경우 : 180,000원 전액
1~2회 수업을 받고 그만두는 경우 : 120,000원 (3분의 2)
3회 수업을 받고 그만두는 경우 : 90,000원 (2분의 1)
4회 이상 수업을 받고 그만두는 경우 : 돌려드리는 금액 없음

[예시 2] 주 1회 반, 한 달 수강료 120,000원 (총 4회)
수업을 한 번도 받지 않고 그만두는 경우 : 120,000원 전액
1회 수업을 받고 그만두는 경우 : 80,000원 (3분의 2)
2회 이상 수업을 받고 그만두는 경우 : 돌려드리는 금액 없음

반환 사유가 발생한 날은, 수강생 또는 보호자께서 수강을 그만두겠다는 뜻을 원에 알려주신 날입니다. 그 날을 기준으로 위 표를 적용합니다.

원은 반환 사유가 발생한 날부터 5일 이내에 반환해 드립니다.

폐강, 교습 정지, 그 밖에 원의 사정으로 수업을 제공하지 못하게 된 경우에는, 아직 진행되지 않은 수업에 해당하는 금액 전액을 돌려드립니다. 이 경우에도 반환 기한(5일 이내)은 동일합니다.

셔틀 이용료는 아직 이용하지 않은 날짜만큼 계산하여 함께 돌려드립니다. 그 달에 예정되어 있던 셔틀 이용 횟수 중 실제로 이용하신 횟수를 뺀 나머지 횟수에 해당하는 금액이 반환 대상입니다. 예를 들어 그 달에 8회 이용하실 예정이었는데 3회를 이용하신 뒤 그만두시는 경우, 남은 5회분에 해당하는 셔틀비를 돌려드립니다.

"휴원과 퇴원"
휴원은 일정 기간 수업을 쉬었다가 다시 돌아오는 것을, 퇴원은 수강을 완전히 그만두는 것을 말합니다. 어느 경우든 반드시 원에 미리 알려주셔야 합니다.

휴원 및 퇴원 신청은 쉬거나 그만두시려는 달의 수강 시작일 전까지, 즉 그 달의 수강료를 청구해 드리기 전까지 알려주셔야 합니다. 그래야 그 달 청구에 반영됩니다. 수강 시작일이 지난 뒤에 알려주시는 경우에는 이미 청구가 이루어진 뒤이므로, 위 "수강료의 반환(환불) 기준"에 따라 정산해 드립니다.

휴원으로 처리된 달에는 수강료와 셔틀비를 청구하지 않습니다. 이미 납부하신 뒤에 휴원하시는 경우에는 위 "수강료의 반환(환불) 기준"에 따라 정산해 드립니다.

퇴원하시는 경우에는, 그만두겠다는 뜻을 알려주신 날을 기준으로 위 반환 기준에 따라 정산하며, 그 다음 달부터는 수강료가 청구되지 않습니다.

휴원은 최대 2개월까지 가능합니다.

휴원 기간 중에는 기존에 다니시던 반의 자리를 비워 둡니다. 복귀하실 때에는 쉬시기 전과 같은 반으로 돌아오실 수 있습니다.

휴원 기간인 2개월을 초과하여 연락이나 재등록이 없는 경우에는, 원의 확인을 거쳐 퇴원으로 처리될 수 있습니다. 이 경우에도 곧바로 처리하지 않고, 먼저 보호자께 연락드려 의사를 확인한 뒤에 진행합니다.

"수업의 보강"
결석으로 수업의 결손이 발생하였을 때, 결석 1회당 보강권 1회가 발급됩니다. 보강권으로 수강 중인 수업 외에 "학년이 맞는 다른 수업"에 보강 수업으로 참여하실 수 있습니다. 참여 가능한 수업은 원의 시간표에 안내된 수업별 학년 구성을 기준으로 하며, 마이페이지에서 보강권과 참여 가능한 수업을 직접 확인하고 예약하실 수 있습니다.

보강 수업은 해당 수업의 정원에 2명까지 추가로 참여할 수 있습니다. 이미 그 인원까지 찬 수업에는 예약하실 수 없으며, 이 경우 다른 요일·시간의 수업을 이용해 주시기 바랍니다.

수업의 보강은 스티즈농구교실 다산점의 의무사항이 아니며, 수강생의 수업 결손을 최대한 보충해 주고자 하는 교육서비스 시스템입니다. 원은 학생의 출결을 엄격하게 관리하고 있으며, 보강 예약은 보호자께서 직접 하시는 것을 원칙으로 합니다. 원에서 먼저 보강을 잡아드리지는 않습니다.

보강권은 결석이 발생한 날로부터 2개월 이내에 사용하는 것을 원칙으로 하며, 2개월이 지난 보강권은 자동으로 소멸됩니다. 보강을 예약한 이후 별다른 고지 없이 참여하지 않을 경우 해당 보강권은 사용한 것으로 처리되니 유의해 주시기 바랍니다. 참여가 어려우실 때에는 미리 예약을 취소해 주시면 보강권이 그대로 유지됩니다.

"수업의 폐강"
스티즈농구교실 다산점은 개설된 수업을 유지하고자 최선의 노력을 다하는 것을 원칙으로 합니다. 다만, 다음과 같은 경우 학부모와의 상의를 통해 수업이 폐강될 수 있습니다.

"수업의 인원이 2인 이하가 되고, 2달 이상 경과한 경우"

위의 경우 무조건 폐강 절차를 진행하는 것은 아닙니다. 해당 수업시간에 인원모집이 어려울 것으로 판단되는 경우, 수강생 및 학부모님과 상담을 통해 적절한 수업으로 이동 배치 후 폐강 절차를 진행할 수 있습니다.

"수업 참여에 관한 규칙"
수업에 참여하는 모든 수강생은 수업참여 시 반드시 "운동복과 실내운동화"를 착용해야 합니다. 이를 이행하지 않을 경우 이용에 제한이 발생할 수 있습니다. 체육관 입장과 함께 실내운동화로 갈아신어야 하며, 소지품의 경우 체육관 내 비치되어 있는 사물함을 이용해야하고, 수업 종료 후에는 본인의 소지품을 스스로 챙기시기 바랍니다. 수강생이 이용하는 사물함 내부에 대해, 스티즈의 구성원들은 일절 관여하지 않으므로 분실물에 대한 책임을 지지 않습니다. 

"수업 중 안전수칙"
농구를 포함한 모든 운동은 항상 부상의 위험을 내포하고 있습니다. 수업 중 강사의 안전교육을 반드시 잘 듣고 따라주시기 바랍니다. 기본적으로 수업 중 안경 착용은 허용하지 않습니다. 안경을 벗고 수업에 참여할 수 없을 정도로 시력에 문제가 있는 경우 스포츠 고글 또는 깨지지 않는 렌즈, 테가 부러지지 않는 재질의 안경 착용을 하시기 바랍니다. 

"수업 중 부상"
수업 중 발생하는 불의의 부상에 대하여 스티즈농구교실 다산점은 "삼성화재"에 가입하여 수강생에게 발생한 안타까운 사고에 대한 대비책을 마련해 두었습니다. 다만 수업 중 일어난 부상에 대한 보상의 범위는 스티즈농구교실의 강사, 시설물 등으로 인한 귀책사유가 법적으로 명확한 경우까지만 가능합니다.  수강생의 본인의 실수로 인한 부상의 경우에는 안타깝게도 보상을 받지 못할 가능성이 높으니 반드시 수업을 총괄하는 강사의 안전관리에 잘 따라주시기 바랍니다.

​
"유니폼"
스티즈농구교실의 모든 수강생은 입단과 동시에 유니폼을 구매하여야하며, 이는 원활한 수업의 운영과 팀 스포츠의 기본에 대한 이해를 위함입니다. 

"수업 사진·동영상"
수업 중에는 강사가 수업 모습을 사진·동영상으로 촬영하며, 촬영한 사진·동영상은 해당 수업의 피드(학부모님이 보시는 수업 소식)에 올라갑니다. 수업 피드는 그 반 수강생의 보호자만 보실 수 있습니다.

촬영한 사진·동영상을 홍보물·SNS·블로그 등 광고에 사용할 때에는, 사용하기 전에 원에서 보호자께 전화로 따로 동의를 받습니다. 동의하지 않으시면 광고에 사용하지 않습니다.

"약관의 시행"
본 약관은 2026년 1월 1일부터 적용됩니다. 개정 전에 등록하신 수강생에게도 개정된 내용이 동일하게 적용되며, 개정 내용은 홈페이지 이용약관 페이지에 게시하여 안내드립니다.

2026년 11월 18일 개정: "수업 사진·동영상" 조항을 추가하였습니다.`;
