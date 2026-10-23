import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const OPENAI_LINK = "https://platform.openai.com/api-keys";

export function isContentPolicyViolation(errorMessage: string): boolean {
  return (
    errorMessage.includes("content policy") ||
    errorMessage.includes("Invalid content detected") ||
    errorMessage.includes("content moderation") ||
    errorMessage.includes("flagged and rejected") ||
    // OpenAI moderation phrasing
    errorMessage.includes("safety system") ||
    errorMessage.includes("moderation_blocked") ||
    errorMessage.toLowerCase().includes("content_policy_violation")
  );
}

export function getContentPolicyErrorMessage(): string {
  return "Unable to generate image due to content policy. Please try a different prompt.";
}
