import { Tabs } from 'expo-router';
import React from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';

// App color palette - consistent with voice assistant
const COLORS = {
  primary: "#1E3A5F",
  accent: "#FF6B6B",
  bg: "#F8FAFC",
  textMuted: "#64748B",
};

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: COLORS.accent,
        tabBarInactiveTintColor: COLORS.textMuted,
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopColor: '#E2E8F0',
          borderTopWidth: 1,
          paddingTop: 8,
          paddingBottom: 8,
          height: 65,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
        },
        headerShown: false,
        tabBarButton: HapticTab,
      }}>
      {/* Tab 1: Trainer */}
      <Tabs.Screen
        name="trainer"
        options={{
          title: 'Practice',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="person.crop.circle.badge.checkmark" color={color} />,
        }}
      />
      {/* Tab 2: Voice Assistant */}
      <Tabs.Screen
        name="voice"
        options={{
          title: 'Assistant',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="waveform.circle.fill" color={color} />,
        }}
      />
      {/* Hidden tabs */}
      <Tabs.Screen
        name="index"
        options={{
          href: null, // Hide from tab bar
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          href: null, // Hide from tab bar
        }}
      />
      <Tabs.Screen
        name="tts"
        options={{
          href: null, // Hide from tab bar
        }}
      />
    </Tabs>
  );
}
