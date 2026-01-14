import { useLlamaModels } from "@/hooks/useLlamaModels";
import { useMeloTTS } from "@/hooks/useMeloTTS";
import { useWhisperModels } from "@/hooks/useWhisperModels";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// Color palette - consistent with voice assistant
const COLORS = {
  primary: "#1E3A5F",
  accent: "#FF6B6B",
  accentLight: "#FFE5E5",
  success: "#4ECDC4",
  warning: "#FFE66D",
  bg: "#F8FAFC",
  card: "#FFFFFF",
  text: "#1E3A5F",
  textMuted: "#64748B",
  textLight: "#94A3B8",
  border: "#E2E8F0",
};

// Difficulty levels
type Difficulty = "beginner" | "intermediate" | "advanced";

const DIFFICULTY_CONFIG: Record<Difficulty, { label: string; color: string; bgColor: string }> = {
  beginner: { label: "Beginner", color: "#059669", bgColor: "#D1FAE5" },
  intermediate: { label: "Intermediate", color: "#D97706", bgColor: "#FEF3C7" },
  advanced: { label: "Advanced", color: "#DC2626", bgColor: "#FEE2E2" },
};

// Scenario definitions
interface Scenario {
  id: string;
  title: string;
  category: string;
  description: string;
  icon: string;
  accentColor: string;
  systemPrompt: string;
  initialMessage: string;
  situation: string;
  userInitiates: boolean;
  difficulty: Difficulty;
  duration: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "introduce-yourself",
    title: "Pantry Intro",
    category: "Networking",
    description: "Introduce yourself to a Director at a tech startup",
    icon: "👋",
    accentColor: "#1E3A5F",
    difficulty: "beginner",
    duration: "2-3 min",
    systemPrompt: `Act as a friendly Director at a tech startup. A new Software Engineer from the backend team approaches you in the breakroom to introduce themselves.

Setting: Breakroom/pantry, morning coffee time. The employee initiates the conversation.

Constraints:
1. Goal: Learn their name, role, team, and what they're working on.
2. Be warm and encouraging. If they seem nervous, help them feel comfortable.
3. Keep responses short (10-25 words).
4. End with '<conv_completed/>' after your final message.`,
    initialMessage: "",
    situation: `You are a newly joined Software Engineer on the backend team at a tech startup. You joined 2 weeks ago and are currently in onboarding - going through documentation and setting up your development environment.

You spotted a Director in the breakroom getting coffee. This is your chance to introduce yourself.`,
    userInitiates: true,
  },
  {
    id: "leaving-early",
    title: "Leaving Early",
    category: "Requests",
    description: "Ask your boss for permission to leave work early",
    icon: "🕐",
    accentColor: "#7C3AED",
    difficulty: "intermediate",
    duration: "3-4 min",
    systemPrompt: `Act as a strict but fair boss at a tech startup. A employee has walked into your office to request leaving early at 2 PM for a personal reason.

Setting: Your office, around 1 PM. The employee initiates the request.

Your behavior:
1. Don't immediately approve - show some restraint
2. Ask about work status and deadlines
3. May express mild concern
4. Eventually make a decision

Constraints:
1. Goal: Handle the leave request professionally
2. Keep responses short (10-30 words)
3. End with '<conv_completed/>' after your final STATEMENT (not a question)`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. You need to leave office early today at 2 PM for a personal commitment.

Your Work Status:
• Completed: API integration for the payments module
• Pending: Code review for the PR
• Priya can cover if needed (you've already informed her)
• There's a 3 PM sprint sync meeting - Priya will cover

You're walking into your boss's office to request permission to leave early.`,
    userInitiates: true,
  },
  {
    id: "status-update",
    title: "Status Update",
    category: "Reporting",
    description: "Give a quick project status update to your busy boss",
    icon: "📊",
    accentColor: "#059669",
    difficulty: "beginner",
    duration: "2-3 min",
    systemPrompt: `Act as a busy boss at a tech company. You're walking to a meeting and need a quick status update on the Customer Dashboard project from your team member.

Setting: Corridor, you're in a hurry. You initiate by asking about the project.

Your behavior:
1. Ask for status quickly
2. If they ramble, cut them off - "Just give me the bottom line"
3. May ask one quick follow-up about blockers or timeline
4. Wrap up quickly once you have what you need

Constraints:
1. Keep responses short (10-20 words)
2. End with '<conv_completed/>' after your final STATEMENT (not a question)`,
    initialMessage: "Hey! Quick - how's the Customer Dashboard coming along?",
    situation: `You are a Software Engineer working on the Customer Dashboard Revamp project at a tech company. Your boss spots you in the corridor while rushing to a meeting.

Project Status:
• Progress: 70-80% complete
• Completed: UI components and design implementation
• Blocker: API integration from Vikram's team (expected resolution: EOD today or tomorrow)
• Target completion: Thursday/Friday this week
• Pending: API integration and testing`,
    userInitiates: false,
  },
  {
    id: "sick-call",
    title: "Sick Call",
    category: "Communication",
    description: "Call your boss to inform them you're unwell",
    icon: "🤒",
    accentColor: "#DC2626",
    difficulty: "beginner",
    duration: "2-3 min",
    systemPrompt: `Act as an understanding boss at a tech startup. Your employee is calling to inform you they're sick and won't be coming in.

Setting: Phone call. The employee initiates.

Your behavior:
1. Be caring and supportive - they're unwell
2. If they don't mention coverage, ask briefly
3. Wish them well and tell them to rest
4. Keep it brief - they're sick

Constraints:
1. Keep responses short (10-25 words)
2. End with '<conv_completed/>' after your final caring message`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. You woke up with a fever this morning and cannot come to office.

Details:
• Reason: Fever
• Urgent task: Code review scheduled for today
• Rahul from your team can cover your urgent tasks (you've already messaged him)
• Duration: Today only (will reassess how you're feeling tomorrow)

You need to call your boss to inform about your absence.`,
    userInitiates: true,
  },
  {
    id: "impossible-deadline",
    title: "Impossible Deadline",
    category: "Negotiation",
    description: "Discuss an unrealistic deadline with facts and data",
    icon: "⏰",
    accentColor: "#EA580C",
    difficulty: "advanced",
    duration: "4-5 min",
    systemPrompt: `Act as a busy but reasonable boss at a tech startup. Your employee has come to discuss a tight deadline you set for the Payment Gateway Integration (2 days).

Setting: Your office. Employee initiates the conversation.

Your behavior:
1. If they just complain without data, ask for specifics (hours, team size, blockers)
2. If they present numbers/math, consider them seriously
3. If they propose alternatives, discuss tradeoffs
4. End with a decision or clear next step
5. Keep discussion about TIME and RESOURCES - do NOT ask about technical implementation details

Constraints:
1. Keep responses short (15-35 words)
2. End with '<conv_completed/>' after your final decision/statement`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. Your boss has set a 2-day deadline for the Payment Gateway Integration project.

The Facts:
• Boss's deadline: 2 days
• Realistic estimate: 5-6 days
• Team size: 3 developers
• Total work required: 120 hours
• The math: 120 hours ÷ 3 devs = 40 hours each = 5 days minimum
• Blockers:
  - API documentation still pending from vendor
  - QA needs minimum 1 day for security testing

You're at your boss's office door to discuss this deadline.`,
    userInitiates: true,
  },
  {
    id: "non-responder",
    title: "Non-Responder",
    category: "Collaboration",
    description: "Follow up with a colleague who hasn't replied to emails",
    icon: "📧",
    accentColor: "#0891B2",
    difficulty: "intermediate",
    duration: "3-4 min",
    systemPrompt: `Act as Priya, a busy Software Engineer at a tech startup. A colleague has walked to your desk because you haven't replied to their emails about API specs.

Setting: Your desk. Colleague initiates the conversation.

Your behavior:
1. You're genuinely busy, not malicious - feel a bit guilty
2. If they're aggressive/passive-aggressive: Be defensive, give vague answers
3. If they're friendly: Be apologetic and cooperative, give specific time
4. If they offer help: Appreciate it

Constraints:
1. Keep responses short (15-30 words)
2. End with '<conv_completed/>' after your final response`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. You need API endpoint specifications for the user authentication module from Priya, but she hasn't responded to your emails.

Details:
• What you need: API endpoint specifications for user authentication module
• Your deadline: Tomorrow standup
• Emails sent: 2 emails over the past 3 days - no response
• Why urgent: Can't proceed with integration testing without it

You've decided to walk to her desk to get an answer in person.`,
    userInitiates: true,
  },
  {
    id: "scope-check",
    title: "Scope Check",
    category: "Prioritization",
    description: "Handle a new task when you already have a deadline",
    icon: "📋",
    accentColor: "#7C3AED",
    difficulty: "intermediate",
    duration: "3-4 min",
    systemPrompt: `Act as a busy manager at a tech startup. You're assigning a bug fix task to a team member.

Setting: Office. You initiate by assigning the task.

Your behavior:
1. If they just say "yes" - wrap up quickly
2. If they mention other work - listen and help prioritize
3. If they ask which is priority - give a clear answer
4. Be reasonable, not demanding
5. Keep discussion about priorities, not technical details

Constraints:
1. Keep responses short (15-30 words)
2. End with '<conv_completed/>' after your final message`,
    initialMessage: "Hey, I need you to pick up a bug fix in the reporting module. Some users are affected.",
    situation: `You are a Software Engineer at a tech startup. Your manager just walked up to assign you a new task.

Your Current Work:
• Current task: API migration task with a client demo
• Current deadline: Thursday (2 days away)

New Task Being Assigned:
• New task: Bug fix in the reporting module
• Reason: Some users are affected

You need to clarify priorities before just saying yes to everything.`,
    userInitiates: false,
  },
  {
    id: "messed-up",
    title: "Messed Up",
    category: "Accountability",
    description: "Confess to your manager about a production mistake",
    icon: "😰",
    accentColor: "#DC2626",
    difficulty: "advanced",
    duration: "4-5 min",
    systemPrompt: `Act as a manager at a tech startup. Your team member has come to confess they made a mistake affecting production.

Setting: Your office. Employee initiates the confession.

Your behavior:
1. If they blame others/system: Push for their role
2. If they own it clearly: Focus on the fix
3. If they're vague: Ask for specifics
4. Focus on solutions, not punishment

Constraints:
1. Keep responses short (15-30 words)
2. End with '<conv_completed/>' after your final message`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. You accidentally ran a DELETE query on the production database instead of the staging database.

What Happened:
• Mistake: Ran DELETE query on production instead of staging
• Impact: About 500 user records affected
• Recovery: Backup exists - can restore data within 2 hours
• Prevention: Will add confirmation prompt and environment check to the script

You need to confess to your boss and present a solution.`,
    userInitiates: true,
  },
  {
    id: "refuse-to-cover",
    title: "Refuse to Cover",
    category: "Ethics",
    description: "Navigate an awkward request from a colleague to lie",
    icon: "🤥",
    accentColor: "#4B5563",
    difficulty: "advanced",
    duration: "3-4 min",
    systemPrompt: `Act as Rahul, a colleague at a tech startup. You need your colleague to cover for you - tell boss you were in a client meeting.

Setting: Office. You initiate by asking the favor.

Your behavior:
1. Ask for the favor nicely
2. If they refuse, you can push once gently
3. Accept their final decision gracefully
4. Don't get angry or threaten

Constraints:
1. Keep responses short (10-25 words)
2. End with '<conv_completed/>' after your final response`,
    initialMessage: "Hey, quick favor - if boss asks, can you say I was in a client meeting earlier?",
    situation: `You are a Software Engineer at a tech startup. Your colleague Rahul approaches you with a request.

The Situation:
• Rahul's request: "If boss asks, can you say I was in a client meeting?"
• The truth: Rahul was actually late / took a long break
• Your position: You don't want to lie, but you also don't want to damage your relationship with Rahul

You need to refuse professionally without being preachy.`,
    userInitiates: false,
  },
  {
    id: "over-promise",
    title: "Over-Promise",
    category: "Expectation Management",
    description: "Inform your boss you can't meet a promised deadline",
    icon: "📅",
    accentColor: "#F59E0B",
    difficulty: "intermediate",
    duration: "3-4 min",
    systemPrompt: `Act as a manager at a tech startup. Your team member promised Tuesday delivery but is coming to talk to you on Monday.

Your behavior:
1. If they inform early with plan: Appreciate honesty
2. If vague: Ask for specifics
3. Focus on solutions

Constraints:
1. Keep responses short (15-30 words)
2. End with '<conv_completed/>' after your final message`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. You promised to deliver the user dashboard feature by Tuesday, but you now realize you won't make it. It's Monday.

The Situation:
• Original promise: Tuesday delivery of user dashboard feature
• New realistic timeline: Thursday
• Progress: 70% complete - backend is done
• What's left: Frontend polish and testing
• Reason: Underestimated frontend complexity

You're going to your boss's office.`,
    userInitiates: true,
  },
  {
    id: "asking-raise",
    title: "Asking for a Raise",
    category: "Negotiation",
    description: "Request a salary raise by presenting your value",
    icon: "💰",
    accentColor: "#10B981",
    difficulty: "advanced",
    duration: "4-5 min",
    systemPrompt: `Act as a supportive but budget-conscious manager at a tech startup. Your employee initiated a raise conversation.

Constraints:
- Keep responses short (15-35 words)
- Push for value-based justification (not personal need)
- End your final message with '<conv_completed/>'`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup with 18 months of tenure. Your current CTC is ₹12 LPA and you want to request ₹15 LPA (25% raise).

Your Value Points:
• Improved checkout reliability, reducing payment failures
• Took ownership of on-call and created runbooks, reducing incidents
• Mentored a junior developer, improving PR turnaround time

You're in a 1-on-1 with your manager to discuss compensation.`,
    userInitiates: true,
  },
  {
    id: "expensive-tool",
    title: "Pitch Expensive Tool",
    category: "Persuasion",
    description: "Convince your manager to approve a $5,000/year tool",
    icon: "🛠️",
    accentColor: "#6366F1",
    difficulty: "advanced",
    duration: "4-5 min",
    systemPrompt: `Act as a skeptical engineering manager at a tech startup. An engineer is pitching a $5,000 monitoring/alerting tool.

Focus on ROI (MTTR, noise reduction, outage risk). Keep it short.
End your final message with '<conv_completed/>'.`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. You want to pitch a $5,000/year monitoring and alerting tool to your manager.

Your ROI Points:
• Reduce MTTR (Mean Time To Recovery)
• Reduce on-call noise and alert fatigue
• Minimize outage risk
• You should have baseline measurements and success metrics ready

You're meeting with your Engineering Manager to pitch the tool.`,
    userInitiates: true,
  },
  {
    id: "remote-work",
    title: "Remote Work Request",
    category: "Negotiation",
    description: "Negotiate for more work-from-home days",
    icon: "🏠",
    accentColor: "#8B5CF6",
    difficulty: "intermediate",
    duration: "3-4 min",
    systemPrompt: `Act as a manager at a tech startup. An employee requests 3 days WFH (Tue/Wed/Fri).

Focus on output/commitments and team concerns (collaboration, availability, fairness).
End final message with '<conv_completed/>'.`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. Current policy allows 2 days WFH. You want to negotiate for 3 days WFH per week (Tuesday, Wednesday, Friday).

Your Points:
• Deep work improves output quality and speed
• Commit to measurable deliverables and response times
• Will come to office for demos, critical incidents, and planning days

Manager's likely concerns: collaboration, availability for urgent work, fairness across team.

You're in a 1-on-1 with your manager.`,
    userInitiates: true,
  },
  {
    id: "kpi-adjustment",
    title: "KPI Adjustment",
    category: "Negotiation",
    description: "Negotiate a more realistic KPI target with data",
    icon: "📈",
    accentColor: "#EC4899",
    difficulty: "advanced",
    duration: "4-5 min",
    systemPrompt: `Act as an engineering manager at a tech startup. Your employee is negotiating a KPI target down using quality/incident risk arguments.

Constraints:
- Keep responses short (15-30 words)
- Push back on laziness; accept only data-backed proposals
- End your final message with '<conv_completed/>'`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. Your manager set an aggressive KPI target of 25 tickets closed per week. You believe a realistic target is 15 tickets per week.

Your Data Points:
• Higher target is causing shallow fixes and repeat bugs
• Incident count has increased because quality is dropping
• You need to negotiate with data, not sound lazy

You're in a review meeting with your manager.`,
    userInitiates: true,
  },
  {
    id: "headcount-plea",
    title: "Headcount Request",
    category: "Resource Planning",
    description: "Request additional team member during hiring freeze",
    icon: "👥",
    accentColor: "#14B8A6",
    difficulty: "advanced",
    duration: "4-5 min",
    systemPrompt: `Act as a manager at a tech startup. Your engineer is asking for extra headcount during a hiring freeze.

Constraints:
- Keep responses short (15-30 words)
- Push for business risk framing and alternative options
- End your final message with '<conv_completed/>'`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. Your team has only 3 engineers and you need 1 additional engineer. There's a hiring freeze, but exceptions require strong justification.

Your Points:
• Burnout risk on the on-call rotation
• Delivery risk for committed roadmap plus increased incident risk
• Alternative: Contractor/temp support OR formal scope reduction

You're meeting with your boss to make the case.`,
    userInitiates: true,
  },
  {
    id: "overtime-comp",
    title: "Overtime Comp-Off",
    category: "Work-Life Balance",
    description: "Request comp-off days after weekend work",
    icon: "⚖️",
    accentColor: "#F97316",
    difficulty: "intermediate",
    duration: "3-4 min",
    systemPrompt: `Act as an engineering manager at a tech startup. Your engineer requests comp-off after weekend work.

Constraints:
- Keep responses short (15-30 words)
- Ensure coverage/handoff is addressed
- End your final message with '<conv_completed/>'`,
    initialMessage: "",
    situation: `You are a Software Engineer at a tech startup. You worked Saturday and Sunday for a production release. You want to request 2 comp-off days next week (Thursday and Friday).

Your Requirements:
• Propose a coverage plan for ongoing work and on-call
• Give clear handoff so delivery doesn't slip

You're in a post-release check-in with your manager.`,
    userInitiates: true,
  },
];

