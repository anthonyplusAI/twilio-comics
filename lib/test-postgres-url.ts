/** Build synthetic PostgreSQL URLs without embedding credential-bearing URLs in source. */
export function testPostgresUrl(options: {
  host?: string;
  database?: string;
  user?: string;
  password?: string;
  port?: number;
  params?: ReadonlyArray<readonly [string, string]>;
} = {}): string {
  const url = new URL("postgresql://localhost/");
  url.hostname = options.host ?? "localhost";
  url.pathname = `/${options.database ?? "comics"}`;
  url.username = options.user ?? "fixture_user";
  url.password = options.password ?? "P".repeat(48);
  if (options.port !== undefined) url.port = String(options.port);
  for (const [name, value] of options.params ?? []) url.searchParams.append(name, value);
  return url.toString();
}
