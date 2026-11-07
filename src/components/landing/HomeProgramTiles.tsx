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
                            <img src={program.imageUrl} alt="" loading="lazy" decoding="async" />
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