export default function TrainerScreen() {
  const router = useRouter();
  
  // Model hooks for status tracking
  const whisper = useWhisperModels();
  const llama = useLlamaModels();
  const tts = useMeloTTS();

  // Track download progress state for display
  const [downloadStatus, setDownloadStatus] = useState<{
    type: "whisper" | "llama" | "tts" | null;
    progress: number;
    modelName: string;
  } | null>(null);

  // Use refs to track previous values and avoid infinite loops
  const prevDownloadStatusRef = useRef<{ type: string | null; progress: number }>({ type: null, progress: 0 });

  // Extract progress values to avoid object reference issues
  const whisperProgress = Object.values(whisper.downloadProgress)[0] || 0;
  const llamaProgress = Object.values(llama.downloadProgress)[0] || 0;
  const ttsProgress = tts.downloadProgress.models || 0;

  // Monitor download progress from all hooks
  useEffect(() => {
    let newType: "whisper" | "llama" | "tts" | null = null;
    let newProgress = 0;
    let newModelName = "";

    // Check Whisper download
    if (whisper.isDownloading) {
      newType = "whisper";
      newProgress = whisperProgress;
      const modelId = Object.keys(whisper.downloadProgress)[0];
      const model = whisper.getModelById(modelId || "");
      newModelName = model?.label || "Speech Recognition";
    }
    // Check LLM download
    else if (llama.isDownloading) {
      newType = "llama";
      newProgress = llamaProgress;
      const modelId = Object.keys(llama.downloadProgress)[0];
      const model = llama.getModelById(modelId || "");
      newModelName = model?.label || "AI Model";
    }
    // Check TTS download
    else if (tts.isDownloading) {
      newType = "tts";
      newProgress = ttsProgress;
      newModelName = `TTS (${tts.currentModelSource})`;
    }

    // Only update state if something actually changed
    const prev = prevDownloadStatusRef.current;
    const hasChanged = prev.type !== newType || Math.abs(prev.progress - newProgress) > 0.01;

    if (hasChanged) {
      prevDownloadStatusRef.current = { type: newType, progress: newProgress };
      
      if (newType) {
        setDownloadStatus({
          type: newType,
          progress: newProgress,
          modelName: newModelName,
        });
      } else {
        setDownloadStatus(null);
      }
    }
  }, [
    whisper.isDownloading,
    whisperProgress,
    llama.isDownloading,
    llamaProgress,
    tts.isDownloading,
    ttsProgress,
    tts.currentModelSource,
  ]);

  // Check model readiness
  const isWhisperReady = whisper.whisperContext !== null;
  const isLlamaReady = llama.llamaContext !== null;
  const isTTSReady = tts.isReady();
  const allModelsReady = isWhisperReady && isLlamaReady && isTTSReady;

  // Check if models are downloaded (file exists) but not initialized
  // Derive these from the hooks directly to avoid state sync issues
  const whisperModelCount = Object.keys(whisper.modelFiles).length;
  const llamaModelCount = Object.keys(llama.modelFiles).length;
  const ttsBertDownloaded = tts.downloadedSources.bert;
  const ttsDefaultDownloaded = tts.downloadedSources.default;

  const whisperDownloaded = whisperModelCount > 0 || 
    whisper.isModelDownloaded("base") || whisper.isModelDownloaded("tiny");
  const llamaDownloaded = llamaModelCount > 0;
  const ttsDownloaded = ttsBertDownloaded || ttsDefaultDownloaded;

  // Check if any model is initializing (not downloading)
  const isInitializing = 
    (whisper.isInitializingModel && !whisper.isDownloading) ||
    (llama.isInitializingModel && !llama.isDownloading) ||
    (tts.isInitializingModel && !tts.isDownloading);

  // Pre-download models state
  const [isPredownloading, setIsPredownloading] = useState(false);

  // Pre-download all models
  const handlePredownloadModels = async () => {
    if (isPredownloading || downloadStatus) return;
    
    setIsPredownloading(true);
    try {
      // Download TTS first (smallest, fastest)
      if (!ttsDownloaded) {
        await tts.downloadAndExtractModels("bert");
      }
      
      // Download Whisper
      if (!whisperDownloaded) {
        const whisperModel = whisper.getModelById("base");
        if (whisperModel) {
          await whisper.downloadModel(whisperModel);
        }
      }
      
      // Download LLM (largest, slowest)
      if (!llamaDownloaded) {
        await llama.downloadModel("gemma-2b-it");
      }
    } catch (error) {
      console.error("Pre-download failed:", error);
    } finally {
      setIsPredownloading(false);
    }
  };

  // Get status text
  const getStatusText = () => {
    if (downloadStatus) {
      return `Downloading ${downloadStatus.modelName}...`;
    }
    if (isInitializing) {
      return "Initializing models...";
    }
    if (allModelsReady) {
      return "All models ready";
    }
    const downloadedCount = [whisperDownloaded, llamaDownloaded, ttsDownloaded].filter(Boolean).length;
    if (downloadedCount === 3) {
      return "All models downloaded";
    }
    if (downloadedCount > 0) {
      return `${downloadedCount}/3 models downloaded`;
    }
    return "Tap to download models";
  };

  // Get status color
  const getStatusColor = () => {
    if (downloadStatus || isInitializing || isPredownloading) return COLORS.warning;
    if (allModelsReady) return COLORS.success;
    const downloadedCount = [whisperDownloaded, llamaDownloaded, ttsDownloaded].filter(Boolean).length;
    if (downloadedCount === 3) return COLORS.success;
    if (downloadedCount > 0) return COLORS.warning;
    return COLORS.textMuted;
  };

  // Check if all models are downloaded
  const allModelsDownloaded = whisperDownloaded && llamaDownloaded && ttsDownloaded;

  const handleScenarioPress = (scenario: Scenario) => {
    router.push({
      pathname: "/scenario/[id]",
      params: { 
        id: scenario.id,
        title: scenario.title,
        systemPrompt: scenario.systemPrompt,
        initialMessage: scenario.initialMessage,
        situation: scenario.situation,
        userInitiates: scenario.userInitiates ? "true" : "false",
      },
    });
  };

  const difficultyConfig = (difficulty: Difficulty) => DIFFICULTY_CONFIG[difficulty];

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>Practice</Text>
          <View style={styles.statsContainer}>
            <View style={styles.statBadge}>
              <Text style={styles.statNumber}>{SCENARIOS.length}</Text>
              <Text style={styles.statLabel}>Scenarios</Text>
            </View>
          </View>
        </View>
        <Text style={styles.subtitle}>
          Build confidence with real workplace conversations
        </Text>

        {/* Model Status Card */}
        <TouchableOpacity 
          style={styles.statusCard}
          onPress={handlePredownloadModels}
          disabled={allModelsDownloaded || downloadStatus !== null || isPredownloading}
          activeOpacity={0.7}
        >
          <View style={styles.statusHeader}>
            {(downloadStatus || isInitializing || isPredownloading) && (
              <ActivityIndicator 
                size="small" 
                color={getStatusColor()} 
                style={styles.statusSpinner}
              />
            )}
            {!downloadStatus && !isInitializing && !isPredownloading && (
              <View style={[styles.statusDot, { backgroundColor: getStatusColor() }]} />
            )}
            <Text style={[styles.statusText, { color: getStatusColor() }]}>
              {getStatusText()}
            </Text>
            {!allModelsDownloaded && !downloadStatus && !isPredownloading && (
              <Text style={styles.downloadHint}>↓</Text>
            )}
          </View>

          {/* Download Progress Bar */}
          {downloadStatus && (
            <View style={styles.progressContainer}>
              <View style={styles.progressBarBg}>
                <View 
                  style={[
                    styles.progressBarFill, 
                    { width: `${Math.round(downloadStatus.progress * 100)}%` }
                  ]} 
                />
              </View>
              <Text style={styles.progressText}>
                {Math.round(downloadStatus.progress * 100)}%
                {tts.isDownloading && tts.downloadSpeed ? ` · ${tts.downloadSpeed}` : ""}
              </Text>
            </View>
          )}

          {/* Model Status Indicators (when not downloading) */}
          {!downloadStatus && (
            <View style={styles.modelStatusRow}>
              <View style={styles.modelStatusItem}>
                <View style={[
                  styles.modelDot, 
                  { backgroundColor: whisperDownloaded || isWhisperReady ? COLORS.success : COLORS.textLight }
                ]} />
                <Text style={styles.modelLabel}>Speech</Text>
              </View>
              <View style={styles.modelStatusItem}>
                <View style={[
                  styles.modelDot, 
                  { backgroundColor: llamaDownloaded || isLlamaReady ? COLORS.success : COLORS.textLight }
                ]} />
                <Text style={styles.modelLabel}>AI</Text>
              </View>
              <View style={styles.modelStatusItem}>
                <View style={[
                  styles.modelDot, 
                  { backgroundColor: ttsDownloaded || isTTSReady ? COLORS.success : COLORS.textLight }
                ]} />
                <Text style={styles.modelLabel}>Voice</Text>
              </View>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Scenarios List */}
      <ScrollView
        style={styles.scenariosContainer}
        contentContainerStyle={styles.scenariosContent}
        showsVerticalScrollIndicator={false}
      >
        {SCENARIOS.map((scenario, index) => {
          const config = difficultyConfig(scenario.difficulty);
          return (
          <TouchableOpacity
            key={scenario.id}
            style={styles.scenarioCard}
            onPress={() => handleScenarioPress(scenario)}
              activeOpacity={0.7}
          >
              {/* Left accent bar */}
              <View style={[styles.accentBar, { backgroundColor: scenario.accentColor }]} />

              {/* Card content */}
              <View style={styles.cardBody}>
                {/* Top row: Icon + Title + Arrow */}
                <View style={styles.cardTopRow}>
                  <View style={[styles.iconContainer, { backgroundColor: scenario.accentColor + "15" }]}>
                    <Text style={styles.icon}>{scenario.icon}</Text>
              </View>
                  <View style={styles.titleContainer}>
                <Text style={styles.cardTitle}>{scenario.title}</Text>
                    <Text style={styles.cardCategory}>{scenario.category}</Text>
              </View>
                  <View style={styles.arrowContainer}>
                    <Text style={styles.arrow}>›</Text>
              </View>
            </View>

                {/* Description */}
                <Text style={styles.cardDescription} numberOfLines={2}>
                  {scenario.description}
                </Text>

                {/* Bottom row: Badges */}
                <View style={styles.badgeRow}>
                  {/* Difficulty badge */}
                  <View style={[styles.badge, { backgroundColor: config.bgColor }]}>
                    <Text style={[styles.badgeText, { color: config.color }]}>
                      {config.label}
                    </Text>
                  </View>

                  {/* Duration badge */}
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>⏱ {scenario.duration}</Text>
                  </View>

                  {/* Initiator badge */}
                  <View style={[styles.badge, styles.initiatorBadge]}>
                    <Text style={styles.badgeText}>
                      {scenario.userInitiates ? "🎤 You start" : "🔊 They start"}
          </Text>
        </View>
      </View>
              </View>
            </TouchableOpacity>
          );
        })}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>16 scenarios available • Practice daily!</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
    backgroundColor: COLORS.bg,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  title: {
    fontSize: 34,
    fontWeight: "800",
    color: COLORS.primary,
    letterSpacing: -0.5,
  },
  statsContainer: {
    flexDirection: "row",
  },
  statBadge: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
    alignItems: "center",
  },
  statNumber: {
    fontSize: 18,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  statLabel: {
    fontSize: 10,
    fontWeight: "600",
    color: "rgba(255,255,255,0.8)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 15,
    color: COLORS.textMuted,
    lineHeight: 22,
  },
  statusCard: {
    marginTop: 16,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statusHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  statusSpinner: {
    marginRight: 8,
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
    flex: 1,
  },
  downloadHint: {
    fontSize: 16,
    color: COLORS.accent,
    fontWeight: "600",
    marginLeft: 8,
  },
  progressContainer: {
    marginTop: 10,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: COLORS.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: COLORS.accent,
    borderRadius: 3,
  },
  progressText: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 6,
    textAlign: "right",
  },
  modelStatusRow: {
    flexDirection: "row",
    marginTop: 10,
    gap: 16,
  },
  modelStatusItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  modelDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  modelLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontWeight: "500",
  },
  scenariosContainer: {
    flex: 1,
  },
  scenariosContent: {
    paddingHorizontal: 20,
    paddingBottom: 30,
  },
  scenarioCard: {
    flexDirection: "row",
    backgroundColor: COLORS.card,
    borderRadius: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    overflow: "hidden",
  },
  accentBar: {
    width: 4,
  },
  cardBody: {
    flex: 1,
    padding: 16,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    fontSize: 22,
  },
  titleContainer: {
    flex: 1,
    marginLeft: 12,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: COLORS.text,
    marginBottom: 2,
  },
  cardCategory: {
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.textLight,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  arrowContainer: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  arrow: {
    fontSize: 24,
    color: COLORS.textMuted,
    fontWeight: "300",
  },
  cardDescription: {
    fontSize: 14,
    color: COLORS.textMuted,
    lineHeight: 20,
    marginBottom: 12,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  badge: {
    backgroundColor: COLORS.bg,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: COLORS.textMuted,
  },
  initiatorBadge: {
    backgroundColor: COLORS.accentLight,
  },
  footer: {
    alignItems: "center",
    paddingVertical: 20,
  },
  footerText: {
    fontSize: 13,
    color: COLORS.textLight,
    fontWeight: "500",
  },
});
