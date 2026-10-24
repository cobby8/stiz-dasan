import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyOperationsEventSignature(params: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowMs?: number;
}) {
  const timestampSeconds = Number(params.timestamp);
  if (!Number.isInteger(timestampSeconds)) return false;
  // 오래된 서명을 다시 보내 원장을 오염시키는 재생 공격을 막는다.
  if (Math.abs((params.nowMs ?? Date.now()) - timestampSeconds * 1000) > 5 * 60_000) return false;

  const suppliedHex = params.signature?.replace(/^sha256=/, "") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const expected = Buffer.from(
    createHmac("sha256", params.secret).update(`${params.timestamp}.${params.rawBody}`).digest("hex"),
    "hex",
  );
  const supplied = Buffer.from(suppliedHex, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
