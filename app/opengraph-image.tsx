import { ImageResponse } from "next/og"

export const alt = "Twilio Comics: turn a story idea into a custom comic"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const ink = "#000D25"
const white = "#FFFFFF"
const red = "#EF223A"
const deepRed = "#DB132A"
const blue = "#1866EE"
const paleBlue = "#E4F7FF"
const neutral = "#F3F4F7"

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: white,
        color: ink,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          width: 750,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "43px 61px 42px 64px",
          borderRight: `5px solid ${ink}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div
            style={{
              width: 46,
              height: 46,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: white,
              border: `3px solid ${ink}`,
            }}
          >
            <svg width={36} height={36} viewBox="-3 -3 52 52" fill="none">
              <path
                d="M17.25 33.17C19.69 33.17 21.67 31.19 21.67 28.75C21.67 26.31 19.69 24.33 17.25 24.33C14.81 24.33 12.83 26.31 12.83 28.75C12.83 31.19 14.81 33.17 17.25 33.17ZM17.25 21.67C19.69 21.67 21.67 19.69 21.67 17.25C21.67 14.81 19.69 12.83 17.25 12.83C14.81 12.83 12.83 14.81 12.83 17.25C12.83 19.69 14.81 21.67 17.25 21.67ZM28.75 33.17C31.19 33.17 33.17 31.19 33.17 28.75C33.17 26.31 31.19 24.33 28.75 24.33C26.31 24.33 24.33 26.31 24.33 28.75C24.33 31.19 26.31 33.17 28.75 33.17ZM28.75 21.67C31.19 21.67 33.17 19.69 33.17 17.25C33.17 14.81 31.19 12.83 28.75 12.83C26.31 12.83 24.33 14.81 24.33 17.25C24.33 19.69 26.31 21.67 28.75 21.67ZM23 0C35.46 0 46 10.54 46 23C46 35.46 35.46 46 23 46C10.54 46 0 35.46 0 23C0 10.54 10.54 0 23 0ZM23 6.19C13.74 6.19 6.19 13.48 6.19 22.69C6.19 31.9 13.74 39.81 23 39.81C32.26 39.81 39.81 31.9 39.81 22.69C39.81 13.48 32.26 6.19 23 6.19Z"
                fill="#EF223A"
              />
            </svg>
          </div>
          <div style={{ fontSize: 29, fontWeight: 900, letterSpacing: "-1.5px" }}>
            Twilio Comics
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 95,
              fontWeight: 900,
              lineHeight: 0.94,
              letterSpacing: "-6px",
            }}
          >
            <div>TELL IT.</div>
            <div style={{ color: red }}>SHAPE IT.</div>
            <div>SEE IT.</div>
          </div>
          <div
            style={{
              display: "flex",
              maxWidth: 575,
              marginTop: 26,
              fontSize: 24,
              fontWeight: 700,
              lineHeight: 1.23,
              letterSpacing: "-0.5px",
            }}
          >
            Turn your idea into a comic with Twilio.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 17,
            fontWeight: 800,
            letterSpacing: "0.3px",
          }}
        >
          <div
            style={{
              display: "flex",
              padding: "11px 15px",
              background: deepRed,
              border: `3px solid ${ink}`,
              color: white,
            }}
          >
            START WITH TWILIO
          </div>
        </div>
      </div>

      <div
        style={{
          width: 450,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: blue,
          position: "relative",
        }}
      >
        <div
          style={{
            width: 326,
            height: 551,
            position: "absolute",
            top: 50,
            left: 72,
            borderRadius: 33,
            background: ink,
          }}
        />
        <div
          style={{
            width: 326,
            height: 551,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            border: `7px solid ${ink}`,
            borderRadius: 33,
            background: white,
            position: "relative",
            marginLeft: -12,
            marginTop: -12,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "100%",
              height: 57,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 19px",
              borderBottom: `3px solid ${ink}`,
              fontSize: 17,
              fontWeight: 900,
              letterSpacing: "-0.6px",
            }}
          >
            <div>Twilio Comics</div>
            <div style={{ fontSize: 26, letterSpacing: "-1px" }}>•••</div>
          </div>

          <div
            style={{
              alignSelf: "flex-end",
              display: "flex",
              width: 250,
              margin: "24px 18px 21px 0",
              padding: "13px 15px",
              background: red,
              border: `3px solid ${ink}`,
              borderRadius: "19px 19px 4px 19px",
              fontSize: 18,
              fontWeight: 700,
              lineHeight: 1.18,
            }}
          >
            A fox opens a door in the sky...
          </div>

          <div
            style={{
              width: 254,
              display: "flex",
              flexDirection: "column",
              border: `4px solid ${ink}`,
              background: neutral,
            }}
          >
            <div style={{ width: "100%", height: 176, display: "flex" }}>
              <div
                style={{
                  width: 83,
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: paleBlue,
                  borderRight: `4px solid ${ink}`,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: 55,
                    height: 55,
                    border: `6px solid ${ink}`,
                    borderRadius: "50%",
                    background: white,
                  }}
                />
              </div>
              <div
                style={{
                  width: 83,
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: ink,
                  borderRight: `4px solid ${ink}`,
                }}
              >
                <div
                  style={{
                    width: 51,
                    height: 86,
                    border: `5px solid ${white}`,
                    borderRadius: "50% 50% 0 0",
                    background: blue,
                  }}
                />
              </div>
              <div
                style={{
                  width: 80,
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: red,
                }}
              >
                <div
                  style={{
                    width: 53,
                    height: 53,
                    border: `5px solid ${ink}`,
                    borderRadius: "50%",
                    background: paleBlue,
                  }}
                />
              </div>
            </div>
            <div
              style={{
                display: "flex",
                padding: "10px 12px",
                borderTop: `4px solid ${ink}`,
                fontSize: 16,
                fontWeight: 800,
              }}
            >
              An adventure begins...
            </div>
          </div>

          <div
            style={{
              alignSelf: "flex-start",
              display: "flex",
              margin: "20px 0 0 19px",
              padding: "11px 13px",
              background: paleBlue,
              border: `3px solid ${ink}`,
              borderRadius: "16px 16px 16px 4px",
              fontSize: 17,
              fontWeight: 800,
            }}
          >
            Your comic is ready!
          </div>
        </div>
      </div>
    </div>,
    size,
  )
}
