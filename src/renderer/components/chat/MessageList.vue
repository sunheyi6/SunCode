<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { useChatStore } from '../../stores/chat';
import UserMessage from './UserMessage.vue';
import AssistantMessage from './AssistantMessage.vue';

const chatStore = useChatStore();
const messageListRef = ref<HTMLElement | null>(null);

watch(
  () => chatStore.messages.length,
  async () => {
    await nextTick();
    if (messageListRef.value) {
      messageListRef.value.scrollTop = messageListRef.value.scrollHeight;
    }
  },
);

watch(
  () => {
    const lastMsg = chatStore.messages[chatStore.messages.length - 1];
    return lastMsg?.content;
  },
  async () => {
    await nextTick();
    if (messageListRef.value) {
      const el = messageListRef.value;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  },
);
</script>

<template>
  <div class="message-list" ref="messageListRef">
    <!-- 欢迎界面 -->
    <div v-if="chatStore.messages.length === 0" class="welcome">
      <div class="welcome-icon">☀️</div>
      <h2>欢迎使用 SunCode</h2>
      <p>你的 AI 智能编程助手。可以问我任何关于代码的问题。</p>
      <div class="welcome-hints">
        <p>试试这样问：</p>
        <ul>
          <li>"解释一下这个项目的认证系统是怎么工作的"</li>
          <li>"修复登录模块中的 bug"</li>
          <li>"给 UserService 类添加单元测试"</li>
          <li>"重构这个函数，让它更易读"</li>
        </ul>
      </div>
    </div>

    <!-- 消息列表 -->
    <template v-for="msg in chatStore.messages" :key="msg.id">
      <UserMessage v-if="msg.role === 'user'" :message="msg" />
      <AssistantMessage v-else-if="msg.role === 'assistant'" :message="msg" />
    </template>
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md) 0;
}

.welcome {
  text-align: center;
  padding: 60px 40px;
  color: var(--color-text-secondary);
}

.welcome-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.welcome h2 {
  font-size: 24px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 8px;
}

.welcome p {
  font-size: 15px;
  margin-bottom: 24px;
}

.welcome-hints {
  text-align: left;
  max-width: 500px;
  margin: 0 auto;
  background: var(--color-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  padding: var(--spacing-lg);
}

.welcome-hints p {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--color-text);
}

.welcome-hints ul {
  padding-left: 20px;
}

.welcome-hints li {
  margin: 4px 0;
  font-size: 13px;
  color: var(--color-text-secondary);
}
</style>
