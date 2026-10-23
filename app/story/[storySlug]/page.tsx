import { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getStoryWithPagesBySlug } from "@/lib/db-actions";
import { ChannelComicViewer } from "./channel-comic-viewer";
import { StoryEditorClient } from "./story-editor-client";

// Deleted comics should stop resolving through the page and its metadata.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Metadata and the page render share one database read per request.
const getStory = cache(getStoryWithPagesBySlug);

function isPhoneChannel(source: string) {
  return source === "sms" || source === "voice" || source === "whatsapp";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ storySlug: string }>;
}): Promise<Metadata> {
  const { storySlug: slug } = await params;

  try {
    const result = await getStory(slug);

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
      // Phone-channel comics can be shared by link without appearing in search.
      ...(isPhoneChannel(story.source)
        ? { robots: { index: false, follow: false } }
        : {}),
      openGraph: {
        title,
        description,
        type: "website",
        images: [firstPageImage],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
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

export default async function StoryPage({
  params,
}: {
  params: Promise<{ storySlug: string }>;
}) {
  const { storySlug: slug } = await params;
  const result = await getStory(slug);
  if (!result) notFound();

  if (isPhoneChannel(result.story.source)) {
    const finishedPages = result.pages.flatMap((page) =>
      page.generatedImageUrl
        ? [{ pageNumber: page.pageNumber, imageUrl: page.generatedImageUrl }]
        : [],
    );
    return (
      <ChannelComicViewer
        title={result.story.title}
        description={result.story.description}
        pages={finishedPages}
      />
    );
  }

  return <StoryEditorClient />;
}
