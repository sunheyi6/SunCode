<script setup lang="ts">
import { useAgent } from '../../composables/useAgent';
import ChatHeader from './ChatHeader.vue';
import MessageList from './MessageList.vue';
import ChatInput from './ChatInput.vue';
import PendingPromptQueue from './PendingPromptQueue.vue';

const { send, interruptAndSend, isStreaming } = useAgent();

function handleSend(text: string): void {
  send(text);
}
</script>

<template>
  <div class="chat-panel">
    <!-- Header: conversation title, folder, git branch -->
    <ChatHeader />

    <!-- Message list -->
    <MessageList />

    <!-- Input area -->
    <PendingPromptQueue @send-now="interruptAndSend" />
    <ChatInput
      @send="handleSend"
      :is-streaming="isStreaming"
    />
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
</style>
