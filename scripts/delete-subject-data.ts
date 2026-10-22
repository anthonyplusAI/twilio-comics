import { resolve } from "node:path";
import { listBlobKeysByPrefixes } from "@/lib/blob-storage";
import {
  buildDeletionPlan,
  deletionSubjectForSender,
  loadSubjectDatabaseSnapshot,
  type SubjectDatabaseSnapshot,
} from "@/lib/privacy-deletion";

const USAGE = `Twilio Comics subject deletion inventory (read-only)

Usage:
  node --import tsx scripts/delete-subject-data.ts --sender +15551234567 [--json]

Options:
  --sender  Exact E.164 sender to inventory, including SMS, Voice, and WhatsApp aliases
  --json    Print a machine-readable manifest, including exact blob keys
  --help    Show this help

No data is deleted. Verify the requester's identity and follow docs/DATA_DELETION.md
for the maintenance-window deletion procedure.\n`;

type ParsedArgs = { help: true } | { help: false; sender: string; json: boolean };

function parseArgs(args: string[]): ParsedArgs {
  let sender: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--execute" || arg === "--apply" || arg === "--confirm") {
      throw new Error("This command is read-only; use the reviewed operator runbook for deletion.");
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--sender") {
      if (sender || !args[index + 1]) throw new Error("Provide exactly one --sender E.164 number.");
      sender = args[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!sender) throw new Error("--sender is required. Use --help for usage.");
  deletionSubjectForSender(sender);
  return { help: false, sender, json };
}

export interface DeletionInventoryDependencies {
  loadSnapshot: (sender: string) => Promise<SubjectDatabaseSnapshot>;
  listBlobKeys: (prefixes: readonly string[]) => Promise<string[]>;
}

function textReport(manifest: Record<string, unknown>): string {
  const counts = manifest.counts as Record<string, number>;
  const blockers = manifest.blockers as string[];
  const blobPrefixes = manifest.blobPrefixes as string[];
  const blobKeys = manifest.blobKeys as string[];
  return [
    `Read-only deletion inventory for ${manifest.sender}`,
    `Channel user ID: ${manifest.userId}`,
    `Generated: ${manifest.generatedAt}`,
    "",
    "Database records:",
    ...Object.entries(counts).map(([name, count]) => `  ${name}: ${count}`),
    `Blob objects: ${manifest.blobObjectCount}`,
    "",
    "Blob prefixes:",
    ...blobPrefixes.map((prefix) => `  ${prefix}`),
    "Blob keys:",
    ...(blobKeys.length ? blobKeys.map((key) => `  ${key}`) : ["  (none)"]),
    "",
    blockers.length ? "BLOCKED:" : "No active-work or ownership blockers found in this snapshot.",
    ...blockers.map((blocker) => `  - ${blocker}`),
    "",
    "No data was deleted. Verify identity and follow docs/DATA_DELETION.md.",
    "",
  ].join("\n");
}

/** A review artifact only; it never mutates PostgreSQL, Azure Blob, or Twilio. */
export async function runDeletionInventory(
  args: string[],
  dependencies: DeletionInventoryDependencies = {
    loadSnapshot: loadSubjectDatabaseSnapshot,
    listBlobKeys: listBlobKeysByPrefixes,
  },
): Promise<{ exitCode: number; output: string }> {
  const parsed = parseArgs(args);
  if (parsed.help) return { exitCode: 0, output: USAGE };

  const snapshot = await dependencies.loadSnapshot(parsed.sender);
  const plan = buildDeletionPlan(parsed.sender, snapshot);
  const blobKeys = [...new Set(await dependencies.listBlobKeys(plan.blobPrefixes))].sort();
  if (blobKeys.some((key) => !plan.blobPrefixes.some((prefix) => key.startsWith(prefix)))) {
    throw new Error("Blob inventory contains a key outside the sender's owned prefixes");
  }
  const manifest = {
    ...plan,
    generatedAt: new Date().toISOString(),
    blobObjectCount: blobKeys.length,
    blobKeys,
    notice: "Inventory only. No data was deleted. Follow docs/DATA_DELETION.md.",
  };
  return {
    exitCode: plan.readyForManualDeletion ? 0 : 2,
    output: parsed.json ? `${JSON.stringify(manifest, null, 2)}\n` : textReport(manifest),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), "scripts/delete-subject-data.ts")) {
  runDeletionInventory(process.argv.slice(2))
    .then(({ exitCode, output }) => {
      process.stdout.write(output);
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Unknown deletion inventory error"}\n`);
      process.exitCode = 1;
    });
}
