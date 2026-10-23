import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role?: "admin" | "user";
    /** Version of the password hash verified by the Credentials provider. */
    adminCredentialVersion?: string;
  }

  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: "admin" | "user";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: "admin" | "user";
    adminIssuedAt?: number;
    adminCredentialVersion?: string;
  }
}
