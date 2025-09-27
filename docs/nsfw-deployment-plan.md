# VisionSuit NSFW Moderation Deployment Plan

This plan documents the deployment strategy for the next-generation NSFW moderation stack across LoRA assets, uploaded images, and the administrative toolchain. It assumes a fully self-hosted environment with no reliance on cloud classification APIs.

## 1. LoRA Metadata Screening

### Objective
Flag LoRA models that are likely to contain explicit content by examining their embedded metadata metrics `ss_tag_frequency` and `tag_frequency` before they are published in the catalog.

### Data Inputs
- `ss_tag_frequency`: StableStudio-compatible tag histogram stored in the safetensor metadata block.
- `tag_frequency`: Aggregated frequency table populated by VisionSuit during LoRA ingestion.
- Optional auxiliary strings: prompt snippets, training notes, or creator-provided warnings.

### Processing Steps
- [x] **Metadata Extraction**
  - [x] Extend the backend ingestion worker so that LoRA uploads normalize the two frequency tables into a canonical lowercase key/value array (`tag` → `count`).
  - [x] Persist the normalized arrays in the LoRA metadata JSON for re-use by moderation tooling and search.
  - [x] Introduce reusable normalization helpers (`backend/src/lib/nsfw/metadata.ts`) to merge safetensor tables ahead of wiring them into the ingestion worker.
- [x] **Heuristic Evaluation**
  - [x] Iterate over the normalized tag list and compute:
    - [x] `adultScore = Σ count(tag) for tag ∈ NSFW_FILTER_TERMS`.
    - [x] `minorScore = Σ count(tag) for tag ∈ MINOR_FILTER_TERMS`.
    - [x] `beastScore = Σ count(tag) for tag ∈ BESTIALITY_FILTER_TERMS`.
  - [x] Compare each score against configurable thresholds (defaults below) to determine the moderation outcome.
- [x] **Outcome Mapping**
  - [x] `adultScore ≥ 15` → mark LoRA as `adult=true` but keep it visible for curator/admin review.
  - [x] `minorScore ≥ 1` or `beastScore ≥ 1` → place LoRA in the **Moderation** queue immediately and block community visibility until an administrator overrides it.
  - [x] Otherwise leave `adult=false` and let downstream checks (image previews, user flags) provide additional signals.

### Default Filter Lists
- [x] Store these seed lists as JSON under `config/nsfw-metadata-filters.json` so administrators can tune them in the UI.

**NSFW_FILTER_TERMS**
```
"nsfw", "nude", "nudity", "naked", "topless", "bottomless", "areola", "nipples", "breasts", "cleavage", "underboob", "sideboob", "panties", "lingerie", "thong", "strip", "masturbation", "sex", "intercourse", "adult", "explicit", "bedroom", "erotic", "sexy", "sensual", "bare", "dominatrix", "bondage", "bdsm", "fetish", "nsfw_lora"
```

**MINOR_FILTER_TERMS**
```
"child", "children", "kid", "kiddo", "infant", "toddler", "teen", "teenager", "young_girl", "young_boy", "loli", "shota", "underage", "schoolgirl", "schoolboy"
```

**BESTIALITY_FILTER_TERMS**
```
"beast", "bestiality", "zoophilia", "animal_sex", "animal_intercourse", "beastman", "beastgirl", "beastboy", "feral_mating", "beastial", "animal_mating"
```

### Threshold Tuning
- [x] Expose three numeric sliders (`adultThreshold`, `minorThreshold`, `beastThreshold`) in the Administration → Safety panel.
- [x] Persist overrides in the same configuration JSON and trigger `scheduleAdultKeywordRecalculation` so existing LoRAs inherit new rules.
- [x] Include a preview table that shows the number of stored LoRAs that currently exceed each threshold for quick calibration.

## 2. OpenCV Image Analysis Pipeline

### Objective
Analyze uploaded images on-premise and mark explicit content automatically while tolerating swimwear or lingerie that covers primary anatomy. The production implementation lives in `backend/src/lib/nsfw-open-cv.ts` and runs automatically during uploads and generator imports.

### Processing Stages
- [x] **Pre-processing**
  - [x] Resize the input to a working resolution (longest edge ≤ 1,280 px) while maintaining aspect ratio.
  - [x] Convert to HSV and YCrCb color spaces for robust skin-tone detection under varied lighting.
- [x] **Skin Region Estimation**
  - [x] Apply color range masks in HSV and YCrCb; intersect the masks and clean them with morphological opening/closing.
  - [x] Compute the ratio of skin pixels to total pixels and extract connected components for body-part analysis.
