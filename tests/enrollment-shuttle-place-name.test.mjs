import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 실제 사고: 지도에 핀을 찍으면 주소가 「타는 곳 이름」 칸에 자동으로 들어가,
// 학부모가 「경기 남양주시 다산동 4002-1」만 남기고 넘어가 기사님이 어디서 태울지 몰랐다.
// 규칙(순수 모듈)을 실제로 돌려 보고, 화면·서버가 같은 규칙을 쓰는지 확인한다.

const {
    isPlaceNameSameAsAddress,
    shuttlePlaceNameError,
    initialPlaceNameFromMap,
    sanitizeLoadedPlaceName,
} = await loadTsModule("src/lib/enrollment/shuttle-place-name.ts");

const pin = { address: "경기 남양주시 다산동 4002-1", roadAddress: "경기 남양주시 다산중앙로 100" };

test("이름이 비었으면 막는다(공백만 있어도)", () => {
    assert.equal(shuttlePlaceNameError("", pin, "pickup"), "타는 곳 이름을 적어 주세요(예: OO아파트 후문).");
    assert.equal(shuttlePlaceNameError("   ", pin, "dropoff"), "내리는 곳 이름을 적어 주세요(예: OO아파트 후문).");
    assert.equal(shuttlePlaceNameError(undefined, pin, "pickup") !== null, true);
});

test("지번·도로명 주소를 그대로 적으면 공백 차이가 있어도 막는다", () => {
    assert.notEqual(shuttlePlaceNameError("경기 남양주시 다산동 4002-1", pin, "pickup"), null);
    assert.notEqual(shuttlePlaceNameError("경기남양주시다산동4002-1", pin, "pickup"), null);
    assert.notEqual(shuttlePlaceNameError(" 경기 남양주시  다산중앙로 100 ", pin, "dropoff"), null);
    assert.equal(isPlaceNameSameAsAddress("경기남양주시 다산중앙로100", pin), true);
});

test("건물·출입구 이름은 통과한다(주소가 일부 섞여도)", () => {
    assert.equal(shuttlePlaceNameError("다산 자이 후문 맘스테이션 앞", pin, "pickup"), null);
    assert.equal(shuttlePlaceNameError("다산동 4002-1 앞 편의점", pin, "pickup"), null);
    // 위치 정보가 없으면 주소 비교는 못 하지만 빈칸 검사는 한다
    assert.equal(shuttlePlaceNameError("정문", null, "pickup"), null);
    assert.notEqual(shuttlePlaceNameError("", null, "pickup"), null);
});

test("지도에서 고른 직후: 장소명이 있으면 채우고, 주소뿐이면 빈칸", () => {
    assert.equal(initialPlaceNameFromMap({ ...pin, placeName: " 다산 롯데캐슬 " }), "다산 롯데캐슬");
    assert.equal(initialPlaceNameFromMap(pin), "");
    assert.equal(initialPlaceNameFromMap({ ...pin, placeName: "경기 남양주시 다산동 4002-1" }), "");
    assert.equal(initialPlaceNameFromMap(undefined), "");
});

test("이전 신청 불러오기: 주소가 이름으로 저장돼 있었으면 빈칸으로", () => {
    assert.equal(sanitizeLoadedPlaceName("경기 남양주시 다산동 4002-1", pin), "");
    assert.equal(sanitizeLoadedPlaceName("후문 맘스테이션", pin), "후문 맘스테이션");
    assert.equal(sanitizeLoadedPlaceName(null, pin), "");
});

test("화면·서버가 같은 규칙을 쓰고, 주소 자동 채움은 사라졌다", () => {
    const form = fs.readFileSync("src/app/apply/enroll/EnrollApplicationForm.tsx", "utf8");
    const steps = fs.readFileSync("src/app/apply/enroll/EnrollApplicationLaterSteps.tsx", "utf8");
    const action = fs.readFileSync("src/app/actions/public.ts", "utf8");

    assert.match(form, /shuttlePlaceNameError\(form\.shuttlePickup, form\.shuttlePickupLocationData, "pickup"\)/);
    assert.match(form, /shuttlePlaceNameError\(form\.shuttleDropoff, form\.shuttleDropoffLocationData, "dropoff"\)/);
    assert.match(form, /sanitizeLoadedPlaceName\(existing\.shuttlePickup/);
    assert.match(form, /sanitizeLoadedPlaceName\(existing\.shuttleDropoff/);

    assert.doesNotMatch(steps, /placeName \?\? location\.address/);
    assert.match(steps, /initialPlaceNameFromMap\(location\)/);
    assert.match(steps, /타는 곳 이름/);
    assert.match(steps, /내리는 곳 이름/);

    assert.match(action, /shuttlePlaceNameError\(data\.shuttlePickup, shuttlePickupLocation, "pickup"\)/);
    assert.match(action, /shuttlePlaceNameError\(data\.shuttleDropoff, shuttleDropoffLocation, "dropoff"\)/);
    // 저장 라벨은 학부모가 적은 이름이 우선(지도 장소명이 덮어쓰지 않게)
    assert.doesNotMatch(action, /shuttlePickupLocation\?\.placeName \?\? \(data\.shuttlePickup/);
    assert.doesNotMatch(action, /shuttleDropoffLocation\?\.placeName \?\? \(data\.shuttleDropoff/);
});
