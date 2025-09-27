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
1. **Metadata Extraction**
   - Extend the backend ingestion worker so that LoRA uploads normalize the two frequency tables into a canonical lowercase key/value array (`tag` → `count`).
   - Persist the normalized arrays in the LoRA metadata JSON for re-use by moderation tooling and search.
2. **Heuristic Evaluation**
   - Iterate over the normalized tag list and compute:
     - `adultScore = Σ count(tag) for tag ∈ NSFW_FILTER_TERMS`.
     - `minorScore = Σ count(tag) for tag ∈ MINOR_FILTER_TERMS`.
     - `beastScore = Σ count(tag) for tag ∈ BESTIALITY_FILTER_TERMS`.
   - Compare each score against configurable thresholds (defaults below) to determine the moderation outcome.
3. **Outcome Mapping**
   - `adultScore ≥ 15` → mark LoRA as `adult=true` but keep it visible for curator/admin review.
   - `minorScore ≥ 1` or `beastScore ≥ 1` → place LoRA in the **Moderation** queue immediately and block community visibility until an administrator overrides it.
   - Otherwise leave `adult=false` and let downstream checks (image previews, user flags) provide additional signals.

### Default Filter Lists
These seed lists should be stored as JSON under `config/nsfw-metadata-filters.json` so administrators can tune them in the UI.

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
- Expose three numeric sliders (`adultThreshold`, `minorThreshold`, `beastThreshold`) in the Administration → Safety panel.
- Persist overrides in the same configuration JSON and trigger `scheduleAdultKeywordRecalculation` so existing LoRAs inherit new rules.
- Include a preview table that shows the number of stored LoRAs that currently exceed each threshold for quick calibration.

## 2. OpenCV Image Analysis Pipeline

### Objective
Analyze uploaded images on-premise and mark explicit content automatically while tolerating swimwear or lingerie that covers primary anatomy.

### Processing Stages
1. **Pre-processing**
   - Resize the input to a working resolution (longest edge ≤ 1,280 px) while maintaining aspect ratio.
   - Convert to HSV and YCrCb color spaces for robust skin-tone detection under varied lighting.
2. **Skin Region Estimation**
   - Apply color range masks in HSV and YCrCb; intersect the masks and clean them with morphological opening/closing.
   - Compute the ratio of skin pixels to total pixels and extract connected components for body-part analysis.
3. **Pose & Region Checks**
   - Run a lightweight pose estimator (e.g., OpenCV’s BlazePose or MediaPipe integration) to detect torso keypoints.
   - Evaluate coverage heuristics:
     - Large contiguous skin regions that include both torso and hip keypoints with minimal high-contrast clothing edges → candidate for full nudity.
     - High skin ratio limited to limbs or head without torso exposure → treat as non-blocking.
4. **Swimwear vs. Full Nudity**
   - Use edge density and color variance inside detected torso regions to infer clothing coverage: bikinis and lingerie typically introduce strong contrast edges along straps and waistbands; pure skin regions with low variance suggest nudity.
   - Maintain thresholds:
     - `skinRatio ≥ 0.35` **and** `coverageScore ≤ 0.25` → flag as `adult=true` (full nudity).
     - `skinRatio ≥ 0.2` **and** `coverageScore > 0.25` → mark as `suggestive` but keep `adult=false` for bikini-tier content.
5. **Disallowed Content Detection**
   - Scan prompts, filenames, and tag metadata for minor/bestiality keywords (reuse the lists above).
   - Incorporate a CNN classifier (e.g., MobileNet-based) fine-tuned for `minor` and `bestiality` cues; run it locally via ONNX Runtime on the CPU.
   - Any positive match marks the image with `moderationFlag=BLOCKED` and suppresses public visibility.
6. **Result Storage**
   - Serialize results into image metadata (e.g., `nsfw.adultScore`, `nsfw.suggestiveScore`, `nsfw.moderationFlag`).
   - Expose these fields to `determineAdultForImage` so the updated filter can combine them with textual signals.

### Runtime Considerations
- CPU-only deployment using OpenCV with OpenMP for multi-core scaling; expect < 120 ms per 1024×1024 image on a modern 8-core CPU.
- Batch processing queue with retry/backoff to prevent high CPU usage from blocking uploads; store intermediate results for auditing.
- Optional GPU acceleration via OpenCL or CUDA when deploying alongside existing GPU worker, but not required.

## 3. NSFW Filter & UI Integration

### Backend Filter Replacement
- Replace the existing keyword-only `determineAdultForImage` and `determineAdultForModel` implementations with a composable scoring engine that fuses:
  - Textual keyword hits (existing behavior).
  - LoRA metadata scores (`adultScore`, `minorScore`, `beastScore`).
  - OpenCV image analysis outputs (`adultScore`, `suggestiveScore`, `moderationFlag`).
- Define a final decision matrix:
  - `moderationFlag=BLOCKED` → auto-queue for moderation, hide from all non-admin roles.
  - `adultScore ≥ adultThreshold` → mark asset as adult; honor user safe-mode toggles.
  - `suggestiveScore ≥ suggestiveThreshold` → keep public but highlight in moderation queue for optional review.
- Implement audit logging so every decision writes the contributing signals for transparency.

### Administration Panel Updates
- **Safety Tab Enhancements**
  - Add configuration cards for metadata thresholds, image analysis thresholds, and keyword packs.
  - Provide CSV upload/download for filter lists to streamline bulk edits.
  - Visualize recent classification stats (e.g., counts of adult vs. flagged items in the last 24 hours).
- **Moderation Queue Redesign**
  - Replace the current tile layout with a split-pane UI:
    - Left rail: prioritized queue filtered by severity (Blocked, Adult, Suggestive, User Flags).
    - Right pane: large preview, metadata scores, contributing tags, and quick actions (Approve, Mark Adult, Remove).
  - Surface reason badges (`Keyword`, `Metadata`, `OpenCV`, `User Flag`) so moderators immediately know why an asset was queued.
  - Allow inline threshold adjustments for admins (debounced save to avoid noisy updates).

### Deployment Steps
1. Implement backend scoring services and migrations for new metadata fields.
2. Ship OpenCV pipeline as a dedicated worker process (`services/nsfw-analyzer`) with message queue integration (Redis or BullMQ via existing Node stack).
3. Update frontend admin routes to consume the new moderation API responses and render enhanced controls.
4. Backfill historical assets by enqueueing a one-time job that:
   - Rehydrates LoRA metadata scores from stored tables.
   - Processes existing images through the OpenCV pipeline.
   - Updates adult flags and moderation queue entries accordingly.
5. Document operational runbooks for tuning thresholds, reviewing audit logs, and handling false positives.

## Rollout & Monitoring

- **Staging Validation**: Deploy to a staging environment with anonymized samples representing safe, suggestive, and explicit categories. Verify pipeline latency and moderation accuracy.
- **Training**: Provide administrators with a short guide on interpreting the new scores and adjusting thresholds responsibly.
- **Observability**: Emit metrics (`nsfw.adult.marked`, `nsfw.moderation.flagged`, processing latency) to the existing monitoring stack.
- **Fallback Plan**: Maintain a feature flag that reverts to the legacy keyword-only system if severe regressions occur during rollout.

Following this plan will deliver a robust, fully self-hosted NSFW moderation system that blends metadata heuristics, on-device computer vision, and operator-friendly controls without depending on external services.
