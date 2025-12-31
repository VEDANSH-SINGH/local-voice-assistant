import React, { useState, useEffect, useRef } from "react";
import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Animated,
  Platform,
  TextInput,
  KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import { useVoiceAssistant, PipelineState } from "@/hooks/useVoiceAssistant";

// Color palette - Deep navy with coral accent
const COLORS = {
  primary: "#1E3A5F",      // Deep navy
  accent: "#FF6B6B",       // Coral red
  accentLight: "#FFE5E5",  // Light coral
  success: "#4ECDC4",      // Teal
  warning: "#FFE66D",      // Warm yellow
  bg: "#F8FAFC",           // Off-white
  card: "#FFFFFF",
  text: "#1E3A5F",
  textMuted: "#64748B",
  border: "#E2E8F0",
};

// Pipeline state display info
const STATE_INFO: Record<PipelineState, { label: string; color: string; icon: string }> = {
  idle: { label: "Ready", color: COLORS.textMuted, icon: "🎤" },
  listening: { label: "Listening...", color: COLORS.accent, icon: "👂" },
  transcribing: { label: "Transcribing...", color: COLORS.warning, icon: "📝" },
  thinking: { label: "Thinking...", color: COLORS.primary, icon: "🤔" },
  speaking: { label: "Speaking...", color: COLORS.success, icon: "🔊" },
  error: { label: "Error", color: "#EF4444", icon: "⚠️" },
};

