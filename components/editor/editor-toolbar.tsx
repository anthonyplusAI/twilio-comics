"use client";

import { Download, Link2, Pencil, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { GitHubStarLink } from "@/components/github-star-link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import styles from "./editor-toolbar.module.css";

interface EditorToolbarProps {
  title: string;
  onContinueStory?: () => void;
  onDownloadPDF?: () => void;
  isGeneratingPDF?: boolean;
  isOwner?: boolean;
  onTitleUpdate?: (newTitle: string) => void;
  textAction?: ReactNode;
  notice?: string;
}

export function EditorToolbar({
  title,
  onContinueStory,
  onDownloadPDF,
  isGeneratingPDF = false,
  isOwner = false,
  onTitleUpdate,
  textAction,
  notice,
}: EditorToolbarProps) {
  const { toast } = useToast();
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitle, setEditingTitle] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelEditRef = useRef(false);

  useEffect(() => {
    setEditingTitle(title);
  }, [title]);

  useEffect(() => {
    if (isEditingTitle && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingTitle]);

  const handleTitleSave = async () => {
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      setEditingTitle(title);
      setIsEditingTitle(false);
      return;
    }

    const newTitle = editingTitle.trim();
    setIsEditingTitle(false);
    if (!newTitle || newTitle === title) {
      setEditingTitle(title);
      return;
    }

    try {
      const response = await fetch(
        `/api/stories/${window.location.pathname.split("/").pop()}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newTitle }),
        },
      );

      if (!response.ok) throw new Error("Failed to update title");
      onTitleUpdate?.(newTitle);
      toast({
        title: "Title updated",
        description: "Your comic title has been updated.",
        duration: 2000,
      });
    } catch (error) {
      console.error("Error updating title:", error);
      toast({
        title: "Could not update title",
        description: "Try changing the title again.",
        variant: "destructive",
        duration: 3000,
      });
      setEditingTitle(title);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      cancelEditRef.current = true;
      event.currentTarget.blur();
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast({ title: "Link copied", description: "Your comic link is ready to share.", duration: 2000 });
    } catch (error) {
      console.error("Failed to copy URL:", error);
      toast({
        title: "Could not copy link",
        description: "Try copying the address from your browser.",
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  return (
    <section className={styles.toolbar} aria-label="Comic controls">
      <div className={styles.inner}>
        <div className={styles.identity}>
          <span className={styles.sectionLabel}>Your comic</span>
          {isEditingTitle ? (
            <input
              ref={inputRef}
              type="text"
              aria-label="Comic title"
              value={editingTitle}
              onChange={(event) => setEditingTitle(event.target.value)}
              onBlur={() => void handleTitleSave()}
              onKeyDown={handleKeyDown}
              className={styles.titleInput}
            />
          ) : (
            <h1 className={styles.title}>
              {isOwner && onTitleUpdate ? (
                <button
                  type="button"
                  className={styles.titleEdit}
                  onClick={() => setIsEditingTitle(true)}
                  aria-label={`Edit title: ${title}`}
                  title="Edit comic title"
                >
                  <span>{title}</span>
                  <Pencil size={17} aria-hidden="true" />
                </button>
              ) : title}
            </h1>
          )}
          {notice && <p className={styles.notice}>{notice}</p>}
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.secondaryAction} onClick={() => void copyLink()}>
            <Link2 size={18} aria-hidden="true" />
            <span>Copy link</span>
          </button>

          {onDownloadPDF && (
            <button
              type="button"
              className={styles.primaryAction}
              onClick={onDownloadPDF}
              disabled={isGeneratingPDF}
            >
              <Download size={18} aria-hidden="true" />
              <span>{isGeneratingPDF ? "Preparing PDF…" : "Download PDF"}</span>
            </button>
          )}

          {textAction}

          {isOwner && onContinueStory && (
            <button type="button" className={styles.secondaryAction} onClick={onContinueStory}>
              <Plus size={18} aria-hidden="true" />
              <span>Add a page</span>
            </button>
          )}

          <GitHubStarLink
            className={styles.githubLink}
            fullLabel="Star this project"
            compactLabel="Star project"
          />
        </div>
      </div>
    </section>
  );
}
