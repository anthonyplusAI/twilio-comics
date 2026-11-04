"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Camera, ImagePlus, X, ArrowRight, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uploadFileToBlob } from "@/lib/blob-upload-client";
import { CameraCaptureButton } from "@/components/camera/camera-capture";
import { COMIC_STYLES } from "@/lib/constants";
import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";
import { isContentPolicyViolation } from "@/lib/utils";
import { MAX_USER_PROMPT } from "@/lib/prompt";
import styles from "./comic-creation-form.module.css";

interface ComicCreationFormProps {
  studioReady: boolean;
  prompt: string;
  setPrompt: (prompt: string) => void;
  style: string;
  setStyle: (style: string) => void;
  characterFiles: File[];
  setCharacterFiles: (files: File[]) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

const DEFAULT_STYLE = 'noir';
const STYLE_STORAGE_KEY = 'comic-style-preference';
const PROMPT_STORAGE_KEY = 'comic-prompt-draft';
const MAX_REFERENCE_PHOTOS = 2;
const MAX_REFERENCE_PHOTO_SIZE = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const SUPPORTED_IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|heic|heif)$/i;
const STYLE_SAMPLE_IMAGES: Record<(typeof COMIC_STYLES)[number]["id"], string> = {
  "american-modern": "/american.jpg",
  manga: "/manga.png",
  noir: "/noir.jpg",
  vintage: "/vintage-superman.jpg",
};

function isSupportedReferencePhoto(file: File): boolean {
  const mime = file.type.toLowerCase();
  const hasSupportedType = SUPPORTED_IMAGE_TYPES.has(mime) ||
    ((mime === "" || mime === "application/octet-stream") && SUPPORTED_IMAGE_EXTENSION.test(file.name));
  return hasSupportedType && file.size > 0 && file.size <= MAX_REFERENCE_PHOTO_SIZE;
}

function isHeifPhoto(file: File): boolean {
  const mime = file.type.toLowerCase();
  return mime === "image/heic" || mime === "image/heif" || /\.(?:heic|heif)$/i.test(file.name);
}

function photoDisplayName(file: File, index: number): string {
  return file.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || `Reference photo ${index + 1}`;
}

