
<template>
  <div class="p-4 bg-background text-foreground min-h-screen"> <!-- Outer container -->
    <div class="max-w-7xl mx-auto"> <!-- Inner container for max-width -->
      <h1 class="text-2xl font-semibold text-foreground mb-6 pb-3 border-b border-border"> <!-- Main Title -->
        {{ $t('settings.title') }}
      </h1>

      <!-- Error state (Show first if error exists) -->
      <div v-if="settingsError" class="p-4 mb-4 border-l-4 border-error bg-error/10 text-error rounded">
        {{ settingsError }}
      </div>

      <!-- Settings Sections Grid (Render grid structure always if no error) -->
      <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-6"> <!-- Changed to 2 columns on large screens -->
        <!-- Removed global loading state, content will show/hide based on individual loading states -->

          <!-- Column 1: Security -->
          <div class="space-y-6"> <!-- Removed col-span -->
          <!-- Security Sections: Only show if settings data is loaded -->
          <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
            <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.security') }}</h2>
            <div class="p-6 space-y-6">
              <!-- Change Password -->
              <div class="settings-section-content">
                <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.changePassword.title') }}</h3>
                <form @submit.prevent="handleChangePassword" class="space-y-4">
                  <div>
                    <label for="currentPassword" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.changePassword.currentPassword') }}</label>
                    <input type="password" id="currentPassword" v-model="currentPassword" required
                           class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                  </div>
                  <div>
                    <label for="newPassword" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.changePassword.newPassword') }}</label>
                    <input type="password" id="newPassword" v-model="newPassword" required
                           class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                  </div>
                  <div>
                    <label for="confirmPassword" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.changePassword.confirmPassword') }}</label>
                    <input type="password" id="confirmPassword" v-model="confirmPassword" required
                           class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                  </div>
                  <div class="flex items-center justify-between">
                    <button type="submit" :disabled="changePasswordLoading"
                            class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium">
                      {{ changePasswordLoading ? $t('common.loading') : $t('settings.changePassword.submit') }}
                    </button>
                    <p v-if="changePasswordMessage" :class="['text-sm', changePasswordSuccess ? 'text-success' : 'text-error']">{{ changePasswordMessage }}</p>
                  </div>
                </form>
              </div>
              <hr class="border-border/50">
              <!-- Passkey Section Removed -->
              <!-- 2FA -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.twoFactor.title') }}</h3>
                 <div v-if="twoFactorEnabled">
                   <p class="p-3 mb-3 border-l-4 border-success bg-success/10 text-success text-sm rounded">{{ $t('settings.twoFactor.status.enabled') }}</p>
                   <form @submit.prevent="handleDisable2FA" class="space-y-4">
                     <div>
                       <label for="disablePassword" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.twoFactor.disable.passwordPrompt') }}</label>
                       <input type="password" id="disablePassword" v-model="disablePassword" required
                              class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                     </div>
                     <div class="flex items-center justify-between">
                        <button type="submit" :disabled="twoFactorLoading"
                                class="px-4 py-2 bg-error text-error-text rounded-md shadow-sm hover:bg-error/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-error disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium">
                          {{ twoFactorLoading ? $t('common.loading') : $t('settings.twoFactor.disable.button') }}
                        </button>
                     </div>
                   </form>
                 </div>
                 <div v-else>
                   <p class="text-sm text-text-secondary mb-4">{{ $t('settings.twoFactor.status.disabled') }}</p>
                   <button v-if="!isSettingUp2FA" @click="handleSetup2FA" :disabled="twoFactorLoading"
                           class="px-4 py-2 bg-success text-success-text rounded-md shadow-sm hover:bg-success/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-success disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium">
                     {{ twoFactorLoading ? $t('common.loading') : $t('settings.twoFactor.enable.button') }}
                   </button>
                   <div v-if="isSettingUp2FA && setupData" class="mt-4 space-y-4 p-4 border border-border rounded-md bg-header/30">
                     <p class="text-sm text-text-secondary">{{ $t('settings.twoFactor.setup.scanQrCode') }}</p>
                     <img :src="setupData.qrCodeUrl" alt="QR Code" class="block mx-auto max-w-[180px] border border-border p-1 bg-white rounded">
                     <p class="text-sm text-text-secondary">{{ $t('settings.twoFactor.setup.orEnterSecret') }} <code class="bg-header/50 p-1 px-2 border border-border/50 rounded font-mono text-sm">{{ setupData.secret }}</code></p>
                     <form @submit.prevent="handleVerifyAndActivate2FA" class="space-y-4">
                       <div>
                         <label for="verificationCode" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.twoFactor.setup.enterCode') }}</label>
                         <input type="text" id="verificationCode" v-model="verificationCode" required pattern="\d{6}" title="请输入 6 位数字验证码"
                                class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                       </div>
                       <div class="flex items-center space-x-3">
                         <button type="submit" :disabled="twoFactorLoading"
                                 class="px-4 py-2 bg-success text-success-text rounded-md shadow-sm hover:bg-success/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-success disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium">
                           {{ twoFactorLoading ? $t('common.loading') : $t('settings.twoFactor.setup.verifyButton') }}
                         </button>
                         <button type="button" @click="cancelSetup" :disabled="twoFactorLoading"
                                 class="px-4 py-2 bg-transparent text-text-secondary border border-border rounded-md shadow-sm hover:bg-border hover:text-foreground focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium">
                           {{ $t('common.cancel') }}
                         </button>
                       </div>
                     </form>
                   </div>
                 </div>
                 <p v-if="twoFactorMessage" :class="['mt-3 text-sm', twoFactorSuccess ? 'text-success' : 'text-error']">{{ twoFactorMessage }}</p>
              </div>
              <hr class="border-border/50"> <!-- Separator -->
              <!-- CAPTCHA Settings -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.captcha.title') }}</h3>
                 <p class="text-sm text-text-secondary mb-4">{{ $t('settings.captcha.description') }}</p>
                 <div v-if="!captchaSettings" class="p-4 text-center text-text-secondary italic">
                    {{ $t('common.loading') }}
                 </div>
                 <form v-else @submit.prevent="handleUpdateCaptchaSettings" class="space-y-4">
                    <!-- Enable Switch -->
                    <div class="flex items-center">
                        <input type="checkbox" id="captchaEnabled" v-model="captchaForm.enabled"
                               class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                        <label for="captchaEnabled" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.captcha.enableLabel') }}</label>
                    </div>

                    <!-- Provider Select (Only show if enabled) -->
                    <div v-if="captchaForm.enabled">
                      <label for="captchaProvider" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.captcha.providerLabel') }}</label>
                      <select id="captchaProvider" v-model="captchaForm.provider"
                              class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                              style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
                        <option value="none">{{ $t('settings.captcha.providerNone') }}</option>
                        <option value="hcaptcha">hCaptcha</option>
                        <option value="recaptcha">Google reCAPTCHA v2</option>
                      </select>
                    </div>

                    <!-- hCaptcha Settings (Only show if enabled and provider is hcaptcha) -->
                    <div v-if="captchaForm.enabled && captchaForm.provider === 'hcaptcha'" class="space-y-4 pl-4 border-l-2 border-border/50 ml-1 pt-2">
                       <p class="text-xs text-text-secondary">{{ $t('settings.captcha.hcaptchaHint') }} <a href="https://www.hcaptcha.com/" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">hCaptcha.com</a></p>
                       <div>
                         <label for="hcaptchaSiteKey" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.captcha.siteKeyLabel') }}</label>
                         <input type="text" id="hcaptchaSiteKey" v-model="captchaForm.hcaptchaSiteKey"
                                class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                       </div>
                       <div>
                         <label for="hcaptchaSecretKey" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.captcha.secretKeyLabel') }}</label>
                         <input type="password" id="hcaptchaSecretKey" v-model="captchaForm.hcaptchaSecretKey" placeholder="••••••••••••" autocomplete="new-password"
                                class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                         <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.captcha.secretKeyHint') }}</small>
                       </div>
                    </div>

                    <!-- reCAPTCHA Settings (Only show if enabled and provider is recaptcha) -->
                    <div v-if="captchaForm.enabled && captchaForm.provider === 'recaptcha'" class="space-y-4 pl-4 border-l-2 border-border/50 ml-1 pt-2">
                       <p class="text-xs text-text-secondary">{{ $t('settings.captcha.recaptchaHint') }} <a href="https://www.google.com/recaptcha/" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">Google reCAPTCHA</a></p>
                       <div>
                         <label for="recaptchaSiteKey" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.captcha.siteKeyLabel') }}</label>
                         <input type="text" id="recaptchaSiteKey" v-model="captchaForm.recaptchaSiteKey"
                                class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                       </div>
                       <div>
                         <label for="recaptchaSecretKey" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.captcha.secretKeyLabel') }}</label>
                         <input type="password" id="recaptchaSecretKey" v-model="captchaForm.recaptchaSecretKey" placeholder="••••••••••••" autocomplete="new-password"
                                class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                         <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.captcha.secretKeyHint') }}</small>
                       </div>
                    </div>

                    <!-- Save Button & Message -->
                    <div class="flex items-center justify-between pt-2">
                       <button type="submit"
                                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                         {{ $t('settings.captcha.saveButton') }}
                       </button>
                       <p v-if="captchaMessage" :class="['text-sm', captchaSuccess ? 'text-success' : 'text-error']">{{ captchaMessage }}</p>
                    </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- Separator -->
             <!-- Auto Login Settings Section -->
             <div class="settings-section-content">
               <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.autoLogin.title', '自动登录') }}</h3>
               <form @submit.prevent="handleUpdateAutoLoginSettings" class="space-y-6">
                 <!-- Cloudflare Auto Login -->
                 <div class="space-y-3 p-3 border border-border/30 rounded-md">
                   <div class="flex items-center">
                     <input type="checkbox" id="cloudflareAutoLoginEnabled" v-model="autoLoginSettingsForm.cloudflareEnabled"
                            class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                     <label for="cloudflareAutoLoginEnabled" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.autoLogin.cloudflareEnableLabel', '启用 Cloudflare Access 自动登录') }}</label>
                   </div>
                   <div v-if="autoLoginSettingsForm.cloudflareEnabled">
                     <label for="cloudflareTrustedIPs" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.autoLogin.cloudflareTrustedIPsLabel', 'Cloudflare 受信任 IP 列表 (逗号分隔)') }}</label>
                     <textarea id="cloudflareTrustedIPs" v-model="autoLoginSettingsForm.cloudflareTrustedIPs" rows="2"
                               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono text-sm"></textarea>
                     <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.autoLogin.cloudflareTrustedIPsHint', '通过 Cloudflare Access 认证后，来自这些 IP 的请求将自动登录。') }}</small>
                   </div>
                 </div>

                 <!-- App IP Whitelist Auto Login -->
                 <div class="space-y-3 p-3 border border-border/30 rounded-md">
                   <div class="flex items-center">
                     <input type="checkbox" id="ipWhitelistAutoLoginEnabled" v-model="autoLoginSettingsForm.ipWhitelistEnabled"
                            class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                     <label for="ipWhitelistAutoLoginEnabled" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.autoLogin.ipWhitelistEnableLabel', '启用应用 IP 白名单自动登录') }}</label>
                   </div>
                   <div v-if="autoLoginSettingsForm.ipWhitelistEnabled">
                     <label for="ipWhitelistAllowedIPs" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.autoLogin.ipWhitelistAllowedIPsLabel', '应用 IP 白名单 (逗号分隔)') }}</label>
                     <textarea id="ipWhitelistAllowedIPs" v-model="autoLoginSettingsForm.ipWhitelistAllowedIPs" rows="2"
                               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono text-sm"></textarea>
                     <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.autoLogin.ipWhitelistAllowedIPsHint', '来自这些 IP 的请求将自动登录（如果 Cloudflare 自动登录未触发）。') }}</small>
                   </div>
                 </div>

                 <div class="flex items-center justify-between pt-2">
                    <button type="submit" :disabled="autoLoginSettingsLoading"
                            class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                      {{ autoLoginSettingsLoading ? $t('common.loading') : $t('settings.autoLogin.saveButton', '保存自动登录设置') }}
                    </button>
                    <p v-if="autoLoginSettingsMessage" :class="['text-sm', autoLoginSettingsSuccess ? 'text-success' : 'text-error']">{{ autoLoginSettingsMessage }}</p>
                 </div>
               </form>
             </div>
           </div>
         </div>

          <!-- IP Whitelist Section (General - for access control, not auto-login specific): Only show if settings data is loaded -->
          <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
            <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.ipWhitelist.title') }} ({{ $t('settings.ipWhitelist.accessControlOnly', '访问控制') }})</h2>
            <div class="p-6 space-y-6">
               <p class="text-sm text-text-secondary mb-4">{{ $t('settings.ipWhitelist.description') }}</p>
               <form @submit.prevent="handleUpdateIpWhitelist" class="space-y-4">
                 <div>
                   <label for="ipWhitelist" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.ipWhitelist.label') }}</label>
                   <textarea id="ipWhitelist" v-model="ipWhitelistInput" rows="4"
                             class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono text-sm"></textarea>
                   <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.ipWhitelist.hint') }}</small>
                 </div>
                 <div class="flex items-center justify-between">
                    <button type="submit" :disabled="ipWhitelistLoading"
                            class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium">
                      {{ ipWhitelistLoading ? $t('common.loading') : $t('settings.ipWhitelist.saveButton') }}
                    </button>
                    <p v-if="ipWhitelistMessage" :class="['text-sm', ipWhitelistSuccess ? 'text-success' : 'text-error']">{{ ipWhitelistMessage }}</p>
                 </div>
               </form>
            </div>
          </div>

          <!-- IP Blacklist Section: Only show if settings data is loaded (as config depends on it) -->
           <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
             <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-header/50">
               <h2 class="text-lg font-semibold text-foreground">{{ $t('settings.ipBlacklist.title') }}</h2>
               <!-- IP Blacklist Enable/Disable Switch -->
               <button
                 type="button"
                 @click="handleUpdateIpBlacklistEnabled"
                 :class="[
                   'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
                   ipBlacklistEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                 ]"
                 role="switch"
                 :aria-checked="ipBlacklistEnabled"
               >
                 <span
                   aria-hidden="true"
                   :class="[
                     'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
                     ipBlacklistEnabled ? 'translate-x-5' : 'translate-x-0'
                   ]"
                 ></span>
               </button>
             </div>
             <div class="p-6 space-y-6">
                 <!-- Description moved below -->

                 <!-- Existing Blacklist Content (Conditional Rendering) -->
                <div v-if="ipBlacklistEnabled" class="space-y-6 pt-4">
                  <p class="text-sm text-text-secondary">{{ $t('settings.ipBlacklist.description') }}</p>
                  <!-- Blacklist config form -->
                  <form @submit.prevent="handleUpdateBlacklistSettings" class="flex flex-wrap items-end gap-4">
                     <div class="flex-grow min-w-[150px]">
                       <label for="maxLoginAttempts" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.ipBlacklist.maxAttemptsLabel') }}</label>
                     <input type="number" id="maxLoginAttempts" v-model="blacklistSettingsForm.maxLoginAttempts" min="1" required
                            class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                   </div>
                   <div class="flex-grow min-w-[150px]">
                     <label for="loginBanDuration" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.ipBlacklist.banDurationLabel') }}</label>
                     <input type="number" id="loginBanDuration" v-model="blacklistSettingsForm.loginBanDuration" min="1" required
                            class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                   </div>
                   <div class="flex-shrink-0">
                      <button type="submit"
                              class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                        {{ $t('settings.ipBlacklist.saveConfigButton') }}
                      </button>
                   </div>
                     <p v-if="blacklistSettingsMessage" :class="['w-full mt-2 text-sm', blacklistSettingsSuccess ? 'text-success' : 'text-error']">{{ blacklistSettingsMessage }}</p>
                  </form>
                  <hr class="border-border/50">
                  <!-- Blacklist table -->
                  <h3 class="text-base font-semibold text-foreground">{{ $t('settings.ipBlacklist.currentBannedTitle') }}</h3>
                <!-- Error state -->
                <div v-if="ipBlacklist.error" class="p-3 border-l-4 border-error bg-error/10 text-error text-sm rounded">{{ ipBlacklist.error }}</div>
                <!-- Loading state (Only show if loading AND no entries are displayed yet) -->
                <div v-else-if="ipBlacklist.loading && ipBlacklist.entries.length === 0" class="p-4 text-center text-text-secondary italic">{{ $t('settings.ipBlacklist.loadingList') }}</div>
                <!-- Empty state (Show only if not loading, no error, and entries empty) -->
                <p v-else-if="!ipBlacklist.loading && !ipBlacklist.error && ipBlacklist.entries.length === 0" class="p-4 text-center text-text-secondary italic">{{ $t('settings.ipBlacklist.noBannedIps') }}</p>
                <!-- Table (Show if not loading, no error, and has entries) -->
                <div v-else-if="!ipBlacklist.loading && !ipBlacklist.error && ipBlacklist.entries.length > 0" class="overflow-x-auto border border-border rounded-lg shadow-sm bg-background">
                  <table class="min-w-full divide-y divide-border text-sm">
                     <thead class="bg-header">
                       <tr>
                         <th scope="col" class="px-4 py-2 text-left font-medium text-text-secondary tracking-wider whitespace-nowrap">{{ $t('settings.ipBlacklist.table.ipAddress') }}</th>
                         <th scope="col" class="px-4 py-2 text-left font-medium text-text-secondary tracking-wider whitespace-nowrap">{{ $t('settings.ipBlacklist.table.attempts') }}</th>
                         <th scope="col" class="px-4 py-2 text-left font-medium text-text-secondary tracking-wider whitespace-nowrap">{{ $t('settings.ipBlacklist.table.lastAttempt') }}</th>
                         <th scope="col" class="px-4 py-2 text-left font-medium text-text-secondary tracking-wider whitespace-nowrap">{{ $t('settings.ipBlacklist.table.bannedUntil') }}</th>
                         <th scope="col" class="px-4 py-2 text-left font-medium text-text-secondary tracking-wider whitespace-nowrap">{{ $t('settings.ipBlacklist.table.actions') }}</th>
                       </tr>
                     </thead>
                     <tbody class="divide-y divide-border">
                       <tr v-for="entry in ipBlacklist.entries" :key="entry.ip" class="hover:bg-header/50">
                         <td class="px-4 py-2 whitespace-nowrap">{{ entry.ip }}</td>
                         <td class="px-4 py-2 whitespace-nowrap">{{ entry.attempts }}</td>
                         <td class="px-4 py-2 whitespace-nowrap">{{ new Date(entry.last_attempt_at * 1000).toLocaleString() }}</td>
                         <td class="px-4 py-2 whitespace-nowrap">{{ entry.blocked_until ? new Date(entry.blocked_until * 1000).toLocaleString() : $t('statusMonitor.notAvailable') }}</td>
                         <td class="px-4 py-2 whitespace-nowrap">
                           <button
                             @click="handleDeleteIp(entry.ip)"
                             :disabled="blacklistDeleteLoading && blacklistToDeleteIp === entry.ip"
                             class="px-2 py-1 bg-error text-error-text rounded text-xs font-medium hover:bg-error/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-error disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out"
                           >
                             {{ (blacklistDeleteLoading && blacklistToDeleteIp === entry.ip) ? $t('settings.ipBlacklist.table.deleting') : $t('settings.ipBlacklist.table.removeButton') }}
                           </button>
                         </td>
                       </tr>
                     </tbody>
                  </table>
                </div>
                <!-- Delete Error (Show regardless of loading state if present) -->
                  <p v-if="blacklistDeleteError" class="mt-3 text-sm text-error">{{ blacklistDeleteError }}</p>
                </div> <!-- End v-if="ipBlacklistEnabled" -->
                <!-- Message when disabled -->
                <div v-else class="p-4 text-center text-text-secondary italic border border-dashed border-border/50 rounded-md">
                   {{ $t('settings.ipBlacklist.disabledMessage', 'IP 黑名单功能当前已禁用。') }}
                </div>
             </div>
           </div>

           <!-- About Section -->
           <div class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
             <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.about') }}</h2>
             <div class="p-6 space-y-4"> <!-- Reduced space-y for tighter layout -->
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary"> <!-- Flex container for info items, allow wrap -->
                   <span class="font-medium">{{ $t('settings.about.version') }}: {{ appVersion }}</span>
                   <!-- Version Check Status -->
                   <span v-if="isCheckingVersion" class="inline-block text-xs ml-2 px-2 py-0.5 rounded-full bg-blue-500 text-white italic">
                     {{ $t('settings.about.checkingUpdate') }}
                   </span>
                   <span v-else-if="versionCheckError" class="inline-block text-xs ml-2 px-2 py-0.5 rounded-full bg-error text-white" :title="versionCheckError">
                     {{ $t('settings.about.error.checkFailedShort') }}
                   </span>
                   <span v-else-if="!isUpdateAvailable && latestVersion" class="inline-block text-xs ml-2 px-2 py-0.5 rounded-full bg-success text-white">
                     {{ $t('settings.about.latestVersion') }}
                   </span>
                   <a v-else-if="isUpdateAvailable && latestVersion"
                      :href="`https://github.com/Heavrnl/nexus-terminal/releases/tag/${latestVersion}`"
                      target="_blank" rel="noopener noreferrer"
                      class="inline-flex items-center text-xs ml-2 px-2 py-0.5 rounded-full bg-warning text-white hover:bg-warning/80">
                     <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-1 h-3 w-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                     {{ $t('settings.about.updateAvailable', { version: latestVersion }) }}
                   </a>
                   <span class="opacity-50">|</span>
                   <a href="https://github.com/Heavrnl/nexus-terminal" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline inline-flex items-center">
                     <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="mr-1" viewBox="0 0 16 16"> <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/> </svg>
                     Heavrnl/nexus-terminal
                   </a>
                   <span class="opacity-50">|</span>
                   <a href="https://ko-fi.com/0heavrnl" target="_blank" rel="noopener noreferrer" title="Support me on Ko-fi" class="text-primary hover:underline inline-flex items-center">
                     <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14" class="mr-1"> <path d="M20.33 6.08c-.28-.4-.7-.68-1.18-.82-.48-.14-.98-.14-1.47-.02-.48.12-.9.38-1.22.75-.32.37-.5.83-.5 1.32 0 .48.18.93.5 1.3.32.37.75.63 1.22.75.48.12.98.12 1.47 0 .48-.12.9-.38 1.18-.75.28-.37.45-.82.45-1.3 0-.48-.17-.95-.45-1.32zm-2.75 1.5c-.14.17-.33.25-.53.25s-.38-.08-.53-.25c-.14-.17-.22-.38-.22-.6s.08-.43.22-.6c.14-.17.33-.25.53-.25s.38.08.53.25c.14.17.22.38.22.6s-.08.43-.22.6zM18 10H6c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-6c0-1.1-.9-2-2-2zm-6 8c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/> </svg>
                     Ko-fi
                   </a>
                </div>
             </div>
           </div> <!-- End About Section -->
         </div>
 
         <!-- Column 2: Appearance, Workspace, System -->
        <div class="space-y-6"> <!-- Removed col-span -->

          <!-- Workspace Section: Only show if settings data is loaded -->
          <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
            <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.workspace.title') }}</h2>
            <div class="p-6 space-y-6">
              <!-- Popup Editor -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.popupEditor.title') }}</h3>
                 <form @submit.prevent="handleUpdatePopupEditorSetting" class="space-y-4">
                     <div class="flex items-center">
                         <input type="checkbox" id="showPopupEditor" v-model="popupEditorEnabled"
                                class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                         <label for="showPopupEditor" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.popupEditor.enableLabel') }}</label>
                     </div>
                     <div class="flex items-center justify-between">
                        <button type="submit"
                                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                          {{ $t('settings.popupEditor.saveButton') }}
                        </button>
                        <p v-if="popupEditorMessage" :class="['text-sm', popupEditorSuccess ? 'text-success' : 'text-error']">{{ popupEditorMessage }}</p>
                     </div>
                 </form>
              </div>
              <hr class="border-border/50">
              <!-- Share Tabs -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.shareEditorTabs.title') }}</h3>
                 <form @submit.prevent="handleUpdateShareTabsSetting" class="space-y-4">
                     <div class="flex items-center">
                         <input type="checkbox" id="shareEditorTabs" v-model="shareTabsEnabled"
                                class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                         <label for="shareEditorTabs" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.shareEditorTabs.enableLabel') }}</label>
                     </div>
                     <p class="text-xs text-text-secondary mt-1">{{ $t('settings.shareEditorTabs.description') }}</p>
                     <div class="flex items-center justify-between">
                        <button type="submit"
                                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                          {{ $t('settings.shareEditorTabs.saveButton') }}
                        </button>
                        <p v-if="shareTabsMessage" :class="['text-sm', shareTabsSuccess ? 'text-success' : 'text-error']">{{ shareTabsMessage }}</p>
                     </div>
                 </form>
              </div>
              <hr class="border-border/50">
              <!-- Auto Copy -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.autoCopyOnSelect.title') }}</h3>
                 <form @submit.prevent="handleUpdateAutoCopySetting" class="space-y-4">
                     <div class="flex items-center">
                         <input type="checkbox" id="autoCopyOnSelect" v-model="autoCopyEnabled"
                                class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                         <label for="autoCopyOnSelect" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.autoCopyOnSelect.enableLabel') }}</label>
                     </div>
                     <div class="flex items-center justify-between">
                        <button type="submit"
                                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                          {{ $t('settings.autoCopyOnSelect.saveButton') }}
                        </button>
                        <p v-if="autoCopyMessage" :class="['text-sm', autoCopySuccess ? 'text-success' : 'text-error']">{{ autoCopyMessage }}</p>
                     </div>
                 </form>
              </div>
              <hr class="border-border/50">
              <!-- Persistent Sidebar -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.workspace.sidebarPersistentTitle') }}</h3>
                 <form @submit.prevent="handleUpdateWorkspaceSidebarSetting" class="space-y-4">
                     <div class="flex items-center">
                         <input type="checkbox" id="workspaceSidebarPersistent" v-model="workspaceSidebarPersistentEnabled"
                                class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                         <label for="workspaceSidebarPersistent" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.workspace.sidebarPersistentLabel') }}</label>
                     </div>
                     <p class="text-xs text-text-secondary mt-1">{{ $t('settings.workspace.sidebarPersistentDescription') }}</p>
                     <div class="flex items-center justify-between">
                        <button type="submit"
                                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                          {{ $t('common.save') }}
                        </button>
                        <p v-if="workspaceSidebarPersistentMessage" :class="['text-sm', workspaceSidebarPersistentSuccess ? 'text-success' : 'text-error']">{{ workspaceSidebarPersistentMessage }}</p>
                     </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- NEW: Separator -->
              <!-- Command Input Sync Target -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.commandInputSync.title', '命令输入同步') }}</h3>
                 <form @submit.prevent="handleUpdateCommandInputSyncTarget" class="space-y-4">
                   <div>
                     <label for="commandInputSyncTargetSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.commandInputSync.selectLabel', '同步目标') }}</label>
                     <select id="commandInputSyncTargetSelect" v-model="commandInputSyncTargetLocal"
                             class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                             style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
                       <option value="none">{{ $t('settings.commandInputSync.targetNone', '无') }}</option>
                       <option value="quickCommands">{{ $t('settings.commandInputSync.targetQuickCommands', '快捷指令') }}</option>
                       <option value="commandHistory">{{ $t('settings.commandInputSync.targetCommandHistory', '历史命令') }}</option>
                     </select>
                     <p class="text-xs text-text-secondary mt-1">{{ $t('settings.commandInputSync.description', '将命令输入框的内容实时同步到所选面板的搜索框。') }}</p>
                   </div>
                   <div class="flex items-center justify-between">
                      <button type="submit"
                              class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                        {{ $t('common.save') }}
                      </button>
                      <p v-if="commandInputSyncMessage" :class="['text-sm', commandInputSyncSuccess ? 'text-success' : 'text-error']">{{ commandInputSyncMessage }}</p>
                   </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- NEW: Separator -->
              <!-- Show Connection Tags -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.workspace.showConnectionTagsTitle', '显示连接标签') }}</h3>
                 <form @submit.prevent="handleUpdateShowConnectionTags" class="space-y-4">
                     <div class="flex items-center">
                         <input type="checkbox" id="showConnectionTags" v-model="showConnectionTagsLocal"
                                class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                         <label for="showConnectionTags" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.workspace.showConnectionTagsLabel', '在连接列表中显示标签') }}</label>
                     </div>
                     <p class="text-xs text-text-secondary mt-1">{{ $t('settings.workspace.showConnectionTagsDescription', '关闭后将隐藏连接列表中的标签，并从搜索中排除标签。') }}</p>
                     <div class="flex items-center justify-between pt-2">
                        <button type="submit"
                                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                          {{ $t('common.save') }}
                        </button>
                        <p v-if="showConnectionTagsMessage" :class="['text-sm', showConnectionTagsSuccess ? 'text-success' : 'text-error']">{{ showConnectionTagsMessage }}</p>
                     </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- NEW: Separator -->
              <!-- Show Quick Command Tags -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.workspace.showQuickCommandTagsTitle', '显示快捷指令标签') }}</h3>
                 <form @submit.prevent="handleUpdateShowQuickCommandTags" class="space-y-4">
                     <div class="flex items-center">
                         <input type="checkbox" id="showQuickCommandTags" v-model="showQuickCommandTagsLocal"
                                class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                         <label for="showQuickCommandTags" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.workspace.showQuickCommandTagsLabel', '在快捷指令列表中显示标签') }}</label>
                     </div>
                     <p class="text-xs text-text-secondary mt-1">{{ $t('settings.workspace.showQuickCommandTagsDescription', '关闭后将隐藏快捷指令列表中的标签，并从搜索中排除标签。') }}</p>
                     <div class="flex items-center justify-between pt-2">
                        <button type="submit"
                                class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                          {{ $t('common.save') }}
                        </button>
                        <p v-if="showQuickCommandTagsMessage" :class="['text-sm', showQuickCommandTagsSuccess ? 'text-success' : 'text-error']">{{ showQuickCommandTagsMessage }}</p>
                     </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- NEW: Separator -->
              <!-- Terminal Scrollback Limit -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ t('settings.terminalScrollback.title', '终端回滚行数') }}</h3>
                 <form @submit.prevent="handleUpdateTerminalScrollbackLimit" class="space-y-4">
                   <div>
                     <label for="terminalScrollbackLimitInput" class="block text-sm font-medium text-text-secondary mb-1">{{ t('settings.terminalScrollback.limitLabel', '最大行数') }}</label>
                     <input type="number" id="terminalScrollbackLimitInput" v-model.number="terminalScrollbackLimitLocal" min="0" step="1" placeholder="5000"
                            class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                     <small class="block mt-1 text-xs text-text-secondary">{{ t('settings.terminalScrollback.limitHint', '设置终端保留的最大输出行数。0 或留空表示无限制 (使用默认值 5000)。此设置将在下次打开终端时生效。') }}</small>
                   </div>
                   <div class="flex items-center justify-between">
                      <button type="submit"
                              class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                        {{ t('settings.terminalScrollback.saveButton', '保存') }}
                      </button>
                      <p v-if="terminalScrollbackLimitMessage" :class="['text-sm', terminalScrollbackLimitSuccess ? 'text-success' : 'text-error']">{{ terminalScrollbackLimitMessage }}</p>
                   </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- NEW: Separator -->
             <!-- File Manager Delete Confirmation -->
             <div class="settings-section-content">
                <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.workspace.fileManagerDeleteConfirmTitle', '文件管理器删除确认') }}</h3>
                <form @submit.prevent="handleUpdateFileManagerDeleteConfirmation" class="space-y-4">
                    <div class="flex items-center">
                        <input type="checkbox" id="fileManagerShowDeleteConfirmation" v-model="fileManagerShowDeleteConfirmationLocal"
                               class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                        <label for="fileManagerShowDeleteConfirmation" class="text-sm text-foreground cursor-pointer select-none">{{ $t('settings.workspace.fileManagerShowDeleteConfirmationLabel', '删除文件或文件夹时显示确认提示框') }}</label>
                    </div>
                    <div class="flex items-center justify-between pt-2">
                       <button type="submit"
                               class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                         {{ $t('common.save') }}
                       </button>
                       <p v-if="fileManagerShowDeleteConfirmationMessage" :class="['text-sm', fileManagerShowDeleteConfirmationSuccess ? 'text-success' : 'text-error']">{{ fileManagerShowDeleteConfirmationMessage }}</p>
                    </div>
                </form>
             </div>
            </div>
          </div>

          <!-- System Section: Only show if settings data is loaded -->
          <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
            <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.system') }}</h2>
            <div class="p-6 space-y-6">
              <!-- Language -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.language.title') }}</h3>
                 <form @submit.prevent="handleUpdateLanguage" class="space-y-4">
                   <div>
                     <label for="languageSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.language.selectLabel') }}</label>
                     <select id="languageSelect" v-model="selectedLanguage"
                             class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                             style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
                       <option v-for="locale in availableLocales" :key="locale" :value="locale">
                         {{ languageNames[locale] || locale }} <!-- Display mapped name or locale code -->
                       </option>
                     </select>
                   </div>
                   <div class="flex items-center justify-between">
                      <button type="submit"
                              class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                        {{ $t('settings.language.saveButton') }}
                      </button>
                      <p v-if="languageMessage" :class="['text-sm', languageSuccess ? 'text-success' : 'text-error']">{{ languageMessage }}</p>
                   </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- Separator -->
              <!-- Timezone Setting -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.timezone.title') }}</h3>
                 <form @submit.prevent="handleUpdateTimezone" class="space-y-4">
                   <div>
                     <label for="timezoneSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.timezone.selectLabel') }}</label>
                     <select id="timezoneSelect" v-model="selectedTimezone"
                             class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                             style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
                       <option v-for="tz in commonTimezones" :key="tz" :value="tz">
                         {{ tz }}
                       </option>
                     </select>
                      <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.timezone.description') }}</small>
                   </div>
                   <div class="flex items-center justify-between">
                      <button type="submit"
                              class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                        {{ $t('common.save') }}
                      </button>
                      <p v-if="timezoneMessage" :class="['text-sm', timezoneSuccess ? 'text-success' : 'text-error']">{{ timezoneMessage }}</p>
                   </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- Separator -->
              <!-- Status Monitor -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ t('settings.statusMonitor.title') }}</h3>
                 <form @submit.prevent="handleUpdateStatusMonitorInterval" class="space-y-4">
                   <div>
                     <label for="statusMonitorInterval" class="block text-sm font-medium text-text-secondary mb-1">{{ t('settings.statusMonitor.refreshIntervalLabel') }}</label>
                     <input type="number" id="statusMonitorInterval" v-model.number="statusMonitorIntervalLocal" min="1" step="1" required
                            class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                     <small class="block mt-1 text-xs text-text-secondary">{{ t('settings.statusMonitor.refreshIntervalHint') }}</small>
                   </div>
                   <div class="flex items-center justify-between">
                      <button type="submit"
                              class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                        {{ t('settings.statusMonitor.saveButton') }}
                      </button>
                      <p v-if="statusMonitorMessage" :class="['text-sm', statusMonitorSuccess ? 'text-success' : 'text-error']">{{ statusMonitorMessage }}</p>
                   </div>
                 </form>
              </div>
              <hr class="border-border/50"> <!-- Separator -->
              <!-- Docker -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ t('settings.docker.title') }}</h3>
                 <form @submit.prevent="handleUpdateDockerSettings" class="space-y-4">
                   <div>
                     <label for="dockerInterval" class="block text-sm font-medium text-text-secondary mb-1">{{ t('settings.docker.refreshIntervalLabel') }}</label>
                     <input type="number" id="dockerInterval" v-model.number="dockerInterval" min="1" step="1" required
                            class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary">
                      <small class="block mt-1 text-xs text-text-secondary">{{ t('settings.docker.refreshIntervalHint') }}</small>
                   </div>
                   <div class="flex items-center">
                     <input type="checkbox" id="dockerExpandDefault" v-model="dockerExpandDefault"
                            class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
                     <label for="dockerExpandDefault" class="text-sm text-foreground cursor-pointer select-none">{{ t('settings.docker.defaultExpandLabel') }}</label>
                   </div>
                   <div class="flex items-center justify-between">
                      <button type="submit"
                              class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                        {{ t('settings.docker.saveButton') }}
                      </button>
                      <p v-if="dockerSettingsMessage" :class="['text-sm', dockerSettingsSuccess ? 'text-success' : 'text-error']">{{ dockerSettingsMessage }}</p>
                   </div>
                 </form>
              </div>
            </div>
          </div>
