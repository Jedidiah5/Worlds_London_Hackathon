import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "THE LOOP HOUSE",
  description:
    "A world-model time loop. The building resets. You remember. Find the key.",
};

// Lock the viewport so the look-drag pad cannot pinch-zoom or rubber-band.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#050505",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* Browser extensions (ColorZilla's cz-shortcut-listen, Grammarly, password
          managers) inject attributes onto <body> before React hydrates, which
          React reports as a mismatch. Nothing here renders differently on the
          server, so suppressing the body-level warning is the correct fix. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
