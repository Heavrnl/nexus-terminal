<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'; // computed 不再直接使用，移除
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
// Removed Passkey import: import { startAuthentication } from '@simplewebauthn/browser';
import { useAuthStore } from '../stores/auth.store';
import VueHcaptcha from '@hcaptcha/vue3-hcaptcha';
import VueRecaptcha from 'vue3-recaptcha2'; // 使用默认导入

const { t } = useI18n();
const authStore = useAuthStore();
// 获取 loginRequires2FA 状态
const { isLoading, error, loginRequires2FA, publicCaptchaConfig } = storeToRefs(authStore); // Get publicCaptchaConfig

// 表单数据
const credentials = reactive({
  username: '',
  password: '',
});
const twoFactorToken = ref(''); // 用于存储 2FA 验证码
const rememberMe = ref(false); // 新增：记住我状态，默认为 false
const enableAutoLoginForIp = ref(false); // 新增：为此IP启用自动登录，默认为 false
const captchaToken = ref<string | null>(null); // NEW: Store CAPTCHA token
const captchaError = ref<string | null>(null); // NEW: Store CAPTCHA specific error
const hcaptchaWidget = ref<InstanceType<typeof VueHcaptcha> | null>(null); // NEW: Ref for hCaptcha component instance
const recaptchaWidget = ref<InstanceType<typeof VueRecaptcha> | null>(null); // 更新 Ref 类型以匹配新导入

// --- reCAPTCHA v3 Initialization ---
// const recaptchaInstance = useReCaptcha(); // 移除 v3 实例，因为我们将使用 v2 组件


// --- CAPTCHA Event Handlers ---
const handleCaptchaVerified = (token: string) => {
  // console.log('CAPTCHA verified, token:', token);
  captchaToken.value = token;
  captchaError.value = null; // Clear error on successful verification
};
const handleCaptchaExpired = () => {
  // console.log('CAPTCHA expired');
  captchaToken.value = null;
};
const handleCaptchaError = (errorDetails: any) => {
  console.error('CAPTCHA error:', errorDetails);
  captchaToken.value = null;
  captchaError.value = t('login.error.captchaLoadFailed');
};
const resetCaptchaWidget = () => {
  // console.log('Resetting CAPTCHA widget...');
  captchaToken.value = null;
  // Reset hCaptcha if it exists
  hcaptchaWidget.value?.reset();
  // Reset reCAPTCHA v2 if it exists
  recaptchaWidget.value?.reset();
};
// --- End CAPTCHA Event Handlers ---


// 处理登录或 2FA 验证提交
const handleSubmit = async () => {
  captchaError.value = null; // Clear previous CAPTCHA error

  // --- CAPTCHA Execution & Check ---
  // --- CAPTCHA Check (v2/hCaptcha) ---
  if (publicCaptchaConfig.value?.enabled && !loginRequires2FA.value) {
    // Check if token exists (obtained via component event for v2/hCaptcha)
    if (!captchaToken.value) {
      captchaError.value = t('login.error.captchaRequired');
      return; // Stop submission if CAPTCHA is required but not completed
    }
  }
  // --- End CAPTCHA Check ---
  // --- End CAPTCHA Check ---

  try {
    if (loginRequires2FA.value) {
      // 如果需要 2FA，则调用 2FA 验证 action
      await authStore.verifyLogin2FA(twoFactorToken.value);
    } else {
      // 否则，调用常规登录 action，并传递 rememberMe 和 captchaToken 状态
      await authStore.login({
          ...credentials,
          rememberMe: rememberMe.value,
          enableAutoLoginForIp: enableAutoLoginForIp.value, // 新增参数
          captchaToken: captchaToken.value ?? undefined // Pass token or undefined if null
      });
    }
    // 成功后的重定向由 store action 处理
    // 失败会更新 error 状态并在模板中显示
  } finally {
     // Reset CAPTCHA after attempt (success or failure handled by store redirect/error display)
     if (publicCaptchaConfig.value?.enabled) {
       resetCaptchaWidget(); // Reset the widget for potential retry
     }
  } // <-- Correctly closing the try block here
};

// Fetch CAPTCHA config on component mount
onMounted(() => {
  console.log('[LoginView] Component mounted, calling fetchCaptchaConfig...'); // 添加日志
  authStore.fetchCaptchaConfig();
});

// --- Passkey Login Handler Removed ---

