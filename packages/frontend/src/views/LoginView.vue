<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'; // computed 不再直接使用，移除
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { startAuthentication } from '@simplewebauthn/browser';
import { useAuthStore } from '../stores/auth.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useOidcNotice } from '../composables/useOidcNotice';
import VueHcaptcha from '@hcaptcha/vue3-hcaptcha';
import VueRecaptcha from 'vue3-recaptcha2'; // 使用默认导入
import { isDesktopApp } from '../utils/platform';

const { t } = useI18n();
const authStore = useAuthStore();
const uiNotificationsStore = useUiNotificationsStore();
const route = useRoute();
const router = useRouter();
// 获取 loginRequires2FA 状态
const { isLoading, error, loginRequires2FA, publicCaptchaConfig, hasPasskeysAvailable, oidcProviders } = storeToRefs(authStore); // Get publicCaptchaConfig and hasPasskeysAvailable

// 表单数据
const credentials = reactive({
  username: '',
  password: '',
});
const twoFactorToken = ref(''); // 用于存储 2FA 验证码
// 桌面端：后端首次启动已经建好 admin 账号，直接把用户名填上，用户只需要点登录
const isDesktop = isDesktopApp();
if (isDesktop) {
  credentials.username = 'admin';
}
const rememberMe = ref(false); // 记住我状态，默认为 false
const captchaToken = ref<string | null>(null); //  Store CAPTCHA token
const captchaError = ref<string | null>(null); //  Store CAPTCHA specific error
const hcaptchaWidget = ref<InstanceType<typeof VueHcaptcha> | null>(null); //  Ref for hCaptcha component instance
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

  try {
    if (loginRequires2FA.value) {
      // 如果需要 2FA，则调用 2FA 验证 action
      await authStore.verifyLogin2FA(twoFactorToken.value);
    } else {
      // 否则，调用常规登录 action，并传递 rememberMe 和 captchaToken 状态
      await authStore.login({
          ...credentials,
          rememberMe: rememberMe.value,
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

 // Fetch CAPTCHA config and check passkey availability on component mount
onMounted(async () => {
  // console.log('[LoginView] Component mounted, calling fetchCaptchaConfig and checkHasPasskeysConfigured...');
  authStore.fetchCaptchaConfig();
  // Check if passkeys are available for login (uses the new public endpoint)
  // Optionally pass username if needed: await authStore.checkHasPasskeysConfigured(credentials.username);
  await authStore.checkHasPasskeysConfigured();
  // OIDC：拉取可用的提供商（仅 enabled），失败时静默降级为不显示按钮
  authStore.fetchOidcProviders();
});

// 回调失败提示（?oidc_error=xxx）在挂载时弹 toast 并清理 query
useOidcNotice();

// --- OIDC Login Handler ---
// OIDC 是整页跳转（契约 §5），不是 fetch：浏览器直接离开当前页面到 IdP
const handleOidcLogin = (providerId: string) => {
  authStore.startOidcLogin(providerId);
};

// --- Passkey Login Handler ---
const handlePasskeyLogin = async () => {
  try {
    isLoading.value = true;
    error.value = null; // Clear previous errors

    // Prepare body for authentication options request
    // If username is provided, include it. Otherwise, send an empty object
    // to allow the backend to attempt discoverable credential authentication.
    const authOptionsBody = credentials.username ? { username: credentials.username } : {};

    // Step 1: Get authentication options from the server
    const optionsResponse = await fetch('/api/v1/auth/passkey/authentication-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authOptionsBody),
    });

    if (!optionsResponse.ok) {
      const errData = await optionsResponse.json();
      throw new Error(errData.message || t('login.error.passkeyAuthOptionsFailed'));
    }
    const authOptions = await optionsResponse.json();

    // Step 2: Use WebAuthn API to authenticate
    const authenticationResult = await startAuthentication(authOptions);

    // Step 3: Send authentication result to the server
    // Pass username if it was used to get options, otherwise pass null or rely on backend to extract from assertion
    // For simplicity, we'll pass the username if available, or an empty string if not.
    // The store action `loginWithPasskey` expects a string.
    // The backend should ideally identify the user from the assertion if an empty username is provided.
    await authStore.loginWithPasskey(credentials.username || '', authenticationResult);

  } catch (err: any) {
    console.error('Passkey login error:', err);
    error.value = err.message || t('login.error.passkeyAuthFailed');
    // Potentially reset CAPTCHA if it was involved, though typically not for passkey flows directly
    // if (publicCaptchaConfig.value?.enabled) {
    //   resetCaptchaWidget();
    // }
  } finally {
    isLoading.value = false;
  }
};

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
              <!-- 桌面端默认账号没有密码，这里不能强制必填，否则空密码永远提交不了 -->
              <input type="password" id="password" v-model="credentials.password" :required="!isDesktop" :disabled="isLoading"
                     class="w-full px-4 py-3 border border-border/50 rounded-lg bg-input text-foreground text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out disabled:bg-gray-100 disabled:cursor-not-allowed" />
              <p v-if="isDesktop" class="mt-1.5 text-xs text-text-secondary/80">{{ t('login.desktopEmptyPasswordHint') }}</p>
            </div>
            <!-- Remember Me Checkbox -->
            <div class="flex items-center">
              <input type="checkbox" id="rememberMe" v-model="rememberMe" :disabled="isLoading"
                     class="w-4 h-4 mr-2 accent-primary rounded border-gray-300 focus:ring-primary disabled:cursor-not-allowed" />
              <label for="rememberMe" class="text-sm text-text-secondary cursor-pointer">{{ t('login.rememberMe', '记住我') }}</label>
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
 
          <!-- Passkey Login Button -->
          <div v-if="hasPasskeysAvailable" class="mt-4 text-center">
           <button type="button" @click="handlePasskeyLogin" :disabled="isLoading"
                   class="w-full py-3 px-4 bg-secondary text-black border-none rounded-lg text-base font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-secondary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-secondary disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-70 flex items-center justify-center">
              <i class="fas fa-key mr-2"></i>
              <span>{{ isLoading ? t('login.loggingIn') : t('login.loginWithPasskey') }}</span>
           </button>
         </div>

         <!-- OIDC Login Buttons（契约 §5：在 passkey 按钮下方逐个渲染 enabled 的提供商） -->
         <div v-if="oidcProviders && oidcProviders.length > 0" class="mt-4 space-y-3">
           <div class="relative flex items-center">
             <div class="flex-grow border-t border-border/50"></div>
             <span class="flex-shrink mx-3 text-xs text-text-secondary">{{ t('login.oidcOr') }}</span>
             <div class="flex-grow border-t border-border/50"></div>
           </div>
           <button v-for="provider in oidcProviders" :key="provider.id" type="button"
                   @click="handleOidcLogin(provider.id)" :disabled="isLoading"
                   class="w-full py-3 px-4 bg-background text-foreground border border-border rounded-lg text-base font-semibold cursor-pointer shadow-sm transition-colors duration-200 ease-in-out hover:bg-header/40 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-70 flex items-center justify-center">
             <img v-if="provider.iconUrl" :src="provider.iconUrl" alt="" class="h-5 w-5 mr-2 object-contain" />
             <i v-else class="fas fa-right-to-bracket mr-2"></i>
             <span>{{ t('login.oidcLoginWith', { name: provider.name }) }}</span>
           </button>
         </div>
        </form>
      </div>
    </div>
  </div>
</template>