<!-- Appearance Section: Only show if settings data is loaded -->
          <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
            <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.appearance') }}</h2>
            <div class="p-6 space-y-6">
              <!-- Style Customizer -->
              <div class="settings-section-content">
                 <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.appearance.title') }}</h3>
                 <p class="text-sm text-text-secondary mb-4">{{ $t('settings.appearance.description') }}</p>
                 <button @click="openStyleCustomizer"
                         class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed transition duration-150 ease-in-out text-sm font-medium">
                   {{ t('settings.appearance.customizeButton') }}
                 </button>
              </div>
            </div>
          </div> <!-- End Appearance Section -->

        </div>
      </div> <!-- End Settings Sections Grid -->
    </div> <!-- End Inner container -->
  </div> <!-- End Outer container -->
</template>

<script setup lang="ts">
// Define necessary types locally if not shared
type CaptchaProvider = 'hcaptcha' | 'recaptcha' | 'none';
interface UpdateCaptchaSettingsDto {
    enabled?: boolean;
    provider?: CaptchaProvider;
    hcaptchaSiteKey?: string;
    hcaptchaSecretKey?: string;
    recaptchaSiteKey?: string;
    recaptchaSecretKey?: string;
}
import { ref, onMounted, computed, reactive, watch } from 'vue';
import axios from 'axios'; // 导入 axios 用于 API 请求
import pkg from '../../package.json'; // 导入 package.json
import { useAuthStore } from '../stores/auth.store';
import { useSettingsStore } from '../stores/settings.store';
import { useAppearanceStore } from '../stores/appearance.store'; // 导入外观 store
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
// setLocale is handled by the store now
import { availableLocales } from '../i18n'; // 导入可用语言列表
import apiClient from '../utils/apiClient'; // 使用统一的 apiClient
import { isAxiosError } from 'axios'; // 单独导入 isAxiosError
// Removed Passkey import: import { startRegistration } from '@simplewebauthn/browser';

