<script setup lang="ts">
import { computed, ref, watch, nextTick, type PropType } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TerminalContextMenuSettings } from '../stores/settings.store';

export type TerminalMenuAction = 'copy' | 'paste' | 'openPath' | 'openFile' | 'saveQuickCommand';

interface ContextMenuItem {
  key: TerminalMenuAction;
  label: string;
  icon: string;
  shortcut?: string;
  requiresSelection?: boolean;
}

const props = defineProps({
  visible: {
    type: Boolean,
    required: true,
  },
  x: {
    type: Number,
    required: true,
  },
  y: {
    type: Number,
    required: true,
  },
  selectedText: {
    type: String,
    default: '',
  },
  menuConfig: {
    type: Object as PropType<TerminalContextMenuSettings>,
    default: () => ({
      copy: true,
      paste: true,
      openPath: true,
      openFile: true,
      saveQuickCommand: true,
    }),
  },
});

const emit = defineEmits<{
  (e: 'select', action: TerminalMenuAction): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();
const menuRef = ref<HTMLElement | null>(null);

const adjustedPosition = ref({ x: 0, y: 0 });

const allMenuItems: ContextMenuItem[] = [
  {
    key: 'copy',
    label: 'terminal.contextMenu.copy',
    icon: 'fas fa-copy',
    shortcut: 'Ctrl+Shift+C',
    requiresSelection: true,
  },
  {
    key: 'paste',
    label: 'terminal.contextMenu.paste',
    icon: 'fas fa-paste',
    shortcut: 'Ctrl+Shift+V',
    requiresSelection: false,
  },
  {
    key: 'openPath',
    label: 'terminal.contextMenu.openPath',
    icon: 'fas fa-folder-open',
    requiresSelection: true,
  },
  {
    key: 'openFile',
    label: 'terminal.contextMenu.openFile',
    icon: 'fas fa-file-code',
    requiresSelection: true,
  },
  {
    key: 'saveQuickCommand',
    label: 'terminal.contextMenu.saveQuickCommand',
    icon: 'fas fa-bolt',
    requiresSelection: true,
  },
];

// 根据用户在设置中自定义的菜单项和当前是否选中文本进行筛选
const visibleItems = computed(() => {
  return allMenuItems.filter((item) => {
    // 检查配置是否开启
    if (props.menuConfig && props.menuConfig[item.key] === false) {
      return false;
    }
    return true;
  });
});

// 计算位置防溢出
const updatePosition = () => {
  let targetX = props.x;
  let targetY = props.y;

  if (menuRef.value) {
    const rect = menuRef.value.getBoundingClientRect();
    const menuWidth = rect.width || 210;
    const menuHeight = rect.height || 180;
    const padding = 10;

    // 水平防溢出
    if (targetX + menuWidth > window.innerWidth - padding) {
      targetX = Math.max(padding, window.innerWidth - menuWidth - padding);
    }

    // 垂直防溢出
    if (targetY + menuHeight > window.innerHeight - padding) {
      targetY = Math.max(padding, window.innerHeight - menuHeight - padding);
    }
  }

  adjustedPosition.value = {
    x: Math.max(8, targetX),
    y: Math.max(8, targetY),
  };
};

watch(
  () => [props.visible, props.x, props.y],
  async ([newVisible]) => {
    if (newVisible) {
      adjustedPosition.value = { x: props.x, y: props.y };
      await nextTick();
      updatePosition();
    }
  },
  { immediate: true }
);

const handleItemClick = (item: ContextMenuItem) => {
  emit('select', item.key);
  emit('close');
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    emit('close');
  }
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && visibleItems.length > 0"
      class="fixed inset-0 z-50 select-none"
      @click="emit('close')"
      @contextmenu.prevent="emit('close')"
      @keydown="handleKeyDown"
      tabindex="-1"
    >
      <div
        ref="menuRef"
        class="fixed min-w-[210px] max-w-[300px] bg-background/95 backdrop-blur-md border border-border/80 shadow-2xl rounded-xl py-1.5 z-50 text-foreground transition-opacity duration-150 animate-in fade-in zoom-in-95 duration-100"
        :style="{
          left: `${adjustedPosition.x}px`,
          top: `${adjustedPosition.y}px`,
        }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <!-- 选中文本简要预览提示（若有） -->
        <div
          v-if="selectedText && selectedText.trim()"
          class="px-3.5 py-1.5 mb-1 border-b border-border/40 text-[11px] text-text-secondary truncate flex items-center gap-1.5 font-mono"
        >
          <i class="fas fa-quote-left text-[10px] opacity-60 shrink-0"></i>
          <span class="truncate">{{ selectedText.trim() }}</span>
        </div>

        <ul class="list-none p-0 m-0 space-y-0.5">
          <li
            v-for="item in visibleItems"
            :key="item.key"
            @click="handleItemClick(item)"
            class="group px-3 py-1.5 mx-1 flex items-center justify-between text-xs sm:text-[13px] rounded-lg cursor-pointer transition-colors duration-150 text-foreground hover:bg-primary/10 hover:text-primary active:bg-primary/20"
          >
            <div class="flex items-center gap-2.5 truncate">
              <span class="w-4 text-center shrink-0 text-text-secondary group-hover:text-primary transition-colors">
                <i :class="item.icon" class="text-xs"></i>
              </span>
              <span class="font-medium truncate">
                {{ t(item.label) }}
              </span>
            </div>

            <span
              v-if="item.shortcut"
              class="text-[10px] text-text-secondary/80 font-mono tracking-tight shrink-0 ml-3 px-1.5 py-0.5 rounded bg-muted/40 border border-border/40"
            >
              {{ item.shortcut }}
            </span>
          </li>
        </ul>
      </div>
    </div>
  </Teleport>
</template>
