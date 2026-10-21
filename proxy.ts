import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "./auth.config";

const { auth } = NextAuth(authConfig);

export default auth((request) => {
  if (request.auth?.user) return NextResponse.next();

  const destination = new URL("/", request.url);
  destination.searchParams.set(
    "callbackUrl",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.redirect(destination);
});

export const config = {
  matcher: ["/stories/:path*"],
};
