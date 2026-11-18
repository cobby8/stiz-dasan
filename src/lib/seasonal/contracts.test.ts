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

// ── 기간 선택·날짜별 선택(2026-11-18) ──

test("옛 입력(요일만)은 결과가 그대로이고 새 칸은 기본값(요일 모드·날짜 없음·기간 없음)이다", () => {
  const parsed = parseApplicationInput(validApplication());
  assert.deepEqual(parsed.selectedWeekdays, ["MON"]);
  assert.equal(parsed.selectionMode, "WEEKDAY");
  assert.deepEqual(parsed.selectedDates, []);
  assert.equal(parsed.periodStartDate, undefined);
  assert.equal(parsed.periodEndDate, undefined);
  assert.equal(parsed.child.name, "홍길동");
  assert.equal(parsed.parent.phone, "01012345678");
  assert.deepEqual(parsed.items, [{ offeringId: "offering-1", shuttle: undefined }]);
});

test("날짜 모드는 요일 없이도 통과하고, 날짜는 중복 제거·오름차순으로 정리된다", () => {
  const parsed = parseApplicationInput({
    ...validApplication(),
    selectedWeekdays: [],
    selectionMode: "DATE",
    selectedDates: ["2027-01-06", "2027-01-04", " 2027-01-06 "],
  });
  assert.equal(parsed.selectionMode, "DATE");
  assert.deepEqual(parsed.selectedDates, ["2027-01-04", "2027-01-06"]);
});

test("날짜 모드인데 날짜가 없으면 거절한다", () => {
  assert.throws(
    () => parseApplicationInput({ ...validApplication(), selectionMode: "DATE", selectedDates: [] }),
    (error) => error instanceof SeasonalError && error.code === "DATE_REQUIRED",
  );
});

test("요일 모드는 여전히 요일이 필수다", () => {
  assert.throws(
    () => parseApplicationInput({ ...validApplication(), selectedWeekdays: [] }),
    (error) => error instanceof SeasonalError && error.code === "WEEKDAY_REQUIRED",
  );
});

test("잘못된 날짜(형식·없는 날짜·문자열 아님)는 거절한다", () => {
  for (const bad of [["2027-1-4"], ["2027-02-30"], [20270104], ["어제"], "2027-01-04"]) {
    assert.throws(
      () => parseApplicationInput({ ...validApplication(), selectionMode: "DATE", selectedDates: bad }),
      (error) => error instanceof SeasonalError && error.code === "INVALID_SELECTED_DATES",
      `거절해야 함: ${JSON.stringify(bad)}`,
    );
  }
});

test("날짜는 60개까지 — 61개(중복 제거 후)면 거절, 중복으로 60개 이하면 통과", () => {
  const days = (count: number) => Array.from({ length: count }, (_, index) => {
    // 2027-01-01 부터 하루씩(달력 숫자만 센다)
    const date = new Date(Date.UTC(2027, 0, 1 + index));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  });
  assert.throws(
    () => parseApplicationInput({ ...validApplication(), selectionMode: "DATE", selectedDates: days(61) }),
    (error) => error instanceof SeasonalError && error.code === "TOO_MANY_SELECTED_DATES",
  );
  const sixty = days(60);
  const parsed = parseApplicationInput({ ...validApplication(), selectionMode: "DATE", selectedDates: [...sixty, ...sixty] });
  assert.equal(parsed.selectedDates.length, 60);
});

test("알 수 없는 선택 방식은 거절한다", () => {
  assert.throws(
    () => parseApplicationInput({ ...validApplication(), selectionMode: "MONTH" }),
    (error) => error instanceof SeasonalError && error.code === "INVALID_SELECTION_MODE",
  );
});

test("수강 기간은 시작·종료가 둘 다 있거나 둘 다 없어야 하고, 종료 ≥ 시작", () => {
  const ok = parseApplicationInput({ ...validApplication(), periodStartDate: "2027-01-04", periodEndDate: "2027-01-29" });
  assert.equal(ok.periodStartDate, "2027-01-04");
  assert.equal(ok.periodEndDate, "2027-01-29");
  // 하루짜리 기간(시작 = 종료)도 된다
  assert.equal(parseApplicationInput({ ...validApplication(), periodStartDate: "2027-01-04", periodEndDate: "2027-01-04" }).periodEndDate, "2027-01-04");
  for (const range of [
    { periodStartDate: "2027-01-04" },
    { periodEndDate: "2027-01-29" },
    { periodStartDate: "2027-01-29", periodEndDate: "2027-01-04" },
    { periodStartDate: "2027-01-04", periodEndDate: "2027-02-30" },
  ]) {
    assert.throws(
      () => parseApplicationInput({ ...validApplication(), ...range }),
      (error) => error instanceof SeasonalError && error.code === "INVALID_PERIOD",
      `거절해야 함: ${JSON.stringify(range)}`,
    );
  }
});

test("요일 모드에 날짜가 섞여 와도 버리고, 날짜 모드에 기간이 와도 버린다(출석 규칙이 뒤바뀌지 않게)", () => {
  const weekday = parseApplicationInput({ ...validApplication(), selectedDates: ["2027-01-04"] });
  assert.deepEqual(weekday.selectedDates, []);
  const date = parseApplicationInput({
    ...validApplication(), selectionMode: "DATE", selectedDates: ["2027-01-04"],
    periodStartDate: "2027-01-04", periodEndDate: "2027-01-29",
  });
  assert.equal(date.periodStartDate, undefined);
  assert.equal(date.periodEndDate, undefined);
});

test("SeasonalError 의 details 는 선택 — 기존 호출(3개 인자)은 그대로", () => {
  const plain = new SeasonalError("안내", 409, "X");
  assert.equal(plain.details, undefined);
  assert.equal(plain.code, "X");
  const withDetails = new SeasonalError("안내", 409, "DATES_FULL", { fullDates: ["2027-01-12"] });
  assert.deepEqual(withDetails.details, { fullDates: ["2027-01-12"] });
  assert.equal(withDetails.status, 409);
});