const authStore = useAuthStore();
const settingsStore = useSettingsStore();
const appearanceStore = useAppearanceStore(); // 实例化外观 store
const { t } = useI18n();
const appVersion = ref(pkg.version); // 获取版本号

// --- Version Check State ---
const latestVersion = ref<string | null>(null);
const isCheckingVersion = ref(false);
const versionCheckError = ref<string | null>(null);
const isUpdateAvailable = computed(() => {
  // 简单的字符串比较，假设 tag 格式为 vX.Y.Z
  return latestVersion.value && latestVersion.value !== `v${appVersion.value}`;
});

// --- Reactive state from store ---
// 使用 storeToRefs 获取响应式 getter，包括 language
const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
    showPopupFileEditorBoolean,
    shareFileEditorTabsBoolean,
    autoCopyOnSelectBoolean,
    dockerDefaultExpandBoolean,
    statusMonitorIntervalSecondsNumber,
    language: storeLanguage,
    workspaceSidebarPersistentBoolean,
    captchaSettings, // <-- Import CAPTCHA settings state
    commandInputSyncTarget, // NEW: Import command input sync target getter
    ipBlacklistEnabledBoolean, // <-- Import IP Blacklist enabled getter
    showConnectionTagsBoolean, // NEW: Import connection tag visibility getter
    showQuickCommandTagsBoolean, // NEW: Import quick command tag visibility getter
    terminalScrollbackLimitNumber, // NEW: Import terminal scrollback limit getter
    fileManagerShowDeleteConfirmationBoolean, // NEW: Import file manager delete confirmation getter
} = storeToRefs(settingsStore);
 
 // Removed Passkey state import from authStore