export default function VoiceAssistantScreen() {
  const [isInitializing, setIsInitializing] = useState(false);
  const [inputMode, setInputMode] = useState<"voice" | "text">("voice");
  const [textInput, setTextInput] = useState("");
  
  const {
    pipelineState,
    error,
    currentTranscription,
    finalTranscription,
    llmResponse,
    conversationHistory,
    ttsQueue,
    isReady,
    getInitStatus,
    isWhisperLoading,
    isLlamaLoading,
    isTTSLoading,
    initializeAll,
    startListening,
    stopListeningAndProcess,
    sendTextMessage,
    cancel,
    clearHistory,
  } = useVoiceAssistant({
    systemPrompt: "You are a helpful, friendly voice assistant. Keep responses concise and natural for spoken conversation. Aim for 2-3 sentences per response.",
  });

  const scrollViewRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const waveAnim = useRef(new Animated.Value(0)).current;

  // Initialize on mount
  useEffect(() => {
    handleInitialize();
  }, []);

  // Pulse animation for active states
  useEffect(() => {
    if (pipelineState === "listening" || pipelineState === "speaking") {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [pipelineState]);

  // Wave animation for listening
  useEffect(() => {
    if (pipelineState === "listening") {
      const wave = Animated.loop(
        Animated.timing(waveAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        })
      );
      wave.start();
      return () => wave.stop();
    } else {
      waveAnim.setValue(0);
    }
  }, [pipelineState]);

  // Auto-scroll on new content
  useEffect(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [conversationHistory, llmResponse]);

  const ensureMicrophonePermission = async (): Promise<boolean> => {
    if (Platform.OS === "web") {
      Alert.alert("Unsupported", "Voice assistant is not available on web.");
      return false;
    }

    try {
      let status = await getRecordingPermissionsAsync();
      
      if (status.granted) return true;
      
      if (!status.canAskAgain) {
        Alert.alert(
          "Microphone Access Required",
          "Please enable microphone access in your device settings to use the voice assistant."
        );
        return false;
      }
      
      status = await requestRecordingPermissionsAsync();
      return status.granted;
    } catch (err) {
      console.error("Permission error:", err);
      return false;
    }
  };

  const handleInitialize = async () => {
    setIsInitializing(true);
    try {
      await initializeAll();
    } catch (err) {
      console.error("Initialization failed:", err);
    } finally {
      setIsInitializing(false);
    }
  };

  const handlePrimaryAction = async () => {
    if (pipelineState === "idle") {
      const hasPermission = await ensureMicrophonePermission();
      if (hasPermission) {
        await startListening();
      }
    } else if (pipelineState === "listening") {
      await stopListeningAndProcess();
    } else {
      await cancel();
    }
  };

  const handleClearHistory = () => {
    Alert.alert(
      "Clear Conversation",
      "This will clear all conversation history. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: clearHistory },
      ]
    );
  };

  const handleSendText = async () => {
    if (!textInput.trim() || pipelineState !== "idle") return;
    const message = textInput.trim();
    setTextInput("");
    await sendTextMessage(message);
  };

  const initStatus = getInitStatus();
  const stateInfo = STATE_INFO[pipelineState];
  const isLoading = isWhisperLoading || isLlamaLoading || isTTSLoading || isInitializing;
  const ready = isReady();

  // Determine button state
  const getButtonConfig = () => {
    if (isLoading) {
      return { label: "Loading...", disabled: true, style: styles.buttonDisabled };
    }
    if (!ready) {
      return { label: "Initialize", disabled: false, style: styles.buttonSecondary };
    }
    
    switch (pipelineState) {
      case "idle":
        return { label: "Hold to Speak", disabled: false, style: styles.buttonPrimary };
      case "listening":
        return { label: "Release to Send", disabled: false, style: styles.buttonListening };
      case "thinking":
      case "speaking":
        return { label: "Cancel", disabled: false, style: styles.buttonCancel };
      default:
        return { label: "Tap to Start", disabled: false, style: styles.buttonPrimary };
    }
  };

  const buttonConfig = getButtonConfig();

  // Calculate TTS progress
  const ttsProgress = ttsQueue.length > 0 
    ? ttsQueue.filter(i => i.status === "done" || i.status === "playing").length / ttsQueue.length 
    : 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Voice Assistant</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: stateInfo.color }]} />
            <Text style={[styles.statusText, { color: stateInfo.color }]}>
              {stateInfo.icon} {stateInfo.label}
            </Text>
          </View>
        </View>
        {conversationHistory.length > 0 && (
          <TouchableOpacity onPress={handleClearHistory} style={styles.clearButton}>
            <Text style={styles.clearButtonText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Model Status Cards */}
      {!ready && (
        <View style={styles.statusCards}>
          <View style={[styles.statusCard, initStatus.whisper && styles.statusCardActive]}>
            <Text style={styles.statusCardIcon}>🎤</Text>
            <Text style={styles.statusCardLabel}>Speech</Text>
            <Text style={[styles.statusCardStatus, initStatus.whisper && styles.statusCardStatusActive]}>
              {isWhisperLoading ? "Loading..." : initStatus.whisper ? "Ready" : "Not loaded"}
            </Text>
          </View>
          <View style={[styles.statusCard, initStatus.llama && styles.statusCardActive]}>
            <Text style={styles.statusCardIcon}>🧠</Text>
            <Text style={styles.statusCardLabel}>AI</Text>
            <Text style={[styles.statusCardStatus, initStatus.llama && styles.statusCardStatusActive]}>
              {isLlamaLoading ? "Loading..." : initStatus.llama ? "Ready" : "Not loaded"}
            </Text>
          </View>
          <View style={[styles.statusCard, initStatus.tts && styles.statusCardActive]}>
            <Text style={styles.statusCardIcon}>🔊</Text>
            <Text style={styles.statusCardLabel}>Voice</Text>
            <Text style={[styles.statusCardStatus, initStatus.tts && styles.statusCardStatusActive]}>
              {isTTSLoading ? "Loading..." : initStatus.tts ? "Ready" : "Not loaded"}
            </Text>
          </View>
        </View>
      )}

      {/* Error Banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={handleInitialize}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Conversation Display */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.conversationContainer}
        contentContainerStyle={styles.conversationContent}
      >
        {conversationHistory.length === 0 && !currentTranscription && !llmResponse && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🎙️</Text>
            <Text style={styles.emptyTitle}>
              {ready ? "Ready to Chat" : "Setting Up..."}
            </Text>
            <Text style={styles.emptySubtitle}>
              {ready 
                ? "Tap and hold the button below to start speaking. Release when done to get a response."
                : "Please wait while the AI models are being loaded..."}
            </Text>
          </View>
        )}

        {/* Conversation Messages */}
        {conversationHistory.map((msg, idx) => (
          <View
            key={idx}
            style={[
              styles.messageBubble,
              msg.role === "user" ? styles.userBubble : styles.assistantBubble,
            ]}
          >
            <Text style={styles.messageRole}>
              {msg.role === "user" ? "You" : "Assistant"}
            </Text>
            <Text
              style={[
                styles.messageText,
                msg.role === "user" ? styles.userText : styles.assistantText,
              ]}
            >
              {msg.content}
            </Text>
          </View>
        ))}

        {/* Current Transcription (Live) */}
        {currentTranscription && pipelineState === "listening" && (
          <View style={[styles.messageBubble, styles.userBubble, styles.liveBubble]}>
            <Text style={styles.messageRole}>You (listening...)</Text>
            <Text style={[styles.messageText, styles.userText]}>
              {currentTranscription}
            </Text>
            <View style={styles.liveIndicator}>
              <ActivityIndicator size="small" color={COLORS.accent} />
            </View>
          </View>
        )}

        {/* LLM Response (Streaming) */}
        {llmResponse && !conversationHistory.some(m => m.content === llmResponse) && (
          <View style={[styles.messageBubble, styles.assistantBubble, styles.streamingBubble]}>
            <Text style={styles.messageRole}>Assistant</Text>
            <Text style={[styles.messageText, styles.assistantText]}>
              {llmResponse}
            </Text>
            {pipelineState === "thinking" && (
              <ActivityIndicator size="small" color={COLORS.primary} style={styles.thinkingIndicator} />
            )}
          </View>
        )}

        {/* Thinking indicator */}
        {pipelineState === "thinking" && !llmResponse && (
          <View style={[styles.messageBubble, styles.assistantBubble]}>
            <View style={styles.thinkingDots}>
              <ActivityIndicator size="small" color={COLORS.primary} />
              <Text style={styles.thinkingText}>Thinking...</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* TTS Progress */}
      {ttsQueue.length > 0 && (
        <View style={styles.ttsProgress}>
          <View style={styles.ttsProgressBar}>
            <View style={[styles.ttsProgressFill, { width: `${ttsProgress * 100}%` }]} />
          </View>
          <Text style={styles.ttsProgressText}>
            Speaking {Math.round(ttsProgress * 100)}%
          </Text>
        </View>
      )}

      {/* Input Mode Toggle */}
      <View style={styles.inputModeToggle}>
        <TouchableOpacity
          style={[styles.modeButton, inputMode === "voice" && styles.modeButtonActive]}
          onPress={() => setInputMode("voice")}
        >
          <Text style={[styles.modeButtonText, inputMode === "voice" && styles.modeButtonTextActive]}>
            🎤 Voice
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeButton, inputMode === "text" && styles.modeButtonActive]}
          onPress={() => setInputMode("text")}
        >
          <Text style={[styles.modeButtonText, inputMode === "text" && styles.modeButtonTextActive]}>
            ⌨️ Text
          </Text>
        </TouchableOpacity>
      </View>

      {/* Text Input Mode */}
      {inputMode === "text" && (
        <View style={styles.textInputContainer}>
          <TextInput
            style={styles.textInput}
            placeholder="Type your message..."
            placeholderTextColor={COLORS.textMuted}
            value={textInput}
            onChangeText={setTextInput}
            multiline
            maxLength={500}
            editable={pipelineState === "idle" && ready}
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!textInput.trim() || pipelineState !== "idle" || !ready) && styles.sendButtonDisabled,
            ]}
            onPress={handleSendText}
            disabled={!textInput.trim() || pipelineState !== "idle" || !ready}
          >
            <Text style={styles.sendButtonText}>→</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Voice Input Mode - Main Action Button */}
      {inputMode === "voice" && (
        <View style={styles.actionContainer}>
          <TouchableOpacity
            style={[styles.mainButton, buttonConfig.style]}
            onPress={!ready && !isLoading ? handleInitialize : handlePrimaryAction}
            disabled={buttonConfig.disabled}
            activeOpacity={0.8}
          >
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              {isLoading ? (
                <ActivityIndicator size="large" color="#FFFFFF" />
              ) : (
                <>
                  <Text style={styles.mainButtonIcon}>
                    {pipelineState === "listening" ? "🎤" : 
                     pipelineState === "speaking" ? "🔊" :
                     pipelineState === "thinking" ? "🤔" : "🎙️"}
                  </Text>
                  <Text style={styles.mainButtonText}>{buttonConfig.label}</Text>
                </>
              )}
            </Animated.View>
          </TouchableOpacity>

          {/* Wave animation for listening */}
          {pipelineState === "listening" && (
          <>
            <Animated.View
              style={[
                styles.waveRing,
                {
                  opacity: waveAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.6, 0],
                  }),
                  transform: [
                    {
                      scale: waveAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 2],
                      }),
                    },
                  ],
                },
              ]}
            />
            <Animated.View
              style={[
                styles.waveRing,
                {
                  opacity: waveAnim.interpolate({
                    inputRange: [0, 0.5, 1],
                    outputRange: [0, 0.6, 0],
                  }),
                  transform: [
                    {
                      scale: waveAnim.interpolate({
                        inputRange: [0, 0.5, 1],
                        outputRange: [1, 1.5, 2],
                      }),
                    },
                  ],
                },
              ]}
            />
          </>
        )}
        </View>
      )}

      {/* Quick Tips */}
      {ready && pipelineState === "idle" && conversationHistory.length === 0 && (
        <View style={styles.tips}>
          <Text style={styles.tipsTitle}>Quick Tips</Text>
          <Text style={styles.tipText}>• Speak clearly and naturally</Text>
          <Text style={styles.tipText}>• Wait for the response to finish before speaking again</Text>
          <Text style={styles.tipText}>• Tap Cancel to stop at any time</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: COLORS.primary,
    letterSpacing: -0.5,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 14,
    fontWeight: "600",
  },
  clearButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  clearButtonText: {
    color: COLORS.textMuted,
    fontSize: 14,
    fontWeight: "600",
  },
  statusCards: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 10,
  },
  statusCard: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 14,
    alignItems: "center",
    borderWidth: 2,
    borderColor: COLORS.border,
  },
  statusCardActive: {
    borderColor: COLORS.success,
    backgroundColor: "#F0FDFA",
  },
  statusCardIcon: {
    fontSize: 24,
    marginBottom: 6,
  },
  statusCardLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statusCardStatus: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 4,
  },
  statusCardStatusActive: {
    color: COLORS.success,
    fontWeight: "600",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FEF2F2",
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  errorText: {
    flex: 1,
    color: "#991B1B",
    fontSize: 13,
  },
  retryText: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: "700",
    marginLeft: 12,
  },
  conversationContainer: {
    flex: 1,
  },
  conversationContent: {
    padding: 16,
    paddingBottom: 24,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    paddingHorizontal: 32,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: COLORS.primary,
    marginBottom: 12,
  },
  emptySubtitle: {
    fontSize: 15,
    color: COLORS.textMuted,
    textAlign: "center",
    lineHeight: 22,
  },
  messageBubble: {
    maxWidth: "85%",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 20,
    marginBottom: 14,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: COLORS.primary,
    borderBottomRightRadius: 6,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: COLORS.card,
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  liveBubble: {
    borderWidth: 2,
    borderColor: COLORS.accent,
    backgroundColor: COLORS.primary,
  },
  streamingBubble: {
    borderColor: COLORS.success,
    borderWidth: 2,
  },
  messageRole: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
    opacity: 0.7,
    color: COLORS.textMuted,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 24,
  },
  userText: {
    color: "#FFFFFF",
  },
  assistantText: {
    color: COLORS.text,
  },
  liveIndicator: {
    marginTop: 8,
  },
  thinkingIndicator: {
    marginTop: 10,
    alignSelf: "flex-start",
  },
  thinkingDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  thinkingText: {
    color: COLORS.textMuted,
    fontSize: 14,
  },
  ttsProgress: {
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  ttsProgressBar: {
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    overflow: "hidden",
  },
  ttsProgressFill: {
    height: "100%",
    backgroundColor: COLORS.success,
    borderRadius: 2,
  },
  ttsProgressText: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 6,
    textAlign: "center",
  },
  actionContainer: {
    alignItems: "center",
    paddingVertical: 24,
    position: "relative",
  },
  mainButton: {
    width: 140,
    height: 140,
    borderRadius: 70,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
    zIndex: 10,
  },
  buttonPrimary: {
    backgroundColor: COLORS.primary,
  },
  buttonSecondary: {
    backgroundColor: COLORS.textMuted,
  },
  buttonListening: {
    backgroundColor: COLORS.accent,
  },
  buttonCancel: {
    backgroundColor: "#64748B",
  },
  buttonDisabled: {
    backgroundColor: COLORS.border,
  },
  mainButtonIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  mainButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  waveRing: {
    position: "absolute",
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 3,
    borderColor: COLORS.accent,
    zIndex: 1,
  },
  tips: {
    paddingHorizontal: 24,
    paddingBottom: 20,
  },
  tipsTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  tipText: {
    fontSize: 13,
    color: COLORS.textMuted,
    lineHeight: 22,
  },
  // Input mode toggle styles
  inputModeToggle: {
    flexDirection: "row",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 12,
    gap: 12,
  },
  modeButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: COLORS.card,
    borderWidth: 2,
    borderColor: COLORS.border,
  },
  modeButtonActive: {
    borderColor: COLORS.primary,
    backgroundColor: "#EEF2FF",
  },
  modeButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.textMuted,
  },
  modeButtonTextActive: {
    color: COLORS.primary,
  },
  // Text input styles
  textInputContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  textInput: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 14,
    fontSize: 16,
    maxHeight: 120,
    color: COLORS.text,
    borderWidth: 2,
    borderColor: COLORS.border,
  },
  sendButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    backgroundColor: COLORS.border,
  },
  sendButtonText: {
    color: "#FFFFFF",
    fontSize: 24,
    fontWeight: "600",
  },
});

