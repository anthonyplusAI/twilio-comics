import { describe, expect, it, vi } from "vitest";
import { generateComicSlug } from "@/lib/slug-generator";

describe("comic story slugs", () => {
  it("includes at least 128 unpredictable bits in the URL suffix", () => {
    const slugs = Array.from({ length: 100 }, generateComicSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/(?:^|-)\w+(?:-\w+)*-[a-f0-9]{32}$/);
    }
  });

  it("keeps story URLs distinct even when Math.random repeats", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const first = generateComicSlug();
      const second = generateComicSlug();
      expect(first).not.toBe(second);
    } finally {
      random.mockRestore();
    }
  });
});
