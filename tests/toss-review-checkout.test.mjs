import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 토스페이먼츠 가맹 심사용 테스트 결제(2026-10-02 추가) → 2026-11-14 제거.
// 심사가 2026-11-07 에 승인돼 원장이 «결제하기는 모두 제거»를 지시했다.
// 이 파일은 이제 «심사용 결제가 남아 있지 않다 + 옛 주소는 /programs 로 넘긴다»를 지킨다.
// (학부모 청구서 결제 /payments/<청구서>·/pay/<토큰>·TOSS_PAYMENTS_* 는 별개 — 다른 테스트가 지킨다)

const { hasSellablePrice } = await loadTsModule("src/lib/payments/tossReview.ts");

/** src 아래 .ts/.tsx 파일 전부 */
function listSourceFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
        else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
}

test("심사 전용 파일은 지워졌다 — 결제 버튼·주문서 양식·심사용 API·결제창 모듈", () => {
    for (const file of [
        "src/app/programs/ProgramPayButton.tsx",
        "src/app/programs/order/OrderForm.tsx",
        "src/app/api/payments/toss-review/checkout/route.ts",
        "src/lib/payments/tossReviewClient.ts",
    ]) {
        assert.equal(existsSync(file), false, `${file} 이 아직 남아 있습니다`);
    }
});

test("TOSS_REVIEW_* 환경값을 읽는 코드가 src 어디에도 없다", async () => {
    for (const file of listSourceFiles("src")) {
        const source = await readFile(file, "utf8");
        assert.doesNotMatch(source, /TOSS_REVIEW_(CLIENT|SECRET)_KEY|readTossReviewConfig/, `${file} 이 심사용 키를 읽습니다`);
    }
});

test("/programs 에는 결제 버튼·빈도 고르기가 없고, 가격표·시간표 링크는 남아 있다", async () => {
    const source = await readFile("src/app/programs/page.tsx", "utf8");
    assert.doesNotMatch(source, /ProgramPayButton|결제하기|listReviewTierOptions|reviewPayEnabled|<select/);
    assert.match(source, /public-fee-table/);
    assert.match(source, /href=\{`\/schedule\?program=\$\{program\.id\}`\}/);
    assert.match(source, /시간표 보기 →/);
});

test("옛 주소(/programs/order · /payments/review/success · /payments/review/fail)는 /programs 로 넘긴다", async () => {
    for (const file of [
        "src/app/programs/order/page.tsx",
        "src/app/payments/review/success/page.tsx",
        "src/app/payments/review/fail/page.tsx",
    ]) {
        const source = await readFile(file, "utf8");
        assert.match(source, /import \{ redirect \} from "next\/navigation";/, file);
        assert.match(source, /redirect\("\/programs"\);/, file);
        // 넘김만 한다 — 결제창·승인 요청·DB 접근이 남아 있으면 안 된다.
        assert.doesNotMatch(source, /tosspayments|requestPayment|fetch\(|prisma|\$queryRaw|\$executeRaw/i, file);
    }
});

// ── 남긴 것: 0원 프로그램 숨김 판정(홈·프로그램 안내가 쓴다) ──

const empty = { price: 0, priceWeek1: null, priceWeek2: null, priceWeek3: null, priceDaily: null };

test("0원 프로그램 판정 — 가격 칸이 모두 0/빈 값이면 공개 화면에 내놓지 않는다", () => {
    assert.equal(hasSellablePrice(empty), false, "여름방학 특강처럼 0원이면 숨김");
    assert.equal(hasSellablePrice({ ...empty, priceWeek2: 0, priceDaily: 0 }), false);
    assert.equal(hasSellablePrice({ ...empty, priceDaily: 200000 }), true);
    assert.equal(hasSellablePrice({ ...empty, price: 150000 }), true);
    assert.equal(hasSellablePrice({ ...empty, price: -1 }), false);
});
