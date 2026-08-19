import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";

export const runtime = "nodejs";
export const alt = "AwardPing - Nationally Competitive Award Monitor";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const serifFont = readFile(new URL("./source-serif-4-semibold.ttf", import.meta.url));
const sansFont = readFile(new URL("./geist-sans-600.ttf", import.meta.url));
const sansFontBold = readFile(new URL("./geist-sans-700.ttf", import.meta.url));

const INK = "#17150f";
const ACCENT = "#1c4e80";
const PAPER = "#ffffff";
const MUTED = "#6f6b66";

export default async function OpenGraphImage() {
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
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg fill="none" height="56" viewBox="0 0 28 28" width="56">
            <circle cx="14" cy="14" r="12" stroke={INK} strokeWidth="2.2" />
            <circle cx="14" cy="14" opacity="0.45" r="7" stroke={INK} strokeWidth="1.8" />
            <circle cx="14" cy="14" fill={ACCENT} r="2.6" />
          </svg>
          <div style={{ display: "flex", fontFamily: '"Geist", Arial, sans-serif', fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>
            <span style={{ color: INK }}>Award</span>
            <span style={{ color: ACCENT }}>Ping</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              color: ACCENT,
              fontFamily: '"Geist", Arial, sans-serif',
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: 4,
              textTransform: "uppercase",
            }}
          >
            Nationally competitive award monitoring
          </div>
          <div style={{ color: INK, fontSize: 64, fontWeight: 600, lineHeight: 1.1, maxWidth: 980 }}>
            The early-warning system for nationally competitive fellowships.
          </div>
          <div style={{ color: MUTED, fontFamily: '"Geist", Arial, sans-serif', fontSize: 26, lineHeight: 1.4, maxWidth: 900 }}>
            Official award pages, PDFs, and deadlines watched continuously - meaningful changes in plain English.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderTop: `2px solid #e2e0dc`,
            color: MUTED,
            fontFamily: '"Geist", Arial, sans-serif',
            fontSize: 22,
            paddingTop: 28,
          }}
        >
          awardping.com
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: "Source Serif 4",
          data: await serifFont,
          weight: 600,
          style: "normal",
        },
        {
          name: "Geist",
          data: await sansFont,
          weight: 600,
          style: "normal",
        },
        {
          name: "Geist",
          data: await sansFontBold,
          weight: 700,
          style: "normal",
        },
      ],
    },
  );
}
