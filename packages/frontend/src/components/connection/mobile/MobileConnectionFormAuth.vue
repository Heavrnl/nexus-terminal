<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import MobileSshKeySelector from './MobileSshKeySelector.vue';

// 定义 Props
const props = defineProps<{
  formData: {
    type: 'SSH' | 'RDP' | 'VNC';
    username: string;
    auth_method: 'password' | 'key';
    password?: string;
    selected_ssh_key_id: number | null;
    vncPassword?: string;
  };
  isEditMode: boolean;
}>();

const { t } = useI18n();

// 密码明文显示状态切换
const showPassword = ref(false);
const showVncPassword = ref(false);
</script>

<template>
  <div class="space-y-3.5 bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
    <!-- 头部卡片标题 -->
    <div class="flex items-center justify-between pb-2.5 border-b border-border/40">
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center text-xs">
          <i class="fas fa-shield-alt"></i>
        </div>
        <span class="text-sm font-semibold text-foreground tracking-tight">
          {{ t('connections.form.sectionAuth', '认证信息') }}
        </span>
      </div>
      <span class="text-[11px] text-text-secondary/80">
        {{ props.formData.type === 'SSH' ? 'SSH 凭据' : (props.formData.type === 'RDP' ? 'Windows 凭据' : 'VNC 密码') }}
      </span>
    </div>

    <!-- 1. 用户名 (针对手机输入法禁用首字母大写与自动纠错) -->
    <div class="space-y-1.5">
      <label for="m-conn-username" class="block text-xs font-medium text-text-secondary">
        {{ t('connections.form.username', '用户名') }} <span class="text-red-400">*</span>
      </label>
      <div class="relative flex items-center">
        <div class="absolute left-3 text-text-secondary/60 text-xs pointer-events-none">
          <i class="fas fa-user"></i>
        </div>
        <input
          type="text"
          id="m-conn-username"
          v-model="props.formData.username"
          required
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          placeholder="例如：root / ubuntu / administrator"
          class="w-full h-10 pl-9 pr-3 text-xs font-mono bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
        />
      </div>
    </div>

    <!-- 2. SSH 专属认证模式 -->
    <template v-if="props.formData.type === 'SSH'">
      <!-- 认证方式切换 (密码 vs 密钥) -->
      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.authMethod', '认证方式') }}
        </label>
        <div class="grid grid-cols-2 gap-1.5 p-1 bg-header/40 border border-border/60 rounded-xl">
          <button
            type="button"
            @click="props.formData.auth_method = 'password'"
            class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            :class="props.formData.auth_method === 'password'
              ? 'bg-primary text-primary-foreground shadow-xs'
              : 'text-text-secondary hover:text-foreground active:bg-border/30'"
          >
            <i class="fas fa-key text-xs"></i>
            <span>{{ t('connections.form.authMethodPassword', '密码认证') }}</span>
          </button>

          <button
            type="button"
            @click="props.formData.auth_method = 'key'"
            class="h-8.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            :class="props.formData.auth_method === 'key'
              ? 'bg-primary text-primary-foreground shadow-xs'
              : 'text-text-secondary hover:text-foreground active:bg-border/30'"
          >
            <i class="fas fa-id-badge text-xs"></i>
            <span>{{ t('connections.form.authMethodKey', '密钥认证') }}</span>
          </button>
        </div>
      </div>

      <!-- 密码输入框 (带眼睛切换) -->
      <div v-if="props.formData.auth_method === 'password'" class="space-y-1.5">
        <div class="flex items-center justify-between">
          <label for="m-conn-password" class="block text-xs font-medium text-text-secondary">
            {{ t('connections.form.password', 'SSH 密码') }}
            <span v-if="!props.isEditMode" class="text-red-400">*</span>
          </label>
          <span v-if="props.isEditMode" class="text-[11px] text-text-secondary/70">留空保持原密码不变</span>
        </div>
        <div class="relative flex items-center">
          <div class="absolute left-3 text-text-secondary/60 text-xs pointer-events-none">
            <i class="fas fa-lock"></i>
          </div>
          <input
            :type="showPassword ? 'text' : 'password'"
            id="m-conn-password"
            v-model="props.formData.password"
            :required="props.formData.auth_method === 'password' && !props.isEditMode"
            autocomplete="new-password"
            placeholder="输入主机登录密码"
            class="w-full h-10 pl-9 pr-10 text-xs font-mono bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
          />
          <button
            type="button"
            @click="showPassword = !showPassword"
            class="absolute right-2.5 w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-border/30 cursor-pointer"
            :title="showPassword ? '隐藏密码' : '显示密码'"
          >
            <i :class="['fas text-xs', showPassword ? 'fa-eye-slash text-primary' : 'fa-eye']"></i>
          </button>
        </div>
      </div>

      <!-- 密钥选择框 -->
      <div v-if="props.formData.auth_method === 'key'" class="space-y-1.5">
        <label class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.sshKey', 'SSH 密钥') }} <span class="text-red-400">*</span>
        </label>
        <div class="mobile-ssh-key-selector">
          <MobileSshKeySelector v-model="props.formData.selected_ssh_key_id" />
        </div>
      </div>
    </template>

    <!-- 3. RDP 专属认证模式 -->
    <template v-if="props.formData.type === 'RDP'">
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <label for="m-conn-password-rdp" class="block text-xs font-medium text-text-secondary">
            {{ t('connections.form.password', 'Windows 密码') }}
            <span v-if="!props.isEditMode" class="text-red-400">*</span>
          </label>
          <span v-if="props.isEditMode" class="text-[11px] text-text-secondary/70">留空保持原密码不变</span>
        </div>
        <div class="relative flex items-center">
          <div class="absolute left-3 text-text-secondary/60 text-xs pointer-events-none">
            <i class="fas fa-lock"></i>
          </div>
          <input
            :type="showPassword ? 'text' : 'password'"
            id="m-conn-password-rdp"
            v-model="props.formData.password"
            :required="!props.isEditMode"
            autocomplete="new-password"
            placeholder="输入远程桌面登录密码"
            class="w-full h-10 pl-9 pr-10 text-xs font-mono bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
          />
          <button
            type="button"
            @click="showPassword = !showPassword"
            class="absolute right-2.5 w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-border/30 cursor-pointer"
            :title="showPassword ? '隐藏密码' : '显示密码'"
          >
            <i :class="['fas text-xs', showPassword ? 'fa-eye-slash text-primary' : 'fa-eye']"></i>
          </button>
        </div>
      </div>
    </template>

    <!-- 4. VNC 专属认证模式 -->
    <template v-if="props.formData.type === 'VNC'">
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <label for="m-conn-password-vnc" class="block text-xs font-medium text-text-secondary">
            {{ t('connections.form.vncPassword', 'VNC 密码') }}
            <span v-if="!props.isEditMode" class="text-red-400">*</span>
          </label>
          <span v-if="props.isEditMode" class="text-[11px] text-text-secondary/70">留空保持原密码不变</span>
        </div>
        <div class="relative flex items-center">
          <div class="absolute left-3 text-text-secondary/60 text-xs pointer-events-none">
            <i class="fas fa-lock"></i>
          </div>
          <input
            :type="showVncPassword ? 'text' : 'password'"
            id="m-conn-password-vnc"
            v-model="props.formData.vncPassword"
            :required="!props.isEditMode"
            autocomplete="new-password"
            placeholder="输入 VNC 访问密码"
            class="w-full h-10 pl-9 pr-10 text-xs font-mono bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
          />
          <button
            type="button"
            @click="showVncPassword = !showVncPassword"
            class="absolute right-2.5 w-7 h-7 rounded-lg flex items-center justify-center text-text-secondary hover:text-foreground active:bg-border/30 cursor-pointer"
            :title="showVncPassword ? '隐藏密码' : '显示密码'"
          >
            <i :class="['fas text-xs', showVncPassword ? 'fa-eye-slash text-primary' : 'fa-eye']"></i>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
:deep(.mobile-ssh-key-selector select) {
  height: 2.5rem;
  border-radius: 0.75rem;
  background-color: var(--color-header, rgba(0,0,0,0.05));
  font-size: 0.75rem;
}
:deep(.mobile-ssh-key-selector button) {
  height: 2.5rem;
  width: 2.5rem;
  border-radius: 0.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
