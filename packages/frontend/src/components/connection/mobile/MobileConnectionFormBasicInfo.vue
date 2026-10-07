<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { PRESET_COLORS, generateRandomColor, hexToRgba } from '../../../utils/colorUtils';

// 定义表单数据 Props
const props = defineProps<{
  formData: {
    name: string;
    type: 'SSH' | 'RDP' | 'VNC';
    host: string;
    port: number;
    custom_background_color?: boolean;
    background_color?: string;
  };
}>();

const { t } = useI18n();

// 提示信息展开状态
const showHostTip = ref(false);

// 切换连接协议
const setConnectionType = (type: 'SSH' | 'RDP' | 'VNC') => {
  const oldType = props.formData.type;
  props.formData.type = type;

  // 如果端口仍为默认端口，切换时自动更正为该协议的标准端口
  if (oldType === 'SSH' && props.formData.port === 22) {
    if (type === 'RDP') props.formData.port = 3389;
    else if (type === 'VNC') props.formData.port = 5900;
  } else if (oldType === 'RDP' && props.formData.port === 3389) {
    if (type === 'SSH') props.formData.port = 22;
    else if (type === 'VNC') props.formData.port = 5900;
  } else if (oldType === 'VNC' && props.formData.port === 5900) {
    if (type === 'SSH') props.formData.port = 22;
    else if (type === 'RDP') props.formData.port = 3389;
  }
};

// 切换背景色自定义开关
const toggleCustomColor = () => {
  props.formData.custom_background_color = !props.formData.custom_background_color;
  if (props.formData.custom_background_color && !props.formData.background_color) {
    props.formData.background_color = generateRandomColor();
  }
};

// 随机生成全新颜色
const handleRandomColor = () => {
  props.formData.background_color = generateRandomColor();
};

// 选择预设颜色
const selectPresetColor = (color: string) => {
  props.formData.background_color = color;
};
</script>

