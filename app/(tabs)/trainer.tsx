import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import {
  Dimensions,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const { width } = Dimensions.get("window");

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

// Scenario definitions
interface Scenario {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  gradient: string[];
  systemPrompt: string;
  initialMessage: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "introduce-yourself",
    title: "Introduce Yourself",
    subtitle: "Corporate Introduction",
    description: "Practice your professional self-introduction for meetings, interviews, and networking events.",
    icon: "👋",
    gradient: ["#1E3A5F", "#0F2942"],  // Deep navy matching primary
    systemPrompt: `Act as the Manager at a bank. I am a new Data Analyst joining today on my first day. We are in the office, it's Monday 10:30 AM. Approach my desk and welcome me.

Constraints:
- Goal: Get a brief introduction.
- Do not drag the conversation.
- Ending: End with '<conv_completed/>' after your final message.`,
    initialMessage: "Hey, welcome to the team! We're so glad to have you here. So, tell me a bit about yourself?",
  },
  // More scenarios can be added here
];

export default function TrainerScreen() {
  const router = useRouter();

  const handleScenarioPress = (scenario: Scenario) => {
    router.push({
      pathname: "/scenario/[id]",
      params: { 
        id: scenario.id,
        title: scenario.title,
        systemPrompt: scenario.systemPrompt,
        initialMessage: scenario.initialMessage,
      },
    });
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Scenario Trainer</Text>
        <Text style={styles.subtitle}>
          Practice real-world corporate communication
        </Text>
      </View>

      {/* Scenarios Grid */}
      <View style={styles.scenariosContainer}>
        <Text style={styles.sectionTitle}>TRAINING SCENARIOS</Text>
        
        {SCENARIOS.map((scenario) => (
          <TouchableOpacity
            key={scenario.id}
            style={styles.scenarioCard}
            onPress={() => handleScenarioPress(scenario)}
            activeOpacity={0.9}
          >
            <View style={[styles.cardGradient, { backgroundColor: scenario.gradient[0] }]}>
              <View style={styles.cardIconContainer}>
                <Text style={styles.cardIcon}>{scenario.icon}</Text>
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardSubtitle}>{scenario.subtitle}</Text>
                <Text style={styles.cardTitle}>{scenario.title}</Text>
                <Text style={styles.cardDescription}>{scenario.description}</Text>
              </View>
              <View style={styles.cardArrow}>
                <Text style={styles.cardArrowText}>→</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}

        {/* Coming Soon Placeholder */}
        <View style={styles.comingSoonCard}>
          <Text style={styles.comingSoonIcon}>🚀</Text>
          <Text style={styles.comingSoonTitle}>More Scenarios Coming Soon</Text>
          <Text style={styles.comingSoonText}>
            Elevator pitch, salary negotiation, performance review, and more...
          </Text>
        </View>
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
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    color: COLORS.primary,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    color: COLORS.textMuted,
    marginTop: 8,
  },
  scenariosContainer: {
    flex: 1,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.textMuted,
    letterSpacing: 1.5,
    marginBottom: 16,
    marginLeft: 4,
  },
  scenarioCard: {
    marginBottom: 16,
    borderRadius: 20,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
  },
  cardGradient: {
    padding: 24,
    minHeight: 180,
  },
  cardIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  cardIcon: {
    fontSize: 28,
  },
  cardContent: {
    flex: 1,
  },
  cardSubtitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "rgba(255, 255, 255, 0.7)",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
  },
  cardTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: "#FFFFFF",
    marginBottom: 8,
  },
  cardDescription: {
    fontSize: 14,
    color: "rgba(255, 255, 255, 0.85)",
    lineHeight: 20,
  },
  cardArrow: {
    position: "absolute",
    right: 24,
    top: 24,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardArrowText: {
    fontSize: 20,
    color: "#FFFFFF",
    fontWeight: "600",
  },
  comingSoonCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 2,
    borderColor: COLORS.border,
    borderStyle: "dashed",
  },
  comingSoonIcon: {
    fontSize: 32,
    marginBottom: 12,
  },
  comingSoonTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.textMuted,
    marginBottom: 8,
  },
  comingSoonText: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
});

