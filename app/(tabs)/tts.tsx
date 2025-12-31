import React, { useState, useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMeloTTS, TTS_MODELS } from "@/hooks/useMeloTTS";

const ACCENT_COLOR = "#FF6B35";
const SECONDARY_COLOR = "#004E64";

export default function TTSScreen() {
  const [inputText, setInputText] = useState("");
  const [error, setError] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [lastAudioPath, setLastAudioPath] = useState<string>("");
  
  // TTS settings
  const [speed, setSpeed] = useState(1.0); // lengthScale
  const [naturalness, setNaturalness] = useState(0.6); // noiseScale
  
  const {
    isInitializingModel,
    isDownloading,
    isSynthesizing,
    currentModelId,
    modelFiles,
    onnxError,
    downloadProgress,
    downloadSpeed,
    downloadAndExtractModels,
    initializeModel,
    speakText,
    stopAudio,
    getCurrentModel,
    getDownloadProgress,
    getModelById,
    isReady,
    getModelDirectory,
    checkOnnxAvailability,
    refreshModelFiles,
    lastInferenceTime,
    lastAudioDuration,
  } = useMeloTTS();

  useEffect(() => {
    // Try to auto-initialize with INT8 model if available
    checkAndInitialize();
  }, []);

  const checkAndInitialize = async () => {
    try {
      setError("");
      
      // First check if ONNX runtime is available
      const onnxAvailable = await checkOnnxAvailability();
      if (!onnxAvailable) {
        return; // Error will be set by checkOnnxAvailability
      }
      
      // Check if model files exist
      const directory = await getModelDirectory();
      console.log("TTS model directory:", directory.uri);
      
      // Refresh model files to get current state
      const currentModels = await refreshModelFiles();
      console.log("Available models:", Object.keys(currentModels));
      
      // Try INT8 model first, then FP32
      if (currentModels["melo-int8"]) {
        await initializeModel("melo-int8");
      } else if (currentModels["melo-fp32"]) {
        await initializeModel("melo-fp32");
      } else {
        // Models not found - show download option
        setError("No TTS model found. Tap 'Download Models' to get started.");
      }
    } catch (err) {
      console.error("Failed to initialize TTS model:", err);
      setError(`Failed to initialize model: ${err}`);
    }
  };

  const handleDownloadModels = async () => {
    try {
      setError("");
      const success = await downloadAndExtractModels();
      if (success) {
        // Re-check and initialize after download
        await checkAndInitialize();
      }
    } catch (err) {
      console.error("Failed to download models:", err);
      setError(`Failed to download models: ${err}`);
    }
  };

  const handleInitializeModel = async (modelId: string) => {
    try {
      setError("");
      await initializeModel(modelId);
    } catch (err) {
      console.error("Failed to initialize model:", err);
      setError(`Failed to initialize model: ${err}`);
    }
  };

  const handleSpeak = async () => {
    if (!inputText.trim()) {
      Alert.alert("Empty Text", "Please enter some text to speak.");
      return;
    }

    if (!isReady()) {
      Alert.alert("Not Ready", "TTS model is not initialized yet.");
      return;
    }

    try {
      setError("");
      setIsPlaying(true);
      
      const audioPath = await speakText(inputText.trim(), {
        lengthScale: speed,
        noiseScale: naturalness,
      });
      
      setLastAudioPath(audioPath);
      console.log("Speech generated:", audioPath);
    } catch (err) {
      console.error("TTS error:", err);
      setError(`Speech synthesis failed: ${err}`);
      Alert.alert("TTS Error", `Failed to generate speech: ${err}`);
    } finally {
      setIsPlaying(false);
    }
  };

  const handleStop = () => {
    stopAudio();
    setIsPlaying(false);
  };

  const formatBytes = (bytes: number): string => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(
      units.length - 1,
      Math.floor(Math.log(bytes) / Math.log(1024))
    );
    const scaled = bytes / Math.pow(1024, index);
    return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  };

  const activeModelLabel = getCurrentModel()?.label || "Not loaded";
  const downloadPercentage = getDownloadProgress(currentModelId || "melo-int8") ?? 0;
  
  const statusText = isDownloading
    ? `Downloading · ${(downloadPercentage * 100).toFixed(0)}%`
    : isInitializingModel
    ? "Initializing…"
    : isSynthesizing
    ? "Synthesizing…"
    : isReady()
    ? `Ready · ${activeModelLabel}`
    : "Not initialized";

  const storedModels = Object.entries(modelFiles);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.title}>Text to Speech</Text>
          <Text style={styles.subtitle}>
            Convert text to natural-sounding speech using MeloTTS.
          </Text>
        </View>

        {(error || onnxError) ? (
          <View style={[styles.card, styles.errorCard]}>
            <Text style={styles.cardLabel}>{onnxError ? "ONNX Runtime Error" : "Setup Required"}</Text>
            <Text style={styles.errorText}>{onnxError || error}</Text>
            <View style={styles.errorButtons}>
              {!onnxError && error?.includes("No TTS model") && (
                <TouchableOpacity
                  style={[styles.downloadButton, isDownloading && styles.buttonDisabled]}
                  onPress={handleDownloadModels}
                  disabled={isDownloading}
                >
                  {isDownloading ? (
                    <ActivityIndicator color="#ffffff" size="small" />
                  ) : (
                    <Text style={styles.downloadButtonText}>Download Models</Text>
                  )}
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.retryButton]}
                onPress={checkAndInitialize}
              >
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {/* Download Progress */}
        {isDownloading && (
          <View style={styles.progressCard}>
            <Text style={styles.progressLabel}>Downloading MeloTTS Models...</Text>
            <View style={styles.progressBar}>
              <View 
                style={[
                  styles.progressFill, 
                  { width: `${(downloadProgress.models || 0) * 100}%` }
                ]} 
              />
            </View>
            <View style={styles.progressInfo}>
              <Text style={styles.progressText}>
                {((downloadProgress.models || 0) * 100).toFixed(0)}%
              </Text>
              {downloadSpeed ? (
                <Text style={styles.speedText}>{downloadSpeed}</Text>
              ) : null}
            </View>
          </View>
        )}

        {/* Status Section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Status</Text>
          <View style={[styles.statusCard, isReady() && styles.statusCardActive]}>
            <Text style={styles.statusTitle}>Model</Text>
            <Text style={styles.statusValue}>{statusText}</Text>
          </View>
        </View>

        {/* Text Input Section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Text to Speak</Text>
          <View style={styles.inputCard}>
            <TextInput
              style={styles.textInput}
              placeholder="Enter text here to convert to speech..."
              placeholderTextColor="#8e8e93"
              multiline
              numberOfLines={4}
              value={inputText}
              onChangeText={setInputText}
              editable={!isSynthesizing}
            />
            <Text style={styles.charCount}>{inputText.length} characters</Text>
          </View>
        </View>

        {/* Settings Section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Voice Settings</Text>
          
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Speed</Text>
            <View style={styles.speedButtons}>
              {[0.8, 1.0, 1.2].map((s) => (
                <TouchableOpacity
                  key={s}
                  style={[
                    styles.speedChip,
                    speed === s && styles.speedChipActive,
                  ]}
                  onPress={() => setSpeed(s)}
                >
                  <Text
                    style={[
                      styles.speedChipText,
                      speed === s && styles.speedChipTextActive,
                    ]}
                  >
                    {s === 0.8 ? "Fast" : s === 1.0 ? "Normal" : "Slow"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Naturalness</Text>
            <View style={styles.speedButtons}>
              {[0.4, 0.6, 0.8].map((n) => (
                <TouchableOpacity
                  key={n}
                  style={[
                    styles.speedChip,
                    naturalness === n && styles.speedChipActive,
                  ]}
                  onPress={() => setNaturalness(n)}
                >
                  <Text
                    style={[
                      styles.speedChipText,
                      naturalness === n && styles.speedChipTextActive,
                    ]}
                  >
                    {n === 0.4 ? "Robotic" : n === 0.6 ? "Natural" : "Expressive"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Action Buttons */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Actions</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[
                styles.button,
                styles.primaryButton,
                (!isReady() || isSynthesizing || !inputText.trim()) &&
                  styles.buttonDisabled,
              ]}
              onPress={handleSpeak}
              disabled={!isReady() || isSynthesizing || !inputText.trim()}
            >
              {isSynthesizing ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  {isPlaying ? "Speaking…" : "Speak Text"}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.button,
                styles.stopButton,
                !isPlaying && styles.buttonDisabled,
              ]}
              onPress={handleStop}
              disabled={!isPlaying}
            >
              <Text style={styles.stopButtonText}>Stop</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Inference Stats */}
        {lastInferenceTime !== null && lastAudioDuration !== null && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Last Inference</Text>
            <View style={styles.statsCard}>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Inference Time</Text>
                <Text style={styles.statValue}>{lastInferenceTime}ms</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Audio Duration</Text>
                <Text style={styles.statValue}>{lastAudioDuration.toFixed(2)}s</Text>
              </View>
              <View style={[styles.statRow, styles.statRowLast]}>
                <Text style={styles.statLabel}>Real-time Factor</Text>
                <Text style={[
                  styles.statValue,
                  (lastInferenceTime / 1000) / lastAudioDuration < 1 
                    ? styles.statValueGood 
                    : styles.statValueBad
                ]}>
                  {((lastInferenceTime / 1000) / lastAudioDuration).toFixed(3)}x
                  {(lastInferenceTime / 1000) / lastAudioDuration < 1 ? " ✓" : ""}
                </Text>
              </View>
              <Text style={styles.statsNote}>
                RTF {"<"} 1.0 = faster than real-time
              </Text>
            </View>
          </View>
        )}

        {/* Quick Phrases */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Quick Phrases</Text>
          <View style={styles.phraseGrid}>
            {[
              "Hello, how are you?",
              "Nice to meet you.",
              "Thank you very much.",
              "Good morning!",
              "See you later.",
              "Have a great day!",
            ].map((phrase) => (
              <TouchableOpacity
                key={phrase}
                style={styles.phraseChip}
                onPress={() => setInputText(phrase)}
              >
                <Text style={styles.phraseChipText}>{phrase}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Model Selection */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Models</Text>
          <View style={styles.modelGrid}>
            {TTS_MODELS.map((model) => {
              const isActive = getCurrentModel()?.id === model.id;
              const hasFile = modelFiles[model.id] !== undefined;
              
              return (
                <TouchableOpacity
                  key={model.id}
                  style={[
                    styles.modelChip,
                    isActive && styles.modelChipActive,
                    !hasFile && styles.modelChipDisabled,
                    (isDownloading || isInitializingModel) && styles.buttonDisabled,
                  ]}
                  onPress={() => handleInitializeModel(model.id)}
                  disabled={!hasFile || isDownloading || isInitializingModel}
                >
                  <Text
                    style={[
                      styles.modelChipText,
                      isActive && styles.modelChipTextActive,
                      !hasFile && styles.modelChipTextDisabled,
                    ]}
                  >
                    {model.label}
                  </Text>
                  <Text
                    style={[
                      styles.modelQuality,
                      isActive && styles.modelQualityActive,
                    ]}
                  >
                    {hasFile ? model.quality : "Not installed"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Stored Models Info */}
        {storedModels.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Installed Models</Text>
            {storedModels.map(([modelId, info]) => {
              const modelLabel = getModelById(modelId)?.label || modelId;
              const isCurrent = currentModelId === modelId;

              return (
                <View key={modelId} style={styles.storageRow}>
                  <View style={styles.storageMeta}>
                    <Text style={styles.storageName}>
                      {modelLabel}
                      {isCurrent ? " · active" : ""}
                    </Text>
                    <Text style={styles.storageDetails}>
                      Size {formatBytes(info.size)}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        <Text style={styles.footerNote}>
          MeloTTS demo — Enter text and tap "Speak Text" to hear it spoken.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#FFFBF5",
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 48,
  },
  header: {
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: SECONDARY_COLOR,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: "#555555",
  },
  section: {
    marginBottom: 28,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#777777",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  statusCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e5e5ea",
    padding: 16,
  },
  statusCardActive: {
    borderColor: ACCENT_COLOR,
    backgroundColor: "#FFF5F0",
  },
  statusTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#666666",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statusValue: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111111",
    lineHeight: 22,
  },
  inputCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#e5e5ea",
    padding: 16,
  },
  textInput: {
    fontSize: 16,
    lineHeight: 24,
    color: "#111111",
    minHeight: 100,
    textAlignVertical: "top",
  },
  charCount: {
    fontSize: 12,
    color: "#8e8e93",
    textAlign: "right",
    marginTop: 8,
  },
  settingRow: {
    marginBottom: 16,
  },
  settingLabel: {
    fontSize: 14,
    fontWeight: "500",
    color: "#333333",
    marginBottom: 8,
  },
  speedButtons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  speedChip: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#d1d1d6",
    backgroundColor: "#ffffff",
  },
  speedChipActive: {
    borderColor: ACCENT_COLOR,
    backgroundColor: "#FFF5F0",
  },
  speedChipText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#333333",
  },
  speedChipTextActive: {
    color: ACCENT_COLOR,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#e5e5ea",
    padding: 20,
    marginBottom: 24,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#777777",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  errorCard: {
    borderColor: "#ff3b30",
    backgroundColor: "#fff5f4",
  },
  errorText: {
    color: "#b3261e",
    fontSize: 14,
    lineHeight: 20,
  },
  errorButtons: {
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
  },
  downloadButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: "#007AFF",
    borderRadius: 8,
  },
  downloadButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  retryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: ACCENT_COLOR,
    borderRadius: 8,
  },
  retryButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  progressCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#007AFF",
    padding: 16,
    marginBottom: 24,
  },
  progressLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333333",
    marginBottom: 12,
  },
  progressBar: {
    height: 8,
    backgroundColor: "#E5E5EA",
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#007AFF",
    borderRadius: 4,
  },
  progressInfo: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
  },
  progressText: {
    fontSize: 12,
    color: "#666666",
  },
  speedText: {
    fontSize: 12,
    color: "#007AFF",
    fontWeight: "600",
  },
  statsCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e5e5ea",
    padding: 16,
  },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  statRowLast: {
    borderBottomWidth: 0,
  },
  statLabel: {
    fontSize: 14,
    color: "#666666",
  },
  statValue: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111111",
  },
  statValueGood: {
    color: "#34C759",
  },
  statValueBad: {
    color: "#FF9500",
  },
  statsNote: {
    fontSize: 11,
    color: "#8e8e93",
    textAlign: "center",
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#f0f0f0",
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  button: {
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    minWidth: 140,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButton: {
    backgroundColor: ACCENT_COLOR,
    flex: 1,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  stopButton: {
    backgroundColor: SECONDARY_COLOR,
  },
  stopButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  phraseGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  phraseChip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#d1d1d6",
    backgroundColor: "#ffffff",
  },
  phraseChipText: {
    fontSize: 13,
    color: "#333333",
  },
  modelGrid: {
    gap: 12,
  },
  modelChip: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#d1d1d6",
    backgroundColor: "#ffffff",
  },
  modelChipActive: {
    borderColor: ACCENT_COLOR,
    backgroundColor: "#FFF5F0",
  },
  modelChipDisabled: {
    backgroundColor: "#f5f5f5",
    borderColor: "#e5e5ea",
  },
  modelChipText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111111",
    marginBottom: 4,
  },
  modelChipTextActive: {
    color: ACCENT_COLOR,
  },
  modelChipTextDisabled: {
    color: "#8e8e93",
  },
  modelQuality: {
    fontSize: 12,
    color: "#666666",
  },
  modelQualityActive: {
    color: ACCENT_COLOR,
  },
  storageRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "#e5e5ea",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    backgroundColor: "#ffffff",
  },
  storageMeta: {
    flex: 1,
  },
  storageName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111111",
    marginBottom: 4,
  },
  storageDetails: {
    fontSize: 12,
    color: "#666666",
  },
  footerNote: {
    fontSize: 12,
    color: "#8e8e93",
    textAlign: "center",
    marginTop: 8,
  },
});
