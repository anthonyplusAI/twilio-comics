import { z } from "zod";
import { COMIC_STYLES } from "@/lib/constants";
import { MAX_USER_PROMPT } from "@/lib/prompt";
import { isAllowedReferenceImageUrl } from "@/lib/reference-image-url";

const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "Invalid ID",
);
const promptSchema = z.string().max(MAX_USER_PROMPT).trim().min(1);
const characterImagesSchema = z.array(
  z.string().max(2048).refine(isAllowedReferenceImageUrl, "Invalid character reference URL"),
).max(2).default([]);

export const generateComicRequestSchema = z.object({
  storyId: uuidSchema.optional(),
  prompt: promptSchema,
  apiKey: z.string().max(512).optional(),
  style: z.string().max(32).refine(
    (style) => COMIC_STYLES.some((candidate) => candidate.id === style),
    "Unknown comic style",
  ).default("noir"),
  characterImages: characterImagesSchema,
  isContinuation: z.boolean().default(false),
  previousContext: z.string().max(MAX_USER_PROMPT).default(""),
});

export const addPageRequestSchema = z.object({
  storyId: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  pageId: uuidSchema.optional(),
  prompt: promptSchema,
  characterImages: characterImagesSchema,
});
