import { hashAdminPassword } from "../lib/admin-auth";

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk.toString();
    return input.replace(/\r?\n$/, "");
  }

  process.stderr.write("Admin password (input hidden): ");
  return new Promise((resolve, reject) => {
    let password = "";
    const input = process.stdin;
    const finish = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          finish();
          resolve(password);
          return;
        }
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
          continue;
        }
        password += character;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main(): Promise<void> {
  try {
    const password = await readPassword();
    process.stdout.write(`${await hashAdminPassword(password)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Could not hash password"}\n`);
    process.exitCode = 1;
  }
}

void main();
