import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startStatusBrowserHarness } from "./helpers/status-browser-harness.mjs";

const recordActions = `
  export const readInboxKakaoRequest = async (id) => ({ schemaReady:true, status:"ALL", classes:[], rows:[{
    id, kind:"OTHER", status:id==="notice" ? "APPROVED" : "SUBMITTED", revision:"same-row-revision", sourceText:"합성 요청", createdAt:"2026-11-11T02:00:00Z",
    studentId:"synthetic", studentName:"합성학생", identityStatus:"ACTIVE", currentClassIds:[], linkedStudents:[], commands:id==="notice" ? [{parentReconfirmationRequired:true,parentConfirmed:false}] : []
  }] });
  export const readInboxWithdrawal = async (id) => ({ administrativeHold:id==="held", activeEnrollments:0 });
  export const readInboxSeasonalAbsence = async () => ({ ...window.absence });
  export const readInboxSeasonalMakeup = async () => ({status:window.makeupStatus});
  export const readInboxSeasonalMakeupOptions = async () => ({
    absence:{enrollmentDateId:"a-seat"},alreadyAssigned:null,seasonalCandidates:[{sessionDateId:"s-date",label:"11/21(토)"}],regularCandidates:[],
  });
  export const assignInboxSeasonalMakeup = async (absenceId,enrollmentDateId,target) => {
    window.calls.push(["assign-guard",absenceId,enrollmentDateId,target.targetSessionDateId]);
    if (window.absence.resolution !== "MAKEUP") return {ok:false,reason:"SOURCE"};
    window.calls.push(["assign",absenceId]); return {ok:true,id:"makeup-id",status:"SCHEDULED"};
  };
  export const decideInboxSeasonalMakeup = async (id,status,decision) => {
    window.calls.push(["makeup",id,status,decision]); window.makeupStatus="SCHEDULED"; return {ok:true};
  };
  export const readInboxMediaRevocation = async () => ({channel:"INSTAGRAM",status:"MANUAL_REQUIRED",resourceUrl:null});
  export const retryInboxMediaRevocation = async () => {throw new Error("unexpected media retry")};
`;

