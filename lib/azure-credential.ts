import { DefaultAzureCredential } from "@azure/identity";

let credential: DefaultAzureCredential | undefined;

export function requireAzureEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getAzureCredential(): DefaultAzureCredential {
  if (!credential) {
    credential = new DefaultAzureCredential({
      managedIdentityClientId:
        requireAzureEnvironmentVariable("AZURE_CLIENT_ID"),
    });
  }
  return credential;
}
