/**
 * OpenAI's Whisper models converted to ggml format for use with whisper.cpp
 *
 * Download from https://huggingface.co/ggerganov/whisper.cpp/tree/main
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { Directory, File, Paths } from "expo-file-system";
import {
  createDownloadResumable,
  type DownloadPauseState,
  type DownloadProgressData,
  type DownloadResumable,
  type FileSystemDownloadResult,
} from "expo-file-system/legacy";
import { initWhisper, initWhisperVad } from "whisper.rn/index.js";
import type { WhisperContext } from "whisper.rn/index.js";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

export interface WhisperModel {
  id: string;
  label: string;
  url: string;
  filename: string;
  expectedSize: number; // Expected file size in bytes (for validation)
  capabilities: {
    multilingual: boolean;
    quantizable: boolean;
    tdrz?: boolean; // Optional TDRZ capability for native models
  };
}

export const WHISPER_MODELS: WhisperModel[] = [
  {
    id: "large-v3-turbo",
    label: "Large Multilanguage",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    filename: "ggml-large-v3-turbo.bin",
    expectedSize: 1620000000, // ~1.6GB
    capabilities: {
      multilingual: true,
      quantizable: false,
    },
  },
  {
    id: "tiny",
    label: "Tiny (en)",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    filename: "ggml-tiny.en.bin",
    expectedSize: 75000000, // ~75MB
    capabilities: {
      multilingual: false,
      quantizable: false,
    },
  },
  {
    id: "base",
    label: "Base Model",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    filename: "ggml-base.bin",
    expectedSize: 147000000, // ~147MB
    capabilities: {
      multilingual: true,
      quantizable: false,
    },
  },
  {
    id: "small",
    label: "Small Model",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    filename: "ggml-small.bin",
    expectedSize: 488000000, // ~488MB
    capabilities: {
      multilingual: true,
      quantizable: false,
    },
  },
  {
    id: "small-tdrz",
    label: "Small (tdrz)",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-tdrz.bin",
    filename: "ggml-small.en-tdrz.bin",
    expectedSize: 488000000, // ~488MB
    capabilities: {
      multilingual: false,
      quantizable: false,
      tdrz: true,
    },
  },
];

interface ModelFileInfo {
  path: string;
  size: number;
}

// Keep awake tag for downloads
const WHISPER_KEEP_AWAKE_TAG = "whisper-model-download";

export function useWhisperModels() {
  const [modelFiles, setModelFiles] = useState<Record<string, ModelFileInfo>>(
    {}
  );
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
  const [isDownloading, setIsDownloading] = useState(false);
  const [isInitializingModel, setIsInitializingModel] = useState(false);
  const [whisperContext, setWhisperContext] = useState<WhisperContext | null>(
    null
  );
  const [vadContext, setVadContext] = useState<any>(null);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [isDownloadPaused, setIsDownloadPaused] = useState(false);

  // Download resumable reference for pause/resume support
  const downloadResumableRef = useRef<DownloadResumable | null>(null);
  const downloadPauseStateRef = useRef<DownloadPauseState | null>(null);
  const currentDownloadModelRef = useRef<WhisperModel | null>(null);

  const getModelDirectory = useCallback(async () => {
    let documentDirectory: Directory;
    try {
      documentDirectory = Paths.document;
    } catch (error) {
      throw new Error("Document directory is not available.");
    }

    if (!documentDirectory?.uri) {
      throw new Error("Document directory is not available.");
    }

    const directory = new Directory(documentDirectory, "whisper-models");
    try {
      directory.create({ idempotent: true, intermediates: true });
    } catch (error) {
      console.warn("Failed to ensure Whisper model directory exists:", error);
      throw error;
    }
    return directory;
  }, []);

  const downloadModel = useCallback(
    async (model: WhisperModel) => {
      const directory = await getModelDirectory();
      const file = new File(directory, model.filename);

      // Helper to update cache with latest stat info
      const updateModelFileInfo = () => {
        try {
          const stats = file.info();
          if (!stats.exists) throw new Error("File not found");
          setModelFiles((prev) => ({
            ...prev,
            [model.id]: {
              path: file.uri,
              size: Number(stats.size) || 0,
            },
          }));
        } catch (statError) {
          console.warn(
            `Failed to stat model file ${model.id} at ${file.uri}:`,
            statError
          );
          setModelFiles((prev) => ({
            ...prev,
            [model.id]: {
              path: file.uri,
              size: 0,
            },
          }));
        }
      };

      // Check if file already exists
      let existingInfo;
      try {
        existingInfo = file.info();
      } catch (infoError) {
        console.warn(
          `Failed to read info for model ${model.id} at ${file.uri}:`,
          infoError
        );
        existingInfo = { exists: false };
      }
      if (existingInfo.exists) {
        console.log(`Model ${model.id} already exists at ${file.uri}`);
        updateModelFileInfo();
        return file.uri;
      }

      setIsDownloading(true);
      setIsDownloadPaused(false);
      currentDownloadModelRef.current = model;

      // Activate keep-awake to prevent screen sleep during download
      try {
        await activateKeepAwakeAsync(WHISPER_KEEP_AWAKE_TAG);
        console.log("[WhisperModels] Keep-awake activated for download");
      } catch (error) {
        console.warn("[WhisperModels] Failed to activate keep-awake:", error);
      }

      console.log(`Downloading model ${model.id} from ${model.url}`);

      try {
        // Create resumable download with background session support
        // expo-file-system uses BACKGROUND session type by default, which:
        // - iOS: Uses NSURLSession background configuration - downloads continue when app is backgrounded or device locked
        // - Android: Downloads continue in background as long as process isn't killed by the system
        const downloadResumable = createDownloadResumable(
          model.url,
          file.uri,
          {
            // sessionType defaults to FileSystemSessionType.BACKGROUND (0)
            // This allows downloads to continue in background and when device is locked
          },
          (progressData: DownloadProgressData) => {
            const { totalBytesWritten, totalBytesExpectedToWrite } = progressData;
            // Calculate progress - if server doesn't send Content-Length, use expected size from model config
            let fraction = 0;
            if (totalBytesExpectedToWrite > 0) {
              fraction = totalBytesWritten / totalBytesExpectedToWrite;
            } else if (model.expectedSize > 0) {
              // Fallback to expected size if Content-Length not provided
              fraction = Math.min(1, totalBytesWritten / model.expectedSize);
            }
            setDownloadProgress((prev) => ({
              ...prev,
              [model.id]: fraction,
            }));
            console.log(
              `[WhisperModels] Download progress for ${model.id}: ${(fraction * 100).toFixed(
                1
              )}% (${(totalBytesWritten / 1024 / 1024).toFixed(1)}MB)`
            );
          },
        );

        console.log("[WhisperModels] Download started with BACKGROUND session type - will continue in background/locked");

        // Store reference for pause/resume
        downloadResumableRef.current = downloadResumable;

        const downloadResult = (await downloadResumable.downloadAsync()) as
          | FileSystemDownloadResult
          | undefined;

        // Clear the reference after download completes
        downloadResumableRef.current = null;
        downloadPauseStateRef.current = null;
        currentDownloadModelRef.current = null;

        if (
          downloadResult &&
          (downloadResult.status === 0 ||
            (downloadResult.status >= 200 && downloadResult.status < 300))
        ) {
          console.log(`Successfully downloaded model ${model.id}`);
          updateModelFileInfo();
          setDownloadProgress((prev) => ({ ...prev, [model.id]: 1 }));
          return file.uri;
        } else {
          throw new Error(
            `Download failed with status: ${downloadResult?.status}`
          );
        }
      } catch (error) {
        console.error(`Error downloading model ${model.id}:`, error);
        throw error;
      } finally {
        setIsDownloading(false);
        setIsDownloadPaused(false);
        downloadResumableRef.current = null;
        currentDownloadModelRef.current = null;

        // Deactivate keep-awake
        try {
          deactivateKeepAwake(WHISPER_KEEP_AWAKE_TAG);
          console.log("[WhisperModels] Keep-awake deactivated");
        } catch (error) {
          console.warn("[WhisperModels] Failed to deactivate keep-awake:", error);
        }
      }
    },
    [getModelDirectory]
  );

  // Manually pause the current download
  const pauseDownload = useCallback(async (): Promise<boolean> => {
    if (!downloadResumableRef.current || !isDownloading) {
      console.warn("[WhisperModels] No active download to pause");
      return false;
    }

    try {
      const pauseState = await downloadResumableRef.current.pauseAsync();
      downloadPauseStateRef.current = pauseState;
      setIsDownloadPaused(true);
      console.log("[WhisperModels] Download paused manually");
      return true;
    } catch (error) {
      console.error("[WhisperModels] Failed to pause download:", error);
      return false;
    }
  }, [isDownloading]);

  // Resume a paused download
  const resumeDownload = useCallback(async (): Promise<boolean> => {
    if (!downloadResumableRef.current || !isDownloadPaused) {
      console.warn("[WhisperModels] No paused download to resume");
      return false;
    }

    try {
      await downloadResumableRef.current.resumeAsync();
      setIsDownloadPaused(false);
      console.log("[WhisperModels] Download resumed");
      return true;
    } catch (error) {
      console.error("[WhisperModels] Failed to resume download:", error);
      return false;
    }
  }, [isDownloadPaused]);

  const initializeWhisperModel = useCallback(
    async (modelId: string, options?: { initVad?: boolean }) => {
      const model = WHISPER_MODELS.find((m) => m.id === modelId);
      if (!model) throw new Error("Invalid model selected");

      try {
        setIsInitializingModel(true);
        console.log(`Initializing Whisper model: ${model.label}`);

        // Download model if not already available
        const modelPath = await downloadModel(model);

        // Initialize Whisper context with hardware acceleration
        const context = await initWhisper({
          filePath: modelPath,
          // GPU acceleration (Metal on iOS - enabled by default)
          useGpu: true,
          // Use Core ML if available on iOS
          useCoreMLIos: true,
          // Flash Attention for better GPU utilization
          useFlashAttn: true,
        });

        setWhisperContext(context);
        setCurrentModelId(modelId);
        console.log(`Whisper context initialized for model: ${model.label}`);

        // Optionally initialize VAD context
        if (options?.initVad) {
          console.log("Initializing VAD context...");
          try {
            const vad = await initWhisperVad({
              filePath: modelPath,
            });
            setVadContext(vad);
            console.log("VAD context initialized successfully");
          } catch (vadError) {
            console.warn("VAD initialization failed:", vadError);
            // Continue without VAD - it's optional
          }
        }

        return {
          whisperContext: context,
          vadContext: options?.initVad ? vadContext : null,
        };
      } catch (error) {
        console.error("Model initialization error:", error);
        throw error;
      } finally {
        setIsInitializingModel(false);
      }
    },
    [downloadModel, vadContext]
  );

  const resetWhisperContext = useCallback(async () => {
    // Release the whisper context to free GPU/memory resources
    if (whisperContext?.release) {
      try {
        await whisperContext.release();
        console.log("Whisper context released");
      } catch (e) {
        console.warn("Failed to release whisper context:", e);
      }
    }
    // Release VAD context if it has a release method
    if (vadContext?.release) {
      try {
        await vadContext.release();
        console.log("VAD context released");
      } catch (e) {
        console.warn("Failed to release VAD context:", e);
      }
    }
    setWhisperContext(null);
    setVadContext(null);
    setCurrentModelId(null);
    console.log("Whisper contexts reset");
  }, [whisperContext, vadContext]);

  const getModelById = useCallback((modelId: string) => {
    return WHISPER_MODELS.find((m) => m.id === modelId);
  }, []);

  const getCurrentModel = useCallback(() => {
    return currentModelId ? getModelById(currentModelId) : null;
  }, [currentModelId, getModelById]);

  const isModelDownloaded = useCallback(
    (modelId: string) => {
      return modelFiles[modelId] !== undefined;
    },
    [modelFiles]
  );

  const getDownloadProgress = useCallback(
    (modelId: string) => {
      return downloadProgress[modelId] || 0;
    },
    [downloadProgress]
  );

  const deleteModel = useCallback(
    async (modelId: string) => {
      const fileInfo = modelFiles[modelId];
      if (!fileInfo) {
        console.warn(`Attempted to delete non-downloaded model: ${modelId}`);
        return;
      }

      try {
        const file = new File(fileInfo.path);
        const info = file.info();
        if (info.exists) {
          file.delete();
          console.log(`Deleted model file at ${fileInfo.path}`);
        }
      } catch (error) {
        console.error(`Failed to delete model ${modelId}:`, error);
        throw error;
      }

      setModelFiles((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });

      if (currentModelId === modelId) {
        if (whisperContext?.release) {
          try {
            await whisperContext.release();
          } catch (releaseError) {
            console.warn(
              "Failed to release Whisper context during model deletion:",
              releaseError
            );
          }
        }
        setWhisperContext(null);
        setCurrentModelId(null);
        setVadContext(null);
      }
    },
    [currentModelId, modelFiles, whisperContext]
  );

  useEffect(() => {
    let isMounted = true;

    const loadExistingModels = async () => {
      try {
        const directory = await getModelDirectory();
        const entries = await Promise.all(
          WHISPER_MODELS.map(async (model) => {
            const file = new File(directory, model.filename);
            try {
              const fileInfo = file.info();
              if (!fileInfo.exists) return null;

              return {
                id: model.id,
                info: {
                  path: file.uri,
                  size: Number(fileInfo.size) || 0,
                },
              } as { id: string; info: ModelFileInfo };
            } catch (statError) {
              console.warn(
                `Failed to stat existing model file ${model.id}:`,
                statError
              );
              return {
                id: model.id,
                info: {
                  path: file.uri,
                  size: 0,
                },
              };
            }
          })
        );

        if (!isMounted) return;

        const fileMap: Record<string, ModelFileInfo> = {};
        entries.forEach((entry) => {
          if (entry) {
            fileMap[entry.id] = entry.info;
          }
        });

        if (Object.keys(fileMap).length > 0) {
          setModelFiles((prev) => ({ ...prev, ...fileMap }));
        }
      } catch (error) {
        console.warn("Failed to load existing Whisper models:", error);
      }
    };

    loadExistingModels();

    return () => {
      isMounted = false;
    };
  }, [getModelDirectory]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try {
        deactivateKeepAwake(WHISPER_KEEP_AWAKE_TAG);
      } catch {
        // Ignore cleanup errors
      }
    };
  }, []);

  return {
    // State
    modelFiles,
    downloadProgress,
    isDownloading,
    isInitializingModel,
    whisperContext,
    vadContext,
    currentModelId,
    isDownloadPaused,

    // Actions
    downloadModel,
    initializeWhisperModel,
    resetWhisperContext,
    deleteModel,
    pauseDownload,
    resumeDownload,

    // Helpers
    getModelById,
    getCurrentModel,
    isModelDownloaded,
    getDownloadProgress,

    // Constants
    availableModels: WHISPER_MODELS,
  };
}
