<template>
  <button
    type="button"
    role="switch"
    :id="id"
    :aria-checked="modelValue"
    :aria-label="ariaLabel"
    :disabled="disabled || loading"
    @click="handleClick"
    :class="[
      'group relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background select-none',
      size === 'sm' ? 'h-5 w-9' : 'h-6 w-11',
      modelValue
        ? 'bg-primary'
        : 'bg-muted-foreground/25 dark:bg-neutral-700/80 hover:bg-muted-foreground/35 dark:hover:bg-neutral-600/80',
      (disabled || loading) ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
    ]"
  >
    <span
      aria-hidden="true"
      :class="[
        'pointer-events-none inline-flex items-center justify-center rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out',
        size === 'sm' ? 'h-4 w-4' : 'h-5 w-5',
        modelValue
          ? (size === 'sm' ? 'translate-x-4' : 'translate-x-5')
          : 'translate-x-0'
      ]"
    >
      <!-- Loading Spinner -->
      <svg
        v-if="loading"
        class="animate-spin text-primary"
        :class="size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </span>
  </button>
</template>

<script setup lang="ts">
interface Props {
  modelValue: boolean;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  disabled: false,
  loading: false,
  size: 'md',
  id: undefined,
  ariaLabel: undefined,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'change', value: boolean): void;
}>();

const handleClick = () => {
  if (props.disabled || props.loading) return;
  const newValue = !props.modelValue;
  emit('update:modelValue', newValue);
  emit('change', newValue);
};
</script>
