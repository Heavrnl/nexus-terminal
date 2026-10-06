import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient';
import { ref, computed, watch, nextTick } from 'vue'; 
import { useDeviceDetection } from '../composables/useDeviceDetection';
import type { ITheme } from 'xterm';
import type { TerminalTheme } from '../types/terminal-theme.types'; 
import type { AppearanceSettings, UpdateAppearanceDto } from '../types/appearance.types';
import { defaultXtermTheme, defaultUiTheme } from '../features/appearance/config/default-themes';
import { htmlPresetsApi, type LocalHtmlPresetItem, type RemoteHtmlPresetItem } from '../features/appearance/api/html-presets.api';
import { terminalThemesApi } from '../features/appearance/api/terminal-themes.api';

// 设备专属终端字体与字号常量
export const DEFAULT_DESKTOP_TERMINAL_FONT = "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', 'Microsoft YaHei Mono', monospace";
export const DEFAULT_MOBILE_TERMINAL_FONT = "-apple-system-monospaced, 'SF Mono', Menlo, Monaco, 'Roboto Mono', 'Noto Sans Mono', 'Droid Sans Mono', Consolas, monospace";

export const STORAGE_KEY_TERMINAL_FONT_SIZE_DESKTOP = 'nexus_terminal_font_size_desktop';
export const STORAGE_KEY_TERMINAL_FONT_SIZE_MOBILE = 'nexus_terminal_font_size_mobile';
export const STORAGE_KEY_TERMINAL_FONT_FAMILY_DESKTOP = 'nexus_terminal_font_family_desktop';
export const STORAGE_KEY_TERMINAL_FONT_FAMILY_MOBILE = 'nexus_terminal_font_family_mobile';

// 安全解析 JSON 辅助函数
export const safeJsonParse = <T>(jsonString: string | undefined | null, defaultValue: T): T => { 
    if (!jsonString) return defaultValue;
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        console.error('JSON 解析失败:', e);
        return defaultValue;
    }
};

