import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import apiClient from '../../utils/apiClient';
import { isAxiosError } from 'axios';

export function useDataManagement() {
  const { t } = useI18n();

  // --- Export Connections State & Method ---
  const exportConnectionsLoading = ref(false);
  const exportConnectionsMessage = ref('');
  const exportConnectionsSuccess = ref(false);

  const handleExportConnections = async () => {
    exportConnectionsLoading.value = true;
    exportConnectionsMessage.value = '';
    exportConnectionsSuccess.value = false;
    try {
      const response = await apiClient.get('/settings/export-connections', {
        responseType: 'blob',
      });

      let filename = 'nexus_connections_export.zip';
      const disposition = response.headers['content-disposition'];
      if (disposition && disposition.includes('attachment')) {
        const filenameRegex = /filename[^;=\n]*=(?:(?:["'])(?<quoted>.*?)\1|(?<unquoted>[^;\n]*))/;
        const matches = filenameRegex.exec(disposition);
        if (matches?.groups?.quoted || matches?.groups?.unquoted) {
          filename = matches.groups.quoted || matches.groups.unquoted;
        }
      }

      const contentType = response.headers['content-type'] ? String(response.headers['content-type']) : 'application/zip';
      const blob = new Blob([response.data], { type: contentType });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      exportConnectionsMessage.value = t('settings.exportConnections.success', '导出成功。文件已开始下载。');
      exportConnectionsSuccess.value = true;
    } catch (error: any) {
      console.error('导出连接失败:', error);
      let message = t('settings.exportConnections.error', '导出连接时发生错误。');
      if (isAxiosError(error) && error.response && error.response.data) {
        if (error.response.data instanceof Blob && error.response.data.type === 'application/json') {
          try {
            const errorJson = JSON.parse(await error.response.data.text());
            message = errorJson.message || message;
          } catch (e) { /* Blob not valid JSON */ }
        } else if (typeof error.response.data === 'string' && error.response.data.length < 200) { // Avoid overly long string errors
          message = error.response.data;
        } else if (error.response.data && typeof error.response.data.message === 'string') {
          message = error.response.data.message;
        }
      } else if (error.message) {
        message = error.message;
      }
      exportConnectionsMessage.value = message;
      exportConnectionsSuccess.value = false;
    } finally {
      exportConnectionsLoading.value = false;
    }
  };

  return {
    exportConnectionsLoading,
    exportConnectionsMessage,
    exportConnectionsSuccess,
    handleExportConnections,
  };
}