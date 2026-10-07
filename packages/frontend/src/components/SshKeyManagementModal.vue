<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSshKeysStore, SshKeyBasicInfo, SshKeyInput } from '../stores/sshKeys.store';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import MobileSshKeyManagementModal from './MobileSshKeyManagementModal.vue';

const { isMobile } = useDeviceDetection();

const emit = defineEmits(['close']);

const { t } = useI18n();
const sshKeysStore = useSshKeysStore();
const uiNotificationsStore = useUiNotificationsStore();
const { showConfirmDialog } = useConfirmDialog();

const keys = computed(() => sshKeysStore.sshKeys);
const isLoading = computed(() => sshKeysStore.isLoading);

const isAddEditFormVisible = ref(false);
const keyToEdit = ref<SshKeyBasicInfo | null>(null); // Store basic info for editing

// Form data for adding/editing
const initialFormData: SshKeyInput = {
    name: '',
    private_key: '',
    passphrase: '',
};
const formData = reactive({ ...initialFormData });
const formError = ref<string | null>(null);

// Fetch keys when the modal is mounted
onMounted(() => {
    sshKeysStore.fetchSshKeys();
});

// Show the form for adding a new key
const showAddForm = () => {
    keyToEdit.value = null;
    Object.assign(formData, initialFormData); // Reset form
    formError.value = null;
    isAddEditFormVisible.value = true;
};

// Show the form for editing an existing key
const showEditForm = async (key: SshKeyBasicInfo) => {
    formError.value = null;
    keyToEdit.value = key; // Store the key being edited

    // Fetch decrypted details to pre-fill the form (excluding passphrase for security)
    const details = await sshKeysStore.fetchDecryptedSshKey(key.id);
    if (details) {
        formData.name = details.name;
        formData.private_key = ''; // Do not pre-fill private key, empty means no change
        formData.passphrase = ''; // Do not pre-fill passphrase
        isAddEditFormVisible.value = true;
    } else {
        // Handle error if details couldn't be fetched
        uiNotificationsStore.addNotification({ message: t('sshKeys.modal.errorFetchDetails'), type: 'error' });
        keyToEdit.value = null; // Reset edit state
    }
};

// Handle form submission (add or edit)
const handleSubmit = async () => {
    formError.value = null;
    if (!formData.name || (!keyToEdit.value && !formData.private_key)) { // Private key is required only for new keys
        formError.value = t('sshKeys.modal.errorRequiredFields');
        return;
    }

    let success = false;
    const dataToSend: Partial<SshKeyInput> = {
        name: formData.name,
    };

    // Add private_key to dataToSend only if it's provided by the user.
    // In edit mode, an empty formData.private_key means the user does not want to change the key.
    // In add mode, formData.private_key is guaranteed to be non-empty by the validation above.
    if (formData.private_key) {
        dataToSend.private_key = formData.private_key;
    }

    // Only send passphrase if it's not empty
    if (formData.passphrase) {
        dataToSend.passphrase = formData.passphrase;
    }


    if (keyToEdit.value) {
        // Edit mode
        // Only send fields that changed? Or send all? Backend handles update logic.
        // Let's send all potentially updatable fields for simplicity here.
        success = await sshKeysStore.updateSshKey(keyToEdit.value.id, dataToSend);
    } else {
        // Add mode
        success = await sshKeysStore.addSshKey(dataToSend as SshKeyInput); // Cast needed as all fields are required for add
    }

    if (success) {
        isAddEditFormVisible.value = false; // Close form on success
    } else {
        // Error message is handled by the store and displayed via uiNotificationsStore
        // Optionally set formError based on store error if needed for specific display
        formError.value = sshKeysStore.error;
    }
};

// Handle key deletion
const handleDelete = async (key: SshKeyBasicInfo) => {
  const confirmed = await showConfirmDialog({
    message: t('sshKeys.modal.confirmDelete', { name: key.name })
  });
  if (confirmed) {
    const success = await sshKeysStore.deleteSshKey(key.id);
    if (!success) {
        // Error handled by store
    }
     // If the deleted key was being edited, close the form
     if (keyToEdit.value?.id === key.id) {
        isAddEditFormVisible.value = false;
        keyToEdit.value = null;
    }
  }
};

// Cancel add/edit form
const cancelForm = () => {
    isAddEditFormVisible.value = false;
    keyToEdit.value = null;
};

</script>

