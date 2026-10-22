import { Metadata } from "next";
import { getStoryWithPagesBySlug } from "@/lib/db-actions";
import { StoryEditorClient } from "./story-editor-client";

// Deleted comics should stop resolving through the page and its metadata.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ storySlug: string }>;
}): Promise<Metadata> {
  const { storySlug: slug } = await params;

  try {
    const result = await getStoryWithPagesBySlug(slug);

    if (!result) {
      return {
        title: "Story Not Found | Twilio Comics",
        description: "The requested comic story could not be found.",
      };
    }

    const { story, pages } = result;
    const title = `${story.title} | Twilio Comics`;
    const description =
      story.description ||
      `${story.title} - Create your own comic book with Twilio Comics`;

    // Use the first page's image as the Open Graph image, or default if none
    const firstPageImage = pages.length > 0 && pages[0].generatedImageUrl ? pages[0].generatedImageUrl : "/placeholder.jpg";

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: "website",
        images: [firstPageImage],
      },
    };
  } catch (error) {
    console.error("Error generating metadata:", error);
    return {
      title: "Twilio Comics",
      description: "Create your own comic book with Twilio Comics",
    };
  }
}

export default function StoryEditorPage() {
  return <StoryEditorClient />;
}
