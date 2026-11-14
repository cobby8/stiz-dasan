import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { normalizeSeasonalWeekdays, parseApplicationInput, parseShuttleLocation, SeasonalError } from "./contracts.ts";

test("weekdays are normalized to the allowed enum and deduplicated", () => {
  assert.deepEqual(normalizeSeasonalWeekdays(["월요일", "MON", "화"]), ["MON", "TUE"]);
});

test("unknown weekdays are rejected", () => {
  assert.throws(() => normalizeSeasonalWeekdays(["휴일"]), (error) => error instanceof SeasonalError && error.code === "INVALID_WEEKDAY");
});

test("map shuttle location is normalized", () => {
  assert.deepEqual(parseShuttleLocation({
    address: "경기도 남양주시 다산동 1",
    roadAddress: "경기도 남양주시 다산중앙로 1",
    latitude: 37.624,
    longitude: 127.151,
    placeId: "kakao-123",
    source: "SEARCH",
    accuracyMeters: 12.5,
  }, "탑승"), {
    address: "경기도 남양주시 다산동 1",
    roadAddress: "경기도 남양주시 다산중앙로 1",
    latitude: 37.624,
    longitude: 127.151,
    placeId: "kakao-123",
    source: "SEARCH",
    accuracyMeters: 12.5,
  });
});

test("map shuttle location rejects invalid coordinate ranges", () => {
  assert.throws(
    () => parseShuttleLocation({ address: "테스트", latitude: 91, longitude: 127, source: "MAP_PIN" }, "탑승"),
    (error) => error instanceof SeasonalError && error.code === "INVALID_SHUTTLE_COORDINATES",
  );
});

const validApplication = () => ({
  idempotencyKey: "test-key",
  selectedWeekdays: ["MON"],
  child: { name: "홍길동", birthDate: "2015-01-01" },
  parent: { name: "보호자", phone: "010-1234-5678" },
  agreedTerms: true,
  agreedPrivacy: true,
  items: [{ offeringId: "offering-1" }],
});

// 2026-11-15 정정: 예전에는 글자만 적은 셔틀 신청도 받았지만, 지금 서버 규칙은 «셔틀을 신청하면 지도 위치(좌표) 필수»다
// (contracts.ts — 화면도 막지만 API 직접 호출 우회를 막으려고 서버에서도 강제). 이 테스트가 옛 규칙에 머물러 있었고,
// 가드 명령이 하위 폴더를 돌지 않아 실패가 드러나지 않았다.
test("글자만 적은 셔틀 신청은 받지 않는다 — 지도 위치 필수", () => {
  const payload = validApplication();
  payload.items = [{
    offeringId: "offering-1",
    shuttle: { pickupLocation: "아파트 정문", dropoffLocation: "학원 앞" },
  } as (typeof payload.items)[number]];
  assert.throws(
    () => parseApplicationInput(payload),
    (error) => error instanceof SeasonalError && error.status === 400 && error.code === "SHUTTLE_LOCATION_REQUIRED",
  );
  // 셔틀을 신청하지 않으면 위치 없이도 된다
  assert.equal(parseApplicationInput(validApplication()).items[0].shuttle, undefined);
});

test("한 요청에서 특강을 20개 넘게 선택할 수 없다", () => {
  const payload = validApplication();
  payload.items = Array.from({ length: 21 }, (_, index) => ({ offeringId: `offering-${index}` }));
  assert.throws(
    () => parseApplicationInput(payload),
    (error) => error instanceof SeasonalError && error.status === 413 && error.code === "TOO_MANY_ITEMS",
  );
});

test("map shuttle payload requires explicit versioned location consent", () => {
  const payload = validApplication();
  payload.items = [{
    offeringId: "offering-1",
    shuttle: {
      pickupLocationData: {
        address: "아파트 정문",
        latitude: 37.624,
        longitude: 127.151,
        source: "MAP_PIN",
      },
    },
  } as (typeof payload.items)[number]];
  assert.throws(
    () => parseApplicationInput(payload),
    (error) => error instanceof SeasonalError && error.code === "SHUTTLE_LOCATION_CONSENT_REQUIRED",
  );
});

test("map shuttle payload rejects an unknown consent version", () => {
  const payload = validApplication();
  payload.items = [{
    offeringId: "offering-1",
    shuttle: {
      pickupLocationData: {
        address: "아파트 정문",
        latitude: 37.624,
        longitude: 127.151,
        source: "MAP_PIN",
      },
      locationConsent: true,
      locationConsentVersion: "unknown-version",
    },
  } as (typeof payload.items)[number]];
  assert.throws(
    () => parseApplicationInput(payload),
    (error) => error instanceof SeasonalError && error.code === "SHUTTLE_LOCATION_CONSENT_REQUIRED",
  );
});

test("map shuttle payload accepts coordinates with versioned consent", () => {
  const payload = validApplication();
  payload.items = [{
    offeringId: "offering-1",
    shuttle: {
      pickupLocationData: {
        address: "아파트 정문",
        latitude: 37.624,
        longitude: 127.151,
        source: "MAP_PIN",
      },
      locationConsent: true,
      locationConsentVersion: "2026-07-21",
    },
  } as (typeof payload.items)[number]];
  const parsed = parseApplicationInput(payload);
  assert.equal(parsed.items[0].shuttle?.locationConsent, true);
  assert.equal(parsed.items[0].shuttle?.locationConsentVersion, "2026-07-21");
});
