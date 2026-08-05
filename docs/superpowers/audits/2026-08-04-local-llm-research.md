# Local LLM Inference for EpubGraph on Mac App Store (Tauri 2, Rust) — Research Report

**Research date:** 2026-08-04/05. Goal: remove the Ollama dependency, run local embeddings + light chat fully in-process (or via a bundled sandboxed helper), under the Mac App Store (MAS) App Sandbox, with Metal acceleration on Apple Silicon and a sane x86_64 fallback.

All findings below were gathered live via WebSearch/WebFetch/GitHub API/crates.io API on the stated date — not from training-data recall — because this space (Tauri 2, MLX, Foundation Models, model licensing, MAS review policy) has moved substantially through 2025-2026. Every claim below is sourced; items that could not be independently verified are explicitly flagged as such inline.

---

## Executive recommendation (read this first)

**Recommended stack:**
- **Inference engine (chat + embeddings, one dependency):** `llama-cpp-2` (crate, actively maintained, weekly releases) running GGUF models via llama.cpp's Metal backend. Statically linked, no `allow-jit`/`disable-library-validation`/`allow-unsigned-executable-memory` entitlements needed — confirmed by inspecting the entitlements of **Noema**, a shipping Mac App Store app that vendors llama.cpp's Metal backend with a clean sandboxed entitlements file.
- **Embedding model:** [IBM Granite Embedding 311M Multilingual R2](https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2) (Apache 2.0, ~253MB Q4_K_M GGUF, #2 open multilingual model under 500M params on MTEB, Spanish is an "enhanced" language).
- **Chat model:** [Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B) (Apache 2.0, ~1.1GB Q4_K_M GGUF, strong EN/ES, no redistribution obligations). Step up to Qwen3-4B on 16GB Macs for better prose, same license/family.
- **Delivery:** Bundle a minimal/degraded default in the `.app` (or nothing), then download the two GGUFs (~1.4GB combined) via a resumable `reqwest` HTTP Range-request downloader on first run, with explicit size disclosure + consent (satisfies App Review Guideline 4.2.3(ii)). Store in `Application Support/<bundle-id>/models/`, **not** Caches (Caches is silently OS-purgeable under disk pressure), and mark the directory excluded-from-backup via the `exclude_from_backups` crate. Apple's macOS app-size cap is actually 200GB (not the iOS 4GB/200MB cellular limits, which don't apply to Mac), so bundling in-app entirely is also a legitimate, simpler option if first-install size isn't a UX concern.