</script>
<template>
  <!-- Page Container -->
  <div class="flex items-center justify-center min-h-screen bg-background p-4">
    <!-- Login Card -->
    <div class="flex w-full max-w-4xl rounded-xl shadow-2xl overflow-hidden bg-background border border-border/20">
      <!-- Left Panel (Brand) - Hidden on small screens -->
      <div class="hidden md:flex w-2/5 bg-gradient-to-br from-primary to-primary-dark flex-col items-center justify-center p-10 text-white relative">
         <!-- Subtle pattern or overlay could go here -->
         <div class="z-10 text-center">
           <img src="../assets/logo.png" alt="Project Logo" class="h-20 w-auto mb-5 mx-auto">
           <h1 class="text-3xl font-bold mb-2">{{ t('projectName') }}</h1>
           <p class="text-base opacity-80">{{ t('slogan') }}</p> <!-- Example Slogan -->
         </div>
      </div>

      <!-- Right Panel (Login Form) -->
      <div class="w-full md:w-3/5 flex flex-col justify-center p-8 sm:p-12">
        <!-- Mobile Logo (optional) -->
         <div class="flex justify-center mb-6 md:hidden">
           <img src="../assets/logo.png" alt="Project Logo" class="h-16 w-auto">
         </div>
        <h2 class="text-2xl font-semibold mb-6 text-center text-foreground">{{ t('login.title') }}</h2>

        <form @submit.prevent="handleSubmit" class="space-y-5"> <!-- Reduced space slightly -->
          <!-- Regular Login Fields -->
          <div v-if="!loginRequires2FA" class="space-y-6">
            <div>
              <label for="username" class="block text-sm font-medium text-text-secondary mb-1">{{ t('login.username') }}</label>
              <input type="text" id="username" v-model="credentials.username" required :disabled="isLoading"
                     class="w-full px-4 py-3 border border-border/50 rounded-lg bg-input text-foreground text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out disabled:bg-gray-100 disabled:cursor-not-allowed" />
            </div>
            <div>
              <label for="password" class="block text-sm font-medium text-text-secondary mb-1">{{ t('login.password') }}</label>
              <input type="password" id="password" v-model="credentials.password" required :disabled="isLoading"
                     class="w-full px-4 py-3 border border-border/50 rounded-lg bg-input text-foreground text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out disabled:bg-gray-100 disabled:cursor-not-allowed" />
            </div>
            <!-- Remember Me Checkbox -->
            <div class="flex items-center">
              <input type="checkbox" id="rememberMe" v-model="rememberMe" :disabled="isLoading"
                     class="w-4 h-4 mr-2 accent-primary rounded border-gray-300 focus:ring-primary disabled:cursor-not-allowed" />
              <label for="rememberMe" class="text-sm text-text-secondary cursor-pointer">{{ t('login.rememberMe', '记住我') }}</label>
            </div>
            <!-- Enable Auto Login For IP Checkbox -->
            <div class="flex items-center">
              <input type="checkbox" id="enableAutoLoginForIp" v-model="enableAutoLoginForIp" :disabled="isLoading"
                     class="w-4 h-4 mr-2 accent-primary rounded border-gray-300 focus:ring-primary disabled:cursor-not-allowed" />
              <label for="enableAutoLoginForIp" class="text-sm text-text-secondary cursor-pointer">{{ t('login.enableAutoLoginForIp', '为此 IP 启用自动登录') }}</label>
            </div>
          </div>

          <!-- 2FA Token Input -->
          <div v-if="loginRequires2FA">
            <label for="twoFactorToken" class="block text-sm font-medium text-text-secondary mb-1">{{ t('login.twoFactorPrompt') }}</label>
            <input type="text" id="twoFactorToken" v-model="twoFactorToken" required :disabled="isLoading" pattern="\d{6}" title="请输入 6 位数字验证码"
                   class="w-full px-4 py-3 border border-border/50 rounded-lg bg-input text-foreground text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out disabled:bg-gray-100 disabled:cursor-not-allowed" />
         </div>

         <!-- CAPTCHA Area -->
         <!-- 恢复原始的 v-if 条件 -->
         <div v-if="publicCaptchaConfig && publicCaptchaConfig.enabled && !loginRequires2FA" class="space-y-2">
            <!-- 提示标签 -->
            <label class="block text-sm font-medium text-text-secondary">{{ t('login.captchaPrompt') }}</label>
            <!-- hCaptcha Component -->
            <div v-if="publicCaptchaConfig?.provider === 'hcaptcha' && publicCaptchaConfig.hcaptchaSiteKey">
               <VueHcaptcha
                 ref="hcaptchaWidget"
                 :sitekey="publicCaptchaConfig.hcaptchaSiteKey"
                 @verify="handleCaptchaVerified"
                 @expired="handleCaptchaExpired"
                 @error="handleCaptchaError"
                 theme="auto"
               ></VueHcaptcha>
            </div>
            <!-- reCAPTCHA v2 Component -->
            <div v-else-if="publicCaptchaConfig?.provider === 'recaptcha' && publicCaptchaConfig.recaptchaSiteKey">
               <VueRecaptcha
                 ref="recaptchaWidget"
                 :sitekey="publicCaptchaConfig.recaptchaSiteKey"
                 @verify="handleCaptchaVerified"
                 @expire="handleCaptchaExpired"
                 @fail="handleCaptchaError"
                 theme="light"
               />
               <!-- 注意: 根据 vue3-recaptcha2 文档调整事件名 @expire, @fail -->
               <!-- 注意: publicCaptchaConfig 需要包含 recaptchaSiteKey -->
               <!-- theme 可以是 'light' 或 'dark' -->
            </div>
            <!-- CAPTCHA Error Message -->
            <div v-if="captchaError" class="text-error text-sm">
              {{ captchaError }}
            </div>
         </div>

         <!-- General Login Error -->
         <div v-if="error" class="text-error text-center text-sm -mt-2 mb-2"> <!-- Adjusted margin -->
           {{ error }}
         </div>

          <button type="submit" :disabled="isLoading"
                  class="w-full py-3 px-4 bg-primary text-white border-none rounded-lg text-base font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-70">
            {{ isLoading ? t('login.loggingIn') : (loginRequires2FA ? t('login.verifyButton') : t('login.loginButton')) }}
          </button>
 
          <!-- Passkey Login Button Removed -->

        </form>
      </div>
    </div>
  </div>
</template>
