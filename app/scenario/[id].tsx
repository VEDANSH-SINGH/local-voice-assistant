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

// Scenario-specific feedback prompts from scenario-readme.md
// Each prompt is designed for the specific scenario context
const FEEDBACK_PROMPTS: Record<string, { promptTemplate: string; roleLabels: { user: string; assistant: string } }> = {
  "introduce-yourself": {
    roleLabels: { user: "Employee", assistant: "Director" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who just introduced themselves to a Director.

**Scenario:** You are a new employee from the engineering team at a tech startup. You spotted a Director in the breakroom and initiated a brief introduction. Goal was to share your name, role/team, and current work in ~30 seconds.

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "leaving-early": {
    roleLabels: { user: "Employee", assistant: "Boss" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who just requested to leave early from their boss.

**Scenario:** You are a employee who walked into your boss's office to request leaving at 2 PM for a personal reason. Goal was to make the request confidently without over-apologizing or giving too much personal detail.

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "status-update": {
    roleLabels: { user: "Employee", assistant: "Boss" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who just gave a project status update.

**Scenario:** You are a Developer working on the Customer Dashboard project. Your boss asked for a quick status update while walking to a meeting. You had ~45 seconds. The ideal format is "Headline → Detail → ETA".

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "sick-call": {
    roleLabels: { user: "Employee", assistant: "Boss" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who just called their boss about sick leave.

**Scenario:** You are a Employee who woke up with a fever and called your boss to inform about absence. Goal was to STATE absence clearly (not ask permission) and mention who's covering urgent tasks.

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "impossible-deadline": {
    roleLabels: { user: "Employee", assistant: "Boss" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who discussed an unrealistic deadline with their boss.

**Scenario:** You are a Software Engineer whose boss set a 2-day deadline for Payment Gateway Integration (realistically needs 5-6 days). You went to their office to discuss this.

**Key facts you should have presented:**
- 120 hours of work needed
- 3 developers available
- Math: 120 ÷ 3 = 40 hours each = 5 days minimum
- Blockers: API docs pending, QA needs 1 day

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "non-responder": {
    roleLabels: { user: "You", assistant: "Priya (Colleague)" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who approached a colleague to get an answer.

**Scenario:** You are a Software Engineer. Priya hasn't replied to your emails about API specs (needed for auth module). Deadline: tomorrow standup. You walked to her desk to get an answer.

**Goal:** Be friendly but firm - get a specific commitment, not just "I'll do it later."

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "scope-check": {
    roleLabels: { user: "You", assistant: "Manager" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who was assigned a new task.

**Scenario:** You are a Software Engineer. You were working on API migration (deadline: Thursday). Manager assigned you a new task (bug fix). Goal: clarify priorities, don't just say yes.

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "messed-up": {
    roleLabels: { user: "You", assistant: "Boss" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who confessed a work mistake.

**Scenario:** You are a Software Engineer. You ran wrong query on production. You went to confess to your boss. Goal: direct ownership + solution.

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "refuse-to-cover": {
    roleLabels: { user: "You", assistant: "Rahul" },
    promptTemplate: `You are a communication coach giving direct feedback to someone whose colleague asked them to lie.

**Scenario:** You are a Software Engineer. Rahul asked you to tell boss he was in a client meeting (he wasn't). Goal: refuse professionally without being preachy or rude.

**Your Conversation:**
{conversation_text}

Analyze and provide feedback directly to "you" in JSON format:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`,
  },
  "over-promise": {
    roleLabels: { user: "You", assistant: "Boss" },
    promptTemplate: `You are a communication coach giving feedback to someone warning about a missed deadline.

**Scenario:** You promised Tuesday delivery. It's Monday. You need until Thursday. 70% done.

**Your Conversation:**
{conversation_text}

Provide feedback in JSON:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you'>"
}`,
  },
  "asking-raise": {
    roleLabels: { user: "You", assistant: "Manager" },
    promptTemplate: `You are a communication coach.

Scenario: You are a Software Engineer asking for a raise (₹12 LPA → ₹15 LPA). Evaluate clarity of ask and value justification.

Conversation:
{conversation_text}

Return JSON with overall_score and feedback addressed to "you".
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you'>"
}`,
  },
  "expensive-tool": {
    roleLabels: { user: "You", assistant: "Manager" },
    promptTemplate: `You are a communication coach.

Scenario: You pitched an expensive monitoring tool. Evaluate ROI framing (MTTR, noise reduction, outage risk) and whether you gave a baseline + measurement plan.

Conversation:
{conversation_text}

Return JSON addressed to "you" with overall_score and feedback.
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you'>"
}`,
  },
  "remote-work": {
    roleLabels: { user: "You", assistant: "Manager" },
    promptTemplate: `You are a communication coach.

Scenario: You are negotiating 3 days WFH. Evaluate whether you focused on productivity/output + commitments, not commuting dislike.

Conversation:
{conversation_text}

Return JSON addressed to "you" with overall_score and feedback.
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you'>"
}`,
  },
  "kpi-adjustment": {
    roleLabels: { user: "You", assistant: "Manager" },
    promptTemplate: `You are a communication coach giving direct feedback to someone who negotiated a KPI target.

Scenario (fixed): KPI was 25 tickets/week, you proposed 15/week citing quality/repeat bugs and higher incidents.

Conversation:
{conversation_text}

Return feedback as JSON:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you'>"
}`,
  },
  "headcount-plea": {
    roleLabels: { user: "You", assistant: "Boss" },
    promptTemplate: `You are a communication coach giving direct feedback to someone requesting headcount during a hiring freeze.

Conversation:
{conversation_text}

Return feedback as JSON:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you'>"
}`,
  },
  "overtime-comp": {
    roleLabels: { user: "You", assistant: "Manager" },
    promptTemplate: `You are a communication coach giving direct feedback to someone asking for comp-off after weekend work.

Conversation:
{conversation_text}

Return feedback as JSON:
{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you'>"
}`,
  },
};

export default function ScenarioScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    title: string;
    systemPrompt: string;
    initialMessage: string;
    situation: string;
    userInitiates: string;
  }>();

  // Prep screen state - show context before starting conversation
  const [showPrepScreen, setShowPrepScreen] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [hasPlayedInitial, setHasPlayedInitial] = useState(false);
  
  // Derived values
  const userInitiates = params.userInitiates === "true";

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
    ttsModelSource: "bert" as ModelSource, // BERT for best prosody in training scenarios
    llamaModel: "gemma-2b-it", // Gemma 2B IT - better quality for scenarios
    whisperModel: "base", // Use base model for better transcription accuracy (same as Whisper demo tab)
  });

  const scrollViewRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const waveAnim = useRef(new Animated.Value(0)).current;

  // Handle "I am ready" button press
  const handleStartConversation = async () => {
    setShowPrepScreen(false);
      setIsInitializing(true);
      try {
        await initializeAll();
      } catch (err) {
        console.error("Initialization failed:", err);
      } finally {
        setIsInitializing(false);
      }
    };

  // Play initial message when models are ready (only if AI initiates)
  useEffect(() => {
    const playInitialMessage = async () => {
      // Only play initial message if: models ready, not played yet, not user-initiated, has message
      if (isReady() && !hasPlayedInitial && !isInitializing && !showPrepScreen && !userInitiates && params.initialMessage) {
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
  }, [isReady, hasPlayedInitial, isInitializing, showPrepScreen, userInitiates, params.initialMessage]);

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

      // Get scenario-specific feedback config, fallback to generic if not found
      const scenarioId = params.id || "";
      const feedbackConfig = FEEDBACK_PROMPTS[scenarioId];
      
      // Use scenario-specific role labels or defaults
      const userLabel = feedbackConfig?.roleLabels.user || "You";
      const assistantLabel = feedbackConfig?.roleLabels.assistant || "Other Person";

      // Format conversation for the prompt using scenario-specific role labels
      const conversationText = allMessages
        .map(msg => {
          const role = msg.role === "user" ? userLabel : assistantLabel;
          // Clean the content - remove <conv_completed/> tag
          const cleanContent = msg.content.replace(/<conv_completed\/?>/g, "").trim();
          return `${role}: ${cleanContent}`;
        })
        .join("\n\n");

      // Use scenario-specific prompt template or fallback to generic
      let feedbackPrompt: string;
      if (feedbackConfig?.promptTemplate) {
        // Use the scenario-specific template with conversation injected
        feedbackPrompt = feedbackConfig.promptTemplate.replace("{conversation_text}", conversationText);
      } else {
        // Fallback generic prompt
        feedbackPrompt = `You are a communication coach giving direct feedback to someone who just completed a workplace conversation practice.

**Scenario:** ${params.title || "Workplace Conversation"}
${params.situation ? `**Context:** ${params.situation.split('\n')[0]}` : ""}

**Goal:** Practice professional communication skills effectively.

**Your Conversation:**

${conversationText}

Analyze and provide feedback directly to "you" in JSON format:

{
  "overall_score": "<score>/10",
  "feedback": "<2-3 sentences addressing 'you': what you did well, what you need to work on, one actionable tip>"
}`;
      }

      console.log("📝 Generating feedback for scenario:", scenarioId);
      console.log("📝 Using role labels:", userLabel, "/", assistantLabel);
      console.log("📝 Prompt preview:", feedbackPrompt.substring(0, 200) + "...");

      // Use llama.completion() wrapper which applies Gemma chat template automatically
      // (equivalent to Python's create_chat_completion)
      const result = await llama.completion([
        { role: "user", content: feedbackPrompt }
      ]);

      console.log("📊 Feedback result:", result);

      // Parse JSON from response
      try {
        // Try to extract JSON from the response (result is now a string directly)
        const jsonMatch = result.match(/\{[\s\S]*?"overall_score"[\s\S]*?"feedback"[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Feedback;
          setFeedback(parsed);
          console.log("✅ Feedback parsed:", parsed);
        } else {
          // Fallback if JSON parsing fails
          setFeedback({
            overall_score: "7/10",
            feedback: result.trim() || "Great effort! Keep practicing your introduction skills.",
          });
        }
      } catch (parseError) {
        console.error("Failed to parse feedback JSON:", parseError);
        setFeedback({
          overall_score: "7/10",
          feedback: result.trim() || "Good job! Continue practicing to improve your communication skills.",
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

  // Prep Screen - Show context before starting conversation
  if (showPrepScreen) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleBack} style={styles.backButton}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{params.title || "Scenario"}</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* Context Content */}
        <ScrollView 
          style={styles.prepContent}
          contentContainerStyle={styles.prepContentContainer}
          showsVerticalScrollIndicator={false}
        >
          {/* Scenario Icon & Title */}
          <View style={styles.prepHeader}>
            <View style={styles.prepIconContainer}>
              <Text style={styles.prepIcon}>🎭</Text>
            </View>
            <Text style={styles.prepTitle}>Your Situation</Text>
            <Text style={styles.prepSubtitle}>Read the context below before starting</Text>
          </View>

          {/* Situation Card */}
          <View style={styles.situationCard}>
            <Text style={styles.situationText}>{params.situation}</Text>
          </View>

          {/* Who speaks first indicator */}
          <View style={styles.initiatorCard}>
            <View style={styles.initiatorIcon}>
              <Text style={styles.initiatorIconText}>{userInitiates ? "🎤" : "🔊"}</Text>
            </View>
            <View style={styles.initiatorTextContainer}>
              <Text style={styles.initiatorLabel}>
                {userInitiates ? "You speak first" : "They speak first"}
              </Text>
              <Text style={styles.initiatorHint}>
                {userInitiates 
                  ? "Start the conversation when you're ready" 
                  : "Listen to what they say, then respond"}
              </Text>
            </View>
          </View>

          {/* Tips */}
          <View style={styles.tipsCard}>
            <Text style={styles.tipsTitle}>💡 Tips</Text>
            <Text style={styles.tipsText}>• Be clear and concise</Text>
            <Text style={styles.tipsText}>• Stay professional</Text>
            <Text style={styles.tipsText}>• Use the information provided</Text>
          </View>
        </ScrollView>

        {/* Ready Button */}
        <View style={styles.prepBottomSection}>
          <TouchableOpacity
            style={styles.readyButton}
            onPress={handleStartConversation}
            activeOpacity={0.8}
          >
            <Text style={styles.readyButtonText}>I'm Ready</Text>
            <Text style={styles.readyButtonIcon}>→</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Conversation Screen
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
  // Prep Screen Styles
  prepContent: {
    flex: 1,
  },
  prepContentContainer: {
    padding: 24,
    paddingBottom: 40,
  },
  prepHeader: {
    alignItems: "center",
    marginBottom: 28,
  },
  prepIconContainer: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: COLORS.accentLight,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  prepIcon: {
    fontSize: 36,
  },
  prepTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: COLORS.text,
    marginBottom: 8,
  },
  prepSubtitle: {
    fontSize: 15,
    color: COLORS.textMuted,
    textAlign: "center",
  },
  situationCard: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 24,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  situationText: {
    fontSize: 16,
    lineHeight: 26,
    color: COLORS.text,
  },
  initiatorCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.primary,
    borderRadius: 16,
    padding: 18,
    marginBottom: 20,
  },
  initiatorIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 16,
  },
  initiatorIconText: {
    fontSize: 24,
  },
  initiatorTextContainer: {
    flex: 1,
  },
  initiatorLabel: {
    fontSize: 17,
    fontWeight: "700",
    color: "#FFFFFF",
    marginBottom: 4,
  },
  initiatorHint: {
    fontSize: 14,
    color: "rgba(255, 255, 255, 0.8)",
  },
  tipsCard: {
    backgroundColor: COLORS.warning,
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
  },
  tipsTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.text,
    marginBottom: 12,
  },
  tipsText: {
    fontSize: 14,
    color: COLORS.text,
    marginBottom: 6,
    paddingLeft: 4,
  },
  prepBottomSection: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    paddingBottom: 32,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  readyButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.accent,
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 32,
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  readyButtonText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#FFFFFF",
    marginRight: 8,
  },
  readyButtonIcon: {
    fontSize: 20,
    color: "#FFFFFF",
    fontWeight: "700",
  },
});
