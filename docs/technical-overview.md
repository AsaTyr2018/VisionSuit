# VisionSuit Technical Overview

VisionSuit is a self-hosted platform that combines a TypeScript/Node.js backend, a React frontend, and optional GPU workers to curate, moderate, and distribute AI-generated imagery. This document summarizes the key technical components, deployment considerations, and configuration surfaces that support the platform.

## Architecture at a Glance

- **Backend (`backend/`)** – Node.js API with Prisma ORM, authentication, moderation workflows, and administrative tooling. It connects to MinIO/S3-compatible storage and optional GPU agents.
- **Frontend (`frontend/`)** – React application with role-aware navigation, dashboards, and upload/moderation workflows. It communicates with the backend through authenticated REST endpoints.
- **GPU Worker (`gpuworker/`)** – Optional ComfyUI-based worker and a dedicated VisionSuit GPU agent used for on-site generation requests. Both ship with installers and scripts for synchronization and diagnostics.
- **Shared Configuration (`config/`)** – JSON and environment templates that govern NSFW analysis thresholds, scheduler behavior, and service endpoints.

## Backend Services

- **Authentication & Roles** – JWT-based auth with role-aware routes for administrators, curators, and members. Session persistence relies on HttpOnly cookies; admin sessions expose additional dashboards and moderation tooling.
- **Content Management** – Supports LoRA model uploads, gallery assets, collection curation, and revisioned model cards. Storage is proxied through the backend to keep MinIO details private.
- **Moderation Pipeline** – Flagging, review queues, and severity filters backed by OpenCV heuristics, ONNX classifiers, and configurable thresholds stored in `config/nsfw-image-analysis.json`.
- **Prompt Governance** – Keyword-based adult tagging, automated rescan workflows, and tagging automation for prompt-free assets via SmilingWolf/wd-swinv2.
- **Generator Control Plane** – Dispatches generation jobs to the GPU agent using configurable workflows, bucket policies, and callback URLs defined in `backend/.env`.

## Frontend Experience

- **Operations Dashboard** – Persistent navigation with live service health, quick links to uploads, moderation queues, and generator activity.
- **Role-Aware Interfaces** – Admin-specific workspaces, curator upload wizards, and guest-safe browsing with NSFW toggles.
- **Realtime Feedback** – Toast notifications, queue states, and moderation status indicators across explorers and detail dialogs.

## GPU Worker & Agent

- **ComfyUI Worker** – Installer at `gpuworker/install.sh` provisions GPU runtimes (CUDA or ROCm) and synchronizes assets with MinIO using bundled helper scripts.
- **VisionSuit GPU Agent** – Lives in `gpuworker/agent/`. Installs as a systemd service, validates workflows exported in ComfyUI API format, serializes job execution, and streams status callbacks back to VisionSuit.
- **Workflow Integration** – Default SDXL workflow located at `backend/generator-workflows/default.json`. Generator settings in `.env` map prompts, LoRA selections, and resolutions into the graph before dispatch.

## Configuration & Operations

- **Environment Alignment** – Administration settings write back to frontend/backend `.env` files to keep service endpoints synchronized.
- **NSFW Analysis** – Thresholds, execution providers, and scheduler limits are configurable via `config/nsfw-image-analysis.json` and the Administration → Safety UI.
- **Bucket Provisioning** – Run `(cd backend && npx ts-node --transpile-only scripts/setupGeneratorBuckets.ts)` once to create required MinIO buckets for generator workflows and outputs.
- **Installer Rollbacks** – `gpuworker/rollback-comfy.sh` and agent re-installers remove previous deployments to maintain clean upgrades.

For deeper planning artifacts, roadmaps, and operational reports, see the other documents inside `docs/`.