<template>
  <div class="space-y-3.5 bg-background border border-border/60 rounded-2xl p-4 shadow-2xs">
    <!-- 头部卡片标题 -->
    <div class="flex items-center justify-between pb-2.5 border-b border-border/40">
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-xs">
          <i class="fas fa-server"></i>
        </div>
        <span class="text-sm font-semibold text-foreground tracking-tight">
          {{ t('connections.form.sectionBasic', '基本信息') }}
        </span>
      </div>
      <span class="text-[11px] text-text-secondary/80 font-mono">必填项已标注 *</span>
    </div>

    <!-- 1. 连接类型协议切换 (大触控分段控制器) -->
    <div class="space-y-1.5">
      <label class="block text-xs font-medium text-text-secondary">
        {{ t('connections.form.connectionType', '协议类型') }}
      </label>
      <div class="grid grid-cols-3 gap-1.5 p-1 bg-header/40 border border-border/60 rounded-xl">
        <button
          type="button"
          @click="setConnectionType('SSH')"
          class="h-9 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
          :class="props.formData.type === 'SSH'
            ? 'bg-primary text-primary-foreground shadow-xs'
            : 'text-text-secondary hover:text-foreground active:bg-border/30'"
        >
          <i class="fas fa-terminal text-xs"></i>
          <span>SSH</span>
        </button>

        <button
          type="button"
          @click="setConnectionType('RDP')"
          class="h-9 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
          :class="props.formData.type === 'RDP'
            ? 'bg-primary text-primary-foreground shadow-xs'
            : 'text-text-secondary hover:text-foreground active:bg-border/30'"
        >
          <i class="fas fa-desktop text-xs"></i>
          <span>RDP</span>
        </button>

        <button
          type="button"
          @click="setConnectionType('VNC')"
          class="h-9 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
          :class="props.formData.type === 'VNC'
            ? 'bg-primary text-primary-foreground shadow-xs'
            : 'text-text-secondary hover:text-foreground active:bg-border/30'"
        >
          <i class="fas fa-plug text-xs"></i>
          <span>VNC</span>
        </button>
      </div>
    </div>

    <!-- 2. 连接名称 -->
    <div class="space-y-1.5">
      <div class="flex items-center justify-between">
        <label for="m-conn-name" class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.name', '连接名称') }}
        </label>
        <span class="text-[11px] text-text-secondary/70">可选</span>
      </div>
      <input
        type="text"
        id="m-conn-name"
        v-model="props.formData.name"
        placeholder="例如：生产服务器 / 我的测试节点"
        class="w-full h-10 px-3 text-xs bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
      />
    </div>

    <!-- 3. 主机与端口 (单行双栏或移动端优化排布) -->
    <div class="grid grid-cols-12 gap-2.5">
      <!-- 主机 -->
      <div class="col-span-8 space-y-1.5">
        <div class="flex items-center justify-between">
          <label for="m-conn-host" class="block text-xs font-medium text-text-secondary">
            {{ t('connections.form.host', '主机地址') }} <span class="text-red-400">*</span>
          </label>
          <button
            type="button"
            @click="showHostTip = !showHostTip"
            class="text-[11px] text-primary flex items-center gap-1 cursor-pointer"
          >
            <i class="fas fa-info-circle text-[10px]"></i>
            <span>{{ showHostTip ? '收起说明' : 'IP范围' }}</span>
          </button>
        </div>
        <input
          type="text"
          id="m-conn-host"
          v-model="props.formData.host"
          required
          placeholder="192.168.1.100 或 域名"
          class="w-full h-10 px-3 text-xs font-mono bg-header/20 border border-border/60 rounded-xl text-foreground placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
        />
      </div>

      <!-- 端口 -->
      <div class="col-span-4 space-y-1.5">
        <label for="m-conn-port" class="block text-xs font-medium text-text-secondary">
          {{ t('connections.form.port', '端口') }} <span class="text-red-400">*</span>
        </label>
        <input
          type="number"
          id="m-conn-port"
          v-model.number="props.formData.port"
          required
          min="1"
          max="65535"
          inputmode="numeric"
          class="w-full h-10 px-3 text-xs font-mono bg-header/20 border border-border/60 rounded-xl text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors text-center"
        />
      </div>
    </div>

    <!-- 主机 IP 范围提示展开面板 -->
    <div
      v-if="showHostTip"
      class="p-2.5 bg-primary/5 border border-primary/20 rounded-xl text-[11px] text-text-secondary leading-relaxed space-y-1"
    >
      <div class="font-medium text-primary flex items-center gap-1.5">
        <i class="fas fa-lightbulb text-xs"></i>
        <span>批量生成技巧：</span>
      </div>
      <div>支持在主机填入 IP 范围批量添加，例如：</div>
      <div class="font-mono text-foreground font-medium bg-header/60 px-2 py-1 rounded-md">
        192.168.1.10~192.168.1.20
      </div>
    </div>

    <!-- 4. 自定义卡片背景色定制 -->
    <div class="pt-3 border-t border-border/40 space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <i class="fas fa-palette text-text-secondary text-xs"></i>
          <div>
            <div class="text-xs font-medium text-foreground">
              {{ t('connections.form.customBackgroundColor', '卡片个性化色彩') }}
            </div>
            <div class="text-[11px] text-text-secondary/70">
              在列表与终端面板展示半透明专属主题色
            </div>
          </div>
        </div>

        <!-- 开关 -->
        <button
          type="button"
          role="switch"
          :aria-checked="props.formData.custom_background_color"
          @click="toggleCustomColor"
          class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
          :class="props.formData.custom_background_color ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-700'"
        >
          <span
            class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out"
            :class="props.formData.custom_background_color ? 'translate-x-5' : 'translate-x-0'"
          />
        </button>
      </div>

      <!-- 展开的颜色选择面板 -->
      <div
        v-if="props.formData.custom_background_color"
        class="space-y-3 p-3 bg-header/30 border border-border/60 rounded-xl"
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-text-secondary">选择调色板</span>
          <button
            type="button"
            @click="handleRandomColor"
            class="h-7 px-2.5 rounded-lg text-xs font-medium bg-header border border-border/70 text-foreground flex items-center gap-1.5 active:scale-95 transition-all cursor-pointer"
          >
            <i class="fas fa-dice text-primary text-xs"></i>
            <span>随机色彩</span>
          </button>
        </div>

        <!-- 预设色彩圆球栅格 (专为移动端手指设计的大触控区) -->
        <div class="grid grid-cols-6 gap-2 pt-1">
          <button
            v-for="color in PRESET_COLORS"
            :key="color"
            type="button"
            @click="selectPresetColor(color)"
            class="w-8 h-8 rounded-full flex items-center justify-center transition-all mx-auto relative shadow-2xs cursor-pointer active:scale-90"
            :style="{ backgroundColor: color }"
            :class="props.formData.background_color?.toLowerCase() === color.toLowerCase()
              ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105'
              : 'hover:scale-105'"
          >
            <i
              v-if="props.formData.background_color?.toLowerCase() === color.toLowerCase()"
              class="fas fa-check text-[10px] text-white drop-shadow-md"
            ></i>
          </button>
        </div>

        <!-- 自定义拾色器与 HEX 代码输入框 -->
        <div class="flex items-center gap-2 pt-1">
          <div class="relative w-8 h-8 rounded-lg overflow-hidden border border-border/70 shrink-0">
            <input
              type="color"
              v-model="props.formData.background_color"
              class="absolute -inset-2 w-12 h-12 cursor-pointer border-none p-0"
            />
          </div>
          <input
            type="text"
            v-model="props.formData.background_color"
            placeholder="#3b82f6"
            class="flex-grow h-8 px-3 text-xs font-mono uppercase bg-background border border-border/60 rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <!-- 实时卡片效果预览 -->
        <div class="pt-2 border-t border-border/40 space-y-1.5">
          <div class="text-[11px] text-text-secondary/80 flex items-center justify-between">
            <span>实时卡片视觉预览</span>
            <span class="font-mono text-[10px]">{{ props.formData.background_color }}</span>
          </div>

          <div
            class="py-2.5 px-3 rounded-xl flex items-center border transition-all duration-200"
            :style="{
              backgroundColor: hexToRgba(props.formData.background_color || '#3b82f6', 0.14),
              borderColor: hexToRgba(props.formData.background_color || '#3b82f6', 0.3)
            }"
          >
            <i
              :class="['fas', props.formData.type === 'RDP' ? 'fa-desktop' : (props.formData.type === 'VNC' ? 'fa-plug' : 'fa-server'), 'mr-2.5 w-4 text-center text-sm']"
              :style="{ color: props.formData.background_color || '#3b82f6' }"
            ></i>
            <span class="font-semibold text-xs text-foreground flex-grow truncate">
              {{ props.formData.name || props.formData.host || '示例服务器节点' }}
            </span>
            <span
              class="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded-md font-bold tracking-wider"
              :style="{
                backgroundColor: hexToRgba(props.formData.background_color || '#3b82f6', 0.2),
                color: props.formData.background_color || '#3b82f6'
              }"
            >
              {{ props.formData.type }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
