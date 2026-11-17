import { optimizedImageProps } from "@/lib/ui/optimizedImage";
import Link from "next/link";

// 홈 3단계 · 프로그램 사진 타일(2026-11-07) — 사진이 있는 공개 프로그램만 큰 사진 칸으로 보여 준다.
// 누르면 프로그램 안내(/programs)로 간다. 가격·신청은 안내 화면에 그대로 있다.
export interface HomeProgramTile {
    id: string;
    name: string;
    targetAge: string | null;
    imageUrl: string;
}

export default function HomeProgramTiles({ programs }: { programs: HomeProgramTile[] }) {
    if (programs.length === 0) return null;
    return (
        <section className="public-home-programs" aria-labelledby="public-home-programs-title">
            <div className="public-home-programs__heading">
                <h2 id="public-home-programs-title">프로그램</h2>
                <Link href="/programs">전체 프로그램 보기 <span aria-hidden="true">→</span></Link>
            </div>
            <ul>
                {programs.map((program) => (
                    <li key={program.id}>
                        <Link href="/programs" aria-label={`${program.name} 안내 보기`}>
                            {/* 타일은 휴대폰 2칸·PC 5칸. PC 타일은 세로로 긴 칸이라 가로 사진이 약 1.6배로 확대돼 그려진다 — 20vw 가 아니라 33vw 로 받는다 */}
                            <img {...optimizedImageProps(program.imageUrl, "(max-width: 767px) 50vw, 33vw", 828)} alt="" loading="lazy" decoding="async" />
                            <span className="public-home-programs__text">
                                <strong>{program.name}</strong>
                                {program.targetAge && <span>{program.targetAge}</span>}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    );
}