// --- Local state for forms ---
const ipWhitelistInput = ref('');
// 使用 store 的 language getter 初始化 selectedLanguage
const selectedLanguage = ref<string>(storeLanguage.value); // 改为 string 类型以支持动态语言
// 可选：创建一个语言名称映射
const languageNames: Record<string, string> = {
  'en-US': 'English', // 更新为 en-US
  'zh-CN': '中文',
  'ja-JP': '日本語', // 更新为 ja-JP (如果您的文件名是 ja-JP.json)
  // Add more languages here as needed
};
const blacklistSettingsForm = reactive({ // Renamed to avoid conflict with store state name
    maxLoginAttempts: '5', // 初始值将在 watcher 中被 store 值覆盖
    loginBanDuration: '300', // 初始值将在 watcher 中被 store 值覆盖
});
const popupEditorEnabled = ref(true); // 本地状态，用于 v-model
const workspaceSidebarPersistentEnabled = ref(false); // 新增：侧边栏固定设置的本地状态
const commandInputSyncTargetLocal = ref<'none' | 'quickCommands' | 'commandHistory'>('none'); // NEW: Local state for command input sync target
const ipBlacklistEnabled = ref(true); // <-- Local state for IP Blacklist switch
const showConnectionTagsLocal = ref(true); // NEW: Local state for connection tags switch
const showQuickCommandTagsLocal = ref(true); // NEW: Local state for quick command tags switch
const terminalScrollbackLimitLocal = ref<number | null>(null); // NEW: Local state for terminal scrollback limit input (allow null for empty input)
const fileManagerShowDeleteConfirmationLocal = ref(true); // NEW: Local state for file manager delete confirmation
 
 // --- Local UI feedback state ---
