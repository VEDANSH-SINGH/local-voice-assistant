import { type ModelSource } from "@/hooks/useMeloTTS";
import { PipelineState, useVoiceAssistant } from "@/hooks/useVoiceAssistant";
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Color palette - Deep navy with coral accent (same as voice assistant)
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

// Pipeline state display info (same as voice assistant)
const STATE_INFO: Record<PipelineState, { label: string; color: string }> = {
  idle: { label: "Tap to speak", color: COLORS.textMuted },
  listening: { label: "Listening...", color: COLORS.accent },
  transcribing: { label: "Processing...", color: COLORS.warning },
  thinking: { label: "Thinking...", color: COLORS.primary },
  speaking: { label: "Speaking...", color: COLORS.success },
  error: { label: "Error", color: "#EF4444" },
};

// Feedback interface
interface Feedback {
  overall_score: string;
  feedback: string;
}

export default function ScenarioScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    title: string;
    systemPrompt: string;
    initialMessage: string;
  }>();

  const [isInitializing, setIsInitializing] = useState(true);
  const [hasPlayedInitial, setHasPlayedInitial] = useState(false);
  
  // Feedback states
  const [isConversationComplete, setIsConversationComplete] = useState(false);
  const [isGeneratingFeedback, setIsGeneratingFeedback] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const conversationCompletedRef = useRef(false);
  const wasPlayingRef = useRef(false);

  const {
    pipelineState,
    error,
    currentTranscription,
    llmResponse,
    conversationHistory,
    isReady,
    isWhisperLoading,
    isLlamaLoading,
    isTTSLoading,
    initializeAll,
    startListening,
    stopListeningAndProcess,
    cancel,
    synthesizeAndPlay,
    llama, // Access the same LLM instance for feedback generation
  } = useVoiceAssistant({
    systemPrompt: params.systemPrompt || "You are a helpful assistant.",
    ttsModelSource: "default" as ModelSource,
    llamaModel: "gemma-2b-it",
    whisperModel: "base", // Use base model for better transcription accuracy in training
  });

  const scrollViewRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const waveAnim = useRef(new Animated.Value(0)).current;

  // Initialize on mount
  useEffect(() => {
    const init = async () => {
      setIsInitializing(true);
      try {
        await initializeAll();
      } catch (err) {
        console.error("Initialization failed:", err);
      } finally {
        setIsInitializing(false);
      }
    };
    init();
  }, []);

  // Play initial message when models are ready
  useEffect(() => {
    const playInitialMessage = async () => {
      if (isReady() && !hasPlayedInitial && !isInitializing && params.initialMessage) {
        setHasPlayedInitial(true);
        // Small delay to ensure everything is ready
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          await synthesizeAndPlay(params.initialMessage);
        } catch (err) {
          console.error("Failed to play initial message:", err);
        }
      }
    };
    playInitialMessage();
  }, [isReady, hasPlayedInitial, isInitializing, params.initialMessage]);

  // Detect conversation completion from llmResponse or conversationHistory
  useEffect(() => {
    const checkCompletion = () => {
      // Check if any message contains <conv_completed/>
      const hasCompletionTag = 
        llmResponse?.includes("<conv_completed/>") ||
        conversationHistory.some(msg => msg.content.includes("<conv_completed/>"));
      
      if (hasCompletionTag && !conversationCompletedRef.current) {
        conversationCompletedRef.current = true;
        setIsConversationComplete(true);
        console.log("🏁 Conversation completed detected!");
      }
    };
    
    checkCompletion();
  }, [llmResponse, conversationHistory]);

  // Track when speaking finishes after conversation is complete
  useEffect(() => {
    if (pipelineState === "speaking") {
      wasPlayingRef.current = true;
    }
    
    // When pipeline goes idle after speaking AND conversation is complete
    if (wasPlayingRef.current && pipelineState === "idle" && isConversationComplete && !isGeneratingFeedback && !feedback) {
      wasPlayingRef.current = false;
      console.log("🎯 Audio finished, generating feedback...");
      generateFeedback();
    }
  }, [pipelineState, isConversationComplete, isGeneratingFeedback, feedback]);

  // Generate feedback using LLM
  const generateFeedback = async () => {
    if (!llama.llamaContext) {
      console.error("LLM not ready for feedback generation");
      return;
    }

    setIsGeneratingFeedback(true);
    setShowFeedbackModal(true);

    try {
      // Build conversation transcript
      const allMessages = [
        ...(params.initialMessage ? [{ role: "assistant", content: params.initialMessage }] : []),
        ...conversationHistory,
      ];

      // Format conversation for the prompt
      const conversationText = allMessages
        .map(msg => {
          const role = msg.role === "user" ? "Employee" : "Manager";
          // Clean the content - remove <conv_completed/> tag
          const cleanContent = msg.content.replace(/<conv_completed\/?>/g, "").trim();
          return `${role}: ${cleanContent}`;
        })
        .join("\n\n");

      const feedbackPrompt = `You are a communication coach analyzing a new employee's introduction conversation at a bank. The employee is a Data Analyst.

Here is the conversation:

${conversationText}

Analyze the employee's communication skills and provide feedback in the following JSON format only, no other text:
{"overall_score": "X/10", "feedback": "Your detailed feedback here"}`;

      console.log("📝 Generating feedback with prompt:", feedbackPrompt.substring(0, 200) + "...");

      // Run completion
      const result = await llama.llamaContext.completion({
        prompt: feedbackPrompt,
        n_predict: 300,
        temperature: 0.7,
        top_p: 0.9,
        stop: ["\n\n", "```"],
      });

      console.log("📊 Feedback result:", result.text);

      // Parse JSON from response
      try {
        // Try to extract JSON from the response
        const jsonMatch = result.text.match(/\{[\s\S]*?"overall_score"[\s\S]*?"feedback"[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Feedback;
          setFeedback(parsed);
          console.log("✅ Feedback parsed:", parsed);
        } else {
          // Fallback if JSON parsing fails
          setFeedback({
            overall_score: "7/10",
            feedback: result.text.trim() || "Great effort! Keep practicing your introduction skills.",
          });
        }
      } catch (parseError) {
        console.error("Failed to parse feedback JSON:", parseError);
        setFeedback({
          overall_score: "7/10",
          feedback: result.text.trim() || "Good job! Continue practicing to improve your communication skills.",
        });
      }
    } catch (err) {
      console.error("Failed to generate feedback:", err);
      setFeedback({
        overall_score: "N/A",
        feedback: "Unable to generate feedback. Please try again.",
      });
    } finally {
      setIsGeneratingFeedback(false);
    }
  };

  // Pulse animation
  useEffect(() => {
    if (pipelineState === "listening" || pipelineState === "speaking") {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.1,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
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
          duration: 1500,
          useNativeDriver: true,
        })
      );
      wave.start();
      return () => wave.stop();
    } else {
      waveAnim.setValue(0);
    }
  }, [pipelineState]);

  // Auto-scroll
  useEffect(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [conversationHistory, llmResponse]);

  const ensureMicrophonePermission = async (): Promise<boolean> => {
    if (Platform.OS === "web") {
      Alert.alert("Unsupported", "Voice is not available on web.");
      return false;
    }

    try {
      let status = await getRecordingPermissionsAsync();
      if (status.granted) return true;

      if (!status.canAskAgain) {
        Alert.alert(
          "Microphone Required",
          "Please enable microphone in settings."
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

  const handleMicPress = async () => {
    // Don't allow mic press if conversation is complete
    if (isConversationComplete) return;
    
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

  const handleBack = () => {
    cancel();
    router.back();
  };

  const handleCloseFeedback = () => {
    setShowFeedbackModal(false);
    router.back();
  };

  const handleTryAgain = () => {
    // Reset all states and start fresh
    setIsConversationComplete(false);
    setIsGeneratingFeedback(false);
    setFeedback(null);
    setShowFeedbackModal(false);
    setHasPlayedInitial(false);
    conversationCompletedRef.current = false;
    wasPlayingRef.current = false;
    // Note: conversation history is in the hook and would need a reset function
    router.back();
  };

  const stateInfo = STATE_INFO[pipelineState];
  const isLoading = isWhisperLoading || isLlamaLoading || isTTSLoading || isInitializing;
  const ready = isReady();

  // Get mic button style
  const getMicStyle = () => {
    if (isLoading) return styles.micLoading;
    if (isConversationComplete) return styles.micDisabled;
    if (pipelineState === "listening") return styles.micListening;
    if (pipelineState === "speaking") return styles.micSpeaking;
    if (pipelineState === "thinking") return styles.micThinking;
    return styles.micIdle;
  };

  // Build display messages - include initial message as assistant message
  // Also clean out <conv_completed/> tags for display
  const displayMessages = [
    ...(hasPlayedInitial && params.initialMessage
      ? [{ role: "assistant" as const, content: params.initialMessage }]
      : []),
    ...conversationHistory.map(msg => ({
      ...msg,
      content: msg.content.replace(/<conv_completed\/?>/g, "").trim(),
    })),
  ];

  // Get score color
  const getScoreColor = (score: string) => {
    const numScore = parseInt(score);
    if (numScore >= 8) return COLORS.success;
    if (numScore >= 6) return COLORS.warning;
    if (numScore >= 4) return "#F97316"; // Orange
    return COLORS.accent;
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />

      {/* Feedback Modal */}
      <Modal
        visible={showFeedbackModal}
        transparent
        animationType="fade"
        onRequestClose={handleCloseFeedback}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.feedbackCard}>
            {isGeneratingFeedback ? (
              <View style={styles.loadingFeedback}>
                <ActivityIndicator size="large" color={COLORS.accent} />
                <Text style={styles.loadingFeedbackText}>Generating Feedback...</Text>
                <Text style={styles.loadingFeedbackSubtext}>Analyzing your conversation</Text>
              </View>
            ) : feedback ? (
              <>
                <Text style={styles.feedbackTitle}>📊 Your Feedback</Text>
                
                {/* Score Circle */}
                <View style={[styles.scoreCircle, { borderColor: getScoreColor(feedback.overall_score) }]}>
                  <Text style={[styles.scoreText, { color: getScoreColor(feedback.overall_score) }]}>
                    {feedback.overall_score}
                  </Text>
                </View>

                {/* Feedback Text */}
                <ScrollView style={styles.feedbackScroll} showsVerticalScrollIndicator={false}>
                  <Text style={styles.feedbackText}>{feedback.feedback}</Text>
                </ScrollView>

                {/* Action Buttons */}
                <View style={styles.feedbackButtons}>
                  <TouchableOpacity
                    style={[styles.feedbackButton, styles.tryAgainButton]}
                    onPress={handleTryAgain}
                  >
                    <Text style={styles.tryAgainButtonText}>Try Again</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.feedbackButton, styles.doneButton]}
                    onPress={handleCloseFeedback}
                  >
                    <Text style={styles.doneButtonText}>Done</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* Minimal Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{params.title || "Scenario"}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Loading State */}
      {isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingText}>
            {isWhisperLoading ? "Loading speech recognition..." :
             isLlamaLoading ? "Loading AI model..." :
             isTTSLoading ? "Loading voice synthesis..." :
             "Preparing..."}
          </Text>
        </View>
      )}

      {/* Conversation - Minimal Display */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.conversation}
        contentContainerStyle={styles.conversationContent}
      >
        {displayMessages.map((msg, idx) => (
          <View
            key={idx}
            style={[
              styles.message,
              msg.role === "user" ? styles.userMessage : styles.assistantMessage,
            ]}
          >
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

        {/* Live transcription */}
        {currentTranscription && pipelineState === "listening" && (
          <View style={[styles.message, styles.userMessage, styles.liveMessage]}>
            <Text style={[styles.messageText, styles.userText]}>
              {currentTranscription}
            </Text>
          </View>
        )}

        {/* Streaming LLM response - clean out tags for display */}
        {llmResponse && !conversationHistory.some(m => m.content === llmResponse) && (
          <View style={[styles.message, styles.assistantMessage]}>
            <Text style={[styles.messageText, styles.assistantText]}>
              {llmResponse.replace(/<conv_completed\/?>/g, "").trim()}
            </Text>
          </View>
        )}

        {/* Thinking indicator */}
        {pipelineState === "thinking" && !llmResponse && (
          <View style={[styles.message, styles.assistantMessage]}>
            <ActivityIndicator size="small" color={COLORS.primary} />
          </View>
        )}
      </ScrollView>

      {/* Bottom Section - Mic + Status */}
      <View style={styles.bottomSection}>
        {/* Status Text */}
        <Text style={[styles.statusText, { color: stateInfo.color }]}>
          {isLoading ? "Loading models..." : 
           isConversationComplete ? "Conversation complete" : stateInfo.label}
        </Text>

        {/* Mic Button */}
        <View style={styles.micContainer}>
          <TouchableOpacity
            style={[styles.micButton, getMicStyle()]}
            onPress={handleMicPress}
            disabled={isLoading || !ready || isConversationComplete}
            activeOpacity={0.8}
          >
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              {isLoading ? (
                <ActivityIndicator size="large" color="#FFFFFF" />
              ) : (
                <Text style={styles.micIcon}>
                  {isConversationComplete ? "✓" :
                   pipelineState === "listening" ? "🎤" :
                   pipelineState === "speaking" ? "🔊" :
                   pipelineState === "thinking" ? "💭" : "🎙️"}
                </Text>
              )}
            </Animated.View>
          </TouchableOpacity>

          {/* Wave rings for listening */}
          {pipelineState === "listening" && (
            <>
              <Animated.View
                style={[
                  styles.waveRing,
                  {
                    opacity: waveAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.5, 0],
                    }),
                    transform: [
                      {
                        scale: waveAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, 1.8],
                        }),
                      },
                    ],
                  },
                ]}
              />
            </>
          )}
        </View>

        {/* Error */}
        {error && (
          <Text style={styles.errorText}>{error}</Text>
        )}
      </View>
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
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    padding: 8,
  },
  backText: {
    fontSize: 16,
    color: COLORS.accent,
    fontWeight: "600",
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: COLORS.text,
  },
  headerSpacer: {
    width: 60,
  },
  loadingContainer: {
    padding: 40,
    alignItems: "center",
  },
  loadingText: {
    marginTop: 16,
    fontSize: 14,
    color: COLORS.textMuted,
  },
  conversation: {
    flex: 1,
  },
  conversationContent: {
    padding: 20,
    paddingBottom: 40,
  },
  message: {
    maxWidth: "80%",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 18,
    marginBottom: 12,
  },
  userMessage: {
    alignSelf: "flex-end",
    backgroundColor: COLORS.primary,
  },
  assistantMessage: {
    alignSelf: "flex-start",
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  liveMessage: {
    opacity: 0.7,
    borderWidth: 2,
    borderColor: COLORS.accent,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  userText: {
    color: "#FFFFFF",
  },
  assistantText: {
    color: COLORS.text,
  },
  bottomSection: {
    alignItems: "center",
    paddingVertical: 24,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  statusText: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 20,
  },
  micContainer: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  micButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
    zIndex: 10,
  },
  micIdle: {
    backgroundColor: COLORS.primary,
  },
  micListening: {
    backgroundColor: COLORS.accent,
  },
  micSpeaking: {
    backgroundColor: COLORS.success,
  },
  micThinking: {
    backgroundColor: "#64748B",
  },
  micLoading: {
    backgroundColor: COLORS.border,
  },
  micDisabled: {
    backgroundColor: COLORS.success,
  },
  micIcon: {
    fontSize: 32,
  },
  waveRing: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: COLORS.accent,
    zIndex: 1,
  },
  errorText: {
    marginTop: 12,
    fontSize: 13,
    color: "#EF4444",
    textAlign: "center",
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  feedbackCard: {
    backgroundColor: COLORS.card,
    borderRadius: 24,
    padding: 28,
    width: "100%",
    maxWidth: 360,
    maxHeight: "80%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 10,
  },
  loadingFeedback: {
    alignItems: "center",
    paddingVertical: 40,
  },
  loadingFeedbackText: {
    marginTop: 20,
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
  },
  loadingFeedbackSubtext: {
    marginTop: 8,
    fontSize: 14,
    color: COLORS.textMuted,
  },
  feedbackTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: COLORS.text,
    textAlign: "center",
    marginBottom: 24,
  },
  scoreCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 4,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
    backgroundColor: COLORS.bg,
  },
  scoreText: {
    fontSize: 28,
    fontWeight: "800",
  },
  feedbackScroll: {
    maxHeight: 200,
    marginBottom: 24,
  },
  feedbackText: {
    fontSize: 15,
    lineHeight: 24,
    color: COLORS.text,
    textAlign: "center",
  },
  feedbackButtons: {
    flexDirection: "row",
    gap: 12,
  },
  feedbackButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  tryAgainButton: {
    backgroundColor: COLORS.bg,
    borderWidth: 2,
    borderColor: COLORS.border,
  },
  tryAgainButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: COLORS.textMuted,
  },
  doneButton: {
    backgroundColor: COLORS.primary,
  },
  doneButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#FFFFFF",
  },
});
