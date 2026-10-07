<script setup lang="ts">
import { ref, nextTick, Teleport } from 'vue';
import { useI18n } from 'vue-i18n';
import { PRESET_COLORS, generateRandomColor, hexToRgba } from '../utils/colorUtils';

// Define Props. formData is expected to be a reactive object from the parent composable.
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

// Tooltip state and refs for the host input
const showHostTooltip = ref(false);
const hostTooltipStyle = ref({});
const hostIconRef = ref<HTMLElement | null>(null);
const hostTooltipContentRef = ref<HTMLElement | null>(null);

// 切换背景色开关
const toggleCustomColor = () => {
  props.formData.custom_background_color = !props.formData.custom_background_color;
  if (props.formData.custom_background_color && !props.formData.background_color) {
    props.formData.background_color = generateRandomColor();
  }
};

// 随机生成全新颜色 (全光谱 HSL 算法随机)
const handleRandomColor = () => {
  props.formData.background_color = generateRandomColor();
};

// 选择预设颜色
const selectPresetColor = (color: string) => {
  props.formData.background_color = color;
};

const handleHostIconMouseEnter = async () => {
  showHostTooltip.value = true;
  await nextTick(); // Wait for DOM update so tooltipRect can be calculated

  if (hostIconRef.value && hostTooltipContentRef.value) {
    const iconRect = hostIconRef.value.getBoundingClientRect();
    const tooltipRect = hostTooltipContentRef.value.getBoundingClientRect();

    let top = iconRect.top - tooltipRect.height - 8; // 8px offset above the icon
    let left = iconRect.left + (iconRect.width / 2) - (tooltipRect.width / 2); // Center the tooltip

    // Boundary checks to keep tooltip within viewport
    if (top < 0) { // If not enough space on top, show below
      top = iconRect.bottom + 8;
    }
    if (left < 0) {
      left = 0;
    }
    if (left + tooltipRect.width > window.innerWidth) {
      left = window.innerWidth - tooltipRect.width;
    }

    hostTooltipStyle.value = {
      position: 'fixed', // Ensure positioning is relative to viewport
      top: `${top}px`,
      left: `${left}px`,
    };
  }
};

