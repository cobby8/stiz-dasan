import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startStatusBrowserHarness } from "../tests/helpers/status-browser-harness.mjs";

const payment = {
    paymentId: "payment-fixture", studentId: "student-fixture", studentName: "합성 학생", description: "합성 수강료", amount: 100000,
    status: "PENDING", dueDate: "2026-11-01", paidDate: null, invoiceNo: null, receiptUrl: null, pending: [], resolved: [],
};
const enrollment = {
    effectiveFrom: "2026-11-01", minEffectiveFrom: "2026-10-20", maxEffectiveFrom: "2027-01-01",
    children: [{ studentId: "student-fixture", studentName: "합성 학생", enrollmentId: "enrollment-fixture", currentClassId: "class-current", currentClassName: "현재 반", currentProgramName: "합성 프로그램", pending: null }],
    classes: [{ classId: "class-target", className: "옮길 반", programName: "합성 프로그램", dayOfWeek: "Mon", startTime: "15:00", endTime: "16:00", capacity: 12, enrolled: 5, full: false }],
};
const harness = await startStatusBrowserHarness({ entry: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import Payment from '@/app/mypage/payments/PaymentRequestClient';
import Enrollment from '@/app/mypage/enrollment-change/EnrollmentChangeClient';
const q=new URLSearchParams(location.search),view=q.get('view'),action=q.get('action'),mode=q.get('mode');
let data=view==='payment'?[${JSON.stringify(payment)}]:${JSON.stringify(enrollment)};
const changePending={id:'request-fixture',kind:'CLASS_CHANGE',toClassName:'옮길 반',effectiveFrom:'2026-11-01',waitlisted:false};
if(view==='payment'&&action==='receipt')data[0].status='PAID';
if(action==='cancel'){if(view==='payment')data[0].pending=[{id:'request-fixture',kind:'PAYMENT_CLAIM',createdAt:'2026-10-19'}];else data.children[0].pending=changePending;}
window.fixture={posts:[],refreshes:0};
window.fetch=async(url,options)=>{
 if(!['/api/mypage/payment-request','/api/mypage/enrollment-change'].includes(url)||options.method!=='POST')throw Error('Unexpected fixture request');
 window.fixture.posts.push(JSON.parse(options.body));
 if((mode==='recover'&&window.fixture.posts.length===1)||mode==='reject'||mode==='refresh-fail'||mode==='lost-accepted')throw TypeError('Synthetic network failure');
 if(mode==='400')return new Response(JSON.stringify({error:'입력 내용을 확인해 주세요.'}),{status:400});
 if(mode==='500')return new Response(JSON.stringify({error:'처리에 실패했습니다.'}),{status:500});
 if(mode==='invalid')return new Response('not-json',{status:200});
 if(mode==='hold')await new Promise(resolve=>window.releaseRequest=resolve);
 return new Response(JSON.stringify({ok:true}),{status:200});
};
function App(){const[value,setValue]=useState(data);React.useEffect(()=>{const refresh=()=>{
 window.fixture.refreshes++;if(mode==='refresh-fail')return;
 data=JSON.parse(JSON.stringify(data));
 if(mode==='lost-accepted'){
  if(view==='payment'){data[0].pending=action==='cancel'?[]:[{id:'accepted',kind:action==='receipt'?'RECEIPT':'PAYMENT_CLAIM',createdAt:'2026-10-19'}];}
  else data.children[0].pending=action==='cancel'?null:changePending;
 }setValue(data);
};window.addEventListener('test:refresh',refresh);return()=>window.removeEventListener('test:refresh',refresh);},[]);
 return React.createElement(view==='payment'?Payment:Enrollment,view==='payment'?{rows:value}:{initial:value});}
createRoot(document.getElementById('root')).render(React.createElement(App));
` });

const results = [];
let browser;
async function scenario(view, action, mode) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.request().url().startsWith(harness.url) ? route.continue() : route.abort());
    try {
        await page.goto(`${harness.url}/?view=${view}&action=${action}&mode=${mode}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        let submit;
        let field;
        let expected;
        if (view === "payment" && action === "claim") {
            await page.getByRole("button", { name: "입금했어요 알리기" }).click();
            await page.getByLabel("입금하신 날짜").fill("2026-10-19");
            field = page.getByLabel("입금자명 (선택)"); expected = "합성 입금자"; await field.fill(expected);
            submit = page.getByRole("button", { name: "확인 요청 보내기" });
        } else if (view === "payment" && action === "receipt") {
            await page.getByRole("button", { name: "영수증 요청하기" }).click();
            field = page.getByLabel("휴대폰 번호"); expected = "010-0000-0000"; await field.fill(expected);
            submit = page.getByRole("button", { name: "영수증 요청 보내기" });
        } else if (action === "cancel") {
            submit = page.getByRole("button", { name: view === "payment" ? "취소" : "신청 취소하기", exact: true });
        } else {
            await page.getByLabel("옮기고 싶은 반").selectOption("class-target");
            await page.getByLabel("언제부터 옮길까요?").fill("2026-11-08");
            field = page.getByLabel("사유 (선택)"); expected = "합성 신청 사유"; await field.fill(expected);
            submit = page.getByRole("button", { name: "신청하기", exact: true });
        }
        await submit.click();
        const payload = await page.evaluate(() => window.fixture.posts[0]);
        if (action === "cancel") assert.deepEqual(payload, { action: "cancel", id: "request-fixture" });
        else if (view === "payment") {
            assert.equal(payload.paymentId, "payment-fixture");
            assert.equal(payload.kind, action === "receipt" ? "RECEIPT" : "PAYMENT_CLAIM");
            assert.equal(Object.hasOwn(payload, "amount"), false);
            if (action === "receipt") { assert.equal(payload.receiptType, "CASH_RECEIPT"); assert.equal(payload.receiptTarget, expected); }
            else { assert.equal(payload.method, "TRANSFER"); assert.equal(payload.paidOn, "2026-10-19"); assert.equal(payload.depositorName, expected); }
        } else {
            assert.deepEqual(payload, { enrollmentId: "enrollment-fixture", kind: "CLASS_CHANGE", toClassId: "class-target", effectiveFrom: "2026-11-08", reason: expected });
        }
        if (mode === "hold") {
            await page.waitForFunction(() => typeof window.releaseRequest === "function");
            const sendingButton = action === "cancel" ? submit : page.getByRole("button", { name: view === "payment" ? "보내는 중..." : "접수 중...", exact: true });
            assert.equal(await sendingButton.isDisabled(), true);
            await page.evaluate(() => { document.querySelectorAll('button').forEach(button => { if (/보내는 중|접수 중|신청 취소하기|^취소$/.test(button.textContent)) button.click(); }); });
            assert.equal(await page.evaluate(() => window.fixture.posts.length), 1);
            await page.evaluate(() => window.releaseRequest());
        }
        if (["reject", "500", "invalid", "refresh-fail", "lost-accepted", "recover"].includes(mode)) {
            await page.getByRole("alert").filter({ hasText: "접수·취소 여부를 알 수 없습니다" }).waitFor();
            assert.equal(await page.locator("main").count(), 1);
            if (field) assert.equal(await field.inputValue(), expected);
            assert.equal(await submit.isDisabled(), true);
            assert.equal(await page.getByRole("button", { name: "내역 확인했어요" }).count(), 0);
            await page.getByRole("button", { name: "접수 결과 다시 확인" }).click();
            if (mode === "refresh-fail") {
                assert.equal(await page.getByRole("button", { name: "내역 확인했어요" }).count(), 0);
                assert.equal(await submit.isDisabled(), true);
            } else {
                await page.getByRole("button", { name: "내역 확인했어요" }).click();
                if (mode === "lost-accepted" && action !== "cancel") {
                    assert.equal(await page.getByRole("button", { name: view === "payment" ? (action === "receipt" ? "영수증 요청하기" : "입금했어요 알리기") : "신청하기", exact: true }).count(), 0);
                } else if (mode !== "lost-accepted") {
                    assert.equal(await submit.isEnabled(), true);
                    if (field) assert.equal(await field.inputValue(), expected);
                }
            }
            assert.equal(await page.evaluate(() => window.fixture.posts.length), 1, "결과 조회는 POST를 재전송하지 않아야 한다");
            if (mode === "recover") {
                await submit.click();
                await page.waitForFunction(() => window.fixture.posts.length === 2);
                assert.deepEqual(await page.evaluate(() => window.fixture.posts[1]), payload, "명시적으로 다시 보낼 때 입력값을 유지해야 한다");
                await page.getByText(action === "cancel" ? (view === "payment" ? "요청을 취소했습니다." : "신청을 취소했습니다.") : (view === "enrollment" ? "신청이 접수되었습니다. 학원에서 확인 후 알려드립니다." : action === "receipt" ? "영수증 요청을 보냈습니다. 발급되면 알려드립니다." : "입금 확인 요청을 보냈습니다. 학원에서 확인 후 알려드립니다."), { exact: true }).waitFor();
            }
        } else if (mode === "400") {
            await page.getByRole("alert").filter({ hasText: "입력 내용을 확인해 주세요" }).waitFor();
            assert.equal(await submit.isEnabled(), true);
            if (field) assert.equal(await field.inputValue(), expected);
        } else {
            await page.getByText(action === "cancel" ? (view === "payment" ? "요청을 취소했습니다." : "신청을 취소했습니다.") : (view === "enrollment" ? "신청이 접수되었습니다. 학원에서 확인 후 알려드립니다." : action === "receipt" ? "영수증 요청을 보냈습니다. 발급되면 알려드립니다." : "입금 확인 요청을 보냈습니다. 학원에서 확인 후 알려드립니다."), { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => window.fixture.refreshes), 1);
        }
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => window.fixture.posts.length), mode === "recover" ? 2 : 1);
        results.push(`${view}/${action}/${mode}`);
    } finally { await page.close(); }
}
try {
    browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    for (const [view, actions] of [["payment", ["claim", "receipt", "cancel"]], ["enrollment", ["submit", "cancel"]]]) {
        for (const action of actions) {
            for (const mode of ["reject", "400", "500", "invalid", "ok", "hold", "refresh-fail", "lost-accepted", "recover"]) await scenario(view, action, mode);
        }
    }
    await mkdir(".tmp/parent-request-network", { recursive: true });
    await writeFile(".tmp/parent-request-network/browser.json", JSON.stringify({ passed: results.length, results, productionRequests: 0, syntheticData: true }, null, 2));
    console.log(`PASS ${results.length}/${results.length}: 학부모 요청 통신 실패·접수 결과 확인`);
} finally {
    await browser?.close();
    await harness.close();
}
