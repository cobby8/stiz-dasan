import { NextRequest,NextResponse } from "next/server";import{applyOperationalDataRetention}from"@/lib/dataRetention";export const dynamic="force-dynamic";async function handleGet(req:NextRequest){const secret=process.env.CRON_SECRET;if(process.env.NODE_ENV!=="development"&&(!secret||req.headers.get("authorization")!==`Bearer ${secret}`))return NextResponse.json({error:"Unauthorized"},{status:401});return NextResponse.json({ok:true,...await applyOperationalDataRetention()})}
import { withCronAlert } from "@/lib/cron/withCronAlert";

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("data-retention", handleGet);
