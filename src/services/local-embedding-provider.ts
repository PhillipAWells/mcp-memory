/**
 * Local Embedding Provider
 *
 * Generates embeddings locally using @huggingface/transformers (ONNX Runtime).
 * No API key required. Model is downloaded from HuggingFace Hub on first use
 * and then cached for offline operation.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Minimal call signature for the HuggingFace feature-extraction pipeline.
 *
 * Typed loosely (rather than importing from `@huggingface/transformers`) because
 * that package is an optional runtime dependency that may not be installed at
 * type-check time.  The actual runtime object satisfies this interface.
 */
type FeatureExtractionPipeline = (
  text: string | string[],
  options?: Record<string, unknown>
) => Promise<{ data: Float32Array }>;

/**
 * Module-level singleton holding the loaded pipeline after the first call to
 * {@link getOrCreatePipeline}.  `null` means the pipeline has not yet been
 * initialised (or has been reset via {@link resetLocalPipeline}).
 */
let pipelineInstance: FeatureExtractionPipeline | null = null;

/**
 * Lazily load the `@huggingface/transformers` feature-extraction pipeline.
 *
 * On first call the model is downloaded from HuggingFace Hub (~20–140 MB) and
 * cached in `$HOME/.cache/mcp-memory/models/` (overridable via
 * `LOCAL_EMBEDDING_CACHE_DIR`).  Subsequent calls return the cached instance.
 *
 * @returns The initialised pipeline ready to process text.
 * @throws If the `@huggingface/transformers` package is not installed, or if
 *   the model download fails.
 */
async function getOrCreatePipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelineInstance) {
    return pipelineInstance;
  }

  let transformers: typeof import('@huggingface/transformers');
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    throw new Error(
      'The @huggingface/transformers package is required for local embeddings. ' +
      'Install it with: npm install @huggingface/transformers',
    );
  }

  const { pipeline, env } = transformers;

  // Store models in a predictable user-level cache rather than node_modules
  env.cacheDir = process.env.LOCAL_EMBEDDING_CACHE_DIR
    ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'}/.cache/mcp-memory/models`;

  const modelName = config.embedding.localModel;
  logger.info(`Loading local embedding model: ${modelName} (first run downloads ~20-140 MB)`);

  const pipe = await pipeline('feature-extraction', modelName, {
    dtype: 'q8',  // int8 quantized — small & fast, minimal quality loss
  });

  // Cast: the runtime pipeline is compatible with our loose signature
  pipelineInstance = pipe as unknown as FeatureExtractionPipeline;

  logger.info(`Local embedding model ready: ${modelName}`);
  return pipelineInstance;
}

/**
 * Generate a single embedding vector using the local HuggingFace model.
 *
 * The output is mean-pooled across token positions and L2-normalised, which
 * matches the expected input format for Qdrant's cosine similarity search.
 *
 * @param text - The input text to embed.
 * @returns A normalised float array whose length equals the model's output
 *   dimension (configured via `LOCAL_EMBEDDING_DIMENSIONS`, default 384).
 */
export async function generateLocalEmbedding(text: string): Promise<number[]> {
  const pipe = await getOrCreatePipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Eagerly initialise the local embedding pipeline.
 *
 * Call this during server startup (before the first user request) when
 * `EMBEDDING_PROVIDER=local` so that the model download and ONNX Runtime
 * initialisation happen in the background rather than blocking the first
 * `memory-store` or `memory-query` request.
 *
 * Safe to call multiple times — returns immediately if already initialised.
 */
export async function preloadLocalPipeline(): Promise<void> {
  await getOrCreatePipeline();
}

/**
 * Clear the cached pipeline instance.
 *
 * The next call to {@link generateLocalEmbedding} will reload and re-initialise
 * the model.  Primarily intended for use in tests or after a configuration change
 * that requires a different model to be loaded.
 */
export function resetLocalPipeline(): void {
  pipelineInstance = null;
}
