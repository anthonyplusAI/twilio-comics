# AGENTS.md

This app features AI generation of comic books using OpenAI image models with user references being included in the final outputs, making it possible to create custom comic books with different styles and real characters in them.

## Commands
- `pnpm dev` - Start development server
Never execute this command always consider the "dev" server as already running, if inside CI then just consider build and lint. Locally dev server is run from the user.
- `pnpm build` - Production build
- `pnpm lint` - Run ESLint
- `pnpm drizzle-kit push` - Push DB schema changes, always remember to do this when doing schema changes with drizzle to prevent mismatch between schema and live db.
- `pnpm drizzle-kit generate` - Generate migrations

## Architecture
- **Framework**: Next.js 16 (App Router) with React 19, TypeScript
- **Auth**: Auth.js with Google OAuth (`next-auth`, `@auth/drizzle-adapter`)
- **Database**: Neon Postgres with Drizzle ORM (`lib/schema.ts`, `lib/db.ts`)
- **Storage**: Azure Blob Storage for images (`lib/blob-storage.ts`)
- **AI**: OpenAI for image generation and title/description generation (`openai`)
- **Jobs**: Azure Queue Storage with an event-driven ACA Job (`worker/`)
- **Rate Limiting**: Atomic PostgreSQL quota reservations (`lib/quota.ts`)
- **UI**: Radix primitives + shadcn/ui (`components/ui/`), Tailwind CSS v4

## Code Style
- Use `@/*` path alias for imports (e.g., `@/lib/utils`, `@/components/ui/button`)
- React Server Components by default; add `"use client"` only when needed
- Export types from schema: `Story`, `NewStory`, `Page`, `NewPage`
- Use Zod for validation, react-hook-form for forms
- API routes in `app/api/*/route.ts`, server actions in `lib/db-actions.ts`
- Component structure: `components/ui/` (primitives), `components/editor/`, `components/landing/`