export const useAppearanceStore = defineStore('appearance', () => {
    const { isMobile } = useDeviceDetection();

    // --- State ---
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const isStyleCustomizerVisible = ref(false);

    const appearanceSettings = ref<Partial<AppearanceSettings>>({});
    const initialAppearanceDataLoaded = ref(false);
    const allTerminalThemes = ref<TerminalTheme[]>([]);

    // HTML Presets State
    const localHtmlPresets = ref<LocalHtmlPresetItem[]>([]);
    const remoteHtmlPresets = ref<RemoteHtmlPresetItem[]>([]);
    const remoteHtmlPresetsRepositoryUrl = ref<string | null>(null);
    const activeHtmlPresetTab = ref<'local' | 'remote'>('local');
    const isLoadingHtmlPresets = ref(false);
    const htmlPresetError = ref<string | null>(null);

    // Theme Preview State
    const isPreviewingTerminalTheme = ref(false);
    const previewTerminalThemeData = ref<ITheme | null>(null);

    // --- Computed Properties (Getters) ---
    const currentUiTheme = computed<Record<string, string>>(() => {
        return safeJsonParse(appearanceSettings.value.customUiTheme, defaultUiTheme);
    });

    const activeTerminalThemeId = computed(() => appearanceSettings.value.activeTerminalThemeId);

    const currentTerminalTheme = computed<ITheme>(() => {
        const activeId = activeTerminalThemeId.value;
        if (activeId === null || activeId === undefined || allTerminalThemes.value.length === 0) {
            const defaultTheme = allTerminalThemes.value.find(t => t.name === '默认');
            return defaultTheme ? defaultTheme.themeData : defaultXtermTheme;
        }
        const activeTheme = allTerminalThemes.value.find(t => parseInt(t._id ?? '-1', 10) === activeId);
        return activeTheme ? activeTheme.themeData : defaultXtermTheme;
    });

    const effectiveTerminalTheme = computed<ITheme>(() => {
        if (isPreviewingTerminalTheme.value && previewTerminalThemeData.value) {
            return previewTerminalThemeData.value;
        }
        const activeId = activeTerminalThemeId.value;
        if (activeId === null || activeId === undefined || allTerminalThemes.value.length === 0) {
            const defaultPresetTheme = allTerminalThemes.value.find(t => t.name === '默认');
            return defaultPresetTheme ? defaultPresetTheme.themeData : defaultXtermTheme;
        }
        const activeSetTheme = allTerminalThemes.value.find(t => parseInt(t._id ?? '-1', 10) === activeId);
        return activeSetTheme ? activeSetTheme.themeData : defaultXtermTheme;
    });

    // 终端字体家族 (自动按移动端/桌面端独立加载，云端设置优先，本地缓存回退)
    const currentTerminalFontFamily = computed<string>(() => {
        if (isMobile.value) {
            if (appearanceSettings.value.terminalFontFamilyMobile) {
                return appearanceSettings.value.terminalFontFamilyMobile;
            }
            const localFont = localStorage.getItem(STORAGE_KEY_TERMINAL_FONT_FAMILY_MOBILE);
            if (localFont && localFont.trim()) return localFont;
            return DEFAULT_MOBILE_TERMINAL_FONT;
        } else {
            if (appearanceSettings.value.terminalFontFamily) {
                return appearanceSettings.value.terminalFontFamily;
            }
            const localFont = localStorage.getItem(STORAGE_KEY_TERMINAL_FONT_FAMILY_DESKTOP);
            if (localFont && localFont.trim()) return localFont;
            return DEFAULT_DESKTOP_TERMINAL_FONT;
        }
    });

    // 桌面端终端字体族 getter
    const terminalFontFamilyDesktop = computed<string>(() => {
        if (appearanceSettings.value.terminalFontFamily) {
            return appearanceSettings.value.terminalFontFamily;
        }
        const localFont = localStorage.getItem(STORAGE_KEY_TERMINAL_FONT_FAMILY_DESKTOP);
        if (localFont && localFont.trim()) return localFont;
        return DEFAULT_DESKTOP_TERMINAL_FONT;
    });

    // 移动端终端字体族 getter
    const terminalFontFamilyMobile = computed<string>(() => {
        if (appearanceSettings.value.terminalFontFamilyMobile) {
            return appearanceSettings.value.terminalFontFamilyMobile;
        }
        const localFont = localStorage.getItem(STORAGE_KEY_TERMINAL_FONT_FAMILY_MOBILE);
        if (localFont && localFont.trim()) return localFont;
        return DEFAULT_MOBILE_TERMINAL_FONT;
    });

    // 终端字号大小 (自动按移动端/桌面端独立加载，云端设置优先，本地缓存回退)
    const currentTerminalFontSize = computed<number>(() => {
        if (isMobile.value) {
            const size = appearanceSettings.value.terminalFontSizeMobile;
            if (typeof size === 'number' && size > 0) return size;
            const localSize = localStorage.getItem(STORAGE_KEY_TERMINAL_FONT_SIZE_MOBILE);
            if (localSize) {
                const parsed = parseInt(localSize, 10);
                if (!isNaN(parsed) && parsed > 0) return parsed;
            }
            return 13;
        } else {
            const size = appearanceSettings.value.terminalFontSize;
            if (typeof size === 'number' && size > 0) return size;
            const localSize = localStorage.getItem(STORAGE_KEY_TERMINAL_FONT_SIZE_DESKTOP);
            if (localSize) {
                const parsed = parseInt(localSize, 10);
                if (!isNaN(parsed) && parsed > 0) return parsed;
            }
            return 14;
        }
    });

    // 桌面端终端字号大小 getter
    const terminalFontSizeDesktop = computed<number>(() => {
        const size = appearanceSettings.value.terminalFontSize;
        if (typeof size === 'number' && size > 0) return size;
        const localSize = localStorage.getItem(STORAGE_KEY_TERMINAL_FONT_SIZE_DESKTOP);
        if (localSize) {
            const parsed = parseInt(localSize, 10);
            if (!isNaN(parsed) && parsed > 0) return parsed;
        }
        return 14;
    });

    // 移动端终端字号大小 getter
    const terminalFontSizeMobile = computed<number>(() => {
        const size = appearanceSettings.value.terminalFontSizeMobile;
        if (typeof size === 'number' && size > 0) return size;
        const localSize = localStorage.getItem(STORAGE_KEY_TERMINAL_FONT_SIZE_MOBILE);
        if (localSize) {
            const parsed = parseInt(localSize, 10);
            if (!isNaN(parsed) && parsed > 0) return parsed;
        }
        return 13;
    });

    const pageBackgroundImage = computed(() => appearanceSettings.value.pageBackgroundImage);
    const terminalBackgroundImage = computed(() => appearanceSettings.value.terminalBackgroundImage);

    const currentEditorFontSize = computed<number>(() => {
        const size = appearanceSettings.value.editorFontSize;
        return typeof size === 'number' && size > 0 ? size : 14;
    });

    const currentEditorFontFamily = computed<string>(() => {
        return appearanceSettings.value.editorFontFamily || 'Consolas, "Noto Sans SC", "Microsoft YaHei"';
    });

    const currentMobileEditorFontSize = computed<number>(() => {
        const size = appearanceSettings.value.mobileEditorFontSize;
        return typeof size === 'number' && size > 0 ? size : 16;
    });

    const isTerminalBackgroundEnabled = computed<boolean>(() => {
        const enabled = appearanceSettings.value.terminalBackgroundEnabled;
        return typeof enabled === 'boolean' ? enabled : true;
    });

    const currentTerminalBackgroundOverlayOpacity = computed<number>(() => {
        const opacity = appearanceSettings.value.terminalBackgroundOverlayOpacity;
        return typeof opacity === 'number' && opacity >= 0 && opacity <= 1 ? opacity : 0.5;
    });

    const terminalCustomHTML = computed(() => appearanceSettings.value.terminal_custom_html ?? null);

    const terminalTextStrokeEnabled = computed<boolean>(() => appearanceSettings.value.terminalTextStrokeEnabled ?? false);
    const terminalTextStrokeWidth = computed<number>(() => appearanceSettings.value.terminalTextStrokeWidth ?? 1);
    const terminalTextStrokeColor = computed<string>(() => appearanceSettings.value.terminalTextStrokeColor ?? '#000000');

    const terminalTextShadowEnabled = computed<boolean>(() => appearanceSettings.value.terminalTextShadowEnabled ?? false);
    const terminalTextShadowOffsetX = computed<number>(() => appearanceSettings.value.terminalTextShadowOffsetX ?? 0);
    const terminalTextShadowOffsetY = computed<number>(() => appearanceSettings.value.terminalTextShadowOffsetY ?? 0);
    const terminalTextShadowBlur = computed<number>(() => appearanceSettings.value.terminalTextShadowBlur ?? 0);
    const terminalTextShadowColor = computed<string>(() => appearanceSettings.value.terminalTextShadowColor ?? 'rgba(0,0,0,0.5)');

    // --- Actions ---

    // 初始化外观数据加载
    async function loadInitialAppearanceData() {
        isLoading.value = true;
        error.value = null;
        try {
            const [settingsResponse, themes] = await Promise.all([
                apiClient.get<AppearanceSettings>('/appearance'),
                terminalThemesApi.fetchAllThemes()
            ]);
            appearanceSettings.value = settingsResponse.data;
            allTerminalThemes.value = themes;
            initialAppearanceDataLoaded.value = true;

            // 将云端最新双端字体与字号同步刷新至本地缓存
            if (settingsResponse.data.terminalFontFamily) {
                localStorage.setItem(STORAGE_KEY_TERMINAL_FONT_FAMILY_DESKTOP, settingsResponse.data.terminalFontFamily);
            }
            if (settingsResponse.data.terminalFontFamilyMobile) {
                localStorage.setItem(STORAGE_KEY_TERMINAL_FONT_FAMILY_MOBILE, settingsResponse.data.terminalFontFamilyMobile);
            }
            if (settingsResponse.data.terminalFontSize) {
                localStorage.setItem(STORAGE_KEY_TERMINAL_FONT_SIZE_DESKTOP, String(settingsResponse.data.terminalFontSize));
            }
            if (settingsResponse.data.terminalFontSizeMobile) {
                localStorage.setItem(STORAGE_KEY_TERMINAL_FONT_SIZE_MOBILE, String(settingsResponse.data.terminalFontSizeMobile));
            }

            remoteHtmlPresetsRepositoryUrl.value = appearanceSettings.value.remoteHtmlPresetsUrl || null;
            applyUiTheme(currentUiTheme.value);
            applyPageBackground();
        } catch (err: any) {
            console.error('加载外观数据失败:', err);
            error.value = err.response?.data?.message || err.message || '加载外观数据失败';
            appearanceSettings.value = {};
            allTerminalThemes.value = [];
            initialAppearanceDataLoaded.value = false;
            applyUiTheme(defaultUiTheme);
            applyPageBackground();
        } finally {
            isLoading.value = false;
        }
    }

    function toggleStyleCustomizer(visible?: boolean) {
        isStyleCustomizerVisible.value = visible === undefined ? !isStyleCustomizerVisible.value : visible;
    }

    // 更新外观设置
    async function updateAppearanceSettings(updates: UpdateAppearanceDto) {
        try {
            const payloadToSend: Partial<AppearanceSettings> = {
                ...appearanceSettings.value,
                ...updates
            };
            const response = await apiClient.put<AppearanceSettings>('/appearance', payloadToSend);
            appearanceSettings.value = response.data;

            if (updates.customUiTheme !== undefined) applyUiTheme(currentUiTheme.value);
            if (updates.pageBackgroundImage !== undefined) applyPageBackground();
        } catch (err: any) {
            console.error('更新外观设置失败:', err);
            throw new Error(err.response?.data?.message || err.message || '更新外观设置失败');
        }
    }

    async function saveCustomUiTheme(uiTheme: Record<string, string>) {
        await updateAppearanceSettings({ customUiTheme: JSON.stringify(uiTheme) });
    }

    async function resetCustomUiTheme() {
        await saveCustomUiTheme(defaultUiTheme);
    }

    async function setActiveTerminalTheme(themeId: string) {
        const previousActiveId = appearanceSettings.value.activeTerminalThemeId;
        const idNum = parseInt(themeId, 10);
        if (isNaN(idNum)) {
            throw new Error(`无效的主题 ID: ${themeId}`);
        }
        appearanceSettings.value.activeTerminalThemeId = idNum;
        try {
            await updateAppearanceSettings({ activeTerminalThemeId: idNum });
        } catch (err) {
            appearanceSettings.value.activeTerminalThemeId = previousActiveId;
            throw new Error(`应用主题失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // 设置终端字体 (自动根据当前设备或指定目标设备分开保存)
    async function setTerminalFontFamily(fontFamily: string, targetDevice?: 'desktop' | 'mobile') {
        const isTargetMobile = targetDevice ? targetDevice === 'mobile' : isMobile.value;
        if (isTargetMobile) {
            localStorage.setItem(STORAGE_KEY_TERMINAL_FONT_FAMILY_MOBILE, fontFamily);
            appearanceSettings.value.terminalFontFamilyMobile = fontFamily;
            await updateAppearanceSettings({ terminalFontFamilyMobile: fontFamily });
        } else {
            localStorage.setItem(STORAGE_KEY_TERMINAL_FONT_FAMILY_DESKTOP, fontFamily);
            appearanceSettings.value.terminalFontFamily = fontFamily;
            await updateAppearanceSettings({ terminalFontFamily: fontFamily });
        }
    }

    // 设置移动端终端字体
    async function setTerminalFontFamilyMobile(fontFamily: string) {
        await setTerminalFontFamily(fontFamily, 'mobile');
    }

    // 设置终端字号 (自动根据当前设备或指定目标设备分开保存)
    async function setTerminalFontSize(size: number, targetDevice?: 'desktop' | 'mobile') {
        const isTargetMobile = targetDevice ? targetDevice === 'mobile' : isMobile.value;
        if (isTargetMobile) {
            localStorage.setItem(STORAGE_KEY_TERMINAL_FONT_SIZE_MOBILE, String(size));
            appearanceSettings.value.terminalFontSizeMobile = size;
            await updateAppearanceSettings({ terminalFontSizeMobile: size });
        } else {
            localStorage.setItem(STORAGE_KEY_TERMINAL_FONT_SIZE_DESKTOP, String(size));
            appearanceSettings.value.terminalFontSize = size;
            await updateAppearanceSettings({ terminalFontSize: size });
        }
    }

    // 设置移动端终端字号大小
    async function setTerminalFontSizeMobile(size: number) {
        await setTerminalFontSize(size, 'mobile');
    }

    async function setEditorFontSize(size: number) {
        await updateAppearanceSettings({ editorFontSize: size });
    }

    async function setEditorFontFamily(fontFamily: string) {
        await updateAppearanceSettings({ editorFontFamily: fontFamily });
    }

    async function setMobileEditorFontSize(size: number) {
        await updateAppearanceSettings({ mobileEditorFontSize: size });
    }

    async function setTerminalBackgroundEnabled(enabled: boolean) {
        await updateAppearanceSettings({ terminalBackgroundEnabled: enabled });
    }

    async function setTerminalBackgroundOverlayOpacity(opacity: number) {
        await updateAppearanceSettings({ terminalBackgroundOverlayOpacity: opacity });
    }

    async function setTerminalCustomHTML(html: string | null) {
        try {
            await updateAppearanceSettings({ terminal_custom_html: html });
        } catch (err: any) {
            console.error('设置终端自定义 HTML 失败:', err);
            throw new Error(err.response?.data?.message || err.message || '设置终端自定义 HTML 失败');
        }
    }

    // 文字描边与阴影 Actions
    async function setTerminalTextStrokeEnabled(enabled: boolean) {
        await updateAppearanceSettings({ terminalTextStrokeEnabled: enabled });
    }
    async function setTerminalTextStrokeWidth(width: number) {
        await updateAppearanceSettings({ terminalTextStrokeWidth: width });
    }
    async function setTerminalTextStrokeColor(color: string) {
        await updateAppearanceSettings({ terminalTextStrokeColor: color });
    }
    async function setTerminalTextShadowEnabled(enabled: boolean) {
        await updateAppearanceSettings({ terminalTextShadowEnabled: enabled });
    }
    async function setTerminalTextShadowOffsetX(offset: number) {
        await updateAppearanceSettings({ terminalTextShadowOffsetX: offset });
    }
    async function setTerminalTextShadowOffsetY(offset: number) {
        await updateAppearanceSettings({ terminalTextShadowOffsetY: offset });
    }
    async function setTerminalTextShadowBlur(blur: number) {
        await updateAppearanceSettings({ terminalTextShadowBlur: blur });
    }
    async function setTerminalTextShadowColor(color: string) {
        await updateAppearanceSettings({ terminalTextShadowColor: color });
    }

    // 终端主题管理 Actions
    async function createTerminalTheme(name: string, themeData: ITheme) {
        try {
            await terminalThemesApi.createTheme(name, themeData);
            await loadInitialAppearanceData();
        } catch (err: any) {
            console.error('创建终端主题失败:', err);
            throw new Error(err.response?.data?.message || err.message || '创建终端主题失败');
        }
    }

    async function updateTerminalTheme(id: string, name: string, themeData: ITheme) {
        try {
            await terminalThemesApi.updateTheme(id, name, themeData);
            await loadInitialAppearanceData();
        } catch (err: any) {
            console.error('更新终端主题失败:', err);
            throw new Error(err.response?.data?.message || err.message || '更新终端主题失败');
        }
    }

    async function deleteTerminalTheme(id: string) {
        try {
            await terminalThemesApi.deleteTheme(id);
            const idNum = parseInt(id, 10);
            if (!isNaN(idNum) && activeTerminalThemeId.value === idNum) {
                await setActiveTerminalTheme('1');
            }
            await loadInitialAppearanceData();
        } catch (err: any) {
            console.error('删除终端主题失败:', err);
            throw new Error(err.response?.data?.message || err.message || '删除终端主题失败');
        }
    }

    async function importTerminalTheme(file: File, name?: string) {
        try {
            await terminalThemesApi.importTheme(file, name);
            await loadInitialAppearanceData();
        } catch (err: any) {
            console.error('导入终端主题失败:', err);
            throw new Error(err.response?.data?.message || err.message || '导入终端主题失败');
        }
    }

    async function exportTerminalTheme(id: string) {
        try {
            await terminalThemesApi.exportTheme(id);
        } catch (err: any) {
            console.error('导出终端主题失败:', err);
            throw new Error(err.response?.data?.message || err.message || '导出终端主题失败');
        }
    }

    async function loadTerminalThemeData(themeId: string): Promise<ITheme | null> {
        const existingTheme = allTerminalThemes.value.find(t => t._id === themeId);
        if (existingTheme?.themeData && Object.keys(existingTheme.themeData).length > 0) {
            return existingTheme.themeData;
        }
        try {
            const fullTheme = await terminalThemesApi.fetchThemeById(themeId);
            if (fullTheme && fullTheme.themeData) {
                const index = allTerminalThemes.value.findIndex(t => t._id === themeId);
                if (index !== -1) {
                    allTerminalThemes.value[index] = { ...allTerminalThemes.value[index], themeData: fullTheme.themeData };
                }
                return fullTheme.themeData;
            }
            return null;
        } catch (err: any) {
            console.error(`加载终端主题 ${themeId} 数据失败:`, err);
            error.value = err.response?.data?.message || err.message || `加载主题 ${themeId} 数据失败`;
            return null;
        }
    }

    // 背景图片 Actions
    async function uploadPageBackground(file: File): Promise<string> {
        const formData = new FormData();
        formData.append('pageBackgroundFile', file);
        try {
            const response = await apiClient.post<{ filePath: string }>('/appearance/background/page', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            appearanceSettings.value.pageBackgroundImage = response.data.filePath;
            applyPageBackground();
            return response.data.filePath;
        } catch (err: any) {
            console.error('上传页面背景失败:', err);
            throw new Error(err.response?.data?.message || err.message || '上传页面背景失败');
        }
    }

    async function uploadTerminalBackground(file: File): Promise<string> {
        const formData = new FormData();
        formData.append('terminalBackgroundFile', file);
        try {
            const response = await apiClient.post<{ filePath: string }>('/appearance/background/terminal', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            appearanceSettings.value.terminalBackgroundImage = response.data.filePath;
            return response.data.filePath;
        } catch (err: any) {
            console.error('上传终端背景失败:', err);
            throw new Error(err.response?.data?.message || err.message || '上传终端背景失败');
        }
    }

    async function removePageBackground() {
        try {
            await apiClient.delete('/appearance/background/page');
            await updateAppearanceSettings({ pageBackgroundImage: '' });
        } catch (err: any) {
            console.error('移除页面背景失败:', err);
            throw new Error(err.response?.data?.message || err.message || '移除页面背景失败');
        }
    }

    async function removeTerminalBackground() {
        try {
            await apiClient.delete('/appearance/background/terminal');
            await updateAppearanceSettings({ terminalBackgroundImage: '' });
        } catch (err: any) {
            console.error('移除终端背景失败:', err);
            throw new Error(err.response?.data?.message || err.message || '移除终端背景失败');
        }
    }

    // 终端主题预览 Actions
    function startTerminalThemePreview(themeData: ITheme) {
        previewTerminalThemeData.value = themeData;
        isPreviewingTerminalTheme.value = true;
    }

    function stopTerminalThemePreview() {
        previewTerminalThemeData.value = null;
        isPreviewingTerminalTheme.value = false;
    }

    // HTML Presets Actions
    async function fetchLocalHtmlPresets() {
        isLoadingHtmlPresets.value = true;
        htmlPresetError.value = null;
        try {
            localHtmlPresets.value = await htmlPresetsApi.fetchLocalPresets();
        } catch (err: any) {
            console.error('获取本地 HTML 主题列表失败:', err);
            htmlPresetError.value = err.response?.data?.message || err.message || '获取本地 HTML 主题列表失败';
            localHtmlPresets.value = [];
        } finally {
            isLoadingHtmlPresets.value = false;
        }
    }

    async function getLocalHtmlPresetContent(name: string): Promise<string> {
        try {
            return await htmlPresetsApi.getLocalPresetContent(name);
        } catch (err: any) {
            console.error(`获取本地 HTML 主题 '${name}' 内容失败:`, err);
            throw new Error(err.response?.data?.message || err.message || `获取主题 '${name}' 内容失败`);
        }
    }

    async function createLocalHtmlPreset(name: string, content: string) {
        try {
            await htmlPresetsApi.createLocalPreset(name, content);
            await fetchLocalHtmlPresets();
        } catch (err: any) {
            console.error('创建本地 HTML 主题失败:', err);
            throw new Error(err.response?.data?.message || err.message || '创建本地 HTML 主题失败');
        }
    }

    async function updateLocalHtmlPreset(name: string, content: string) {
        try {
            await htmlPresetsApi.updateLocalPreset(name, content);
        } catch (err: any) {
            console.error(`更新本地 HTML 主题 '${name}' 失败:`, err);
            throw new Error(err.response?.data?.message || err.message || `更新主题 '${name}' 失败`);
        }
    }

    async function deleteLocalHtmlPreset(name: string) {
        try {
            await htmlPresetsApi.deleteLocalPreset(name);
            await fetchLocalHtmlPresets();
        } catch (err: any) {
            console.error(`删除本地 HTML 主题 '${name}' 失败:`, err);
            throw new Error(err.response?.data?.message || err.message || `删除主题 '${name}' 失败`);
        }
    }

    async function fetchRemoteHtmlPresetsRepositoryUrl() {
        isLoadingHtmlPresets.value = true;
        htmlPresetError.value = null;
        try {
            remoteHtmlPresetsRepositoryUrl.value = await htmlPresetsApi.fetchRemoteRepositoryUrl();
        } catch (err: any) {
            console.error('获取远程 HTML 主题仓库链接失败:', err);
            htmlPresetError.value = err.response?.data?.message || err.message || '获取远程仓库链接失败';
        } finally {
            isLoadingHtmlPresets.value = false;
        }
    }

    async function updateRemoteHtmlPresetsRepositoryUrl(url: string) {
        try {
            await htmlPresetsApi.updateRemoteRepositoryUrl(url);
            remoteHtmlPresetsRepositoryUrl.value = url;
            await updateAppearanceSettings({ remoteHtmlPresetsUrl: url });
        } catch (err: any) {
            console.error('更新远程 HTML 主题仓库链接失败:', err);
            throw new Error(err.response?.data?.message || err.message || '更新远程仓库链接失败');
        }
    }

    async function fetchRemoteHtmlPresets(repoUrlParam?: string) {
        isLoadingHtmlPresets.value = true;
        htmlPresetError.value = null;
        const urlToFetch = repoUrlParam || remoteHtmlPresetsRepositoryUrl.value;
        if (!urlToFetch) {
            htmlPresetError.value = '远程仓库链接未设置';
            isLoadingHtmlPresets.value = false;
            remoteHtmlPresets.value = [];
            return;
        }
        try {
            remoteHtmlPresets.value = await htmlPresetsApi.fetchRemotePresets(urlToFetch);
        } catch (err: any) {
            console.error('获取远程 HTML 主题列表失败:', err);
            htmlPresetError.value = err.response?.data?.message || err.message || '获取远程主题列表失败';
            remoteHtmlPresets.value = [];
        } finally {
            isLoadingHtmlPresets.value = false;
        }
    }

    async function getRemoteHtmlPresetContent(fileUrl: string): Promise<string> {
        try {
            return await htmlPresetsApi.getRemotePresetContent(fileUrl);
        } catch (err: any) {
            console.error(`获取远程 HTML 主题内容失败:`, err);
            throw new Error(err.response?.data?.message || err.message || '获取远程主题内容失败');
        }
    }

    async function applyHtmlPreset(htmlContent: string) {
        await setTerminalCustomHTML(htmlContent);
    }

    // 辅助函数
    function applyUiTheme(theme: Record<string, string>) {
        const root = document.documentElement;
        for (const [key, value] of Object.entries(theme)) {
            root.style.setProperty(key, value);
        }
    }

    function applyPageBackground() {
        const body = document.body;
        if (pageBackgroundImage.value) {
            const backendUrl = import.meta.env.VITE_API_BASE_URL || window.location.origin;
            const imagePath = pageBackgroundImage.value;
            let fullImageUrl = '';
            try {
                const baseUrl = new URL(backendUrl);
                const correctedPath = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
                fullImageUrl = new URL(correctedPath, baseUrl).href;
            } catch (e) {
                console.error('[AppearanceStore applyPageBackground] 构建背景图片 URL 失败:', e);
                body.style.backgroundImage = 'none';
                return;
            }
            body.style.backgroundImage = 'none';
            nextTick(() => {
                if (fullImageUrl) {
                    body.style.backgroundImage = `url(${fullImageUrl})`;
                    body.style.backgroundSize = 'cover';
                    body.style.backgroundPosition = 'center';
                    body.style.backgroundRepeat = 'no-repeat';
                    body.style.backgroundAttachment = 'fixed';
                } else {
                    body.style.backgroundImage = 'none';
                }
            });
        } else {
            body.style.backgroundImage = 'none';
        }
    }

    // Watchers
    watch(currentUiTheme, (newTheme) => {
        applyUiTheme(newTheme);
    }, { deep: true, immediate: true });

    watch(pageBackgroundImage, () => {
        applyPageBackground();
    });

    return {
        isLoading,
        error,
        initialAppearanceDataLoaded,
        appearanceSettings,
        allTerminalThemes,
        isPreviewingTerminalTheme, 
        previewTerminalThemeData, 
        currentUiTheme,
        activeTerminalThemeId,
        currentTerminalTheme,     
        effectiveTerminalTheme,   
        currentTerminalFontFamily,
        terminalFontFamilyDesktop,
        terminalFontFamilyMobile,
        currentTerminalFontSize,
        terminalFontSizeDesktop,
        terminalFontSizeMobile,
        currentEditorFontSize,
        currentMobileEditorFontSize,
        currentEditorFontFamily, 
        pageBackgroundImage,
        terminalBackgroundImage,
        currentTerminalBackgroundOverlayOpacity,
        isTerminalBackgroundEnabled,
        terminalCustomHTML,
        terminalTextStrokeEnabled,
        terminalTextStrokeWidth,
        terminalTextStrokeColor,
        terminalTextShadowEnabled,
        terminalTextShadowOffsetX,
        terminalTextShadowOffsetY,
        terminalTextShadowBlur,
        terminalTextShadowColor,
        isStyleCustomizerVisible,
        toggleStyleCustomizer,
        loadInitialAppearanceData,
        updateAppearanceSettings,
        saveCustomUiTheme,
        resetCustomUiTheme,
        setActiveTerminalTheme,
        setTerminalFontFamily,
        setTerminalFontFamilyMobile,
        setTerminalFontSize,
        setTerminalFontSizeMobile,
        setEditorFontSize,
        setMobileEditorFontSize,
        setEditorFontFamily, 
        setTerminalBackgroundEnabled,
        setTerminalBackgroundOverlayOpacity,
        setTerminalCustomHTML,
        setTerminalTextStrokeEnabled,
        setTerminalTextStrokeWidth,
        setTerminalTextStrokeColor,
        setTerminalTextShadowEnabled,
        setTerminalTextShadowOffsetX,
        setTerminalTextShadowOffsetY,
        setTerminalTextShadowBlur,
        setTerminalTextShadowColor,
        createTerminalTheme,
        updateTerminalTheme, 
        deleteTerminalTheme, 
        importTerminalTheme, 
        exportTerminalTheme,
        loadTerminalThemeData,
        uploadPageBackground,
        uploadTerminalBackground,
        removePageBackground,
        removeTerminalBackground,
        startTerminalThemePreview,
        stopTerminalThemePreview,
        localHtmlPresets,
        remoteHtmlPresets,
        remoteHtmlPresetsRepositoryUrl,
        activeHtmlPresetTab,
        isLoadingHtmlPresets,
        htmlPresetError,
        fetchLocalHtmlPresets,
        getLocalHtmlPresetContent,
        createLocalHtmlPreset,
        updateLocalHtmlPreset,
        deleteLocalHtmlPreset,
        fetchRemoteHtmlPresetsRepositoryUrl,
        updateRemoteHtmlPresetsRepositoryUrl,
        fetchRemoteHtmlPresets,
        getRemoteHtmlPresetContent,
        applyHtmlPreset,
    };
});
