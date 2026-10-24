function readEnv(name) {
  return typeof process.env[name] === "string" ? process.env[name].trim() : "";
}

const DEFAULT_PUBLIC_SITE_URL = "https://www.stiz-dasan.kr";

function inferTossKeyMode(key) {
  if (key.startsWith("test_")) return "test";
  if (key.startsWith("live_")) return "live";
  return "unknown";
}

function modeLabel(mode) {
  if (mode === "test") return "테스트 결제";
  if (mode === "live") return "실거래 결제";
  return "확인 필요";
}

function makeUrl(origin, path, invoiceId) {
  const url = new URL(path, origin);
  url.searchParams.set("invoiceId", invoiceId);
  return url.toString();
}

const scope = (readEnv("RELEASE_ENV_SCOPE") || readEnv("VERCEL_ENV") || "local").toLowerCase();
const rawProvider = (readEnv("PAYMENT_PROVIDER") || readEnv("NEXT_PUBLIC_PAYMENT_PROVIDER") || "TOSS").toUpperCase();
const provider = ["CAFE24", "CAFE24_BRIDGE", "CAFE24_PAYMENT", "STIZ_CAFE24"].includes(rawProvider)
  ? "CAFE24_BRIDGE"
  : "TOSS";
const clientKey = readEnv("NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY") || readEnv("TOSS_PAYMENTS_CLIENT_KEY");
const secretKey = readEnv("TOSS_PAYMENTS_SECRET_KEY");
const cafe24BridgeUrl = readEnv("CAFE24_PAYMENT_BRIDGE_URL") || readEnv("STIZ_CAFE24_PAYMENT_API_URL");
const cafe24BridgeSecret = readEnv("CAFE24_PAYMENT_BRIDGE_SECRET") || readEnv("STIZ_PARTNER_SECRET");
const configuredSiteUrl = readEnv("NEXT_PUBLIC_SITE_URL");
const siteUrl = configuredSiteUrl || DEFAULT_PUBLIC_SITE_URL;
const errors = [];
const warnings = [];

if (provider === "TOSS" && !clientKey) {
  errors.push("토스 공개키가 필요합니다. NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY 또는 TOSS_PAYMENTS_CLIENT_KEY를 설정하세요.");
}
if (provider === "TOSS" && !secretKey) {
  errors.push("토스 서버키가 필요합니다. TOSS_PAYMENTS_SECRET_KEY를 설정하세요.");
}
if (provider === "CAFE24_BRIDGE" && !cafe24BridgeUrl) {
  errors.push("본사 카페24 결제 브리지 URL이 필요합니다. CAFE24_PAYMENT_BRIDGE_URL 또는 STIZ_CAFE24_PAYMENT_API_URL을 설정하세요.");
}
if (provider === "CAFE24_BRIDGE" && !cafe24BridgeSecret) {
  errors.push("본사 카페24 결제 서명키가 필요합니다. CAFE24_PAYMENT_BRIDGE_SECRET 또는 STIZ_PARTNER_SECRET을 설정하세요.");
}
if (provider === "CAFE24_BRIDGE" && cafe24BridgeSecret && !/^[a-fA-F0-9]{64}$/.test(cafe24BridgeSecret)) {
  errors.push("본사 카페24 결제 서명키는 64자 hex 형식이어야 합니다.");
}
if (provider === "CAFE24_BRIDGE" && cafe24BridgeUrl) {
  try {
    const bridgeOrigin = new URL(cafe24BridgeUrl).origin;
    if (!/^https?:\/\//i.test(bridgeOrigin)) errors.push("본사 카페24 결제 브리지 URL은 http 또는 https 주소여야 합니다.");
  } catch {
    errors.push("본사 카페24 결제 브리지 URL 형식이 올바르지 않습니다.");
  }
}

const clientMode = inferTossKeyMode(clientKey);
const secretMode = inferTossKeyMode(secretKey);
const keyPairReady = Boolean(clientKey && secretKey && clientMode !== "unknown" && clientMode === secretMode);

if (provider === "TOSS" && clientKey && clientMode === "unknown") {
  errors.push("토스 공개키 형식을 확인할 수 없습니다. test_ 또는 live_ 키를 사용하세요.");
}
if (provider === "TOSS" && secretKey && secretMode === "unknown") {
  errors.push("토스 서버키 형식을 확인할 수 없습니다. test_ 또는 live_ 키를 사용하세요.");
}
if (provider === "TOSS" && clientKey && secretKey && clientMode !== secretMode) {
  errors.push("토스 공개키와 서버키의 테스트/실거래 종류가 서로 다릅니다.");
}
if (provider === "TOSS" && scope === "production" && keyPairReady && clientMode === "test") {
  errors.push("운영 배포에는 토스 실거래 키가 필요합니다.");
}
if (provider === "TOSS" && scope === "preview" && keyPairReady && clientMode === "live") {
  warnings.push("미리보기 환경에서 실거래 키를 사용 중입니다.");
}
if (!configuredSiteUrl) {
  warnings.push(`NEXT_PUBLIC_SITE_URL이 없어 기본 운영 주소(${DEFAULT_PUBLIC_SITE_URL})로 URL을 점검합니다.`);
}

let origin = "";
try {
  origin = new URL(siteUrl).origin;
  if (!/^https?:\/\//i.test(origin)) {
    errors.push("사이트 주소는 http 또는 https 주소여야 합니다.");
  }
  if (scope === "production" && (!origin.startsWith("https://") || /localhost/i.test(origin))) {
    errors.push("운영 사이트 주소는 localhost가 아닌 https 주소여야 합니다.");
  }
} catch {
  errors.push("사이트 주소 형식이 올바르지 않습니다.");
}

console.log("[온라인 결제 점검]");
console.log(`- 범위: ${scope}`);
console.log(`- 결제 제공자: ${provider === "CAFE24_BRIDGE" ? "본사 카페24" : "토스페이먼츠"}`);
if (provider === "TOSS") {
  console.log(`- 결제 모드: ${keyPairReady ? modeLabel(clientMode) : "준비 필요"}`);
  console.log(`- 공개키: ${clientKey ? "있음" : "없음"}`);
  console.log(`- 서버키: ${secretKey ? "있음" : "없음"}`);
} else {
  console.log(`- 본사 브리지 URL: ${cafe24BridgeUrl ? "있음" : "없음"}`);
  console.log(`- 본사 서명키: ${cafe24BridgeSecret ? "있음" : "없음"}`);
}

if (origin) {
  const successPath = provider === "CAFE24_BRIDGE" ? "/payments/cafe24/success" : "/payments/success";
  const webhookPath = provider === "CAFE24_BRIDGE" ? "/api/payments/cafe24/webhook" : "/api/payments/toss/webhook";
  console.log(`- 성공 복귀 주소: ${makeUrl(origin, successPath, "invoice-id")}`);
  console.log(`- 실패 복귀 주소: ${makeUrl(origin, "/payments/fail", "invoice-id")}`);
  console.log(`- 콜백/웹훅 등록 주소: ${new URL(webhookPath, origin).toString()}`);
}

warnings.forEach((message) => console.warn(`[주의] ${message}`));

if (errors.length > 0) {
  console.error(`\n[실패] 결제 설정에서 ${errors.length}개 항목을 확인해야 합니다.`);
  errors.forEach((message) => console.error(`- ${message}`));
  process.exit(1);
}

console.log("\n[통과] 실제 결제 요청 없이 결제 설정 형식을 확인했습니다.");
