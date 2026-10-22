"use client";

import { FileText, ImageIcon, Palette } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { COMIC_STYLES } from "@/lib/constants";

interface PageData {
  id: number;
  title: string;
  image: string;
  prompt: string;
  characterUploads?: string[];
  style: string;
}

interface PageInfoSheetProps {
  isOpen: boolean;
  onClose: () => void;
  page?: PageData;
  isOwner: boolean;
}

export function PageInfoSheet({ isOpen, onClose, page, isOwner }: PageInfoSheetProps) {
  if (!isOwner || !page) return null;

  const styleName = COMIC_STYLES.find((s) => s.id === page.style)?.name || page.style;

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-md border-l border-border/50 bg-background px-6">
        <SheetHeader className="pb-4 border-b border-border/50 px-0">
          <SheetTitle className="text-base font-medium text-white">
            Page {page.id} Details
          </SheetTitle>
        </SheetHeader>

        <div className=" space-y-6">
          {/* Prompt Section */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <FileText className="w-3.5 h-3.5" />
              <span>Prompt</span>
            </div>
            <div className="p-3 glass-panel rounded-lg">
              <p className="text-sm text-foreground leading-relaxed">
                {page.prompt}
              </p>
            </div>
          </div>

          {/* Style Section */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Palette className="w-3.5 h-3.5" />
              <span>Style</span>
            </div>
            <div className="inline-flex items-center px-3 py-1.5 glass-panel rounded-md">
              <span className="text-sm text-foreground">{styleName}</span>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <ImageIcon className="w-3.5 h-3.5" />
              <span>Character Uploads</span>
            </div>
            {page.characterUploads && page.characterUploads.length > 0 ? (
              <div className="flex gap-2">
                {page.characterUploads.map((upload, index) => (
                  <div
                    key={index}
                    className="relative h-24 w-24 rounded-lg overflow-hidden glass-panel"
                  >
                    <img
                      src={upload || "/placeholder.svg"}
                      alt={`Uploaded character ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 glass-panel rounded-lg text-center">
                <p className="text-sm text-muted-foreground">
                  No characters uploaded
                </p>
              </div>
            )}
          </div>

          {/* Generated Image Preview
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <ImageIcon className="w-3.5 h-3.5" />
              <span>Generated Image</span>
            </div>
            <div className="relative aspect-[3/4] rounded-lg overflow-hidden glass-panel">
              <img
                src={page.image || "/placeholder.svg"}
                alt={`Page ${page.id}`}
                className="w-full h-full object-cover"
              />
            </div>
          </div> */}
        </div>
      </SheetContent>
    </Sheet>
  );
}