**One alternative worth strong consideration:** Use **Apple's Foundation Models framework** (macOS 26+, Apple Silicon only, free, zero bundling) as the primary chat backend when available via a small embedded Swift/XPC helper (Apple's own documented, MAS-legal "embed a helper tool in a sandboxed app" pattern — no `mach-lookup` exception needed for a private in-bundle service), falling back to the bundled llama.cpp/Qwen3 path on Intel Macs, older OS versions, or Apple-Intelligence-ineligible hardware. Foundation Models has **no embeddings API** (Apple's on-device embedding surface is the separate, older `NLContextualEmbedding` in the Natural Language framework), so embeddings still need the Rust/llama.cpp path regardless of which chat approach you pick. Apple announced (WWDC26) it will open-source an `MLXLanguageModel` backend for this framework "later this summer 2026" — unconfirmed as shipped as of this research; worth rechecking before committing to it.

**Three biggest risks:**
1. **Tauri 2's MAS build/signing path has live, partially-undocumented bugs.** `tauri build`'s documented `productbuild --sign` step only signs the installer wrapper, not the `.app` inside it, causing "app sandbox not enabled" rejections unless you manually `codesign --entitlements` the `.app` first ([tauri#13118](https://github.com/tauri-apps/tauri/issues/13118), fixed via workaround, not doc update). A second signing bug for MAS-style Apple Distribution identities is open as of April 2026 ([tauri#15230](https://github.com/tauri-apps/tauri/issues/15230)). Budget real time for signing/entitlements debugging, not just following the docs verbatim.
2. **No working macOS security-scoped-bookmark support exists anywhere in the Tauri ecosystem today.** `tauri-plugin-persisted-scope` only persists plain path strings to Tauri's in-process allow-list — it does nothing for the actual kernel-level sandbox extension NSURL bookmarks provide. The 4-year-old core feature request ([tauri#3716](https://github.com/tauri-apps/tauri/issues/3716)) is still open. EpubGraph's core feature — remembering a user-chosen ebook library folder across relaunches under sandbox — will require hand-rolling `objc2`/`objc2-foundation` NSURL bookmark calls; this is a real, unsolved engineering gap, not a research gap.
3. **Sidecar/helper-process entitlements conflict with Tauri's default deep-signing.** A documented production case ([MailVault's sandbox-signing writeup](https://mailvaultapp.com/blog/sandbox-signing-saga.html)) shows Tauri's default `codesign --deep` stamps the *outer app's* sandbox entitlements onto any bundled sidecar binary too, breaking anything that needs JIT/executable-memory (a real concern if any inference stack needs it, and a certain concern if you add an embedded Swift/XPC helper for Foundation Models) — requires separate entitlements plists and a specific non-deep signing order. Any Swift-bridging approach (`swift-rs`) is additionally a maintenance risk: its most recent commit is Dec 2024, ~20 months stale as of this research, against a fast-moving macOS/Xcode/Swift toolchain.

Full detail, sources, and the two alternate research paths (Swift-side / MLX) follow below.

---

## 1. Rust inference stacks (chat + embeddings)

### The central sandbox question, resolved up front

The task brief's premise — that Metal shader JIT compilation might require `com.apple.security.cs.allow-jit` (forbidden on MAS) — does not hold up under research. Two corrections:

- **`allow-jit` is not actually forbidden on the Mac App Store.** Apple's own [entitlement docs](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.allow-jit) scope it narrowly to `mmap()` calls with `MAP_JIT` — an app creating its **own** writable+executable memory (JS engines, bytecode VMs, emulators). It's used by shipping MAS apps (Electron/V8-based apps, browsers). What's actually disqualifying for MAS is `com.apple.security.cs.disable-library-validation` and `com.apple.security.cs.allow-unsigned-executable-memory`, because those permit loading/executing arbitrary unsigned code.
- **Metal shader compilation doesn't touch any of these entitlements regardless.** Asking `MTLDevice` to compile a `.metal` source string (`newLibraryWithSource:options:`) is serviced out-of-process by Apple's own `MTLCompilerService` over XPC. The compiling code never runs inside your sandboxed app's own address space, so none of the hardened-runtime exceptions apply — this is exactly how every Metal game (Unity, Unreal, Godot titles) already ships JIT-compiled shaders through MAS.

**Direct proof, not just theory:** [Noema: Local AI & Offline LLM](https://apps.apple.com/us/app/noema-local-ai-offline-llm/id6751169935) is a live Mac App Store app whose open-source repo ([noemaai-labs/noema-ios](https://github.com/noemaai-labs/noema-ios), pushed 2026-08-02) vendors llama.cpp directly (`ggml-metal`) with GPU offload. Its macOS sandbox entitlements file (`RelayServer.entitlements`) contains only `com.apple.security.app-sandbox`, `com.apple.security.network.client`, and audio/iCloud keys — **zero** hits for `allow-jit`, `disable-library-validation`, or `allow-unsigned-executable-memory` anywhere in the repo. This directly confirms llama.cpp's Metal path ships clean under MAS sandbox, and the same reasoning (same `MTLCompilerService` mechanism) extends to candle, mlx-rs, and mistral.rs below.

### 1.1 llama.cpp Rust bindings — `llama-cpp-2` / `llama-cpp-rs`

**Verdict: viable, most-precedented option (Noema proof above).**

- Crate: [`llama-cpp-2`](https://crates.io/crates/llama-cpp-2) **0.1.154**, published 2026-08-05 (same-week cadence; ~weekly releases). [`llama-cpp-sys-2`](https://crates.io/crates/llama-cpp-sys-2) tracks in lockstep.
- Repo: [utilityai/llama-cpp-rs](https://github.com/utilityai/llama-cpp-rs), 623 stars, most recent commit 2026-08-04 (active embedding-pooling-fix work landed same day as research) — actively maintained daily, not a stale wrapper.
- **Metal:** enabled via a `metal` Cargo feature, auto-enabled by default on macOS aarch64 targets; links `Metal.framework`/`Foundation.framework` (public system frameworks, always sandbox-permitted).
- **Shader compilation:** llama.cpp embeds `.metal` source text into the binary (`GGML_METAL_EMBED_LIBRARY=ON`, the modern default) and compiles at runtime via `newLibraryWithSource:`. A precompiled `.metallib` build option also exists if you want to avoid runtime compilation. Caveat: per [llama.cpp#12199](https://github.com/ggml-org/llama.cpp/issues/12199), the embedded-source path currently recompiles on every new `llama_context` — a startup-latency issue (not a sandbox issue); mitigate by reusing one long-lived context or building a precompiled metallib.
- **Linking:** static by default (`libllama.a`/`libggml.a`); a `dynamic-link` feature exists but is opt-in — avoid it for MAS.
- **Binary size:** no precise verified figure found; order-of-magnitude estimate is single-digit-to-low-double-digit MB for the static library, excluding model weights (separate multi-GB GGUF files).
- **Embeddings:** llama.cpp has native embedding-mode support (pooling strategies) and `llama-cpp-2` exposes it — one crate covers both chat and embeddings.

Sources: [llama-cpp-2](https://crates.io/crates/llama-cpp-2), [llama-cpp-sys-2](https://crates.io/crates/llama-cpp-sys-2), [utilityai/llama-cpp-rs](https://github.com/utilityai/llama-cpp-rs), [Metal backend docs](https://deepwiki.com/ggml-org/llama.cpp/5.2-metal-backend-(apple)), [llama.cpp#12199](https://github.com/ggml-org/llama.cpp/issues/12199), [Noema repo](https://github.com/noemaai-labs/noema-ios), [Noema on App Store](https://apps.apple.com/us/app/noema-local-ai-offline-llm/id6751169935), [Apple allow-jit docs](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.allow-jit).

### 1.2 candle (Hugging Face)

**Verdict: viable, same sandbox profile as llama.cpp, slightly behind on raw Metal throughput but closing the gap.**

- Crates: `candle-core`/`candle-nn`/`candle-transformers` all at **0.11.0** (2026-06-26). Repo very active: [huggingface/candle](https://github.com/huggingface/candle), 20,842 stars, pushed 2026-07-30 (a Metal-path Qwen3 attention-mask bugfix landed that day).
- **Metal quantized GGUF chat:** mature; [PR #2615](https://github.com/huggingface/candle/pull/2615) added Metal mat-mat quantized kernels, reported ~2.5x faster than MLX and within ~10% of llama.cpp on prompt processing.
- **Shader compilation (verified directly in source):** `candle-metal-kernels/src/utils.rs` embeds `.metal` kernels via `include_str!` at compile time; `metal/device.rs` calls `new_library_with_source(...)` — runtime JIT via `MTLCompilerService`, same category as llama.cpp, same sandbox story (fine).
- **Embeddings:** `candle-transformers` includes BERT-family model code; no turnkey pipeline crate as convenient as fastembed-rs — you wire up the model yourself.
- **Binary size:** secondary-source estimates only (~22-48MB for various example binaries) — not independently verified, flagged as directional only.

Sources: [candle-core](https://crates.io/crates/candle-core), [huggingface/candle](https://github.com/huggingface/candle), [candle-metal-kernels source](https://github.com/huggingface/candle/tree/main/candle-metal-kernels/src), [PR #2615](https://github.com/huggingface/candle/pull/2615), [quantization docs](https://deepwiki.com/huggingface/candle/4-quantization).

### 1.3 mlx-rs (Rust bindings for Apple MLX)

**Verdict: cleanest static-linking story of all five stacks technically, but the Rust binding layer itself shows real maintenance-risk signals in 2026 — treat as higher-risk for a production dependency right now.**

- Crate: [`mlx-rs`](https://crates.io/crates/mlx-rs) **0.25.3**, published 2025-12-16 — **~8 months stale** as of this research, by far the largest gap of any crate reviewed.
- Repo: transferred from `oxideai/mlx-rs` to `oxiglade/mlx-rs` (confirmed via GitHub API); most recent commit 2026-03-27 — ~4+ months of inactivity. README still carries "⚠️ Project is in active development" banner as its own self-assessment.
- **Build/linking (verified directly in `mlx-sys/build.rs`):** builds Apple's `mlx-c` from source via CMake, links `static=mlx`/`static=mlxc` plus only Apple system frameworks (`Metal`, `Foundation`, `libobjc`, `libc++`) — fully static, no third-party dylibs, the cleanest code-signing story of the five stacks.
- **MLX's own JIT** (`MLX_METAL_JIT` build flag) is the same category of runtime shader compilation as candle/llama.cpp — no sandbox issue.
- The underlying [ml-explore/mlx](https://github.com/ml-explore/mlx) C++ framework itself is extremely healthy (27,826 stars, pushed 2026-08-05, v0.32.0 released 2026-07-07) — the staleness is specific to the Rust binding layer, not Apple's MLX.

Sources: [mlx-rs on crates.io](https://crates.io/crates/mlx-rs), [oxiglade/mlx-rs](https://github.com/oxiglade/mlx-rs), [ml-explore/mlx](https://github.com/ml-explore/mlx), [MLX install docs](https://ml-explore.github.io/mlx/build/html/install.html).

### 1.4 ort (ONNX Runtime) + fastembed-rs — for embeddings specifically

**Verdict: viable for embeddings; default config is already MAS-friendly, but CoreML/GPU acceleration needs explicit configuration and verification.**

- Crates: [`ort`](https://crates.io/crates/ort) **2.0.0-rc.13** (2026-07-28) — docs call it "production-ready" despite the long-running `-rc` tag. [`fastembed`](https://crates.io/crates/fastembed) **5.17.4** (2026-07-28), pinned exactly to that `ort` version. Both very actively maintained (ort: 2 open issues, pushed 2026-08-05).
- **Linking:** `ort`'s default `download-binaries` feature prefers static linking over dynamic when both are available; `fastembed`'s defaults inherit this. The `load-dynamic` runtime-dylib feature is opt-in — leave it off for MAS to avoid any library-validation questions.
- **CoreML gotcha (real, unresolved):** CoreML EP is gated behind a `coreml` feature, and the default prebuilt ONNX Runtime binaries may not include CoreML support at all — an open [fastembed-rs issue #137](https://github.com/Anush008/fastembed-rs/issues/137) (filed 2024-12-15, still open) reports an M4 Mac running CPU-only at 100% CPU with no Neural Engine engagement. **Don't assume GPU/ANE acceleration works out of the box** — explicitly configure the `coreml` feature and verify via `EP::is_available()`.
- No native Metal EP exists for ONNX Runtime on macOS; GPU acceleration goes through CoreML only.
- **Binary size:** ~7-19MB range estimated from Python wheel proxies, not a direct static-lib measurement.

Sources: [ort](https://crates.io/crates/ort), [pykeio/ort](https://github.com/pykeio/ort), [ort linking docs](https://ort.pyke.io/setup/linking), [ort cargo features](https://ort.pyke.io/setup/cargo-features), [fastembed](https://crates.io/crates/fastembed), [Anush008/fastembed-rs](https://github.com/Anush008/fastembed-rs), [fastembed-rs#137](https://github.com/Anush008/fastembed-rs/issues/137).

### 1.5 mistral.rs

**Verdict: the only stack with a genuinely unified first-class Rust API for both chat and embeddings, and the best-designed Metal shader story (AOT compilation by default) — a strong dark-horse candidate.**

- Crates: [`mistralrs`](https://crates.io/crates/mistralrs)/`mistralrs-core` on crates.io at **0.8.1** (2026-04-02) — but [GitHub](https://github.com/EricLBuehler/mistral.rs) has since shipped v0.9.0 (2026-07-07) with commits as recent as 2026-07-29. **crates.io is ~4 months behind GitHub** — pin a git dependency if adopting this, or wait for the next publish.
- Repo very active: 7,566 stars, pushed 2026-07-29.
- **Metal:** built on candle internally (pinned git rev, not crates.io candle release).
- **Shader compilation — standout finding, verified directly in source:** a dedicated `mistralrs-metal-compile` crate defaults (`MISTRALRS_METAL_PRECOMPILE`, on by default) to **AOT-compiling** `.metal` sources into precompiled metallibs via `build.rs` at your build time, falling back to the same runtime-JIT path as candle/llama.cpp only if explicitly disabled. This is the only stack of the four GPU-capable ones that avoids runtime shader compilation by default — better first-launch latency, and sidesteps the "recompiled per-context" issue flagged for llama.cpp.
- **Embeddings — confirmed first-class, not a stretch:** documented `EmbeddingModelBuilder`/`EmbeddingRequest` Rust API plus an OpenAI-compatible `/v1/embeddings` endpoint, tested against `google/embeddinggemma-300m` and `Qwen/Qwen3-Embedding-0.6B`. One dependency, one runtime process, both chat and embeddings — simplest binary/entitlement surface of any option here.

Sources: [mistralrs](https://crates.io/crates/mistralrs), [mistralrs-core](https://crates.io/crates/mistralrs-core), [EricLBuehler/mistral.rs](https://github.com/EricLBuehler/mistral.rs) (workspace Cargo.toml, `mistralrs-metal-compile/src/lib.rs`, embeddings docs read directly), [releases](https://github.com/EricLBuehler/mistral.rs/releases).

### Cross-cutting notes

- Most popular general-purpose local-LLM chat apps (LM Studio, GPT4All, Ollama, Msty, BoltAI, Jan) are **not** distributed via the Mac App Store — they ship as direct, notarized-outside-sandbox downloads. MAS distribution for this category is uncommon, but the research above shows it is not blocked by Metal/JIT concerns; more likely reasons are wanting unsandboxed filesystem access, running local HTTP servers, or avoiding App Review latency.
- Binary size figures throughout are approximate; no rigorous current apples-to-apples comparison across all five stacks was found. Measure your own static build if exact numbers matter.

---

## 2. Swift-side alternative: Foundation Models / MLX Swift as a sidecar

### 2.1 Apple's Foundation Models framework

- **Availability:** public, third-party-usable Swift API since **macOS 26 "Tahoe"** (Apple switched to year-based OS versioning in 2025 — this is not "macOS 15/16"), announced WWDC 2025, confirmed in [Apple's Sept 2025 newsroom post](https://www.apple.com/newsroom/2025/09/apples-foundation-models-framework-unlocks-new-intelligent-app-experiences/). `import FoundationModels`, no special App Review gate found beyond normal capability availability.
- **WWDC 2026 expansion** (sessions [241](https://developer.apple.com/videos/play/wwdc2026/241/) and [339](https://developer.apple.com/videos/play/wwdc2026/339/), June 8-9 2026): a new `LanguageModel` protocol abstracts the backend; Apple's own `SystemLanguageModel` (on-device) and `PrivateCloudComputeLanguageModel` (32K context, free under 2M downloads) both conform. Apple announced it will open-source the framework core plus two reference backends — **`CoreAILanguageModel`** (Neural Engine) and **`MLXLanguageModel`** (MLX-Community HF models on Mac GPU) — "later this summer" 2026. **Unconfirmed as actually shipped as of 2026-08-04** — only a companion utilities package (`apple/foundation-models-utilities`, Apache-2.0) was confirmed live; verify current state before depending on it.
- **Hardware:** Apple Silicon (M1+) only, ~8GB unified memory minimum for baseline features. **Intel Macs are excluded entirely** — confirmed across multiple sources, no exceptions found. (Side note: macOS 27, in beta as of this research, will be the first macOS version to drop Intel support altogether — reinforcing that any Foundation Models integration is Apple-Silicon-only by design going forward.)
- **Capabilities:** guided/structured generation (`@Generable`/`@Guide` macros), tool calling, multi-turn streaming sessions. WWDC26 added multimodal (image) input, configurable reasoning levels (cloud model only), context introspection, an Evaluations framework, and a `SpotlightSearchTool` for RAG-style access to an on-device semantic index (a tool the model calls, not a general embeddings API).
- **No embeddings API.** Confirmed absent from both the docs and the WWDC26 "what's new" session. Apple's on-device embedding surface is the separate, older **`NLContextualEmbedding`** (Natural Language framework, since iOS 17/macOS 14) — a BERT-like on-device sentence/token embedder, usable independently of Foundation Models.
- **Entitlements:** no Foundation-Models-specific entitlement/Info.plist key found for baseline chat/structured-generation use — gate at runtime via `SystemLanguageModel.availability`. A "Foundation Models Framework Adapter Entitlement" surfaced only in the context of custom LoRA adapter distribution (advanced/optional, unverified specifics).
- **Cost/content restrictions:** free (no per-token cost), but [Apple's Acceptable Use Requirements](https://developer.apple.com/apple-intelligence/acceptable-use-requirements-for-the-foundation-models-framework/) prohibit adult/erotic content, unsupervised high-impact decisions in employment/medical/legal/finance, and several other categories — worth a skim for a book-Q&A/recommendation use case (low risk, but review before shipping).

### 2.2 MLX Swift

- [`mlx-swift`](https://github.com/ml-explore/mlx-swift) + [`mlx-swift-lm`](https://github.com/ml-explore/mlx-swift-lm) (renamed/successor to `mlx-swift-examples`, referenced directly in WWDC26 materials) cover chat/generation, streaming, tool calling, LoRA, quantized loading. GGUF read support exists for a subset of quantizations (Q4_0/Q4_1/Q8_0 native; others cast to fp16).
- **Embeddings** are not yet unified into one first-party Swift package: options are [Blaizzy/mlx-embeddings](https://github.com/Blaizzy/mlx-embeddings) (Python), [jkrukowski/swift-embeddings](https://github.com/jkrukowski/swift-embeddings) (pure Swift, `MLTensor`-based), [mzbac/mlx.embeddings](https://github.com/mzbac/mlx.embeddings). `mlx-swift-lm` has an `embeddings.md` reference doc suggesting first-party support is being folded in, not confirmed finished.
- **Sandbox/JIT:** same corrected reasoning as Section 1 — MLX's runtime Metal kernel compilation is out-of-process via `MTLCompilerService`, not app-process `MAP_JIT`, and is not blocked by MAS rules. (The task brief's premise that `allow-jit` is MAS-forbidden was the one fact worth correcting across both the Rust and Swift research.)
- **Shipped precedent:** [MLX Studio: Local AI Chat App](https://apps.apple.com/us/app/mlx-studio-local-ai-chat/id6757399038) is live on the Mac App Store today — 100% on-device, 15+ pre-configured MLX models, macOS 14.0+, native SwiftUI (not a hybrid/Tauri app, so it validates MLX-under-MAS-sandbox but not the Rust-bridging path specifically).
- WWDC26's announced `MLXLanguageModel` backend for Foundation Models (see 2.1) is a strong signal Apple considers MLX-on-Metal a legitimate production path for third-party apps — same "unconfirmed shipped yet" caveat applies.

### 2.3 Bridging Swift into Tauri while staying MAS-legal

**Option A — `swift-rs`:** statically links a compiled Swift Package directly into the Rust binary via `build.rs` + `swiftc`; exposed functions must be `@_cdecl` free functions with ObjC-representable types only. Architecturally MAS-safe (everything ends up under one code signature/Team ID, no separate unsigned executable, no `disable-library-validation` needed). **Maintenance risk: latest tagged release 1.0.7 is Aug 26 2024, last commit Dec 12 2024 — ~20 months stale as of this research**, against a fast-moving Xcode/Swift/macOS toolchain (macOS 26 Tahoe, Swift 6.x). A known Tauri-specific gotcha (`Library not loaded: @rpath/libswiftCore.dylib`) is documented in swift-rs's own README, fixable via `tauri.conf.json` minimum-system-version config. Less-established, more-active alternatives: [Choochmeque/tauri-swift-runtime](https://github.com/Choochmeque/tauri-swift-runtime) and [chinedufn/swift-bridge](https://github.com/chinedufn/swift-bridge).

**Option B — embedded helper tool / private in-bundle XPC service (recommended):** Apple's own current doc, [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app), is written explicitly with Mac App Store submission in mind (its validation walkthrough uses App Store Connect distribution, real `Authority=Apple Distribution` codesign output). The helper is placed via a "Copy Files" build phase (Destination: Executables), gets `com.apple.security.app-sandbox=true` + `com.apple.security.inherit=true` (inheriting the parent's sandbox rather than negotiating separately), and is signed under the same Team ID as the main app. For a **private, in-bundle XPC service** specifically, no `mach-lookup.global-name` temporary-exception entitlement is needed — that's only required for reaching a global/system-wide Mach service outside your own app bundle (confirmed by contrast with [Sparkle's sandboxing docs](https://sparkle-project.org/documentation/sandboxing/), which does need it, but only because Sparkle's updater is a separately-versioned system-wide service, not a plain private helper).

**Real-world precedent:** [jaytuduri/tauri-plugin-apple-intelligence](https://github.com/jaytuduri/tauri-plugin-apple-intelligence) is an actual Tauri v2 plugin wrapping Foundation Models (text generation, streaming, tool calling), but it's very early (2 stars, 14 commits, explicitly labeled "API may change") and makes no mention of MAS distribution or sandboxing. **No confirmed case of a shipped Tauri+embedded-Swift/XPC MAS app for local ML was found** — the mechanism is independently proven safe on both sides (Apple's helper-tool docs for MAS generally; MLX Studio for MLX-under-sandbox specifically) but the specific combination is architecturally sound-by-composition rather than directly precedented.

---

## 3. Model choices + licensing for App Store redistribution

### 3.1 Embeddings (multilingual, EN/ES, book metadata/descriptions)

| Model | License | Size (quantized) | Notes |
|---|---|---|---|
| [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) | MIT | Q8_0 ≈ 635MB | Still solid, no longer SOTA vs. 2025/26 entrants |
| [nomic-embed-text-v2-moe](https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe) | Apache 2.0 | Q4_K_M ≈ 328MB | MoE (305M active/475M total), ~100 languages |
| [snowflake-arctic-embed-m/l-v2.0](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0) | Apache 2.0 | comparable to bge-m3 class | strong multilingual retrieval, MRL down to 128 bytes |
| [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | Apache 2.0 | Q8_0 = 639MB (Q4 ~350-400MB est.) | family tops MTEB multilingual leaderboard overall (8B variant: 70.58) |
| [jina-embeddings-v4](https://huggingface.co/jinaai/jina-embeddings-v4) | **CC-BY-NC-4.0 (non-commercial)** | too large anyway (3.8B) | **disqualified** — blocks commercial redistribution |
| [google/embeddinggemma-300m](https://huggingface.co/google/embeddinggemma-300m) | **Gemma Terms of Use** (custom, not Apache) | <200MB w/ int4 QAT | #1 on MTEB multilingual under 500M params, but see license caveat below |
| **[ibm-granite/granite-embedding-311m-multilingual-r2](https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2)** | **Apache 2.0** | **Q4_K_M ≈ 253MB**, Q8_0 ≈ 347MB | **Recommended** — #2 open multilingual model under 500M params, MTEB multilingual retrieval 65.2, Spanish is an "enhanced" language, released May 14 2026 |
| [ibm-granite/granite-embedding-97m-multilingual-r2](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2) | Apache 2.0 | ONNX ~98MB | fallback if an even smaller footprint is needed; #1 under 100M params |

**License caveat worth flagging explicitly:** Google's April 2026 relicense of Gemma to Apache 2.0 ([announcement](https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html)) applies to the **Gemma 4 generative line only** — **EmbeddingGemma remains under the older custom Gemma Terms of Use** ([ai.google.dev/gemma/terms](https://ai.google.dev/gemma/terms)), which requires flowing Google's restrictions down to end users via your own EULA and carrying prominent modification notices — real legal/ops overhead a paid App Store app doesn't need when Apache-2.0 alternatives (Granite, Qwen3-Embedding) now match it on quality.

**Recommendation:** Granite Embedding 311M Multilingual R2, Apache 2.0, Q4_K_M (~253MB). Alternative: Qwen3-Embedding-0.6B (Apache 2.0, slightly larger, top-of-leaderboard family).

### 3.2 Chat/instruct (~1-4B, light Q&A / recommendation copy)

| Model | License | Size (Q4_K_M) | Notes |
|---|---|---|---|
| **[Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B)** (also 0.6B/4B) | **Apache 2.0** | 0.6B=397MB, 1.7B≈1.1GB | **Recommended** — cleanest license, 100+ languages incl. strong Spanish, no attribution/naming obligations |
| Llama 3.2 (1B/3B) / Llama 4 | **Meta Llama Community License** (not Apache/MIT) | — | 700M-MAU threshold clause (not a practical blocker at this scale, but a real ongoing dependency on Meta's discretion), **mandatory "Built with Llama" UI attribution**, derivative-naming restriction ("Llama" prefix required) — extra legal/UI surface for no quality gain over Apache alternatives at this size |
| Gemma 3 / 3n | custom Gemma Terms of Use | — | same redistribution/flow-down obligations as EmbeddingGemma |
| **Gemma 4** (Apr 2 2026) | **Apache 2.0** (newly relicensed) | E2B Q4_0 ≈ 2.84GB | purpose-built for offline/edge, 140+ languages, 128K context — legitimate alternative now that licensing friction is gone |
| Phi-4-mini | **MIT** | Q6_K_L ≈ 3.30GB | cleanest license of all, but tuned more for reasoning/math; only 23 languages |
| SmolLM3-3B | Apache 2.0 | Q4_K_M ≈ 1.92GB | curated 6-language multilingual set explicitly including Spanish |
| Ministral 3 (3B/8B/14B) | Apache 2.0 | — | Dec 2025 successor; earlier Ministral required a commercial license, this one doesn't |

**Recommendation:** Qwen3-1.7B, Apache 2.0, Q4_K_M (~1.1GB); step to Qwen3-4B (~2.5GB) on 16GB Macs. **Alternative:** Gemma 4 E2B (Apache 2.0 as of April 2026, ~2.84GB Q4_0, purpose-built for offline/edge) — newer track record than Qwen3, worth revisiting as it matures.

**Complementary strategy (not a replacement):** where Apple's Foundation Models framework is available (Apple Silicon, macOS 26+, Apple Intelligence enabled), it ships with zero bundling/licensing burden and can serve as the primary chat backend, falling back to the bundled Qwen3 GGUF on Intel/older/ineligible Macs.

---

## 4. Delivery pattern: bundle vs. download

### App size limits (2026)

Directly from Apple's live [Maximum build file sizes](https://developer.apple.com/help/app-store-connect/reference/maximum-build-file-sizes/) doc: **macOS apps can be up to 200GB uncompressed** — there is no macOS equivalent of iOS's 4GB bundle cap or 200MB cellular-download gate (both are iOS/iPadOS-specific and don't apply to Macs, which have no cellular radio). **A 200MB-2GB model combo is nowhere near any hard Apple limit** — bundling both models directly in the `.app` at submission time is a legitimate, simple option that sidesteps the entire post-install-download question.

**On-Demand Resources does not work on macOS** ("macOS and watchOS don't support on-demand resources" — [Apple docs](https://developer.apple.com/help/app-store-connect/reference/on-demand-resources-size-limits/)), and is now deprecated fleet-wide in favor of **Background Assets** ([developer.apple.com/documentation/backgroundassets](https://developer.apple.com/documentation/backgroundassets)), which does support native macOS 13.0+. However, its managed/Apple-hosted mode requires an Xcode App Extension target — awkward to retrofit into a Tauri-generated Xcode project. The pragmatic path for a Tauri app is a self-hosted download (your own HTTP GET with Range-resume), which is what comparable local-AI Tauri/Electron-adjacent apps already do.

### App Review stance — confirmed acceptable, well-precedented

Guideline **4.2.3(ii)**: *"If your app needs to download additional resources in order to function on initial launch, disclose the size of the download and prompt users before doing so."* Guidelines 2.4.5(iv)/2.5.2 restrict downloading **code** that changes functionality — inert model weight files for an already-reviewed feature (chat/search) don't trip this. Real, currently-shipping precedents downloading GB-scale models post-install on the Mac App Store: **Draw Things**, **Private LLM**, **FreeChat**, **Locally AI by LM Studio**, **OneLLM**. Practical checklist: ship a minimally-functional default state pre-download, disclose size + get consent before the pull, frame it as more content for the same feature (not unlocking a different app).

**Worth weighing seriously:** LM Studio, Ollama, GPT4All, and MacWhisper's full-featured build all skip the Mac App Store entirely, distributing as notarized (non-sandboxed) DMGs — removing 2.4.5's constraints altogether. If MAS discoverability isn't a hard requirement, this is a well-trodden lower-friction path for exactly this app category.

### Resumable download implementation

Sandboxed apps need `com.apple.security.network.client` for any outbound networking (confirmed via a real sandboxed-Tauri debugging report, [tauri-docs#3171](https://github.com/tauri-apps/tauri-docs/issues/3171) — without it, sandboxed Tauri apps fail silently with a white screen). There's no macOS equivalent of iOS's `UIBackgroundModes` capability-declaration dance (macOS doesn't suspend background processes as aggressively as iOS). The idiomatic Tauri pattern: stream via `reqwest`, write to a `.part` file with persisted byte-offset state, resume via `Range: bytes=<offset>-` (HTTP 206), verify a checksum on completion. Tauri's own community has documented forwarding download progress as Tauri events via a `ProgressHandler` ([tauri discussion #4726](https://github.com/orgs/tauri-apps/discussions/4726)). Native `URLSession` background sessions (survive full app-quit) are a possible upgrade but require Swift/ObjC FFI bridging Tauri doesn't provide out of the box — treat as optional, not baseline.

### Where model files live

Sandboxed container: `~/Library/Containers/<bundle-id>/Data/Library/Application Support/<bundle-id>/...` — Tauri's `appDataDir()` resolves here automatically (both sandboxed and non-sandboxed). **Store models in Application Support, not Caches.** Apple's own doc on this ([Optimizing Your App's Data for iCloud Backup](https://developer.apple.com/documentation/foundation/optimizing_your_app_s_data_for_icloud_backup/)) states Caches is "periodically purged" by the system, and a live Apple Developer Forums thread documents a named system mechanism (`CacheDeleteAppContainerCaches`) that deletes container caches under disk pressure — a real risk of a model vanishing mid-session. Mark the model directory excluded-from-backup (via the `exclude_from_backups` crate, wrapping `NSURLIsExcludedFromBackupKey`) to keep Time Machine from wasting GBs on re-downloadable weights — apply at the directory level per Apple's own recommendation. No iCloud sync risk exists unless you separately opt into ubiquity-container APIs; keep the model directory structurally separate from any future iCloud-sync feature's path as a precaution.

---

## 5. Tauri 2 + Mac App Store specifics

**Current Tauri version (verified via crates.io API):** core `tauri` at **2.11.5** (2026-07-01), CLI 2.11.4, tauri-bundler 2.9.4. No "beta" language anywhere in current docs; MAS is documented as one of three macOS output targets (App Bundle / App Store / DMG) without an explicit stability label.

### 5.1 Official docs and known signing bugs

Current guide: [App Store | Tauri](https://v2.tauri.app/distribute/app-store/), plus [macOS Application Bundle](https://v2.tauri.app/distribute/macos-application-bundle/) and [Code signing / notarization for macOS](https://v2.tauri.app/distribute/sign/macos/). Config wiring: `bundle.macOS.entitlements` → dedicated `Entitlements.plist` (must not be Info.plist), `bundle.macOS.files["embedded.provisionprofile"]`, `bundle.category`.

**Two real, current bugs found:**
- [tauri#13118](https://github.com/tauri-apps/tauri/issues/13118) (closed Aug 2025): following the documented `productbuild --sign` sequence verbatim produces "App sandbox not enabled" / root-owned-file validation failures, because `productbuild --sign` only signs the installer wrapper, not the `.app` inside it — entitlements never reach the actual binary. Fix (undocumented in Tauri's own guide): `codesign --force --options runtime --entitlements Entitlements.plist --sign "<Apple Distribution identity>" App.app` **before** `productbuild`.
- [tauri#15230](https://github.com/tauri-apps/tauri/issues/15230) (**open**, filed April 2026): Tauri's internal `Keychain::sign` omits `--requirements`, causing `codesign --strict` to fail the "does not satisfy its designated Requirement" check specifically for Apple-Distribution/MAS-style signing. Workaround: manual re-sign pass.
- A separate real-world report ([tauri#13815](https://github.com/tauri-apps/tauri/issues/13815), closed same-day): app passed validation and installed via TestFlight/MAS but showed a blank window at launch — root cause was a missing `com.apple.security.network.client` entitlement, needed even for the webview/IPC layer of a fully local app.

Sidecar/bundled-binary signing is **not covered by the official docs at all** — real-world detail comes from a third-party production writeup ([MailVault's "macOS Sandbox Signing Saga"](https://mailvaultapp.com/blog/sandbox-signing-saga.html)): Tauri's default `codesign --deep` stamps the outer app's sandbox entitlements onto any bundled sidecar too, breaking anything needing JIT/executable memory. Fix: separate entitlements plists per binary, sign the sidecar first, sign the outer `.app` **without** `--deep`. This directly matters if you ship an inference engine or Swift helper as a sidecar rather than statically linking it.

### 5.2 Security-scoped bookmarks — a real, unsolved gap

**Verdict, confirmed by reading source directly, not just docs: no working macOS desktop solution exists in Tauri core or its official plugins today.**

- `plugins/fs/src/ios.rs` in [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) implements `startAccessingSecurityScopedResource()` via `objc2_foundation::NSURL` — but this file is **iOS-only**. `plugins/fs/src/desktop.rs` (used for macOS) has **zero** matches for `objc`, `NSURL`, `security`, or `bookmark` — plain `std::fs` only.
- `tauri-plugin-persisted-scope` ([source read directly](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/persisted-scope/src/lib.rs)) only serializes plain path strings to Tauri's own in-process `fs::Scope` allow-list via `bincode` — no NSURL bookmark creation/resolution anywhere. This does nothing for the actual kernel-level sandbox extension that gates file access after relaunch.
- The core feature request, [tauri#3716](https://github.com/tauri-apps/tauri/issues/3716) ("(macOS) (MAS) Security Scoped Resources via startAccessingSecurityScopedResource"), filed **March 2022**, remains open with no assignee or linked PR.
- Community crates checked and ruled out: `tauri-plugin-scoped-storage` (verified via crates.io API: Android/iOS only, desktop targets are explicit `UNSUPPORTED` stubs), `tauri-plugin-ios-bookmark` (iOS-only, 0 stars). No generic macOS-targeting `security-scoped-bookmarks`/`security-bookmark` crate was found on crates.io.

**Practical path (pieced together, not a verified turnkey solution):** hand-roll via `objc2`/`objc2-foundation` — call `NSURL.bookmarkData(options: .withSecurityScope, ...)` when the user picks the library folder, persist the bytes yourself, resolve + `startAccessingSecurityScopedResource()` on relaunch. Requires the `com.apple.security.files.bookmarks.app-scope` entitlement. **This is a genuine, unsolved engineering gap EpubGraph will need to build itself** — nothing in the current Tauri ecosystem solves it off the shelf, and it directly affects the app's core "point at your ebook library folder" workflow, not just the LLM feature.

### 5.3 Plugin sandbox compatibility

- **`tauri-plugin-updater` must be disabled for MAS builds** (MAS apps update only through the App Store — universal Apple policy) — this is treated as background knowledge by the ecosystem but is **not stated in Tauri's own updater docs or App Store guide**; gate it behind a build-target flag explicitly, don't assume a first read of the docs will catch it.
- `tauri-plugin-shell` already requires explicit per-program allow-listing in Tauri 2, but even a scoped shell command will likely fail under MAS regardless, since App Sandbox restricts executing anything not embedded/signed/entitled inside the `.app` — an OS-level restriction independent of Tauri config.
- `tauri-plugin-fs`/`tauri-plugin-dialog` are otherwise sandbox-compatible by design; the gap is specifically the security-scoped-bookmark persistence issue above, not the plugins themselves.

---

## Sources index (representative, not exhaustive — see inline links above for full citation set)

- Apple: [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [Maximum build file sizes](https://developer.apple.com/help/app-store-connect/reference/maximum-build-file-sizes/), [On-demand resources size limits](https://developer.apple.com/help/app-store-connect/reference/on-demand-resources-size-limits/), [Background Assets](https://developer.apple.com/documentation/backgroundassets), [Embedding a helper tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app), [allow-jit entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.allow-jit), [Optimizing app data for iCloud Backup](https://developer.apple.com/documentation/foundation/optimizing_your_app_s_data_for_icloud_backup/), [Acceptable Use Requirements for Foundation Models](https://developer.apple.com/apple-intelligence/acceptable-use-requirements-for-the-foundation-models-framework/), WWDC26 sessions [241](https://developer.apple.com/videos/play/wwdc2026/241/)/[339](https://developer.apple.com/videos/play/wwdc2026/339/).
- Rust crates/repos: [llama-cpp-2](https://crates.io/crates/llama-cpp-2)/[utilityai/llama-cpp-rs](https://github.com/utilityai/llama-cpp-rs), [candle](https://github.com/huggingface/candle), [mlx-rs](https://github.com/oxiglade/mlx-rs), [ort](https://github.com/pykeio/ort)/[fastembed-rs](https://github.com/Anush008/fastembed-rs), [mistral.rs](https://github.com/EricLBuehler/mistral.rs).
- Tauri: [App Store guide](https://v2.tauri.app/distribute/app-store/), [tauri-apps/tauri#13118](https://github.com/tauri-apps/tauri/issues/13118), [#15230](https://github.com/tauri-apps/tauri/issues/15230), [#13815](https://github.com/tauri-apps/tauri/issues/13815), [#3716](https://github.com/tauri-apps/tauri/issues/3716), [plugins-workspace](https://github.com/tauri-apps/plugins-workspace).
- Models: [Granite Embedding 311M R2](https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2), [Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B), [Gemma 4 relicense](https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html), [Llama 4 License](https://www.llama.com/llama4/license/).
- Real-world app precedents: [Noema](https://github.com/noemaai-labs/noema-ios) / [App Store listing](https://apps.apple.com/us/app/noema-local-ai-offline-llm/id6751169935), [MLX Studio](https://apps.apple.com/us/app/mlx-studio-local-ai-chat/id6757399038), [Draw Things](https://apps.apple.com/us/app/draw-things-offline-ai-art/id6444050820), [Private LLM](https://privatellm.app/faq), [MailVault sandbox-signing writeup](https://mailvaultapp.com/blog/sandbox-signing-saga.html).

---

## Explicitly unverified / needs rechecking before implementation

- Whether Apple's promised `MLXLanguageModel`/`CoreAILanguageModel`/Foundation Models core open-source ("later this summer 2026") has actually shipped — check `github.com/apple` directly.
- Exact minimum RAM/chip for the *base* on-device Foundation Models model vs. the M3+/12GB bar that applies to some newer Siri-specific features only.
- Whether a distinct "Foundation Models Framework Adapter" entitlement is real and what exactly it gates (only relevant if pursuing custom LoRA adapters).
- Precise static-binary size figures for llama.cpp/candle/mlx-rs/ort Metal builds — only order-of-magnitude estimates were found; measure your own build.
- Whether `ort`'s CoreML EP gap ([fastembed-rs#137](https://github.com/Anush008/fastembed-rs/issues/137)) has been resolved since Dec 2024 — appeared still open as of this research.
- Whether Tauri's App Store doc page has since incorporated the manual `codesign --entitlements` step ahead of `productbuild` (missing as of the fetch date in this research).