const harness = await startStatusBrowserHarness({
  mocks: {
    "@/app/admin/inbox/specialized-actions": recordActions,
    "@/app/actions/account-withdrawal-admin": `
      export const approveWithdrawalRequest = async (id) => { window.calls.push(["approve-withdrawal",id]); return {ok:true} };
      export const rejectWithdrawalRequest = async (id) => { window.calls.push(["reject-withdrawal",id]); return {ok:true} };
    `,
    "@/app/actions/media-revocations": `
      export const confirmInstagramMediaRemoved = async (form) => {window.calls.push(["media",form.get("jobId"),form.get("evidence")]);};
    `,
    "@/app/actions/seasonal-absence-admin": `
      export const resolveSeasonalAbsence = async ({absenceId,resolution}) => {
        window.calls.push(["resolve",absenceId,resolution]); window.absence.resolution=resolution;
      };
      export const confirmSeasonalAbsence = async ({absenceId}) => {
        window.calls.push(["confirm",absenceId]); window.absence.status="CONFIRMED";
      };
      export const revertSeasonalAbsenceConfirm = async ({absenceId}) => {
        window.calls.push(["revert",absenceId]); window.absence.status="REPORTED";
      };
    `,
    "@/app/actions/kakao-parent-intake-admin": `
      export const decideKakaoParentIntake = async (input) => {window.calls.push(["kakao",input.intakeId,input.expectedRevision,input.decision,input.note]); return {ok:true};};
    `,
    "@/app/actions/kakao-reconfirmation-notice": `
      export const prepareKakaoReconfirmationNotice = async (id) => {
        window.calls.push(["notice-preview",id]);
        return {approvalId:"synthetic-preview",intakeId:id,studentName:"합성학생",message:"합성 미리보기",url:"https://example.invalid/synthetic",expiresAt:"2026-11-30T10:00:00Z",maskedRecipient:"***-****-0000"};
      };
      export const sendKakaoReconfirmationNotice = async () => {throw new Error("unexpected send")};
    `,
    "@/app/actions/kakao-shuttle-roster-task": `
      export const completeKakaoShuttleRosterTask = async () => {throw new Error("unexpected roster write")};
    `,
    "@/app/actions/customer-notice": `
      export const prepareCustomerNotice = async () => {throw new Error("unexpected preview")};
      export const sendCustomerNotice = async () => {throw new Error("unexpected send")};
    `,
  },
  entry: `import {createElement} from "react";
    import {createRoot} from "react-dom/client";
    import Specialized from "@/app/admin/inbox/InboxSpecializedActions";
    window.calls=[]; window.refreshes=0; window.makeupStatus="REQUESTED"; window.absence={status:"REPORTED",resolution:"PENDING"};
    const query=new URLSearchParams(location.search);
    createRoot(document.getElementById("root")).render(createElement(Specialized,{
      row:{id:query.get("id")??"selected",kind:query.get("kind"),rawStatus:query.get("status")??"REQUESTED",summary:"합성 신청"},
      onChanged:()=>{window.refreshes++},
    }));`,
});

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.STATUS_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  async function check(kind, id, run, expected) {
    const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
    const errors = [];
    const requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const { origin, pathname } = new URL(route.request().url());
      if (origin === harness.url && ["/", "/bundle.js"].includes(pathname)) return route.continue();
      requests.push(pathname);
      return route.abort();
    });
    const url = `${harness.url}/?kind=${kind}&id=${id}`;
    await page.goto(url);
    await run(page);
    assert.deepEqual(await page.evaluate(() => window.calls), expected);
    assert.equal(page.url(), url);
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${kind} ${id}`);
  }

  await check("SEASONAL_ABSENCE", "a", async page => {
    const confirm = page.getByRole("button", {name:"결석 확정",exact:true});
    await confirm.waitFor();
    assert.equal(await confirm.isEnabled(), false);
    await page.getByLabel("결석 처리 방식").selectOption("MAKEUP");
    await page.getByRole("button", {name:"방식 저장"}).click();
    await confirm.click();
    await page.getByRole("button", {name:"보강 수업 조회"}).click();
    await page.getByLabel("보강 수업").selectOption("s-date");
    await page.getByRole("button", {name:"보강 배정",exact:true}).click();
    await page.evaluate(() => {window.absence.resolution="REFUND";});
    await page.getByRole("dialog").getByRole("button", {name:"배정",exact:true}).click();
    await page.getByRole("alert").getByText(/결석 처리 방식이 바뀌었습니다/).waitFor();
  }, [["resolve","a","MAKEUP"],["confirm","a"],["assign-guard","a","a-seat","s-date"]]);
  await check("SEASONAL_MAKEUP", "m", async page => {
    await page.getByRole("button", {name:"승인",exact:true}).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", {name:"그만"}).click();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    await page.getByRole("button", {name:"승인",exact:true}).click();
    await dialog.getByRole("button", {name:"승인",exact:true}).click();
    await page.getByRole("button", {name:"출석 확정",exact:true}).waitFor();
    assert.equal(await page.getByRole("button", {name:"승인",exact:true}).count(),0);
  }, [["makeup","m","REQUESTED","APPROVE"]]);
  await check("WITHDRAWAL", "held", async page => {
    await page.getByText("업무·권한 이관 후 처리해 주세요.").waitFor();
    assert.equal(await page.getByRole("button", {name:"탈퇴 처리"}).count(),0);
    assert.equal(await page.getByRole("button", {name:"신청 반려"}).count(),0);
  }, []);
  await check("WITHDRAWAL", "clear", async page => {
    await page.getByRole("button", {name:"탈퇴 처리",exact:true}).click();
    await page.getByRole("dialog").getByText(/되돌릴 수 없습니다/).waitFor();
    await page.getByRole("button", {name:"정말 삭제",exact:true}).click();
  }, [["approve-withdrawal","clear"]]);
  await check("MEDIA_REVOCATION", "p", async page => {
    const confirm = page.getByRole("button", {name:"외부 삭제 확인",exact:true});
    await confirm.waitFor();
    assert.equal(await confirm.isEnabled(),false);
    await page.getByLabel("외부 삭제 확인 근거").fill("합성 삭제 근거");
    await confirm.click();
    await page.getByRole("dialog").getByRole("button", {name:"확인 저장",exact:true}).click();
  }, [["media","p","합성 삭제 근거"]]);
  await check("KAKAO", "k", async page => {
    await page.getByLabel("검토 및 상담 처리 사유").fill("합성 사유");
    await page.getByRole("button", {name:"추가 확인",exact:true}).click();
    assert.equal(await page.getByRole("navigation", {name:"접수 상태 필터"}).count(),0);
    assert.equal(await page.getByRole("dialog").count(),0);
  }, [["kakao","k","same-row-revision","NEEDS_DETAILS","합성 사유"]]);
  await check("KAKAO", "notice", async page => {
    await page.getByRole("button", {name:/재확인 링크·안내 준비/}).click();
    const preview = page.getByRole("region", {name:"재확인 안내 미리보기"});
    await preview.waitFor();
    assert.equal(await preview.getByRole("textbox", {name:"재확인 안내 문구"}).inputValue(), "합성 미리보기");
    const confirmation = page.waitForEvent("dialog");
    const send = preview.getByRole("button", {name:/미리보기 승인 후 SMS/}).click();
    await (await confirmation).dismiss();
    await send;
    await preview.getByRole("button", {name:"미리보기 닫기"}).click();
    assert.equal(await preview.isVisible(),false);
  }, [["notice-preview","notice"]]);
} finally {
  await browser?.close();
  await harness.close();
}