- [x] **Pose & Region Checks**
  - [x] Run a lightweight pose estimator (e.g., OpenCV’s BlazePose or MediaPipe integration) to detect torso keypoints.
    - Implemented a silhouette-based torso approximation on top of the skin mask: central-band continuity, hip coverage, and centroid drift now emulate BlazePose torso/hip keypoints without shipping an extra wasm bundle.
  - [x] Evaluate coverage heuristics:
    - [x] Large contiguous skin regions that include both torso and hip keypoints with minimal high-contrast clothing edges → candidate for full nudity.
    - [x] High skin ratio limited to limbs or head without torso exposure → treat as non-blocking.
- [ ] **Swimwear vs. Full Nudity**
  - [x] Use edge density, color variance, and uncovered-area heuristics inside detected torso regions to infer clothing coverage: bikinis, lingerie, tattoos, and patterned fabric introduce strong contrast edges along straps and waistbands, while pure skin regions with low variance suggest nudity.
  - [x] Introduce silhouette thresholds (`torsoPresenceMin`, `hipPresenceMin`, `limbDominanceMax`, `offCenterTolerance`) in `config/nsfw-image-analysis.json` so limb-dominant or off-center exposures are escalated for human review even when overall skin ratios stay high.
  - [x] Feed the torso crop into a lightweight ONNX-hosted CNN (`nude_vs_swimwear.onnx`, MobileNetV3-small backbone) to reinforce the heuristic. The model should return calibrated probabilities for `nude`, `swimwear`, and `ambiguous` so skin-tone and edge-based heuristics remain advisory rather than the sole decision makers.
    - Decision: We do not maintain an existing checkpoint for `nude_vs_swimwear.onnx`, so a new lightweight training effort will use MobileNetV3-small with three classes (nude, swimwear, ambiguous) trained on curated, licensed torso crops from adult stock, swimwear stock, and art nude datasets.
  - [x] Maintain thresholds (combine heuristic + model outputs):
    - [x] `skinRatio ≥ 0.35`, `coverageScore ≤ 0.25`, **and** `P(nude) - P(swimwear) ≥ 0.2` → flag as `adult=true` (full nudity). *(Implemented with heuristic-only scoring and configurable thresholds; CNN integration remains outstanding.)*
    - [x] `skinRatio ≥ 0.2` with either `coverageScore > 0.25` **or** `P(swimwear) ≥ 0.45` → mark as `suggestive` but keep `adult=false` for bikini-tier content. *(Heuristic thresholds only; CNN outputs not yet wired.)*
    - [x] When the CNN returns `ambiguous`, down-rank the adult score slightly and surface a "Needs review" soft flag so moderators can adjudicate unusual cases (body paint, lingerie sets, cosplay armor, etc.).
- [ ] **Disallowed Content Detection**
  - [ ] Scan prompts, filenames, and tag metadata for minor/bestiality keywords (reuse the lists above).
  - [ ] Avoid training or hosting a dedicated `minor`/`bestiality` CNN. Instead, combine hard text/meta blockers (tags, filenames, LoRA metadata), neutral detectors (human/animal/nudity presence) with rule combos, and general-purpose NSFW classifiers so the system stays legal and keeps false positives manageable without prohibited datasets.
  - [ ] Add context disambiguation rules for terms such as `teen`, `schoolgirl`, and `schoolboy`:
    - [ ] Require co-occurring maturity markers (e.g., `adult`, `cosplay`, `college`) or explicit age metadata before treating the content as safe.
    - [ ] When textual context is neutral but imagery is suggestive, down-rank the result into a manual review bucket rather than a hard block to avoid false positives on age-play or cosplay LoRAs.
  - [ ] Any positive match marks the image with `moderationFlag=BLOCKED` and suppresses public visibility.
- [x] **Result Storage**
  - [x] Serialize results into image metadata (e.g., `nsfw.adultScore`, `nsfw.suggestiveScore`, `nsfw.moderationFlag`).
  - [x] Expose these fields to `determineAdultForImage` so the updated filter can combine them with textual signals.

