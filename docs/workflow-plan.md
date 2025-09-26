# VisionSuit Workflow Plan

## 1. Project Overview
- **Goal**: Build a self-hostable Node.js platform for AI-generated image galleries and LoRA safetensor hosting.
- **USP**: Consistent upload experience with automatic metadata extraction, intelligent links between images and LoRAs, and high-performance search without enterprise databases.
- **Guiding Principles**: User-friendly modern dark UI, simple shell-based installation, focus on accessibility, and moderate hardware requirements.

## 2. Work Phases & Milestones
1. **Foundations & Planning (Week 1)**
   - Finalize requirements analysis, define data model and API specifications.
   - Evaluate libraries for image/LoRA safetensor analysis (e.g., `sharp`, `safetensors` via Node bindings).
2. **Backend Base (Week 2)**
   - Set up the Node.js project structure (TypeScript + Express/Fastify, Prisma/Drizzle with optional SQLite/PostgreSQL).
   - Prepare authentication/authorization (sessions + API key for automated uploads).
   - Define file storage strategy (local storage with structured folder hierarchy + checksums).
3. **Upload Pipeline & Metadata (Week 3)**
   - Build the upload wizard API: validations, chunked uploads, virus/malware scan hooks.
   - Implement metadata extractor: read PNG/JPEG EXIF, JSON sidecars, and safetensor headers.
   - Add asynchronous job queue for analysis (BullMQ with a Redis alternative such as `bullmq-lite` or a SQLite-based queue).
4. **Gallery & Hosting Functionality (Week 4)**
   - Provide REST/GraphQL endpoints for images & LoRAs (CRUD, search, filter, tagging).
   - Implement linking engine: automatically associate LoRA files with gallery entries based on tags/prompts.
   - Create search indices without Elastic: lightweight full-text (SQLite FTS5) + faceted filters.
5. **Frontend Web Panel (Weeks 5-6)**
   - Deliver a modern dark UI using React/Vite + Tailwind/Shadcn or SvelteKit.
   - Develop upload wizard UI with step-by-step form, validation feedback, drag & drop.
   - Add gallery view with infinite scroll, filter bars, detail drawer for metadata & linked LoRAs.
6. **Automation & Installation Layer (Week 7)**
   - Provide shell installation script (bash/sh) for automatic setup (Node, dependencies, DB migration, PM2 service).
   - Generate configuration templates (.env, storage paths).
7. **Quality Assurance & Release (Week 8)**
   - Set up tests (unit, integration, E2E with Playwright/Cypress).
   - Run accessibility and performance audits (Lighthouse, axe-core).
   - Prepare documentation, onboarding guide, release tagging.

## 3. Core Technical Components
- **Backend**: Node.js (LTS), TypeScript, Fastify/Express, Prisma/Drizzle ORM, SQLite as default DB.
- **Storage**: Local file system with structured storage (`/assets/images`, `/assets/loras`), hash verification.
- **Metadata Service**: Worker process with queue, uses libraries for EXIF and safetensor parsing.
- **Search & Filter**: SQLite FTS5 + tagging relations; optional caching with `node-cache` or `redis`.
- **Frontend**: React (Vite) or SvelteKit, TailwindCSS, Headless UI components, smooth page transitions via Framer Motion.
- **API Security**: Rate limiting, input sanitization, signed upload URLs, CSRF protection in the panel.

## 4. Upload Wizard Flow
1. User authenticates.
2. **"Basics" step**: name, type (image/LoRA), category, tags, description.
3. **"Files" step**: drag & drop, upload progress, hash verification.
4. **"Review" step**: summary + automatic metadata preview.
5. Submit → API creates entry, triggers analysis queue.
6. After analysis: link images ↔ LoRAs, enrich tags/prompts, send notification.

## 5. Metadata Extraction & Linking
- **Images**: EXIF, prompt JSON in PNG text chunk (Stable Diffusion), dimensions, model details.
- **LoRAs**: Read safetensor header, extract network architecture, trigger words, base model.
- **Matching Logic**: Compare tags, trigger words, prompt hash; allow manual review in the UI.
- **Moderation**: Perceptual hashing for duplicate detection, flagging rules for sensitive content.

## 6. Search & Filter Features
- Filter by type, category, tags, model, resolution, upload date.
- Full-text search across title, description, extracted prompts.
- Sorting (newest, most popular, community rating).
- Optional favorites/collections per user.

## 7. Deployment & Operations
- Target platform: self-hosted Linux (Debian/Ubuntu) without Docker.
- Installation script performs: Node installation (nvm or binary), `npm install`, DB migration, start via PM2/Systemd.
- Logging: Winston/Pino + rotating logs.
- Backup strategy: cron job for DB + assets (rsync/Restic).

## 8. Risks & Mitigations
- **Large files**: chunked upload + resume, storage quotas.
- **Metadata variety**: fallbacks for unknown formats, modular parsers.
- **Search performance**: caching layer, asynchronous indexing.
- **Legal considerations**: opt-in terms of use, content moderation/DMCA workflow.

## 9. Next Concrete Steps
1. Document detailed data model & API schema.
2. Build proof of concept for safetensor parsing in Node.js.
3. Define UI wireframes (upload wizard, gallery, detail view).
4. Gather installation script requirements (supported OS, dependencies).

This workflow plan serves as a guide and can be refined once technical evaluations are complete.
