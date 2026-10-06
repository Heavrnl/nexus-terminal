import apiClient from '../../../utils/apiClient';
import type { ITheme } from 'xterm';
import type { TerminalTheme } from '../../../types/terminal-theme.types';

export const terminalThemesApi = {
    async fetchAllThemes(): Promise<TerminalTheme[]> {
        const response = await apiClient.get<TerminalTheme[]>('/terminal-themes');
        return response.data;
    },

    async fetchThemeById(id: string): Promise<TerminalTheme> {
        const response = await apiClient.get<TerminalTheme>(`/terminal-themes/${id}`);
        return response.data;
    },

    async createTheme(name: string, themeData: ITheme): Promise<void> {
        await apiClient.post('/terminal-themes', { name, themeData });
    },

    async updateTheme(id: string, name: string, themeData: ITheme): Promise<void> {
        await apiClient.put(`/terminal-themes/${id}`, { name, themeData });
    },

    async deleteTheme(id: string): Promise<void> {
        await apiClient.delete(`/terminal-themes/${id}`);
    },

    async importTheme(file: File, name?: string): Promise<void> {
        const formData = new FormData();
        formData.append('themeFile', file);
        if (name) {
            formData.append('name', name);
        }
        await apiClient.post('/terminal-themes/import', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
        });
    },

    async exportTheme(id: string): Promise<void> {
        const response = await apiClient.get(`/terminal-themes/${id}/export`, {
            responseType: 'blob'
        });
        const contentDisposition = response.headers['content-disposition'];
        let filename = `terminal_theme_${id}.json`;
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
            if (filenameMatch && filenameMatch.length > 1) {
                filename = filenameMatch[1];
            }
        }
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
    }
};
