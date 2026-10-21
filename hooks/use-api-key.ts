"use client";

import useLocalStorageState from "use-local-storage-state";

export function useApiKey(): [string | null, (key: string | null) => void] {
  const [apiKey, setApiKey] = useLocalStorageState<string | null>(
    "openai_api_key",
    { defaultValue: null },
  );
  return [apiKey, setApiKey];
}
