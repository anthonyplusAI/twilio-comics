import type React from "react"
import type { Metadata } from "next"
import {
  Inter,
  Bangers,
  Space_Grotesk,
  Instrument_Serif,
} from "next/font/google"
import { Toaster } from "@/components/ui/toaster"
import "./globals.css"

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })
const bangers = Bangers({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bangers",
})
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
})
const instrumentSerif = Instrument_Serif({
  weight: ["400"],
  subsets: ["latin"],
  variable: "--font-instrument-serif",
})

const title = "Twilio Comics | Turn a story idea into a comic"
const description =
  "Create a custom comic from your story idea with Twilio Comics. See which Twilio channels are available and how to get started."

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_BASE_URL || "http://localhost:3000"),
  applicationName: "Twilio Comics",
  title,
  description,
  openGraph: {
    type: "website",
    siteName: "Twilio Comics",
    title,
    description,
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Twilio Comics: turn a story idea into a custom comic",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/opengraph-image"],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${bangers.variable} ${spaceGrotesk.variable} ${instrumentSerif.variable}`}
    >
      <body className="font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
