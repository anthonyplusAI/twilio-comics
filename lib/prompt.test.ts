import { describe, expect, it } from "vitest";
import { buildComicPrompt } from "@/lib/prompt";

describe("comic reference portraits", () => {
  it("uses one portrait for one recurring character without inventing a second portrait character", () => {
    const prompt = buildComicPrompt({
      prompt: "A detective finds a hidden city",
      style: "noir",
      characterImages: ["portrait-one"],
    });

    expect(prompt).toMatch(/reference image 1: character 1 portrait/i);
    expect(prompt).toMatch(/same person across panels.*clothing|clothing.*same person across panels/i);
    expect(prompt).not.toMatch(/reference image 2: character 2 portrait/i);
  });

  it("assigns two portraits to two people without duplicating one person in different outfits", () => {
    const prompt = buildComicPrompt({
      prompt: "Two friends find a hidden city",
      style: "manga",
      characterImages: ["portrait-one", "portrait-two"],
    });

    expect(prompt).toMatch(/reference image 1: character 1 portrait/i);
    expect(prompt).toMatch(/reference image 2: character 2 portrait/i);
    expect(prompt).toMatch(/different people/i);
    expect(prompt).toMatch(/same person.*two characters/i);
  });

  it("keeps a previous comic page separate from numbered character portraits", () => {
    const prompt = buildComicPrompt({
      prompt: "The friends enter the city",
      style: "manga",
      characterImages: ["portrait-one", "portrait-two"],
      previousPageImageIncluded: true,
    });

    expect(prompt).toMatch(/reference image 1: previous comic page/i);
    expect(prompt).toMatch(/reference image 2: character 1 portrait/i);
    expect(prompt).toMatch(/reference image 3: character 2 portrait/i);
    expect(prompt).toMatch(/previous comic page.*not.*new character/i);
  });
});
