import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdminSession } from "@/lib/admin-auth";

/** Always call before reading retained user or analytics data. */
export async function requireAdmin() {
  const session = await auth();
  if (!session || !isAdminSession(session)) redirect("/admin/login");
  return session;
}
