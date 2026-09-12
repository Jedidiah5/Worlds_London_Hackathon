import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "THE LOOP HOUSE",
  description:
    "A world-model time loop. The house resets. You remember. Find the key.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
