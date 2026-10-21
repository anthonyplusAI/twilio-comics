import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import "../envConfig.ts";

type NeonClient = ReturnType<typeof neon>;
let client: NeonClient | undefined;

function getClient(): NeonClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  return (client ??= neon(databaseUrl));
}

// Drizzle and Auth.js need a real NeonHttpDatabase during module evaluation.
// Defer the Neon URL requirement until the first query reaches the client.
const lazyClient = Object.assign(
  (strings: TemplateStringsArray, ...params: unknown[]) =>
    getClient()(strings, ...params),
  {
    query: (...args: Parameters<NeonClient["query"]>) =>
      getClient().query(...args),
    transaction: (...args: Parameters<NeonClient["transaction"]>) =>
      getClient().transaction(...args),
    unsafe: (...args: Parameters<NeonClient["unsafe"]>) =>
      getClient().unsafe(...args),
  },
) as NeonClient;

export const db = drizzle(lazyClient);