const ipWhitelistLoading = ref(false);
const ipWhitelistMessage = ref('');
const ipWhitelistSuccess = ref(false);
const languageLoading = ref(false);
const languageMessage = ref('');
const languageSuccess = ref(false);
const blacklistSettingsLoading = ref(false);
const blacklistSettingsMessage = ref('');
const blacklistSettingsSuccess = ref(false);
// Removed ipBlacklistEnabledLoading, ipBlacklistEnabledMessage, ipBlacklistEnabledSuccess refs


const popupEditorLoading = ref(false);
const popupEditorMessage = ref('');
const popupEditorSuccess = ref(false);
const shareTabsEnabled = ref(true); // 本地状态，用于共享标签页 v-model
const shareTabsLoading = ref(false);
const shareTabsMessage = ref('');
const shareTabsSuccess = ref(false);
const autoCopyEnabled = ref(false); // 本地状态，用于选中即复制 v-model
const autoCopyLoading = ref(false);
const autoCopyMessage = ref('');
const autoCopySuccess = ref(false);
const dockerInterval = ref(2); // 本地状态，用于 Docker 刷新间隔 v-model
const dockerExpandDefault = ref(false); // 本地状态，用于 Docker 默认展开 v-model
const dockerSettingsLoading = ref(false);
const dockerSettingsMessage = ref('');
const dockerSettingsSuccess = ref(false);
const statusMonitorIntervalLocal = ref(3); // 本地状态，用于状态监控间隔 v-model
const statusMonitorLoading = ref(false);
const statusMonitorMessage = ref('');
const statusMonitorSuccess = ref(false);
const workspaceSidebarPersistentLoading = ref(false); // 新增
const workspaceSidebarPersistentMessage = ref(''); // 新增
const workspaceSidebarPersistentSuccess = ref(false); // 新增
const commandInputSyncLoading = ref(false); // NEW
const commandInputSyncMessage = ref(''); // NEW
const commandInputSyncSuccess = ref(false); // NEW
const selectedTimezone = ref('UTC'); // 本地状态，用于时区 v-model
const timezoneLoading = ref(false);
const timezoneMessage = ref('');
const timezoneSuccess = ref(false);
const showConnectionTagsLoading = ref(false); // NEW
const showConnectionTagsMessage = ref(''); // NEW
const showConnectionTagsSuccess = ref(false); // NEW
const showQuickCommandTagsLoading = ref(false); // NEW
const showQuickCommandTagsMessage = ref(''); // NEW
const showQuickCommandTagsSuccess = ref(false); // NEW
const terminalScrollbackLimitLoading = ref(false); // NEW
const terminalScrollbackLimitMessage = ref(''); // NEW
const terminalScrollbackLimitSuccess = ref(false); // NEW
const fileManagerShowDeleteConfirmationLoading = ref(false); // NEW
const fileManagerShowDeleteConfirmationMessage = ref(''); // NEW
const fileManagerShowDeleteConfirmationSuccess = ref(false); // NEW
// CAPTCHA Form State
const captchaForm = reactive<UpdateCaptchaSettingsDto>({ // Use reactive for the form object
    enabled: false,
    provider: 'none',
    hcaptchaSiteKey: '',
    hcaptchaSecretKey: '',
    recaptchaSiteKey: '',
    recaptchaSecretKey: '',
});
const captchaLoading = ref(false);
const captchaMessage = ref('');
const captchaSuccess = ref(false);

// --- Auto Login Settings State ---
const autoLoginSettingsForm = reactive({
 cloudflareEnabled: false,
 cloudflareTrustedIPs: '',
 ipWhitelistEnabled: false,
 ipWhitelistAllowedIPs: '',
});
const autoLoginSettingsLoading = ref(false);
const autoLoginSettingsMessage = ref('');
const autoLoginSettingsSuccess = ref(false);


// Removed Passkey Deletion State


// 提供一些常用的时区供选择
const commonTimezones = ref([
  'UTC',
  'Etc/GMT+12', 'Pacific/Midway', 'Pacific/Honolulu', 'America/Anchorage',
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Caracas', 'America/Halifax', 'America/Sao_Paulo', 'Atlantic/Azores',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
  'Etc/GMT-14'
]);

// --- Watcher to sync local form state with store state ---
watch(settings, (newSettings, oldSettings) => {
  // Initialize only if settings were previously null or undefined
  const isInitialLoad = !oldSettings;

  ipWhitelistInput.value = newSettings.ipWhitelist || '';
  // selectedLanguage.value = newSettings.language || 'en'; // <-- 移除这一行，selectedLanguage 现在由 v-model 更新
  blacklistSettingsForm.maxLoginAttempts = newSettings.maxLoginAttempts || '5';
  blacklistSettingsForm.loginBanDuration = newSettings.loginBanDuration || '300';

  // 始终将本地布尔状态与 store 的布尔 getter 同步 (除了 language)
  popupEditorEnabled.value = showPopupFileEditorBoolean.value;
  shareTabsEnabled.value = shareFileEditorTabsBoolean.value;
  autoCopyEnabled.value = autoCopyOnSelectBoolean.value; // 同步选中即复制状态
  dockerInterval.value = parseInt(newSettings.dockerStatusIntervalSeconds || '2', 10); // 同步 Docker 间隔
  dockerExpandDefault.value = dockerDefaultExpandBoolean.value; // 同步 Docker 默认展开状态
  statusMonitorIntervalLocal.value = statusMonitorIntervalSecondsNumber.value; // 同步状态监控间隔
  workspaceSidebarPersistentEnabled.value = workspaceSidebarPersistentBoolean.value; // 新增：同步侧边栏固定设置
  commandInputSyncTargetLocal.value = commandInputSyncTarget.value; // NEW: Sync command input sync target
  selectedTimezone.value = newSettings.timezone || 'UTC'; // 同步时区设置
  ipBlacklistEnabled.value = ipBlacklistEnabledBoolean.value; // <-- Sync IP Blacklist enabled state
  showConnectionTagsLocal.value = showConnectionTagsBoolean.value; // NEW: Sync connection tags state
  showQuickCommandTagsLocal.value = showQuickCommandTagsBoolean.value; // NEW: Sync quick command tags state
  // NEW: Directly sync terminal scrollback limit from store getter to local state
  terminalScrollbackLimitLocal.value = terminalScrollbackLimitNumber.value;
  // NEW: Sync file manager delete confirmation
  fileManagerShowDeleteConfirmationLocal.value = fileManagerShowDeleteConfirmationBoolean.value;
  
  // Sync Auto Login Settings from store to local form
  if (newSettings) { // Ensure newSettings is not null/undefined
    // Helper function to safely convert to boolean
    const toBoolean = (value: any): boolean => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toLowerCase() === 'true';
      return false; // Default to false if undefined or other types
    };

    autoLoginSettingsForm.cloudflareEnabled = toBoolean(newSettings.autoLoginCloudflareEnabled);
    autoLoginSettingsForm.cloudflareTrustedIPs = newSettings.autoLoginCloudflareTrustedIPs || '';
    autoLoginSettingsForm.ipWhitelistEnabled = toBoolean(newSettings.autoLoginIpWhitelistEnabled);
    autoLoginSettingsForm.ipWhitelistAllowedIPs = newSettings.autoLoginIpWhitelistAllowedIPs || '';
  }

}, { deep: true, immediate: true }); // immediate: true to run on initial load

