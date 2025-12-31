import React, { useState, useEffect, useRef } from "react";
import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLlamaModels, ChatMessage } from "@/hooks/useLlamaModels";

const ACCENT_COLOR = "#10B981"; // Emerald green for chat

export default function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string>("");
  const scrollViewRef = useRef<ScrollView>(null);

  const {
    llamaContext,
    isInitializingModel,
    isDownloading,
    downloadProgress,
    currentModelId,
    modelFiles,
    isGenerating,
    llamaError,
    initializeLlamaModel,
    completion,
    getCurrentModel,
    getDownloadProgress,
    deleteModel,
  } = useLlamaModels();

  useEffect(() => {
    // Auto-initialize with Gemma model
    if (!llamaContext && !isInitializingModel && !isDownloading) {
      initializeModel();
    }
  }, []);

  const initializeModel = async () => {
    try {
      setError("");
      await initializeLlamaModel("gemma-3-270m");
    } catch (err) {
      console.error("Failed to initialize model:", err);
      setError(`Failed to initialize model: ${err}`);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() || !llamaContext || isGenerating) return;

    const userMessage: ChatMessage = {
      role: "user",
      content: inputText.trim(),
    };

    const newMessages: ChatMessage[] = [...messages, userMessage];
    setMessages(newMessages);
    setInputText("");
    setStreamingText("");
    setError("");

    // Scroll to bottom
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      // Build conversation with system prompt
      const conversationMessages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are a helpful, friendly AI assistant. Keep your responses concise and helpful.",
        },
        ...newMessages,
      ];

      let fullResponse = "";
      const response = await completion(conversationMessages, (token) => {
        fullResponse += token;
        setStreamingText(fullResponse);
        // Auto-scroll during streaming
        scrollViewRef.current?.scrollToEnd({ animated: false });
      });

      // Add assistant response to messages
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.trim(),
      };
      setMessages([...newMessages, assistantMessage]);
      setStreamingText("");
    } catch (err) {
      console.error("Completion error:", err);
      setError(`Failed to generate response: ${err}`);
    }
  };

  const handleClearChat = () => {
    Alert.alert("Clear Chat", "Are you sure you want to clear the conversation?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          setMessages([]);
          setStreamingText("");
          setError("");
        },
      },
    ]);
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

  const activeModelLabel = getCurrentModel()?.label || "Model";
  const downloadPercentage = getDownloadProgress("gemma-3-270m") ?? 0;
  const modelStatusText = isDownloading
    ? `Downloading ${activeModelLabel} · ${(downloadPercentage * 100).toFixed(0)}%`
    : isInitializingModel
    ? "Loading model…"
    : llamaContext
    ? `Ready · ${activeModelLabel}`
    : llamaError
    ? "Error"
    : "Not initialized";

  const isReady = llamaContext && !isInitializingModel && !isDownloading;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>AI Chat</Text>
            <View
              style={[
                styles.statusBadge,
                isReady ? styles.statusReady : styles.statusLoading,
              ]}
            >
              <Text
                style={[
                  styles.statusText,
                  isReady ? styles.statusTextReady : styles.statusTextLoading,
                ]}
              >
                {modelStatusText}
              </Text>
            </View>
          </View>
          {messages.length > 0 && (
            <TouchableOpacity onPress={handleClearChat} style={styles.clearButton}>
              <Text style={styles.clearButtonText}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Error Banner */}
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={initializeModel}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Download Progress */}
        {isDownloading && (
          <View style={styles.progressContainer}>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${downloadPercentage * 100}%` },
                ]}
              />
            </View>
            <Text style={styles.progressText}>
              Downloading model... {(downloadPercentage * 100).toFixed(0)}%
            </Text>
          </View>
        )}

        {/* Chat Messages */}
        <ScrollView
          ref={scrollViewRef}
          style={styles.messagesContainer}
          contentContainerStyle={styles.messagesContent}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() =>
            scrollViewRef.current?.scrollToEnd({ animated: true })
          }
        >
          {messages.length === 0 && !streamingText && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>💬</Text>
              <Text style={styles.emptyTitle}>Start a conversation</Text>
              <Text style={styles.emptySubtitle}>
                {isReady
                  ? "Type a message below to chat with Gemma AI"
                  : "Please wait while the model loads..."}
              </Text>
            </View>
          )}

          {messages.map((message, index) => (
            <View
              key={index}
              style={[
                styles.messageBubble,
                message.role === "user"
                  ? styles.userBubble
                  : styles.assistantBubble,
              ]}
            >
              <Text
                style={[
                  styles.messageText,
                  message.role === "user"
                    ? styles.userText
                    : styles.assistantText,
                ]}
              >
                {message.content}
              </Text>
            </View>
          ))}

          {/* Streaming response */}
          {streamingText ? (
            <View style={[styles.messageBubble, styles.assistantBubble]}>
              <Text style={[styles.messageText, styles.assistantText]}>
                {streamingText}
              </Text>
              <View style={styles.typingIndicator}>
                <ActivityIndicator size="small" color={ACCENT_COLOR} />
              </View>
            </View>
          ) : null}

          {/* Loading indicator when generating but no text yet */}
          {isGenerating && !streamingText && (
            <View style={[styles.messageBubble, styles.assistantBubble]}>
              <View style={styles.loadingDots}>
                <ActivityIndicator size="small" color={ACCENT_COLOR} />
                <Text style={styles.thinkingText}>Thinking...</Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Input Area */}
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.textInput}
            placeholder={isReady ? "Type a message..." : "Loading model..."}
            placeholderTextColor="#9CA3AF"
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={1000}
            editable={isReady && !isGenerating}
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!isReady || !inputText.trim() || isGenerating) &&
                styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={!isReady || !inputText.trim() || isGenerating}
          >
            <Text style={styles.sendButtonText}>
              {isGenerating ? "..." : "→"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Model Info Footer */}
        {modelFiles["gemma-3-270m"] && (
          <View style={styles.modelInfo}>
            <Text style={styles.modelInfoText}>
              Model: {formatBytes(modelFiles["gemma-3-270m"].size)} on device
            </Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F9FAFB",
  },
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  headerLeft: {
    flex: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },
  statusBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusReady: {
    backgroundColor: "#D1FAE5",
  },
  statusLoading: {
    backgroundColor: "#FEF3C7",
  },
  statusText: {
    fontSize: 12,
    fontWeight: "600",
  },
  statusTextReady: {
    color: "#065F46",
  },
  statusTextLoading: {
    color: "#92400E",
  },
  clearButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  clearButtonText: {
    color: "#6B7280",
    fontSize: 14,
    fontWeight: "600",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FEF2F2",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#FECACA",
  },
  errorText: {
    flex: 1,
    color: "#991B1B",
    fontSize: 13,
  },
  retryText: {
    color: ACCENT_COLOR,
    fontSize: 13,
    fontWeight: "600",
    marginLeft: 12,
  },
  progressContainer: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: "#ffffff",
  },
  progressBar: {
    height: 6,
    backgroundColor: "#E5E7EB",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: ACCENT_COLOR,
    borderRadius: 3,
  },
  progressText: {
    marginTop: 8,
    fontSize: 12,
    color: "#6B7280",
    textAlign: "center",
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: 16,
    paddingBottom: 24,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    paddingHorizontal: 40,
  },
  messageBubble: {
    maxWidth: "85%",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
    marginBottom: 12,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: ACCENT_COLOR,
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#ffffff",
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  messageText: {
    fontSize: 15,
    lineHeight: 22,
  },
  userText: {
    color: "#ffffff",
  },
  assistantText: {
    color: "#1F2937",
  },
  typingIndicator: {
    marginTop: 8,
  },
  loadingDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  thinkingText: {
    color: "#6B7280",
    fontSize: 13,
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
    gap: 12,
  },
  textInput: {
    flex: 1,
    backgroundColor: "#F3F4F6",
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
    fontSize: 15,
    maxHeight: 120,
    color: "#111827",
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: ACCENT_COLOR,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    backgroundColor: "#D1D5DB",
  },
  sendButtonText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "600",
  },
  modelInfo: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "#F9FAFB",
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
  },
  modelInfoText: {
    fontSize: 11,
    color: "#9CA3AF",
    textAlign: "center",
  },
});