<template>
  <MobileSshKeyManagementModal
    v-if="isMobile"
    @close="emit('close')"
  />
  <div v-else class="fixed inset-0 bg-overlay flex justify-center items-center z-50 p-4">
    <div class="bg-background text-foreground p-6 rounded-lg shadow-xl border border-border w-full max-w-3xl max-h-[80vh] flex flex-col">

            <!-- Main Modal Content -->
            <div v-if="!isAddEditFormVisible" class="flex flex-col h-full">
                <h3 class="text-xl font-semibold text-center mb-4 flex-shrink-0">{{ t('sshKeys.modal.title') }}</h3>

                <div class="mb-4 flex justify-end flex-shrink-0">
                    <button @click="showAddForm"
                            class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50"
                            :disabled="isLoading">
                        <i class="fas fa-plus mr-2" style="color: white;"></i>{{ t('sshKeys.modal.addKey') }} <!-- Use inline style for white color -->
                    </button>
                </div>

                <!-- Key List -->
                <div class="flex-grow overflow-y-auto border border-border rounded-md" style="max-height: 50vh;">
                    <table class="min-w-full divide-y divide-border">
                        <thead class="bg-header sticky top-0">
                            <tr>
                                <th scope="col" class="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                                    {{ t('sshKeys.modal.keyName') }}
                                </th>
                                <th scope="col" class="px-6 py-3 text-right text-xs font-medium text-text-secondary uppercase tracking-wider">
                                    {{ t('sshKeys.modal.actions') }}
                                </th>
                            </tr>
                        </thead>
                        <tbody class="bg-background divide-y divide-border">
                            <tr v-if="isLoading">
                                <td colspan="2" class="px-6 py-4 whitespace-nowrap text-sm text-text-secondary text-center">{{ t('sshKeys.modal.loading') }}</td>
                            </tr>
                            <tr v-else-if="keys.length === 0">
                                <td colspan="2" class="px-6 py-4 whitespace-nowrap text-sm text-text-secondary text-center">{{ t('sshKeys.modal.noKeys') }}</td>
                            </tr>
                            <tr v-for="key in keys" :key="key.id">
                                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-foreground">{{ key.name }}</td>
                                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                                    <button @click="showEditForm(key)" class="text-primary hover:text-primary-hover disabled:opacity-50" :disabled="isLoading" :title="t('sshKeys.modal.edit')">
                                        <i class="fas fa-pencil-alt"></i>
                                    </button>
                                    <button @click="handleDelete(key)" class="text-error hover:text-error-hover disabled:opacity-50" :disabled="isLoading" :title="t('sshKeys.modal.delete')">
                                        <i class="fas fa-trash-alt"></i>
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                 <!-- Close Button -->
                 <div class="mt-6 text-right flex-shrink-0">
                    <button @click="emit('close')"
                            class="px-4 py-2 bg-transparent text-text-secondary border border-border rounded-md shadow-sm hover:bg-border hover:text-foreground focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50"
                            :disabled="isLoading">
                        {{ t('sshKeys.modal.close') }}
                    </button>
                </div>
            </div>

            <!-- Add/Edit Form -->
            <div v-else class="flex flex-col h-full">
                 <h3 class="text-xl font-semibold text-center mb-6 flex-shrink-0">
                    {{ keyToEdit ? t('sshKeys.modal.editTitle') : t('sshKeys.modal.addTitle') }}
                </h3>
                <form @submit.prevent="handleSubmit" class="flex-grow overflow-y-auto pr-2 space-y-4">
                     <div>
                        <label for="key-name" class="block text-sm font-medium text-text-secondary mb-1">{{ t('sshKeys.modal.keyName') }}</label>
                        <input type="text" id="key-name" v-model="formData.name" required
                               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
                    </div>
                     <div>
                        <label for="key-private" class="block text-sm font-medium text-text-secondary mb-1">{{ t('sshKeys.modal.privateKey') }}</label>
                        <textarea id="key-private" v-model="formData.private_key" rows="8" required
                                  class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono text-sm"></textarea>
                         <!-- <small v-if="keyToEdit" class="block text-xs text-text-secondary mt-1">{{ t('sshKeys.modal.keyUpdateNote') }}</small> -->
                    </div>
                     <div>
                        <label for="key-passphrase" class="block text-sm font-medium text-text-secondary mb-1">{{ t('sshKeys.modal.passphrase') }} ({{ t('connections.form.optional') }})</label>
                        <input type="password" id="key-passphrase" v-model="formData.passphrase" autocomplete="new-password"
                               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
                         <!-- <small v-if="keyToEdit" class="block text-xs text-text-secondary mt-1">{{ t('sshKeys.modal.passphraseUpdateNote') }}</small> -->
                    </div>

                     <!-- Form Error -->
                    <div v-if="formError" class="text-error bg-error/10 border border-error/30 rounded-md p-3 text-sm text-center font-medium">
                        {{ formError }}
                    </div>
                </form>
                 <!-- Form Actions -->
                <div class="flex justify-end space-x-3 pt-5 mt-4 flex-shrink-0">
                    <button type="button" @click="cancelForm" :disabled="isLoading"
                            class="px-4 py-2 bg-transparent text-text-secondary border border-border rounded-md shadow-sm hover:bg-border hover:text-foreground focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50">
                        {{ t('sshKeys.modal.cancel') }}
                    </button>
                    <button type="submit" @click="handleSubmit" :disabled="isLoading"
                            class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50">
                        {{ keyToEdit ? t('sshKeys.modal.saveChanges') : t('sshKeys.modal.addKey') }}
                    </button>
                </div>
            </div>

        </div>
    </div>
</template>