// Watcher for CAPTCHA settings
watch(captchaSettings, (newCaptchaSettings) => {
    if (newCaptchaSettings) {
        captchaForm.enabled = newCaptchaSettings.enabled;
        captchaForm.provider = newCaptchaSettings.provider;
        captchaForm.hcaptchaSiteKey = newCaptchaSettings.hcaptchaSiteKey || '';
        captchaForm.hcaptchaSecretKey = newCaptchaSettings.hcaptchaSecretKey || ''; // Keep secret keys local
        captchaForm.recaptchaSiteKey = newCaptchaSettings.recaptchaSiteKey || '';
        captchaForm.recaptchaSecretKey = newCaptchaSettings.recaptchaSecretKey || ''; // Keep secret keys local
    } else {
        // Reset form if settings are null (e.g., on error)
        captchaForm.enabled = false;
        captchaForm.provider = 'none';
        captchaForm.hcaptchaSiteKey = '';
        captchaForm.hcaptchaSecretKey = '';
        captchaForm.recaptchaSiteKey = '';
        captchaForm.recaptchaSecretKey = '';
    }
}, { immediate: true }); // immediate: true to run on initial load


// Watcher specifically for terminalScrollbackLimitNumber is redundant if the main settings watcher handles it.
// Let's remove the specific watcher for simplicity, the main one should suffice.

// --- Popup Editor setting method ---
const handleUpdatePopupEditorSetting = async () => {
    popupEditorLoading.value = true;
    popupEditorMessage.value = '';
    popupEditorSuccess.value = false;
    try {
        // 将布尔值转换为字符串 'true' 或 'false' 来存储
        const valueToSave = popupEditorEnabled.value ? 'true' : 'false';
        await settingsStore.updateSetting('showPopupFileEditor', valueToSave);
        popupEditorMessage.value = t('settings.popupEditor.success.saved'); // 需要添加翻译
        popupEditorSuccess.value = true;
    } catch (error: any) {
        console.error('更新弹窗编辑器设置失败:', error);
        popupEditorMessage.value = error.message || t('settings.popupEditor.error.saveFailed'); // 需要添加翻译
        popupEditorSuccess.value = false;
        // 保存失败时，不需要手动恢复，v-model 应该保持用户最后的操作状态
        // popupEditorEnabled.value = showPopupFileEditorBoolean.value; // <-- 移除恢复逻辑
    } finally {
        popupEditorLoading.value = false;
    }
};

// --- Share Editor Tabs setting method ---
const handleUpdateShareTabsSetting = async () => {
    shareTabsLoading.value = true;
    shareTabsMessage.value = '';
    shareTabsSuccess.value = false;
    try {
        const valueToSave = shareTabsEnabled.value ? 'true' : 'false';
        await settingsStore.updateSetting('shareFileEditorTabs', valueToSave);
        shareTabsMessage.value = t('settings.shareEditorTabs.success.saved'); // 需要添加翻译
        shareTabsSuccess.value = true;
    } catch (error: any) {
        console.error('更新共享编辑器标签页设置失败:', error);
        shareTabsMessage.value = error.message || t('settings.shareEditorTabs.error.saveFailed'); // 需要添加翻译
        shareTabsSuccess.value = false;
        // 保存失败时，不需要手动恢复
        // shareTabsEnabled.value = shareFileEditorTabsBoolean.value; // <-- 移除恢复逻辑
    } finally {
        shareTabsLoading.value = false;
    }
};

// --- Auto Copy on Select setting method ---
const handleUpdateAutoCopySetting = async () => {
    autoCopyLoading.value = true;
    autoCopyMessage.value = '';
    autoCopySuccess.value = false;
    try {
        const valueToSave = autoCopyEnabled.value ? 'true' : 'false';
        await settingsStore.updateSetting('autoCopyOnSelect', valueToSave);
        autoCopyMessage.value = t('settings.autoCopyOnSelect.success.saved'); // 需要添加翻译
        autoCopySuccess.value = true;
    } catch (error: any) {
        console.error('更新自动复制设置失败:', error);
        autoCopyMessage.value = error.message || t('settings.autoCopyOnSelect.error.saveFailed'); // 需要添加翻译
        autoCopySuccess.value = false;
    } finally {
        autoCopyLoading.value = false;
    }
};

// --- Docker settings method ---
const handleUpdateDockerSettings = async () => {
    dockerSettingsLoading.value = true;
    dockerSettingsMessage.value = '';
    dockerSettingsSuccess.value = false;
    try {
        const intervalValue = dockerInterval.value;
        if (isNaN(intervalValue) || intervalValue < 1) {
            throw new Error(t('settings.docker.error.invalidInterval')); // 需要添加翻译
        }
        await settingsStore.updateMultipleSettings({
            dockerStatusIntervalSeconds: String(intervalValue), // 保存为字符串
            dockerDefaultExpand: dockerExpandDefault.value ? 'true' : 'false' // 保存为字符串 'true'/'false'
        });
        dockerSettingsMessage.value = t('settings.docker.success.saved'); // 需要添加翻译
        dockerSettingsSuccess.value = true;
    } catch (error: any) {
        console.error('更新 Docker 设置失败:', error);
        dockerSettingsMessage.value = error.message || t('settings.docker.error.saveFailed'); // 需要添加翻译
        dockerSettingsSuccess.value = false;
    } finally {
        dockerSettingsLoading.value = false;
    }
};

// --- Status Monitor interval setting method ---
const handleUpdateStatusMonitorInterval = async () => {
    statusMonitorLoading.value = true;
    statusMonitorMessage.value = '';
    statusMonitorSuccess.value = false;
    try {
        const intervalValue = statusMonitorIntervalLocal.value;
        if (isNaN(intervalValue) || intervalValue < 1 || !Number.isInteger(intervalValue)) {
            throw new Error(t('settings.statusMonitor.error.invalidInterval')); // 需要添加翻译
        }
        await settingsStore.updateSetting('statusMonitorIntervalSeconds', String(intervalValue)); // 保存为字符串
        statusMonitorMessage.value = t('settings.statusMonitor.success.saved'); // 需要添加翻译
        statusMonitorSuccess.value = true;
    } catch (error: any) {
        console.error('更新状态监控间隔失败:', error);
        statusMonitorMessage.value = error.message || t('settings.statusMonitor.error.saveFailed'); // 需要添加翻译
        statusMonitorSuccess.value = false;
    } finally {
        statusMonitorLoading.value = false;
    }
};

// --- Workspace Sidebar Persistent setting method ---
const handleUpdateWorkspaceSidebarSetting = async () => {
    workspaceSidebarPersistentLoading.value = true;
    workspaceSidebarPersistentMessage.value = '';
    workspaceSidebarPersistentSuccess.value = false;
    try {
        const valueToSave = workspaceSidebarPersistentEnabled.value ? 'true' : 'false';
        await settingsStore.updateSetting('workspaceSidebarPersistent', valueToSave);
        workspaceSidebarPersistentMessage.value = t('settings.workspace.success.sidebarPersistentSaved'); // 需要添加翻译
        workspaceSidebarPersistentSuccess.value = true;
    } catch (error: any) {
        console.error('更新侧边栏固定设置失败:', error);
        workspaceSidebarPersistentMessage.value = error.message || t('settings.workspace.error.sidebarPersistentSaveFailed'); // 需要添加翻译
        workspaceSidebarPersistentSuccess.value = false;
    } finally {
        workspaceSidebarPersistentLoading.value = false;
    }
};

// --- Command Input Sync Target setting method ---
const handleUpdateCommandInputSyncTarget = async () => {
    commandInputSyncLoading.value = true;
    commandInputSyncMessage.value = '';
    commandInputSyncSuccess.value = false;
    try {
        await settingsStore.updateSetting('commandInputSyncTarget', commandInputSyncTargetLocal.value);
        commandInputSyncMessage.value = t('settings.commandInputSync.success.saved', '同步目标已保存'); // 需要添加翻译
        commandInputSyncSuccess.value = true;
    } catch (error: any) {
        console.error('更新命令输入同步目标失败:', error);
        commandInputSyncMessage.value = error.message || t('settings.commandInputSync.error.saveFailed', '保存同步目标失败'); // 需要添加翻译
        commandInputSyncSuccess.value = false;
    } finally {
        commandInputSyncLoading.value = false;
    }
};

// --- Timezone setting method ---
const handleUpdateTimezone = async () => {
    timezoneLoading.value = true;
    timezoneMessage.value = '';
    timezoneSuccess.value = false;
    try {
        await settingsStore.updateSetting('timezone', selectedTimezone.value);
        timezoneMessage.value = t('settings.timezone.success.saved');
        timezoneSuccess.value = true;
    } catch (error: any) {
        console.error('更新时区设置失败:', error);
        timezoneMessage.value = error.message || t('settings.timezone.error.saveFailed');
        timezoneSuccess.value = false;
    } finally {
        timezoneLoading.value = false;
    }
};

