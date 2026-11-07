<template>
  <div class="settings-section-content">
    <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.oidc.title') }}</h3>
    <p class="text-sm text-text-secondary mb-4">{{ $t('settings.oidc.description') }}</p>

    <div v-if="loading" class="p-4 text-center text-text-secondary italic">{{ $t('common.loading') }}</div>

    <div v-else class="space-y-6">
      <!-- ============ Provider 列表（增删改） ============ -->
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <h4 class="text-sm font-semibold text-foreground">{{ $t('settings.oidc.providersTitle') }}</h4>
          <button type="button" @click="addProvider"
                  class="px-3 py-1.5 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-xs font-medium">
            {{ $t('settings.oidc.addProvider') }}
          </button>
        </div>

        <p v-if="providers.length === 0" class="text-sm text-text-secondary italic">
          {{ $t('settings.oidc.noProviders') }}
        </p>

        <div v-for="(provider, index) in providers" :key="provider.id || `new-${index}`"
             class="border border-border rounded-md p-4 space-y-3 bg-header/10">
          <div class="flex items-center justify-between">
            <span class="text-xs text-text-tertiary">
              {{ provider.isNew ? $t('settings.oidc.newProviderBadge') : provider.id }}
            </span>
            <button type="button" @click="removeProvider(index)"
                    class="px-2 py-1 bg-error text-error-text rounded-md text-xs font-medium hover:bg-error/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-error transition duration-150 ease-in-out">
              {{ $t('common.delete') }}
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">{{ $t('settings.oidc.nameLabel') }}</label>
              <input type="text" v-model="provider.name"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm" />
            </div>
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">{{ $t('settings.oidc.issuerUrlLabel') }}</label>
              <input type="text" v-model="provider.issuerUrl" placeholder="https://kc.example.com/realms/myrealm"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm" />
            </div>
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">{{ $t('settings.oidc.clientIdLabel') }}</label>
              <input type="text" v-model="provider.clientId"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm" />
            </div>
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">{{ $t('settings.oidc.clientSecretLabel') }}</label>
              <input type="password" v-model="provider.clientSecret" placeholder="••••••••••••" autocomplete="new-password"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm" />
              <small class="block mt-1 text-xs text-text-secondary">
                {{ provider.hasClientSecret ? $t('settings.oidc.clientSecretConfigured') : $t('settings.oidc.clientSecretNotConfigured') }}
                — {{ $t('settings.oidc.clientSecretHint') }}
              </small>
            </div>
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">{{ $t('settings.oidc.scopesLabel') }}</label>
              <input type="text" v-model="provider.scopes" placeholder="openid profile email"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm" />
            </div>
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">{{ $t('settings.oidc.iconUrlLabel') }}</label>
              <input type="text" v-model="provider.iconUrl" :placeholder="$t('settings.oidc.iconUrlPlaceholder')"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm" />
            </div>
            <div class="sm:col-span-2">
              <label class="block text-xs font-medium text-text-secondary mb-1">{{ $t('settings.oidc.allowedEmailDomainsLabel') }}</label>
              <input type="text" v-model="provider.allowedEmailDomains" :placeholder="$t('settings.oidc.allowedEmailDomainsPlaceholder')"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm" />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-4">
            <label class="flex items-center text-sm text-foreground cursor-pointer select-none">
              <input type="checkbox" v-model="provider.enabled"
                     class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
              {{ $t('settings.oidc.enabledLabel') }}
            </label>
            <label class="flex items-center text-sm text-foreground cursor-pointer select-none">
              <input type="checkbox" v-model="provider.autoCreateUser"
                     class="h-4 w-4 rounded border-border text-primary focus:ring-primary mr-2 cursor-pointer">
              {{ $t('settings.oidc.autoCreateUserLabel') }}
            </label>
          </div>
        </div>

        <div class="flex items-center justify-between pt-1">
          <button type="button" @click="saveProviders" :disabled="saving"
                  class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed">
            {{ saving ? $t('common.loading') : $t('settings.oidc.saveButton') }}
          </button>
          <p v-if="errorMessage" class="text-sm text-error">{{ errorMessage }}</p>
        </div>
      </div>

      <hr class="border-border/50">

      <!-- ============ 已绑定账号 ============ -->
      <div class="space-y-3">
        <h4 class="text-sm font-semibold text-foreground">{{ $t('settings.oidc.linksTitle') }}</h4>
        <p class="text-xs text-text-secondary">{{ $t('settings.oidc.linksDescription') }}</p>

        <div v-if="links.length === 0" class="text-sm text-text-secondary italic">
          {{ $t('settings.oidc.noLinks') }}
        </div>

        <ul v-else class="space-y-2">
          <li v-for="link in links" :key="link.id"
              class="flex flex-col sm:flex-row justify-between items-start sm:items-center p-3 border border-border rounded-md bg-header/20">
            <div class="flex-grow mb-2 sm:mb-0">
              <div class="font-medium text-foreground text-sm">{{ link.providerName }}</div>
              <div class="text-xs text-text-secondary mt-1 space-x-2">
                <span v-if="link.email">{{ link.email }}</span>
                <span>{{ $t('settings.oidc.boundAt') }}: {{ formatDate(link.createdAt) }}</span>
                <span>{{ $t('settings.oidc.lastLoginAt') }}: {{ formatDate(link.lastLoginAt) }}</span>
              </div>
            </div>
            <button type="button" @click="unlink(link.id)"
                    class="px-3 py-1.5 bg-error text-error-text rounded-md text-xs font-medium hover:bg-error/80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-error transition duration-150 ease-in-out self-start sm:self-center">
              {{ $t('settings.oidc.unlinkButton') }}
            </button>
          </li>
        </ul>

        <!-- 绑定新账号：按已保存的 provider 逐个给按钮 -->
        <div v-if="savedProviders.length > 0" class="pt-2">
          <p class="text-xs font-medium text-text-secondary mb-2">{{ $t('settings.oidc.bindNewLabel') }}</p>
          <div class="flex flex-wrap gap-2">
            <button v-for="provider in savedProviders" :key="provider.id" type="button"
                    @click="bindProvider(provider.id!)"
                    class="px-3 py-1.5 bg-secondary text-black rounded-md text-xs font-medium hover:bg-secondary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-secondary transition duration-150 ease-in-out">
              {{ $t('settings.oidc.bindButton', { name: provider.name }) }}
            </button>
          </div>
        </div>
        <p v-else class="text-xs text-text-secondary italic">{{ $t('settings.oidc.bindNeedsProvider') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useOidcSettings } from '../../composables/settings/useOidcSettings';

const {
  providers,
  links,
  loading,
  saving,
  errorMessage,
  loadAll,
  addProvider,
  removeProvider,
  saveProviders,
  bindProvider,
  unlink,
  formatDate,
} = useOidcSettings();

// 只有已保存（有服务端 id）的 provider 才能用于绑定
const savedProviders = computed(() => providers.filter((p) => !p.isNew && !!p.id));

onMounted(() => {
  loadAll();
});
</script>

<style scoped>
/* Styles specific to OidcSettingsForm if any */
</style>
