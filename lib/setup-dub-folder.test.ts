import { describe, expect, it, vi } from "vitest";

import { ensureDubFolderId } from "../scripts/setup-dub-folder";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ensureDubFolderId", () => {
  it("finds an exact folder name on a later page without creating one", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `folder-${index}`,
      name: index === 0 ? "Twilio Comics Archive" : `Other ${index}`,
    }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([{ id: "wanted", name: "Twilio Comics" }]));

    await expect(ensureDubFolderId("secret-key", fetchMock)).resolves.toBe("wanted");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.dub.co/folders?page=1&pageSize=50");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.dub.co/folders?page=2&pageSize=50");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer secret-key",
    });
  });

  it("creates the folder when it is absent", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "new-folder", name: "Twilio Comics" }, 201));

    await expect(ensureDubFolderId("secret-key", fetchMock)).resolves.toBe("new-folder");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "Twilio Comics" }),
    });
  });

  it("recovers when another setup process created the folder first", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "conflict" } }, 409))
      .mockResolvedValueOnce(jsonResponse([{ id: "raced-folder", name: "Twilio Comics" }]));

    await expect(ensureDubFolderId("secret-key", fetchMock)).resolves.toBe("raced-folder");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not echo an API key or response body on authentication failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { message: "secret-key" } }, 401));

    await expect(ensureDubFolderId("secret-key", fetchMock)).rejects.toThrow(
      "Dub API GET /folders returned 401. Check DUB_API_KEY and workspace permissions.",
    );
  });

  it("rejects malformed folder data before creating anything", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ folders: [] }));

    await expect(ensureDubFolderId("secret-key", fetchMock)).rejects.toThrow(
      "Dub API returned an invalid folder list.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
