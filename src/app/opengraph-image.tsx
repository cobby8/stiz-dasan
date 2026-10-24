import { ImageResponse } from "next/og";
import { PUBLIC_SITE_NAME } from "@/lib/publicMetadata";

// 브랜드 육각 심볼(흰색) — 파비콘/앱 아이콘과 동일한 마크를 소셜 공유 이미지에도 사용
const MARK_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAABmJLR0QA/wD/AP+gvaeTAAANVUlEQVR4nO3de/BndV3H8ddnWViwHWVRQNDYuGiygmJCgJOLZJODheYQo0Zp5Jhh42UXIyWUMC9xD5UmQBEdVDSs8TYyFdZwsWQjEJvdZBdZiw1EWkEXlr0+++N8qZX5wZ7P5/c+v8853/N6/Lv7O5/X95zz/p7L93ORzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMrLJUO0AfALtK+rqkA2tn6YkNkl6RUrqvdpDa5tcO0BOnSXp57RA9c46kt9QOUdvoryDAMyTdKWlR7Sw9s13SMSmlFbWD1DSvdoAe+IBcHDOZJ+mC2iFqG/UVBHihpFsl7VI7S4+9LqX0+dohahl7gXxD0vG1c/Tc9yUtSSk9UjtIDaO9xQJOkoujjcWS/rh2iFpGeQUBdpe0Un6t29ZGNVeRtbWDzLWxXkFOl4sjxx6SPlQ7RA2ju4IAz5a0StLC2lkGaGlK6cbaIebSGK8g75eLo9QFwKjOmVFdQYBjJN2svC+G/5b0JklbOwlVxxJJlxT+7akppasCs1gfAAm4mXyvqp29C8BnC/YFwH3AU2vnt2DAKQUnw3W1c3cF2B94qLBIzq+d3wIBC4F1mSfBJuCw2tm7BLyzsEA2AQfXzm9BgHMKToKLaufuGjAfuKOwSP6mdn4LABwIbMw8+KO5zwaOA7YXFomHCAwd8IWCA/97tXPPJeCqwgL5DuAxRUMF/ErBQb+Fkb3rB/YD1hcWyR/Wzm8FgF2A2zMP9jbgpbWz1wC8o7BAHgCeXju/ZQLeXHCwr66duxaaL5RvFxbJ1L/QmCrAXsD9mQf5JzT9tEYLOIayB/YtwPNr57eWgIsKDvK7a+fuA+DjBfsOpvhH1akCLAE2Zx7c7wELamfvA2Bvyh/YX107v+0E8LWCA3ti7dx9Ary1sEDuwl80/QX8asFB/bvaufuG5oF9RWGRLK+d32YA7AqsyjyYm4Hn1c7eR8CRwNaCAnkQ2Ld2fnscyt7jX1g7d59R9rID4Ira2aNMxYApYB9JqyXl9J9aJ+nwlNKPAnNcI+moqO1lWCDpKR1sd3c149FzbZd0bErpluA8c25a+tGcrbzikKSzg4vj1yS9Nmp7AzdP0oXA0pQStcPMxuCvIMARkv5VebMjflPSL0UdPJo3NyslHRSxvSlyckrp2tohZmMaOuV9RHnFgaRlwd9sy+TimMlFQBe3fnNm0AUCnCwpt3PhZyLvjYFnSjozantT5mclvat2iNkY7C3W5JtplaQDMv5sg6RDUko/CMxxpaRTo7Y3hTZKOjSl9P3aQUoM+QryNuUVhyS9N7g4XizpjVHbm1J7SPpg7RClBnkFAZ6lZtGbnPvbVZJemFLaEpQhSbpJ0ksitjflkHTcEGdlHOoV5M+U/95/WVRxTJwkF0dbSc2sjIP7Qh5cYOAlkm5UXnF/JaUUNgHc5Pnnu5JGPX6kwOBmZRzUFWTyDXSh8nJvVvMaNtJyuThKnMvAZosZVIFI+m1Jx2T+zXkppbuiAgD7S3pP1PZGZh8NbDGewdxiTb55VknaP+PP1kl6XkppQ2COz0p6fdT2RmiTmj5wq2sHaWNIV5AzlFccknRGcHEcK+l1UdsbqQVqbpMHYRBXEJp5YP9dTe/Stm6Q9LLILiU0S7eV9G6dZsslnVXwdyeklDyOPQLwxczxCFuAI2vnHgNgN8rm910F7Fo7/+BRNoz28tq5xwQ4mmbSvVxvq5190CibHXE9sHft7GMD/FVBgawH9qydfbCA0wp2ur+VKgD2BO4tOF4frZ19kIBF5M+OuBLPNl4NcHJBgWwBltTOPjjAXxTs7ONr5x474NqC4/YPtXMPCnAo+bMjesWjHgAOAB4uKJLX1M4+GMB1mTv3YWBx7dzWAJYXFMhqYLfa2XsPeGXBzj27dm77f8A84J8LjuMf1c7ea8AC4M7MnboG+Jna2e2nAS+geQDP8RCelfGJUXZp9lxUPQWcV3A8r6ydu5eAfYENmTvTE0/3GPAUmit8jm3AL9TO3jvAFZk7citwWO3c9uSA48lfterm2rl7BTic/L48l9XObe0An848ttDMeWZAAm7M3Hn345VVB4Nm1aoHMo/xWgY2PLcTwFPJX/LL/a0GBjg18xhvAg6pnbsXA6aAZZLaLiW8WdIb1EyxP0S3pZTWRG0MeJHyllxA0oMt/t+NKaX7ylLN0Ggz4cadktqe9JellP4gqv1SfSmQ3STdIenna2fp2DZJL0opfSdiY5NbkO9KembE9nbwQ0nPTSm1KaRWgKWS/kntzrmH1EwR+0BU+6V6MSY9pbRZ0hiWYf5YVHFM/Knii0NqpmiNLI75kj6q9l/IH+hDcfQO8PXM+9Qh+SGwV+C+ej75HTrbuBUI/eIE3p7R/p14KO7MKFvjfCjeEryvvtFBxu3AccE59yXvDdYrI9ufOsDFHRz42u4Achb52dk+em1HOa+JyrhD1isz2v9qdPuz1YuH9B0Bi9QsyDktv3MgaWlK6aaQjTVTD61W/NSnj0g6LKV0d9QGaWaW+ZbaPetuUTP7/qqo9iP04iF9R5OFNd9XO0ega6KKY+IsdTMv8CXBxTFP0qVqf45d2rfikHp4BZGa2Uwk3Sbp8NpZZulhNVOf3hOxMeC5km5X/OR196jJ+XDUBoHflfTJlv89/LVylN5dQSQppbRN0jtq5whwblRxTJynbmZ2fF9wcSySdH7Gn5zVx+LoPfJnVOyTtTTPC1H74oSOct5C8MI2wCUZ7d9K4AuMUQEWAxs7OCnmQuSCPSUjLdvYDuQuJ7GzrC8g71V9r2ei6eUt1mMmK6NeUjtHgetTSl8O3N5ySc8J3N5jrk4p/UvUxmiuRBdLavtD37UppX+Mar8LvXxI3xGwUNIaSUMZq7xF0hEppZURGwOerWZdlIUR29vBRklLUkprozYInCLp6pb//VE1r5XDFjfqQq+vIJI0Wd/jzNo5MlweVRwTH1R8cUjNC4S1URujmTjjwxl/ckHfi2MwaKaRWRF8/92F+4GnBX7uXyZ/uGob9wChb8OAD2W0fy+eiSYWcGxHJ0ukNwd+3l3Jn9m+rdCZYIADgUcz2j8lsn2bAD7TzfkS4t8I7AULvLWjnOEPxeTNhHkTA1wvfRCAZwE/6eS0mZ3twEsDP+f+5A9DbmMr8OKonJOsJ2bup2Mj27fHAd7bwYkzW58L/owli9G0ETopG83vM3dntP+JyPZtBpODclcXZ0+hDUDYqD7gSMqWM9uZB4F9onJOsp6Z0f6Pgf0i27cnQHfjIUr8SeDnmgd8q+85J1kXk9fLwRNTzyXg+k5OozxriO1v9YaOct5F8NICwDUZ7d8d3b7tBN3diuQ4KfDz7AX8T0c5fyMq5yTr8Znt/2Zk+9YS8PEOTqa2rgv+LB/pKGfoBN80t4E566JfH9m+ZaCZ0rKL16E7sxk4NPBzLKF5BRstfKZ04J2Z++mIyPYtE7CsgxNrZy4OzD8PuKGjnFdE5Zxk3ZvmbVRbl0a2bwWA+cCqTk6vmf0A2DMwf1dv5NYDe0flnGS9KrP9Z0S2b4XI+zV3tiL7Wy0E/qujnO+KyjnJ+ovkvRQ5PbL9WqamTwzwZUkndtzMCklHp5SI2BjNEg6v0czDDjZJWle6aUk3pJS2lGb7qY01fcxuldT2eeI/1Iz12BbRvgUADiGvR2mu0P5WQwK8KXNfnVA7s82AskUj2/pU7c9XA7CI5rmrrS/VzmxPAHga+SsZtRHa32pIyPt9ZhMw7UtYDBtwWgcFMsp+RDQzlGzK2E/n1c5sOwHsAtwWWByrgQW1P1cN5P0+cy9eU3AYgJcRNzz312t/nhqA38rcT79fO7NlAL4QUBy9m45/LtD8PrM2Yz+FL7pjHQMOAB6ZRXE8Ciyp/TlqAM7P2E/hi+7YHCFvKprHu6B2/hqAg8kbCPXXtTNbIWAPYF1BcdxL4PxWQwJ8NWM/PQL8XO3MNgvAKQUF8sbauWsgv0/b+2tntlkCEs1cTG2tYITzNgG7Aysz9tN/4tkRpwNwNO16om4Hjqqdtwbyp1P6ndqZLRDtxjKMtb/VYvIm5PsmI7zKTjVgP558NNxDjLe/1ecyimM7zeq1Nm2AM57kwL+ndr4agKUZxQEjmx1xVJdJmjms7tDMqzV9T9KP5jZRLxwsqe0Q4h9Lek5K6f4O8/TK/NoB5lJK6VHgDEl/O8M/HzTXeQboz8dUHNLIriDS/62j9/eSXl47y8CsUbNkW8gw3qEYXQezyXjy0yV5vHSed4+tOKQRFogkpZS+Lemy2jkG5PqU0hdrh6hhdLdYjwH2UvNgPso+Vxm2SjoqpXR77SA1jPIKIkkppfWSzqmdYwD+cqzFIY34CiI1C2VKul3SKMd9tPCgpINSSmN8/S1pZK95Hy+ltAV4u6TLa2fpqXPHXBxmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmbWC/8LMi7OOumBd5MAAAAASUVORK5CYII=";