export function ComicCreationForm({
  studioReady,
  prompt,
  setPrompt,
  style,
  setStyle,
  characterFiles,
  setCharacterFiles,
  isLoading,
  setIsLoading,
}: ComicCreationFormProps) {
  const router = useRouter();
  const [loadingStep, setLoadingStep] = useState(0);
  const { toast } = useToast();
  const [previews, setPreviews] = useState<(string | null)[]>([]);
  const [stylePreferenceLoaded, setStylePreferenceLoaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist prompt to localStorage
  useEffect(() => {
    if (prompt) {
      localStorage.setItem(PROMPT_STORAGE_KEY, prompt);
    }
  }, [prompt]);

  // Restore prompt from localStorage only once on mount
  useEffect(() => {
    const saved = localStorage.getItem(PROMPT_STORAGE_KEY);
    if (saved && !prompt) {
      setPrompt(saved);
    }
    // Restore only on mount; clearing the prompt must not restore the old draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load style preference from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(STYLE_STORAGE_KEY);
    if (saved && COMIC_STYLES.some((option) => option.id === saved)) {
      setStyle(saved);
    }
    setStylePreferenceLoaded(true);
  }, [setStyle]);

  // The parent owns the selected style so preview controls and generation stay in sync.
  useEffect(() => {
    if (stylePreferenceLoaded) {
      localStorage.setItem(STYLE_STORAGE_KEY, style || DEFAULT_STYLE);
    }
  }, [style, stylePreferenceLoaded]);

  useEffect(() => {
    const urls = characterFiles.map((file) => {
      if (isHeifPhoto(file)) return null;
      try {
        return URL.createObjectURL(file);
      } catch {
        return null;
      }
    });
    setPreviews(urls);
    return () => urls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
  }, [characterFiles]);

  // Keyboard shortcut for form submission
  useKeyboardShortcut(() => {
    if (studioReady && !isLoading && prompt.trim() && characterFiles.length > 0) {
      void handleCreate();
    }
  }, { disabled: isLoading || !studioReady });

  const addPhotos = (files: File[]) => {
    if (!studioReady || isLoading) return;
    const supported = files.filter(isSupportedReferencePhoto);
    if (supported.length !== files.length) {
      toast({
        title: "Choose a supported photo",
        description: "Use a JPG, PNG, WebP, HEIC, or HEIF photo up to 5 MB.",
        variant: "destructive",
      });
    }

    const availableSlots = MAX_REFERENCE_PHOTOS - characterFiles.length;
    const nextPhotos = supported.slice(0, availableSlots);
    if (nextPhotos.length) setCharacterFiles([...characterFiles, ...nextPhotos]);
    if (supported.length > availableSlots) {
      toast({ title: "Two photos maximum", description: "Remove a photo before adding another one." });
    }
  };

  const removeFile = (index: number) => {
    setCharacterFiles(characterFiles.filter((_, i) => i !== index));
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleCreate = async () => {
    if (!studioReady || isLoading) {
      return;
    }

    if (!prompt.trim()) {
      toast({
        title: "Prompt required",
        description: "Please enter a prompt to generate your comic",
        variant: "destructive",
        duration: 3000,
      });
      return;
    }

    if (characterFiles.length === 0) {
      toast({
        title: "Reference photo required",
        description: "Add at least one reference photo before generating your comic.",
        variant: "destructive",
        duration: 3000,
      });
      return;
    }

    setIsLoading(true);
    setLoadingStep(0);

    // Progress through loading steps
    const stepInterval = setInterval(() => {
      setLoadingStep((prev) => {
        if (prev < 3) return prev + 1;
        return prev;
      });
    }, 3500);

    try {
      const characterUploads = await Promise.all(
        characterFiles.map((file) => uploadFileToBlob(file).then(({ url }) => url))
      );

      // Use API to create story and generate first page
      const response = await fetch("/api/generate-comic", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          style,
          characterImages: characterUploads,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 429 && errorData.isRateLimited) {
          throw new Error(errorData.error);
        }
        throw new Error(errorData.error || "Failed to create story");
      }

      const result = await response.json();

      // Clear the draft since submission was successful
      localStorage.removeItem(PROMPT_STORAGE_KEY);
      clearInterval(stepInterval);
      // Redirect to the story editor using slug
      router.push(`/story/${result.storySlug}`);
    } catch (error) {
      console.error("Error creating comic:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to create comic. Please try again.";
      let title = "Creation failed";
      if (isContentPolicyViolation(errorMessage)) {
        title = "Content policy violation";
      }
      toast({
        title,
        description: errorMessage,
        variant: "destructive",
        duration: 4000,
      });
      clearInterval(stepInterval);
      setIsLoading(false);
    }
  };

  const loadingSteps = [
    "Enhancing prompt...",
    "Generating scenes...",
    "Creating your comic...",
    "Finishing up...",
  ];

  const selectedStyle = style || DEFAULT_STYLE;
  const photoSlotsAvailable = characterFiles.length < MAX_REFERENCE_PHOTOS;
  const canAddPhotos = studioReady && !isLoading && photoSlotsAvailable;
  const canGenerate = studioReady && !isLoading && Boolean(prompt.trim()) && characterFiles.length > 0;
  const actionHint = !studioReady
    ? "Preparing Browser Studio…"
    : characterFiles.length === 0
        ? "Add a photo to make your comic personal."
        : !prompt.trim()
          ? "Write your idea to continue."
          : "Your photos and idea are ready.";

  return (
    <section className={styles.form} aria-label="Create your comic">
      <div className={styles.formHeader}>
        <p className={styles.brandLine}>Twilio Comics Studio</p>
        <h2>Create your comic</h2>
        <p>Use your own photos so the people in the story look like you.</p>
      </div>

      <div className={styles.formBody}>
        {!studioReady && (
          <div className={styles.signInGate}>
            <p>Preparing Browser Studio…</p>
          </div>
        )}
        <section className={styles.stepSection} aria-labelledby="studio-photos-title">
          <div className={styles.stepHeading}>
            <span className={styles.stepNumber} aria-hidden="true">1</span>
            <div className={styles.stepCopy}>
              <h3 id="studio-photos-title">Add 1 or 2 reference photos</h3>
              <p>First photo required. Add a second for another person or look.</p>
            </div>
          </div>

          <div className={styles.photoGrid} aria-label="Reference photos">
            {[0, 1].map((index) => {
              const file = characterFiles[index];
              return (
                <div
                  key={index}
                  className={`${styles.photoSlot} ${file ? styles.photoSlotFilled : ""}`}
                >
                  {file ? (
                    <>
                      {previews[index] ? (
                        <Image
                          src={previews[index]}
                          alt={`Reference photo ${index + 1}`}
                          width={300}
                          height={240}
                          unoptimized
                          className={styles.photoImage}
                          onError={() => setPreviews((current) => current.map((preview, previewIndex) => (
                            previewIndex === index ? null : preview
                          )))}
                        />
                      ) : (
                        <div className={styles.photoPending}>
                          <ImagePlus size={26} aria-hidden="true" />
                          <span>{previews[index] === undefined ? "Preparing preview…" : "Photo added; preview unavailable"}</span>
                        </div>
                      )}
                      <span className={styles.photoFileName} title={photoDisplayName(file, index)}>
                        {photoDisplayName(file, index)}
                      </span>
                      <button
                        type="button"
                        className={styles.removePhoto}
                        aria-label={`Remove reference photo ${index + 1}`}
                        onClick={() => removeFile(index)}
                        disabled={!studioReady || isLoading}
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <div className={styles.photoEmpty}>
                      <ImagePlus size={28} strokeWidth={1.7} aria-hidden="true" />
                      <strong>Photo {index + 1}</strong>
                      <span>{index === 0 ? "Required" : "Optional"}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className={styles.photoActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => fileInputRef.current?.click()}
              disabled={!canAddPhotos}
            >
              <ImagePlus size={18} aria-hidden="true" />
              Choose photo
            </button>
            <CameraCaptureButton
              onCapture={(file) => addPhotos([file])}
              disabled={!canAddPhotos}
              title="Take a reference photo"
              className={styles.secondaryButton}
            >
              <Camera size={18} aria-hidden="true" />
              Take photo
            </CameraCaptureButton>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
            multiple
            className={styles.fileInput}
            aria-label="Choose reference photos"
            onChange={(event) => {
              if (event.target.files) addPhotos(Array.from(event.target.files));
              event.target.value = "";
            }}
            disabled={!canAddPhotos}
          />
          <p className={styles.photoMeta}>
            <span aria-live="polite">{characterFiles.length} of 2 photos added</span>
            <span>JPG, PNG, WebP, HEIC, or HEIF; up to 5 MB each</span>
          </p>
        </section>

        <section className={styles.stepSection} aria-labelledby="studio-idea-title">
          <div className={styles.stepHeading}>
            <span className={styles.stepNumber} aria-hidden="true">2</span>
            <div className={styles.stepCopy}>
              <h3 id="studio-idea-title">Your comic idea</h3>
              <p>Tell us what happens in your story.</p>
            </div>
          </div>
          <label htmlFor="studio-idea" className={styles.srOnly}>Your comic idea</label>
          <textarea
            id="studio-idea"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value.slice(0, MAX_USER_PROMPT))}
            placeholder="My friend and I explore a hidden city under the ocean..."
            disabled={isLoading}
            maxLength={MAX_USER_PROMPT}
            rows={4}
            className={styles.ideaInput}
          />
          <p className={styles.characterCount}>{prompt.length} / {MAX_USER_PROMPT} characters</p>
        </section>

        <section className={styles.stepSection} aria-labelledby="studio-style-title">
          <div className={styles.stepHeading}>
            <span className={styles.stepNumber} aria-hidden="true">3</span>
            <div className={styles.stepCopy}>
              <h3 id="studio-style-title">Choose a style</h3>
              <p>Pick the look for your comic.</p>
            </div>
          </div>
          <div className={styles.styleOptions} role="group" aria-label="Comic style">
            {COMIC_STYLES.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`${styles.styleOption} ${selectedStyle === option.id ? styles.styleOptionSelected : ""}`}
                aria-pressed={selectedStyle === option.id}
                onClick={() => setStyle(option.id)}
                disabled={isLoading}
              >
                <Image
                  src={STYLE_SAMPLE_IMAGES[option.id]}
                  alt=""
                  width={256}
                  height={256}
                  sizes="(max-width: 560px) 40vw, 80px"
                  className={styles.styleOptionImage}
                />
                <span>{option.name}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className={styles.formFooter}>
        <button
          type="button"
          aria-label="Generate comic"
          className={styles.generateButton}
          onClick={() => { void handleCreate(); }}
          disabled={!canGenerate}
        >
          {isLoading ? (
            <><Loader2 size={18} className={styles.spinner} aria-hidden="true" /> {loadingSteps[loadingStep]}</>
          ) : (
            <>Generate comic <ArrowRight size={19} aria-hidden="true" /></>
          )}
        </button>
        <div className={styles.actionMeta}>
          <span role="status">{actionHint}</span>
          {studioReady && <span>No account needed. Make another comic whenever you like.</span>}
        </div>
      </div>
    </section>
  );
}
