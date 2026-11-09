import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { normalizePlaceName, pickNearbyStop, sameComplex, splitGate } from "./stopNameMatch.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { suggestPlacement } from "./regularRosterPlacementLogic.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { planLeg } from "./driverAssignLogic.ts";

// 셔틀 「기존 정류장 추천」 장소명 일치 우선(2026-11-09 원장 승인) — 허재원 사례 · 거리순 유지 · 300m 밖 · 다른 단지.

const HUR = "다산e편한세상자이아파트 후문";

test("정규화: e편한/이편한 통일 · 아파트 꼬리말·공백 제거, 출입구 단어 분리", () => {
  assert.equal(normalizePlaceName(HUR), "다산이편한세상자이후문");
  assert.deepEqual(splitGate(HUR), { base: "다산이편한세상자이", gate: "후문" });
  assert.deepEqual(splitGate("다산이편한세상자이 정문 앞"), { base: "다산이편한세상자이", gate: "정문" });
  assert.deepEqual(splitGate("호평 롯데캐슬 맘스테이션"), { base: "호평롯데캐슬", gate: "맘스테이션" });
  // «다산동문화센터»의 «동문»은 출입구가 아니다.
  assert.equal(splitGate("다산동문화센터").gate, null);
  // 단지 이름 없이 «정문»만 적으면 이름 일치로 쓰지 않는다.
  assert.equal(splitGate("정문").gate, null);
  assert.equal(sameComplex("다산이편한세상자이", "다산이편한세상자이2단지"), true);
  assert.equal(sameComplex("다산이편한세상자이", "호평롯데캐슬"), false);
});

test("허재원 사례: 정문 88m · 후문 169m → 장소명이 «후문»이면 후문 추천", () => {
  const pick = pickNearbyStop(HUR, [
    { label: "다산이편한세상자이 정문", distanceMeters: 88 },
    { label: "다산이편한세상자이 후문", distanceMeters: 169 },
  ]);
  assert.equal(pick?.index, 1);
  assert.equal(pick?.by, "NAME");
  assert.equal(pick?.reason, "이름 일치: 후문");
});

test("장소명에 출입구 단어가 없으면 예전처럼 가장 가까운 곳", () => {
  const pick = pickNearbyStop("다산e편한세상자이아파트", [
    { label: "다산이편한세상자이 후문", distanceMeters: 169 },
    { label: "다산이편한세상자이 정문", distanceMeters: 88 },
  ]);
  assert.equal(pick?.index, 1);
  assert.equal(pick?.by, "NEAREST");
  assert.equal(pick?.reason, "가장 가까움 88m");
});

test("300m 밖 이름 일치는 무시하고 반경 안 가장 가까운 곳", () => {
  const pick = pickNearbyStop(HUR, [
    { label: "다산이편한세상자이 정문", distanceMeters: 88 },
    { label: "다산이편한세상자이 후문", distanceMeters: 320 },
  ]);
  assert.equal(pick?.index, 0);
  assert.equal(pick?.by, "NEAREST");
  // 반경 안 후보가 하나도 없으면 추천 없음.
  assert.equal(pickNearbyStop(HUR, [{ label: "다산이편한세상자이 후문", distanceMeters: 301 }]), null);
});

test("다른 단지의 같은 «정문»은 이름 일치로 보지 않는다", () => {
  const pick = pickNearbyStop("다산e편한세상자이 정문", [
    { label: "다산자연앤롯데캐슬 정문", distanceMeters: 150 },
    { label: "다산이편한세상자이 후문", distanceMeters: 90 },
  ]);
  assert.equal(pick?.index, 1);
  assert.equal(pick?.by, "NEAREST");
});

// ── 연결부: 관리자 학생 추가 · 기사님/관리자 새 학생 배정이 같은 규칙을 쓰는지 ──

// 아파트 대표 주소 좌표(다산중앙로81번길 25)와, 그 점에서 약 88m·169m 떨어진 두 정류장.
const HOME = { lat: 37.6195, lng: 127.15188 };
const FRONT = { lat: 37.6195 + 88 / 111_195, lng: 127.15188 };
const BACK = { lat: 37.6195 - 169 / 111_195, lng: 127.15188 };

test("관리자 학생 추가 추천(suggestPlacement)도 후문 합류", () => {
  const stops = [
    { label: "다산이편한세상자이 정문", arriveTime: "16:40", lat: FRONT.lat, lng: FRONT.lng, rows: [{ rowId: "a" }] },
    { label: "다산이편한세상자이 후문", arriveTime: "16:45", lat: BACK.lat, lng: BACK.lng, rows: [{ rowId: "b" }] },
  ];
  const s = suggestPlacement({ stops, direction: "BOARD", stopName: HUR, student: HOME, academy: null, depot: null });
  assert.deepEqual(s.choice, { kind: "JOIN", stopIndex: 1 });
  assert.match(s.reason, /이름 일치: 후문/);
  // 장소명이 출입구 없이 단지 이름뿐이면 가까운 정문.
  const n = suggestPlacement({ stops, direction: "BOARD", stopName: "다산e편한세상자이", student: HOME, academy: null, depot: null });
  assert.deepEqual(n.choice, { kind: "JOIN", stopIndex: 0 });
});

let seq = 0;
function row(over: Record<string, unknown> = {}): any {
  seq += 1;
  return {
    id: `r${seq}`, serviceMonth: "2026-11", weekday: 1, weekdayLabel: "월", classTime: "17:00~18:00", arriveTime: "16:40",
    stopName: "A", direction: "BOARD", studentName: `학생${seq}`, studentId: `s${seq}`, studentPhone: null, parentPhone: `010-9999-${1000 + seq}`,
    note: null, sortOrder: seq, latitude: null, longitude: null, ...over,
  };
}

test("기사님·관리자 새 학생 배정(planLeg) 후보: 후문 추천 + 이유 «이름 일치: 후문»", () => {
  const stops = [
    row({ stopName: "다산이편한세상자이 정문", latitude: FRONT.lat, longitude: FRONT.lng }),
    // 후문은 같은 달 다른 요일(화) 정류장 — 그 칸에 없어도 후보로 들어와 추천돼야 한다.
    row({ weekday: 2, weekdayLabel: "화", stopName: "다산이편한세상자이 후문", latitude: BACK.lat, longitude: BACK.lng }),
  ];
  const student: any = {
    studentId: "new", name: "허재원", grade: null, wishTime: null, parentPhone: "010-0000-0000",
    enrolled: [{ weekday: 1, startTime: "17:00", endTime: "17:55", status: "ACTIVE" }],
    pickup: { name: HUR, address: "경기 남양주시 다산중앙로81번길 25", latitude: HOME.lat, longitude: HOME.lng },
    dropoff: null,
  };
  const plan = planLeg(student, { weekday: 1, direction: "BOARD", classTime: "17:00~18:00", startTime: "17:00", label: "월 등원" }, stops, null, null);
  const rec = plan.joinOptions.find((o: any) => o.recommended);
  assert.equal(rec?.label, "다산이편한세상자이 후문");
  assert.equal(rec?.recommendReason, "이름 일치: 후문");
  assert.equal(plan.joinOptions[0].label, "다산이편한세상자이 후문"); // 추천이 맨 위
  const front = plan.joinOptions.find((o: any) => o.label === "다산이편한세상자이 정문");
  assert.equal(front?.recommended, false);
  assert.equal(front?.recommendReason, null);
});
