import { COMIC_STYLES } from "./constants";

// OpenAI gpt-image-2 has a 32,000 character limit for the prompt parameter
// We use 30k total to keep a safety margin below that cap
export const MAX_PROMPT_LENGTH = 30000;
export const MAX_SYSTEM_LENGTH = 26000; // Reserve 4,000 for user's prompt

export const MAX_USER_PROMPT = MAX_PROMPT_LENGTH - MAX_SYSTEM_LENGTH;

export function buildComicPrompt({
  prompt,
  style,
  characterImages = [],
  isContinuation = false,
  previousContext = "",
  isAddPage = false,
  previousPages = [],
  previousPageImageIncluded = false,
}: {
  prompt: string;
  style?: string;
  characterImages?: string[];
  isContinuation?: boolean;
  previousContext?: string;
  isAddPage?: boolean;
  previousPages?: Array<{
    prompt: string;
  }>;
  previousPageImageIncluded?: boolean;
}): string {
  const styleInfo = COMIC_STYLES.find((s) => s.id === style);
  const styleDesc = styleInfo?.prompt || COMIC_STYLES[2].prompt;

  let continuationContext = "";
  if (isContinuation && previousContext) {
    continuationContext = `\nCONTINUATION CONTEXT:\nThis is a continuation of an existing story. The previous page showed: ${previousContext}\nMaintain visual consistency with the previous panels. Continue the narrative naturally.\n`;
  }

  if (isAddPage && previousPages.length > 0) {
    // Limit previous pages to fit within MAX_SYSTEM_LENGTH
    // Start with most recent pages and work backwards
    const header = `\nSTORY CONTINUATION CONTEXT:\nThis is page ${previousPages.length + 1} of an existing comic story. Here are the recent pages for context:\n`;
    const footer = `\n\nThe new page should naturally continue this story. Maintain the same characters, setting, and narrative style. Reference previous events and build upon them.\n`;
    
    // Calculate available space for previous pages (reserve space for rest of system prompt)
    const basePromptLength = 2500; // Approximate length of system prompt without previous pages
    const availableSpace = MAX_SYSTEM_LENGTH - basePromptLength - header.length - footer.length;
    
    const selectedPages: string[] = [];
    let currentLength = 0;
    
    // Add pages from most recent backwards until we run out of space
    for (let i = previousPages.length - 1; i >= 0; i--) {
      const pageEntry = `Page ${i + 1}: ${previousPages[i].prompt}`;
      const entryLength = pageEntry.length + (selectedPages.length > 0 ? 1 : 0); // +1 for newline
      
      if (currentLength + entryLength <= availableSpace) {
        selectedPages.unshift(pageEntry);
        currentLength += entryLength;
      } else {
        break;
      }
    }
    
    if (selectedPages.length > 0) {
      continuationContext = header + selectedPages.join("\n") + footer;
    } else {
      // Fallback if no pages fit
      continuationContext = `\nSTORY CONTINUATION CONTEXT:\nThis is page ${previousPages.length + 1} of an existing comic story with ${previousPages.length} previous pages. Continue the story maintaining consistency.\n`;
    }
  }

  const firstPortraitImageNumber = previousPageImageIncluded ? 2 : 1;
  const previousPageReference = previousPageImageIncluded
    ? "REFERENCE IMAGE 1: PREVIOUS COMIC PAGE. Use it for story, layout, and style continuity; the previous comic page is not a new character or a character portrait.\n"
    : "";
  let characterSection = previousPageReference;
  if (characterImages.length === 1) {
    characterSection += `REFERENCE IMAGE ${firstPortraitImageNumber}: CHARACTER 1 PORTRAIT. Use the main person in this photo as the comic's reference character.
- Preserve their recognizable face, skin tone, hair, and distinctive features in the comic style.
- Keep the same person across panels even when clothing, pose, expression, or camera angle changes.
- A different outfit or view of this person does not create another character. Do not invent a second portrait-based character.`;
  } else if (characterImages.length >= 2) {
    characterSection += `REFERENCE IMAGE ${firstPortraitImageNumber}: CHARACTER 1 PORTRAIT. Use the main person in this photo for Character 1.
REFERENCE IMAGE ${firstPortraitImageNumber + 1}: CHARACTER 2 PORTRAIT. Use the main person in this photo for Character 2.
- These photos are intended to show two different people, one person per photo. Keep their faces and identities distinct and consistent across panels.
- Clothing, pose, and camera angle are not character identities. Do not make extra doubles or swap the two people's faces.
- If the photos clearly show the same person in different outfits, depict one person rather than two characters or twins; use the first photo for identity and the second only as an alternate look.`;
  }

  const systemPrompt = `Professional comic book page illustration.
${continuationContext}
${characterSection}

CHARACTER CONSISTENCY RULES (HIGHEST PRIORITY):
- Match the people in the reference portraits as closely as the comic style allows.
- Preserve each person's facial structure, complexion, hair, and distinctive features.
- Keep each person's identity consistent wherever they appear, even when clothes or poses change.

TEXT AND LETTERING (CRITICAL):
- All text in speech bubbles must be PERFECTLY CLEAR, LEGIBLE, and correctly spelled
- Use bold clean comic book lettering, large and easy to read
- Speech bubbles: crisp white fill, solid black outline, pointed tail toward speaker
- Keep dialogue SHORT: maximum 1-2 sentences per bubble
- NO blurry, warped, or unreadable text

PAGE LAYOUT:
5-panel comic page arranged as:
[Panel 1] [Panel 2] — top row, 2 equal panels
[    Panel 3      ] — middle row, 1 large cinematic hero panel
[Panel 4] [Panel 5] — bottom row, 2 equal panels
- Solid black panel borders with clean white gutters between panels
- Each panel clearly separated and distinct

ART STYLE:
${styleDesc}

COMPOSITION:
- Vary camera angles across panels: close-up, medium shot, wide establishing shot
- Natural visual flow: left-to-right, top-to-bottom reading order
- Dynamic character poses with clear expressive acting
- Detailed backgrounds matching the scene and mood`;

  return `${systemPrompt}\n\nSTORY:\n${prompt}`;
}
