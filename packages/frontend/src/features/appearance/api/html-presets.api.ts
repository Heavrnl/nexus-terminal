import apiClient from '../../../utils/apiClient';

export interface LocalHtmlPresetItem {
    name: string;
    type: 'preset' | 'custom';
}

export interface RemoteHtmlPresetItem {
    name: string;
    downloadUrl?: string;
}

export const htmlPresetsApi = {
    async fetchLocalPresets(): Promise<LocalHtmlPresetItem[]> {
        const response = await apiClient.get<LocalHtmlPresetItem[]>('/appearance/html-presets/local');
        return response.data;
    },

    async getLocalPresetContent(name: string): Promise<string> {
        const response = await apiClient.get<string>(`/appearance/html-presets/local/${name}`, {
            transformResponse: (res) => res
        });
        return response.data;
    },

    async createLocalPreset(name: string, content: string): Promise<void> {
        await apiClient.post('/appearance/html-presets/local', { name, content });
    },

    async updateLocalPreset(name: string, content: string): Promise<void> {
        await apiClient.put(`/appearance/html-presets/local/${name}`, { content });
    },

    async deleteLocalPreset(name: string): Promise<void> {
        await apiClient.delete(`/appearance/html-presets/local/${name}`);
    },

    async fetchRemoteRepositoryUrl(): Promise<string | null> {
        const response = await apiClient.get<{ url: string | null }>('/appearance/html-presets/remote/repository-url');
        return response.data.url;
    },

    async updateRemoteRepositoryUrl(url: string): Promise<void> {
        await apiClient.put('/appearance/html-presets/remote/repository-url', { url });
    },

    async fetchRemotePresets(repoUrl?: string | null): Promise<RemoteHtmlPresetItem[]> {
        const params: { repoUrl?: string } = {};
        if (repoUrl) {
            params.repoUrl = repoUrl;
        }
        const response = await apiClient.get<RemoteHtmlPresetItem[]>('/appearance/html-presets/remote/list', { params });
        return response.data;
    },

    async getRemotePresetContent(fileUrl: string): Promise<string> {
        const response = await apiClient.get<string>('/appearance/html-presets/remote/content', {
            params: { fileUrl },
            transformResponse: (res) => res
        });
        return response.data;
    }
};