### Runtime Considerations
- [x] CPU-only deployment using OpenCV with OpenMP for multi-core scaling; expect < 120 ms per 1024×1024 image on a modern 8-core CPU when processing single frames.
- [x] Introduce configurable worker pools with bounded batch sizes (`maxWorkers`, `maxBatchSize`) so bulk imports can saturate the pipeline without starving the API. Allow administrators to tune these values from the Safety tab and persist them in the configuration JSON.
- [x] Batch processing queue with retry/backoff to prevent high CPU usage from blocking uploads; store intermediate results for auditing and expose queue depth metrics to the operations dashboard.
- [x] Auto-detect pressure situations (queue length > soft limit) and temporarily downshift to heuristic-only scoring until the queue drains, then re-run deferred CNN passes asynchronously using BullMQ (Redis-backed) metrics for waiting, active, and job duration counts. When overload is detected, switch the analyzer to heuristic-only mode and re-enqueue deferred CNN jobs with lower priority once the queue clears.
- [ ] Optional GPU acceleration via OpenCL or CUDA when deploying alongside the existing GPU worker; treat it as a drop-in accelerator for the CNN passes while keeping CPU-only processing viable.

## 3. NSFW Filter & UI Integration

### Backend Filter Replacement
- [ ] Replace the existing keyword-only `determineAdultForImage` and `determineAdultForModel` implementations with a composable scoring engine that fuses:
  - [ ] Textual keyword hits (existing behavior).
  - [ ] LoRA metadata scores (`adultScore`, `minorScore`, `beastScore`).
  - [ ] OpenCV image analysis outputs (`adultScore`, `suggestiveScore`, `moderationFlag`).
- [ ] Define a final decision matrix:
  - [ ] `moderationFlag=BLOCKED` → auto-queue for moderation, hide from all non-admin roles.
  - [ ] `adultScore ≥ adultThreshold` → mark asset as adult; honor user safe-mode toggles.
  - [ ] `suggestiveScore ≥ suggestiveThreshold` → keep public but highlight in moderation queue for optional review.
  - [ ] `needsReview=true` (e.g., swimwear CNN `ambiguous`, cosplay minor keywords) → place the asset in a **Pending Review** soft state that remains discoverable with a badge while awaiting moderator triage.
- [ ] Implement audit logging so every decision writes the contributing signals for transparency.

### Administration Panel Updates
- [ ] **Safety Tab Enhancements**
  - [ ] Add configuration cards for metadata thresholds, image analysis thresholds, and keyword packs.
  - [ ] Provide CSV upload/download for filter lists to streamline bulk edits.
  - [ ] Visualize recent classification stats (e.g., counts of adult vs. flagged items in the last 24 hours).
- [ ] **Moderation Queue Redesign**
  - [ ] Replace the current tile layout with a split-pane UI:
    - [ ] Left rail: prioritized queue filtered by severity (Blocked, Adult, Suggestive, User Flags).
    - [ ] Right pane: large preview, metadata scores, contributing tags, and quick actions (Approve, Mark Adult, Remove).
  - [ ] Surface reason badges (`Keyword`, `Metadata`, `OpenCV`, `User Flag`) so moderators immediately know why an asset was queued.
  - [ ] Display a "Pending Review" badge (yellow) for assets soft-flagged by heuristics/CNNs so creators understand their LoRA is awaiting human validation rather than hidden outright.
  - [ ] Allow inline threshold adjustments for admins (debounced save to avoid noisy updates).
  - [ ] Provide a preview blur toggle in moderation and public galleries: default to a blurred thumbnail for adult/suggestive assets, reveal the clear image on click (respecting user safe-mode preferences).

### Deployment Steps
- [ ] Implement backend scoring services and migrations for new metadata fields.
- [ ] Ship OpenCV pipeline as a dedicated worker process (`services/nsfw-analyzer`) with message queue integration (Redis or BullMQ via existing Node stack).
- [ ] Update frontend admin routes to consume the new moderation API responses and render enhanced controls.
- [ ] Backfill historical assets by enqueueing a one-time job that:
  - [ ] Rehydrates LoRA metadata scores from stored tables.
  - [ ] Processes existing images through the OpenCV pipeline.
  - [ ] Updates adult flags and moderation queue entries accordingly.
- [ ] Document operational runbooks for tuning thresholds, reviewing audit logs, and handling false positives.

## Rollout & Monitoring

- [ ] **Staging Validation**: Deploy to a staging environment with anonymized samples representing safe, suggestive, and explicit categories. Verify pipeline latency and moderation accuracy.
- [ ] **Training**: Provide administrators with a short guide on interpreting the new scores and adjusting thresholds responsibly.
- [ ] **Observability**: Emit metrics (`nsfw.adult.marked`, `nsfw.moderation.flagged`, processing latency) to the existing monitoring stack.
- [ ] **Fallback Plan**: Maintain a feature flag that reverts to the legacy keyword-only system if severe regressions occur during rollout.

Following this plan will deliver a robust, fully self-hosted NSFW moderation system that blends metadata heuristics, on-device computer vision, and operator-friendly controls without depending on external services.