// --- Show Connection Tags setting method ---
const handleUpdateShowConnectionTags = async () => {
    showConnectionTagsLoading.value = true;
    showConnectionTagsMessage.value = '';
    showConnectionTagsSuccess.value = false;
    try {
        await settingsStore.updateSetting('showConnectionTags', showConnectionTagsLocal.value);
        showConnectionTagsMessage.value = t('settings.workspace.success.showConnectionTagsSaved', '连接标签显示设置已保存'); // 需要添加翻译
        showConnectionTagsSuccess.value = true;
    } catch (error: any) {
        console.error('更新显示连接标签设置失败:', error);
        showConnectionTagsMessage.value = error.message || t('settings.workspace.error.showConnectionTagsSaveFailed', '保存连接标签显示设置失败'); // 需要添加翻译
        showConnectionTagsSuccess.value = false;
        // No need to revert local state on failure with explicit save button
    } finally {
        showConnectionTagsLoading.value = false;
        // Keep message visible until next save attempt
    }
};

// --- Show Quick Command Tags setting method ---
const handleUpdateShowQuickCommandTags = async () => {
    showQuickCommandTagsLoading.value = true;
    showQuickCommandTagsMessage.value = '';
    showQuickCommandTagsSuccess.value = false;
    try {
        await settingsStore.updateSetting('showQuickCommandTags', showQuickCommandTagsLocal.value);
        showQuickCommandTagsMessage.value = t('settings.workspace.success.showQuickCommandTagsSaved', '快捷指令标签显示设置已保存'); // 需要添加翻译
        showQuickCommandTagsSuccess.value = true;
    } catch (error: any) {
        console.error('更新显示快捷指令标签设置失败:', error);
        showQuickCommandTagsMessage.value = error.message || t('settings.workspace.error.showQuickCommandTagsSaveFailed', '保存快捷指令标签显示设置失败'); // 需要添加翻译
        showQuickCommandTagsSuccess.value = false;
        // No need to revert local state on failure with explicit save button
    } finally {
        showQuickCommandTagsLoading.value = false;
        // Keep message visible until next save attempt
    }
};

// --- Terminal Scrollback Limit setting method ---
const handleUpdateTerminalScrollbackLimit = async () => {
    terminalScrollbackLimitLoading.value = true;
    terminalScrollbackLimitMessage.value = '';
    terminalScrollbackLimitSuccess.value = false;
    try {
        const limitValue = terminalScrollbackLimitLocal.value;

        // Validate: must be a non-negative integer or null/undefined (treat null/undefined as default 5000)
        if (limitValue !== null && limitValue !== undefined && (isNaN(limitValue) || !Number.isInteger(limitValue) || limitValue < 0)) {
            throw new Error(t('settings.terminalScrollback.error.invalidInput', '请输入一个有效的非负整数。'));
        }

        // If input is empty (null/undefined), save the default value '5000'. Otherwise, save the entered number as string.
        const valueToSave = (limitValue === null || limitValue === undefined) ? '5000' : String(limitValue);

        await settingsStore.updateSetting('terminalScrollbackLimit', valueToSave);
        terminalScrollbackLimitMessage.value = t('settings.terminalScrollback.success.saved', '终端回滚行数设置已保存。');
        terminalScrollbackLimitSuccess.value = true;
    } catch (error: any) {
        console.error('更新终端回滚行数设置失败:', error);
        terminalScrollbackLimitMessage.value = error.message || t('settings.terminalScrollback.error.saveFailed', '保存终端回滚行数设置失败。');
        terminalScrollbackLimitSuccess.value = false;
    } finally {
        terminalScrollbackLimitLoading.value = false;
    }
  };
   
  // --- File Manager Delete Confirmation setting method ---
  const handleUpdateFileManagerDeleteConfirmation = async () => {
      fileManagerShowDeleteConfirmationLoading.value = true;
      fileManagerShowDeleteConfirmationMessage.value = '';
      fileManagerShowDeleteConfirmationSuccess.value = false;
      try {
          const valueToSave = fileManagerShowDeleteConfirmationLocal.value ? 'true' : 'false';
          await settingsStore.updateSetting('fileManagerShowDeleteConfirmation', valueToSave);
          fileManagerShowDeleteConfirmationMessage.value = t('settings.workspace.fileManagerDeleteConfirmSuccess', '文件管理器删除确认设置已保存。'); // 需要添加翻译
          fileManagerShowDeleteConfirmationSuccess.value = true;
      } catch (error: any) {
          console.error('更新文件管理器删除确认设置失败:', error);
          fileManagerShowDeleteConfirmationMessage.value = error.message || t('settings.workspace.fileManagerDeleteConfirmError', '保存文件管理器删除确认设置失败。'); // 需要添加翻译
          fileManagerShowDeleteConfirmationSuccess.value = false;
      } finally {
          fileManagerShowDeleteConfirmationLoading.value = false;
      }
  };
   
   // --- 外观设置 ---
const openStyleCustomizer = () => {
    appearanceStore.toggleStyleCustomizer(true);
};

// --- Passkey state & methods Removed ---

// --- Formatting function (kept in case other parts need it, can be removed if unused) ---
const formatDate = (timestamp: number | undefined) => {
    if (!timestamp) return t('statusMonitor.notAvailable');
    try {
        return new Date(timestamp * 1000).toLocaleString();
    } catch (e) {
        console.error("Error formatting date:", e);
        return t('statusMonitor.notAvailable');
    }
};


// --- Change Password state & methods --- (Keep as is)
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const changePasswordLoading = ref(false);
const changePasswordMessage = ref('');
const changePasswordSuccess = ref(false);
const handleChangePassword = async () => {
  changePasswordMessage.value = '';
  changePasswordSuccess.value = false;
  if (newPassword.value !== confirmPassword.value) {
    changePasswordMessage.value = t('settings.changePassword.error.passwordsDoNotMatch');
    return;
  }
  changePasswordLoading.value = true;
  try {
    await authStore.changePassword(currentPassword.value, newPassword.value);
    changePasswordMessage.value = t('settings.changePassword.success');
    changePasswordSuccess.value = true;
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
  } catch (error: any) {
    console.error('修改密码失败:', error);
    changePasswordMessage.value = error.message || t('settings.changePassword.error.generic');
    changePasswordSuccess.value = false;
  } finally {
    changePasswordLoading.value = false;
  }
};

// --- 2FA state & methods --- (Keep as is)
const twoFactorEnabled = ref(false);
const twoFactorLoading = ref(false);
const twoFactorMessage = ref('');
const twoFactorSuccess = ref(false);
const setupData = ref<{ secret: string; qrCodeUrl: string } | null>(null);
const verificationCode = ref('');
const disablePassword = ref('');
const isSettingUp2FA = computed(() => setupData.value !== null);
const checkTwoFactorStatus = async () => {
  await authStore.checkAuthStatus();
  twoFactorEnabled.value = authStore.user?.isTwoFactorEnabled ?? false;
};
const handleSetup2FA = async () => {
  twoFactorMessage.value = ''; twoFactorSuccess.value = false; twoFactorLoading.value = true;
  setupData.value = null; verificationCode.value = '';
  try {
    const response = await apiClient.post<{ secret: string; qrCodeUrl: string }>('/auth/2fa/setup'); // 使用 apiClient
    setupData.value = response.data;
  } catch (error: any) {
    console.error('开始设置 2FA 失败:', error);
    twoFactorMessage.value = error.response?.data?.message || t('settings.twoFactor.error.setupFailed');
  } finally { twoFactorLoading.value = false; }
};
const handleVerifyAndActivate2FA = async () => {
  if (!setupData.value || !verificationCode.value) {
    twoFactorMessage.value = t('settings.twoFactor.error.codeRequired'); return;
  }
  twoFactorMessage.value = ''; twoFactorSuccess.value = false; twoFactorLoading.value = true;
  try {
    await apiClient.post('/auth/2fa/verify', { token: verificationCode.value }); // 使用 apiClient
    twoFactorMessage.value = t('settings.twoFactor.success.activated');
    twoFactorSuccess.value = true; twoFactorEnabled.value = true;
    setupData.value = null; verificationCode.value = '';
  } catch (error: any) {
    console.error('验证并激活 2FA 失败:', error);
    twoFactorMessage.value = error.response?.data?.message || t('settings.twoFactor.error.verificationFailed');
  } finally { twoFactorLoading.value = false; }
};
const handleDisable2FA = async () => {
  if (!disablePassword.value) {
    twoFactorMessage.value = t('settings.twoFactor.error.passwordRequiredForDisable'); return;
  }
  twoFactorMessage.value = ''; twoFactorSuccess.value = false; twoFactorLoading.value = true;
  try {
    await apiClient.delete('/auth/2fa', { data: { password: disablePassword.value } }); // 使用 apiClient
    twoFactorMessage.value = t('settings.twoFactor.success.disabled');
    twoFactorSuccess.value = true; twoFactorEnabled.value = false;
    disablePassword.value = '';
  } catch (error: any) {
    console.error('禁用 2FA 失败:', error);
    twoFactorMessage.value = error.response?.data?.message || t('settings.twoFactor.error.disableFailed');
  } finally { twoFactorLoading.value = false; }
};
const cancelSetup = () => {
    setupData.value = null; verificationCode.value = ''; twoFactorMessage.value = '';
};

// --- Language settings method --- (Refactored)
const handleUpdateLanguage = async () => {
    languageLoading.value = true;
    languageMessage.value = '';
    languageSuccess.value = false;
    try {
        await settingsStore.updateSetting('language', selectedLanguage.value);
        languageMessage.value = t('settings.language.success.saved');
        languageSuccess.value = true;
    } catch (error: any) {
        console.error('更新语言设置失败:', error);
        languageMessage.value = error.message || t('settings.language.error.saveFailed');
        languageSuccess.value = false;
    } finally {
        languageLoading.value = false;
    }
};

