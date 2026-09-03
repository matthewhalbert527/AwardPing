import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { getPublicAwardPageBySlug } from "@/lib/public-award-pages";

export const runtime = "nodejs";
export const alt = "AwardPing award record";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Lazy, realm-independent font loads: a module-scope readFile(new URL(...))
// rejects under the bundled runtime and the unhandled rejection at module
// evaluation killed every request on routes sharing this chunk.
const fontPath = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url).href);
const loadFont = (relative: string) => readFile(fontPath(relative));

const INK = "#17150f";
const ACCENT = "#1c4e80";
const PAPER = "#ffffff";
const MUTED = "#6f6b66";
const HAIRLINE = "#e2e0dc";

export default async function AwardOpenGraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const award = hasSupabaseAdminConfig()
    ? await getPublicAwardPageBySlug(slug).catch(() => null)
    : null;

  const name = award?.award.name ?? "The early-warning system for nationally competitive fellowships.";
  const kicker = award ? "Nationally competitive award" : "Nationally competitive award monitoring";
  const deadline = award?.facts.deadline ?? null;
  const sourceCount = award ? award.sources.length : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          padding: 72,
          fontFamily: '"Source Serif 4", Georgia, serif',
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg fill="none" height="48" viewBox="0 0 28 28" width="48">
            <circle cx="14" cy="14" r="12" stroke={INK} strokeWidth="2.2" />
            <circle cx="14" cy="14" opacity="0.45" r="7" stroke={INK} strokeWidth="1.8" />
            <circle cx="14" cy="14" fill={ACCENT} r="2.6" />
          </svg>
          <div style={{ display: "flex", fontFamily: '"Geist", Arial, sans-serif', fontSize: 34, fontWeight: 700, letterSpacing: -1 }}>
            <span style={{ color: INK }}>Award</span>
            <span style={{ color: ACCENT }}>Ping</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              color: ACCENT,
              fontFamily: '"Geist", Arial, sans-serif',
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: 4,
              textTransform: "uppercase",
            }}
          >
            {kicker}
          </div>
          <div style={{ color: INK, fontSize: 66, fontWeight: 600, lineHeight: 1.08 }}>{name}</div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "row",
            gap: 56,
            borderTop: `2px solid ${HAIRLINE}`,
            paddingTop: 30,
            fontFamily: '"Geist", Arial, sans-serif',
          }}
        >
          {deadline && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ color: MUTED, fontSize: 18, fontWeight: 600, letterSpacing: 3, textTransform: "uppercase" }}>
                Deadline
              </div>
              <div style={{ color: INK, fontSize: 30, fontWeight: 600 }}>{deadline}</div>
            </div>
          )}
          {sourceCount !== null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ color: MUTED, fontSize: 18, fontWeight: 600, letterSpacing: 3, textTransform: "uppercase" }}>
                Monitored sources
              </div>
              <div style={{ color: INK, fontSize: 30, fontWeight: 600 }}>{`${sourceCount} official pages`}</div>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginLeft: "auto" }}>
            <div style={{ color: MUTED, fontSize: 22 }}>awardping.com</div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: "Source Serif 4",
          data: await loadFont("../source-serif-4-semibold.ttf"),
          weight: 600,
          style: "normal",
        },
        {
          name: "Geist",
          data: await loadFont("../geist-sans-600.ttf"),
          weight: 600,
          style: "normal",
        },
        {
          name: "Geist",
          data: await loadFont("../geist-sans-700.ttf"),
          weight: 700,
          style: "normal",
        },
      ],
    },
  );
}