const handleHostIconMouseLeave = () => {
  showHostTooltip.value = false;
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="showHostTooltip"
      ref="hostTooltipContentRef"
      :style="hostTooltipStyle"
      class="fixed w-max max-w-xs p-2 text-xs text-white bg-gray-800 rounded shadow-lg z-[1000] whitespace-pre-wrap pointer-events-none"
      role="tooltip"
    >
      {{ t('connections.form.hostTooltip', '支持 IP 范围, 例如 192.168.1.10~192.168.1.15 (仅限添加模式)') }}
    </div>
  </Teleport>
  <!-- Basic Info Section -->
  <div class="space-y-4 p-4 border border-border rounded-md bg-header/30">
    <h4 class="text-base font-semibold mb-3 pb-2 border-b border-border/50">{{ t('connections.form.sectionBasic', '基本信息') }}</h4>
    <div>
      <label for="conn-name" class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.name') }} ({{ t('connections.form.optional') }})</label>
      <input type="text" id="conn-name" v-model="props.formData.name"
             class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
    </div>
    <!-- Connection Type -->
    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.connectionType', '连接类型') }}</label>
      <div class="flex rounded-md shadow-sm">
        <button type="button"
                @click="props.formData.type = 'SSH'"
                :class="['flex-1 px-3 py-2 border border-border text-sm font-medium focus:outline-none',
                         props.formData.type === 'SSH' ? 'bg-primary text-white' : 'bg-background text-foreground hover:bg-border',
                         'rounded-l-md']">
          {{ t('connections.form.typeSsh', 'SSH') }}
        </button>
        <button type="button"
                @click="props.formData.type = 'RDP'"
                :class="['flex-1 px-3 py-2 border-t border-b border-r border-border text-sm font-medium focus:outline-none -ml-px',
                         props.formData.type === 'RDP' ? 'bg-primary text-white' : 'bg-background text-foreground hover:bg-border']">
          {{ t('connections.form.typeRdp', 'RDP') }}
        </button>
        <button type="button"
                @click="props.formData.type = 'VNC'"
                :class="['flex-1 px-3 py-2 border border-border text-sm font-medium focus:outline-none -ml-px',
                         props.formData.type === 'VNC' ? 'bg-primary text-white' : 'bg-background text-foreground hover:bg-border',
                         'rounded-r-md']">
          {{ t('connections.form.typeVnc', 'VNC') }}
        </button>
      </div>
    </div>
    <!-- Host and Port Row -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="md:col-span-2">
        <label for="conn-host" class="block text-sm font-medium text-text-secondary mb-1">
          {{ t('connections.form.host') }}
          <span class="relative ml-1" @mouseenter="handleHostIconMouseEnter" @mouseleave="handleHostIconMouseLeave">
            <i ref="hostIconRef" class="fas fa-exclamation-circle text-text-secondary cursor-help"></i>
          </span>
        </label>
        <input type="text" id="conn-host" v-model="props.formData.host" required
               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
      </div>
      <div>
        <label for="conn-port" class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.port') }}</label>
        <input type="number" id="conn-port" v-model.number="props.formData.port" required min="1" max="65535"
               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
      </div>
    </div>

    <!-- Custom Background Color Section -->
    <div class="pt-3 border-t border-border/40">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <i class="fas fa-palette text-text-secondary text-sm"></i>
          <div>
            <span class="text-sm font-medium text-foreground">{{ t('connections.form.customBackgroundColor', '卡片背景颜色') }}</span>
            <p class="text-xs text-text-secondary">{{ t('connections.form.customBackgroundColorTip', '在连接面板中以醒目的半透明卡片样式展示') }}</p>
          </div>
        </div>
        <!-- Toggle Switch -->
        <button
          type="button"
          role="switch"
          :aria-checked="props.formData.custom_background_color"
          @click="toggleCustomColor"
          class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
          :class="props.formData.custom_background_color ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-700'"
        >
          <span
            class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out"
            :class="props.formData.custom_background_color ? 'translate-x-5' : 'translate-x-0'"
          />
        </button>
      </div>

      <!-- Expanded Color Configuration Area -->
      <div v-if="props.formData.custom_background_color" class="mt-3.5 space-y-3 p-3 bg-background/70 border border-border/60 rounded-lg">
        <div class="flex items-center justify-between">
          <label class="text-xs font-semibold text-text-secondary">{{ t('connections.form.selectColor', '选择颜色') }}</label>
          <button
            type="button"
            @click="handleRandomColor"
            class="px-2.5 py-1 text-xs font-medium rounded-md bg-header hover:bg-border/60 text-foreground border border-border/70 flex items-center gap-1.5 transition-all active:scale-95 shadow-xs"
            :title="t('connections.form.randomColorTip', '随机抽取一个颜色')"
          >
            <i class="fas fa-dice text-primary"></i>
            <span>{{ t('connections.form.randomColor', '随机颜色') }}</span>
          </button>
        </div>

        <!-- Preset Color Swatches -->
        <div class="flex items-center flex-wrap gap-2 pt-1">
          <button
            v-for="color in PRESET_COLORS"
            :key="color"
            type="button"
            @click="selectPresetColor(color)"
            class="w-7 h-7 rounded-full flex items-center justify-center transition-transform hover:scale-110 focus:outline-none relative shadow-xs"
            :style="{ backgroundColor: color }"
            :class="props.formData.background_color?.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-110' : ''"
            :title="color"
          >
            <i
              v-if="props.formData.background_color?.toLowerCase() === color.toLowerCase()"
              class="fas fa-check text-xs text-white drop-shadow-md"
            ></i>
          </button>
        </div>

        <!-- Custom Color Picker & Hex Input -->
        <div class="flex items-center gap-2 pt-1">
          <div class="relative flex items-center">
            <input
              type="color"
              id="conn-color-native"
              v-model="props.formData.background_color"
              class="w-8 h-8 rounded-lg cursor-pointer border border-border/70 bg-transparent p-0.5"
            />
          </div>
          <div class="flex-grow">
            <input
              type="text"
              v-model="props.formData.background_color"
              placeholder="#3b82f6"
              class="w-full px-2.5 py-1 text-xs font-mono border border-border rounded-md bg-background text-foreground uppercase focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>
        </div>

        <!-- Live Effect Preview -->
        <div class="pt-2 border-t border-border/40">
          <div class="text-[11px] font-medium text-text-secondary mb-1.5 flex items-center justify-between">
            <span>{{ t('connections.form.previewEffect', '卡片视觉预览') }}</span>
            <span class="text-[10px] text-text-secondary/70">{{ t('connections.form.previewHint', '半透明常态 / 悬浮加深') }}</span>
          </div>
          <div
            class="group py-2 px-3 rounded-md flex items-center border transition-all duration-200 cursor-default"
            :style="{
              backgroundColor: hexToRgba(props.formData.background_color || '#3b82f6', 0.14),
              borderColor: hexToRgba(props.formData.background_color || '#3b82f6', 0.3)
            }"
          >
            <i
              :class="['fas', props.formData.type === 'RDP' ? 'fa-desktop' : (props.formData.type === 'VNC' ? 'fa-plug' : 'fa-server'), 'mr-2.5 w-4 text-center']"
              :style="{ color: props.formData.background_color || '#3b82f6' }"
            ></i>
            <span class="font-medium text-sm text-foreground flex-grow truncate">
              {{ props.formData.name || props.formData.host || t('connections.form.previewDefaultName', '示例服务器连接') }}
            </span>
            <span
              class="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded font-semibold"
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