export const alt = "STIZ 농구교실 다산2호점";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#07101f",
          color: "white",
          padding: "58px 68px",
          position: "relative",
          overflow: "hidden",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            right: "-60px",
            top: "-90px",
            width: "420px",
            height: "420px",
            borderRadius: "999px",
            border: "56px solid rgba(204,255,0,0.16)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "-120px",
            bottom: "-150px",
            width: "520px",
            height: "520px",
            borderRadius: "999px",
            border: "70px solid rgba(255,106,0,0.18)",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
            <div
              style={{
                width: "74px",
                height: "74px",
                borderRadius: "22px",
                background: "#ff6a00",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={MARK_SRC} width={52} height={52} alt="STIZ" style={{ display: "block" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: "34px", fontWeight: 900, letterSpacing: "0" }}>STIZ</div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#ccff00" }}>BASKETBALL CLUB DASAN</div>
            </div>
          </div>
          <div
            style={{
              borderRadius: "999px",
              background: "#ccff00",
              color: "#07101f",
              padding: "14px 24px",
              fontSize: "22px",
              fontWeight: 900,
            }}
          >
            Trial Class Open
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "840px", zIndex: 1 }}>
          <div style={{ fontSize: "72px", lineHeight: 1.05, fontWeight: 900, letterSpacing: "0" }}>
            Dasan No.1 Youth Basketball Academy
          </div>
          <div style={{ fontSize: "30px", lineHeight: 1.35, color: "#c8d2e3", fontWeight: 700 }}>
            Professional coaching, level-based classes, shuttle guidance, and easy trial enrollment.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", zIndex: 1 }}>
          <div style={{ display: "flex", gap: "14px" }}>
            {["Kids", "Elementary", "Middle School", "Trial"].map((label) => (
              <div
                key={label}
                style={{
                  borderRadius: "999px",
                  background: "rgba(255,255,255,0.12)",
                  border: "1px solid rgba(255,255,255,0.2)",
                  padding: "12px 18px",
                  fontSize: "20px",
                  fontWeight: 800,
                }}
              >
                {label}
              </div>
            ))}
          </div>
          <div style={{ fontSize: "24px", fontWeight: 900, color: "#ccff00" }}>{PUBLIC_SITE_NAME}</div>
        </div>
      </div>
    ),
    size,
  );
}
