"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { Key, ExternalLink, ArrowRight, X, Check } from "lucide-react"
import { motion, AnimatePresence } from "motion/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { OPENAI_LINK } from "@/lib/utils"
import { useApiKey } from "@/hooks/use-api-key"
import styles from "./api-key-modal.module.css"

interface ApiKeyModalProps {
  theme?: "studio"
  isOpen: boolean
  onClose: () => void
  onSubmit: (key: string) => void
}

export function ApiKeyModal({ theme, isOpen, onClose, onSubmit }: ApiKeyModalProps) {
  const isStudio = theme === "studio"
  const [apiKeyInput, setApiKeyInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shakeKey, setShakeKey] = useState(0)
  const [success, setSuccess] = useState(false)
  const [existingKey, setApiKey] = useApiKey()

  useEffect(() => {
    if (isOpen) {
      setSuccess(false)
      setError(null)
      setApiKeyInput((current) => {
        if (existingKey && current === "") {
          return existingKey
        }
        return current
      })
    }
  }, [isOpen, existingKey])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKeyInput.trim()) return

    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/validate-api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      })
      const data = await res.json()

      if (!data.valid) {
        setError("Invalid API key. Please check and try again.")
        setShakeKey((k) => k + 1)
        setIsLoading(false)
        return
      }
    } catch {
      setError("Could not validate key. Please try again.")
      setShakeKey((k) => k + 1)
      setIsLoading(false)
      return
    }

    setIsLoading(false)
    setSuccess(true)
    onSubmit(apiKeyInput.trim())
    setTimeout(() => {
      setSuccess(false)
      setApiKeyInput("")
    }, 1400)
  }

  const handleDelete = () => {
    setApiKey(null)
    setApiKeyInput("")
    setError(null)
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className={isStudio ? styles.studioDialog : "border border-border/50 rounded-xl bg-background max-w-sm p-6 overflow-hidden"}>
        <AnimatePresence>
          {success && (
            <motion.div
              key="success"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className={isStudio ? styles.studioSuccess : "absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background rounded-xl"}
            >
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.05 }}
                className={isStudio ? styles.studioSuccessMark : "w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center"}
              >
                <Check className={isStudio ? styles.studioSuccessIcon : "w-7 h-7 text-emerald-400"} strokeWidth={2.5} />
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.2 }}
                className={isStudio ? styles.studioSuccessTitle : "text-sm font-medium text-white"}
              >
                API key saved
              </motion.p>
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.2 }}
                className={isStudio ? styles.studioSuccessText : "text-xs text-muted-foreground"}
              >
                You're all set for unlimited generation
              </motion.p>
            </motion.div>
          )}
        </AnimatePresence>
        <DialogHeader className={isStudio ? styles.studioHeader : "mb-4"}>
          <div className="flex items-center gap-2 mb-1">
            <Key className={isStudio ? styles.studioKeyIcon : "w-4 h-4 text-muted-foreground flex-shrink-0"} />
            <DialogTitle className={isStudio ? styles.studioTitle : "text-base font-semibold text-white leading-none"}>
              {existingKey ? "Your API key" : "Add your API key"}
            </DialogTitle>
          </div>
          <DialogDescription className={isStudio ? styles.studioDescription : "text-sm text-muted-foreground leading-snug pl-6"}>
            {existingKey
              ? "Update or remove your OpenAI key."
              : isStudio
                ? "Use your own OpenAI key for comic generation. You can add it at any time."
                : "You've used all your free credits. Add your key for unlimited use."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <AnimatePresence>
              {error && (
                <motion.p
                  key="error"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className={isStudio ? styles.studioError : "absolute bottom-full left-0 mb-1.5 text-xs text-red-400 flex items-center gap-1.5 pointer-events-none"}
                >
                  <span className={isStudio ? styles.studioErrorDot : "inline-block w-1 h-1 rounded-full bg-red-400 flex-shrink-0"} />
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <motion.div
              key={shakeKey}
              className="relative"
              animate={shakeKey > 0 ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : {}}
              transition={{ duration: 0.45, ease: "easeInOut" }}
            >
              <Input
                type="password"
                aria-label="OpenAI API key"
                value={apiKeyInput}
                onChange={(e) => { setApiKeyInput(e.target.value); setError(null) }}
                placeholder="sk-••••••••••••••••"
                className={isStudio
                  ? `${styles.studioInput} ${error ? styles.studioInputError : ""}`
                  : `bg-secondary border-border/50 text-white placeholder-muted-foreground/40 py-5 pr-10 font-mono text-sm transition-colors duration-200 ${error ? "border-red-500/60 focus-visible:ring-red-500/20" : ""}`}
              />
              {apiKeyInput && (
                <button
                  type="button"
                  onClick={() => setApiKeyInput("")}
                  className={isStudio ? styles.studioClear : "absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors"}
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </motion.div>
          </div>

          <a
            href={OPENAI_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className={isStudio ? styles.studioLink : "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-white transition-colors"}
          >
            Get an OpenAI API key
            <ExternalLink className="h-3 w-3" />
          </a>

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={existingKey ? handleDelete : onClose}
              className={isStudio
                ? `${styles.studioSecondaryButton} ${existingKey ? styles.studioDeleteButton : ""}`
                : `flex-1 border-border/50 hover:border-border transition-colors ${
                    existingKey
                      ? "text-red-400 border-red-500/30 hover:bg-red-500/10 hover:border-red-500/50 hover:text-red-300"
                      : "text-muted-foreground hover:text-white hover:bg-secondary"
                  }`}
            >
              {existingKey ? "Delete" : "Later"}
            </Button>
            <Button
              type="submit"
              disabled={!apiKeyInput.trim() || isLoading}
              className={isStudio ? styles.studioPrimaryButton : "flex-[2] gap-2 bg-white hover:bg-neutral-200 text-black font-medium"}
            >
              {isLoading ? "Checking…" : "Save key"}
              {!isLoading && <ArrowRight className="w-4 h-4" />}
            </Button>
          </div>

          <p className={isStudio ? styles.studioFinePrint : "text-xs text-muted-foreground/50 text-center pt-1"}>
            Stored locally and sent only when validating or generating
          </p>
        </form>
      </DialogContent>
    </Dialog>
  )
}