// --- IP Whitelist method --- (Refactored)
const handleUpdateIpWhitelist = async () => {
    ipWhitelistLoading.value = true;
    ipWhitelistMessage.value = '';
    ipWhitelistSuccess.value = false;
    try {
        await settingsStore.updateSetting('ipWhitelist', ipWhitelistInput.value.trim());
        ipWhitelistMessage.value = t('settings.ipWhitelist.success.saved');
        ipWhitelistSuccess.value = true;
    } catch (error: any) {
        console.error('更新 IP 白名单失败:', error);
        ipWhitelistMessage.value = error.message || t('settings.ipWhitelist.error.saveFailed');
        ipWhitelistSuccess.value = false;
    } finally {
        ipWhitelistLoading.value = false;
    }
};

// --- IP Blacklist state & methods --- (Keep fetch/delete as is, update uses store)
const ipBlacklist = reactive({
    entries: [] as any[],
    total: 0,
    loading: false,
    error: null as string | null,
    currentPage: 1,
    limit: 10,
});
const blacklistToDeleteIp = ref<string | null>(null);
const blacklistDeleteLoading = ref(false);
const blacklistDeleteError = ref<string | null>(null);

const fetchIpBlacklist = async (page = 1) => {
    ipBlacklist.loading = true;
    ipBlacklist.error = null;
    const offset = (page - 1) * ipBlacklist.limit;
    try {
        // Assuming fetchIpBlacklist is still needed from authStore
        const data = await authStore.fetchIpBlacklist(ipBlacklist.limit, offset);
        ipBlacklist.entries = data.entries;
        ipBlacklist.total = data.total;
        ipBlacklist.currentPage = page;
    } catch (error: any) {
        ipBlacklist.error = error.message || t('settings.ipBlacklist.error.fetchFailed');
    } finally {
        ipBlacklist.loading = false;
    }
};

const handleDeleteIp = async (ip: string) => {
    blacklistToDeleteIp.value = ip;
    if (confirm(t('settings.ipBlacklist.confirmRemoveIp', { ip }))) {
        blacklistDeleteLoading.value = true;
        blacklistDeleteError.value = null;
        try {
            // Assuming deleteIpFromBlacklist is still needed from authStore
            await authStore.deleteIpFromBlacklist(ip);
            await fetchIpBlacklist(ipBlacklist.currentPage);
        } catch (error: any) {
            blacklistDeleteError.value = error.message || t('settings.ipBlacklist.error.deleteFailed');
        } finally {
            blacklistDeleteLoading.value = false;
            blacklistToDeleteIp.value = null;
        }
    } else {
        blacklistToDeleteIp.value = null;
    }
};

// Update Blacklist Config method (Refactored)
const handleUpdateBlacklistSettings = async () => {
    blacklistSettingsLoading.value = true;
    blacklistSettingsMessage.value = '';
    blacklistSettingsSuccess.value = false;
    try {
        const maxAttempts = parseInt(blacklistSettingsForm.maxLoginAttempts, 10);
        const banDuration = parseInt(blacklistSettingsForm.loginBanDuration, 10);
        if (isNaN(maxAttempts) || maxAttempts <= 0) {
            throw new Error(t('settings.ipBlacklist.error.invalidMaxAttempts'));
        }
        if (isNaN(banDuration) || banDuration <= 0) {
            throw new Error(t('settings.ipBlacklist.error.invalidBanDuration'));
        }
        await settingsStore.updateMultipleSettings({
            maxLoginAttempts: blacklistSettingsForm.maxLoginAttempts,
            loginBanDuration: blacklistSettingsForm.loginBanDuration,
        });
        blacklistSettingsMessage.value = t('settings.ipBlacklist.success.configUpdated');
        blacklistSettingsSuccess.value = true;
    } catch (error: any) {
        console.error('更新黑名单配置失败:', error);
        blacklistSettingsMessage.value = error.message || t('settings.ipBlacklist.error.updateConfigFailed');
        blacklistSettingsSuccess.value = false;
    } finally {
        blacklistSettingsLoading.value = false;
    }
};

// --- IP Blacklist Enable/Disable Method (Button Style) ---
const handleUpdateIpBlacklistEnabled = async () => {
   // Toggle local state immediately for instant UI feedback
   const originalValue = ipBlacklistEnabled.value;
   ipBlacklistEnabled.value = !ipBlacklistEnabled.value;

   try {
       const valueToSave = ipBlacklistEnabled.value ? 'true' : 'false';
       await settingsStore.updateSetting('ipBlacklistEnabled', valueToSave);
       // Save successful, no message needed for toggle switch
       console.log('IP Blacklist enabled status saved:', valueToSave);
   } catch (error: any) {
       console.error('更新 IP 黑名单启用状态失败:', error);
       // Optionally show error notification to user here
       // Revert button state on failure
       ipBlacklistEnabled.value = originalValue; // Revert to original value
   }
   // No loading/message state management needed
};

// --- CAPTCHA Settings Method ---
const handleUpdateCaptchaSettings = async () => {
    captchaLoading.value = true;
    captchaMessage.value = '';
    captchaSuccess.value = false;
    try {
        // Prepare DTO, only sending secret keys if they have been entered
        const dto: UpdateCaptchaSettingsDto = {
            enabled: captchaForm.enabled,
            provider: captchaForm.provider,
            // Site keys are not sensitive, send them if present
            hcaptchaSiteKey: captchaForm.hcaptchaSiteKey || '',
            recaptchaSiteKey: captchaForm.recaptchaSiteKey || '',
        };

        // Only include secret keys in the DTO if the user entered a value
        if (captchaForm.hcaptchaSecretKey) {
            dto.hcaptchaSecretKey = captchaForm.hcaptchaSecretKey;
        }
        if (captchaForm.recaptchaSecretKey) {
            dto.recaptchaSecretKey = captchaForm.recaptchaSecretKey;
        }

        await settingsStore.updateCaptchaSettings(dto);
        captchaMessage.value = t('settings.captcha.success.saved'); // Need translation
        captchaSuccess.value = true;
        // Clear secret key fields in the form after successful save for security
        captchaForm.hcaptchaSecretKey = '';
        captchaForm.recaptchaSecretKey = '';
    } catch (error: any) {
        console.error('更新 CAPTCHA 设置失败:', error);
        captchaMessage.value = error.message || t('settings.captcha.error.saveFailed'); // Need translation
        captchaSuccess.value = false;
    } finally {
        captchaLoading.value = false;
    }
};

// --- Auto Login Settings Method ---
const handleUpdateAutoLoginSettings = async () => {
 autoLoginSettingsLoading.value = true;
 autoLoginSettingsMessage.value = '';
 autoLoginSettingsSuccess.value = false;
 try {
   const settingsToSave = {
     autoLoginCloudflareEnabled: autoLoginSettingsForm.cloudflareEnabled ? 'true' : 'false',
     autoLoginCloudflareTrustedIPs: autoLoginSettingsForm.cloudflareTrustedIPs.trim(),
     autoLoginIpWhitelistEnabled: autoLoginSettingsForm.ipWhitelistEnabled ? 'true' : 'false',
     autoLoginIpWhitelistAllowedIPs: autoLoginSettingsForm.ipWhitelistAllowedIPs.trim(),
   };
   // Assuming a new action in settingsStore or using updateMultipleSettings
   await settingsStore.updateMultipleSettings(settingsToSave);
   // Or if you create a specific action: await settingsStore.updateAutoLoginSettings(autoLoginSettingsForm);

   autoLoginSettingsMessage.value = t('settings.autoLogin.success.saved', '自动登录设置已保存。');
   autoLoginSettingsSuccess.value = true;
 } catch (error: any) {
   console.error('更新自动登录设置失败:', error);
   autoLoginSettingsMessage.value = error.message || t('settings.autoLogin.error.saveFailed', '保存自动登录设置失败。');
   autoLoginSettingsSuccess.value = false;
 } finally {
   autoLoginSettingsLoading.value = false;
 }
};


// --- Version Check Function ---
const checkLatestVersion = async () => {
  isCheckingVersion.value = true;
  versionCheckError.value = null;
  latestVersion.value = null;
  try {
    // 使用 GitHub API 获取最新的 release 信息
    // 移除 headers 以避免 CORS 问题
    const response = await axios.get('https://api.github.com/repos/Heavrnl/nexus-terminal/releases/latest');
    if (response.data && response.data.tag_name) {
      latestVersion.value = response.data.tag_name;
    } else {
      throw new Error('Invalid API response format');
    }
  } catch (error: any) {
    console.error('检查最新版本失败:', error);
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      versionCheckError.value = t('settings.about.error.noReleases'); // 没有找到发布版本
    } else if (axios.isAxiosError(error) && error.response?.status === 403) {
       versionCheckError.value = t('settings.about.error.rateLimit'); // API 速率限制
    } else {
      versionCheckError.value = t('settings.about.error.checkFailed'); // 通用检查失败
    }
  } finally {
    isCheckingVersion.value = false;
  }
};

// --- Lifecycle Hooks ---
onMounted(async () => {
  await checkTwoFactorStatus(); // Check 2FA status
  await fetchIpBlacklist(); // Fetch current blacklist entries
  await settingsStore.loadCaptchaSettings(); // <-- Load CAPTCHA settings
  await checkLatestVersion(); // <-- Check for latest version on mount
  // Removed fetchPasskeys call: await authStore.fetchPasskeys();
  // Initial settings (including language, whitelist, blacklist config) are loaded in main.ts via settingsStore.loadInitialSettings()
});

</script>

<style scoped>
/* Remove all scoped styles as they are now handled by Tailwind utility classes */
</style>

