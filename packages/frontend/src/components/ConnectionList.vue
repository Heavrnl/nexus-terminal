<script setup lang="ts">
import { onMounted, computed, ref, reactive, watch } from 'vue'; 
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useConnectionsStore, ConnectionInfo } from '../stores/connections.store';
import { useTagsStore } from '../stores/tags.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog';

const { t } = useI18n();
const router = useRouter();
const tagsStore = useTagsStore();
const { showConfirmDialog } = useConfirmDialog();
const { showAlertDialog } = useAlertDialog();



const { tags: allTags, isLoading: isTagsLoading, error: tagsError } = storeToRefs(tagsStore); 

// 定义 Props，接收筛选后的连接列表
const props = defineProps<{
  connections: ConnectionInfo[];
}>();

// 定义组件发出的事件 (添加 edit-connection)
const emit = defineEmits(['edit-connection']);

// 用于跟踪每个连接测试状态的响应式对象
const testingState = reactive<Record<number, boolean>>({});

// 组件挂载时获取标签列表 (连接列表由父组件传入)
onMounted(() => {
  tagsStore.fetchTags(); // 获取标签列表
});

// Log received props for debugging
watch(() => props.connections, (newVal: ConnectionInfo[]) => { // Add type annotation for newVal
  console.log('[ConnectionList] Received connections prop:', JSON.stringify(newVal, null, 2));
}, { immediate: true, deep: true });

// 创建标签 ID 到名称的映射
const tagMap = computed(() => {
    const map = new Map<number, string>();
    allTags.value.forEach(tag => {
        map.set(tag.id, tag.name);
    });
    return map;
});

// 获取连接的标签名称数组
const getConnectionTagNames = (conn: ConnectionInfo): string[] => {
    if (!conn.tag_ids || conn.tag_ids.length === 0) {
        return [];
    }
    return conn.tag_ids
        .map(tagId => tagMap.value.get(tagId)) // 使用映射获取名称
         .filter((name): name is string => !!name); // 过滤掉未找到的标签并确保类型为 string
 };

 // 计算按标签分组的连接
 const groupedConnections = computed(() => {
     const groups: { [key: string]: ConnectionInfo[] } = {};
     const untaggedKey = '_untagged_'; // 特殊键，用于未标记的连接

     // 初始化所有标签组（包括未标记）
     groups[untaggedKey] = [];
     allTags.value.forEach(tag => {
         groups[tag.name] = []; // 使用标签名称作为键
     });

     // 将连接分配到对应的组
     props.connections.forEach(conn => {
         if (!conn.tag_ids || conn.tag_ids.length === 0) {
             groups[untaggedKey].push(conn);
         } else {
             conn.tag_ids.forEach(tagId => {
                 const tagName = tagMap.value.get(tagId);
                 if (tagName && groups[tagName]) { // 确保标签存在于映射和分组中
                     groups[tagName].push(conn);
                 } else if (tagName) {
                     // 如果标签存在但分组未初始化（理论上不应发生），则创建分组
                     groups[tagName] = [conn];
                 } else {
                     // 如果 tagId 无效或未找到对应标签名，归入未标记组
                     groups[untaggedKey].push(conn);
                 }
             });
         }
     });

     // 过滤掉没有连接的标签组（除了未标记组，即使为空也可能需要显示）
     const filteredGroups: { [key: string]: ConnectionInfo[] } = {};
     for (const groupName in groups) {
         if (groups[groupName].length > 0 || groupName === untaggedKey) {
              // 按连接名称排序每个分组内部的连接
              groups[groupName].sort((a, b) => a.name.localeCompare(b.name));
              filteredGroups[groupName] = groups[groupName];
         }
     }

      // 对分组本身进行排序（未标记的放最后）
      const sortedGroupNames = Object.keys(filteredGroups).sort((a, b) => {
          if (a === untaggedKey) return 1; // 未标记的排在后面
          if (b === untaggedKey) return -1;
          return a.localeCompare(b); // 其他按名称排序
      });

      const sortedGroups: { [key: string]: ConnectionInfo[] } = {};
      sortedGroupNames.forEach(name => {
          sortedGroups[name] = filteredGroups[name];
      });


     return sortedGroups;
 });


 // 辅助函数：格式化时间戳
const formatTimestamp = (timestamp: number | null): string => {
  if (!timestamp) return t('connections.status.never'); // 使用 i18n
  return new Date(timestamp * 1000).toLocaleString(); // 乘以 1000 转换为毫秒
};

// 处理删除连接的方法
const handleDelete = async (conn: ConnectionInfo) => {
    // 在函数内部获取 store 实例
    const connectionsStore = useConnectionsStore();
    // 使用 i18n 获取确认消息
    const confirmMessage = t('connections.prompts.confirmDelete', { name: conn.name });
    const confirmed = await showConfirmDialog({
      message: confirmMessage
    });
    if (confirmed) {
        const success = await connectionsStore.deleteConnection(conn.id);
        if (!success) {

            showAlertDialog({ title: t('common.error'), message: t('connections.errors.deleteFailed', { error: connectionsStore.error || '未知错误' }) });
        }
     }
 };

 // 处理测试连接的方法
 const handleTestConnection = async (connectionId: number) => {
     const connectionsStore = useConnectionsStore(); // 获取 store 实例
     testingState[connectionId] = true; // 设置为正在测试状态
     const result = await connectionsStore.testConnection(connectionId); // 调用 store action
     testingState[connectionId] = false; // 清除测试状态

     // 显示测试结果
     if (result.success) {
         showAlertDialog({ title: t('common.success'), message: t('connections.test.success') });
     } else {
         showAlertDialog({ title: t('common.error'), message: t('connections.test.failed', { error: result.message || '未知错误' }) });
     }
 };

 </script>

<template>
  <div class="mt-2 font-sans">
    <div v-if="tagsError" class="p-4 border border-red-300 bg-red-100 text-red-700 rounded m-2">
      {{ t('tags.error', { error: tagsError }) }}
    </div>

    <!-- 遍历分组 -->
    <div v-for="(groupConnections, groupName) in groupedConnections" :key="groupName" class="mb-6 border border-border rounded-md overflow-hidden bg-background">
        <h4 class="m-0 px-4 py-2 text-base font-semibold bg-header text-foreground border-b border-border">
            {{ groupName === '_untagged_' ? t('connections.untaggedGroup') : groupName }}
            ({{ groupConnections.length }})
        </h4>
        <div class="overflow-x-auto">
            <table v-if="groupConnections.length > 0" class="w-full">
                <thead class="bg-header">
                    <tr>
                        <th class="px-4 py-2 text-left text-xs font-medium text-text-secondary uppercase tracking-wider border-b-2 border-border">{{ t('connections.table.name') }}</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-text-secondary uppercase tracking-wider border-b-2 border-border">{{ t('connections.table.host') }}</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-text-secondary uppercase tracking-wider border-b-2 border-border">{{ t('connections.table.port') }}</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-text-secondary uppercase tracking-wider border-b-2 border-border">{{ t('connections.table.user') }}</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-text-secondary uppercase tracking-wider border-b-2 border-border">{{ t('connections.table.authMethod') }}</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-text-secondary uppercase tracking-wider border-b-2 border-border">{{ t('connections.table.tags') }}</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-text-secondary uppercase tracking-wider border-b-2 border-border">{{ t('connections.table.lastConnected') }}</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-text-secondary uppercase tracking-wider border-b-2 border-border">{{ t('connections.table.actions') }}</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-border">
                    <tr v-for="conn in groupConnections" :key="conn.id" class="hover:bg-hover transition-colors duration-150">
                        <td class="px-4 py-3 text-sm text-foreground whitespace-nowrap flex items-center">
                          <span
                            v-if="conn.background_color"
                            class="w-2.5 h-2.5 rounded-full mr-2 flex-shrink-0 border border-white/20 shadow-xs"
                            :style="{ backgroundColor: conn.background_color }"
                            :title="conn.background_color"
                          ></span>
                          <i :class="['fas', conn.type === 'RDP' || conn.type === 'VNC' ? 'fa-desktop' : 'fa-server', 'mr-2 w-4 text-center', conn.background_color ? '' : 'text-text-secondary']" :style="conn.background_color ? { color: conn.background_color } : {}"></i>
                          <span>{{ conn.name }}</span>
                        </td>
                        <td class="px-4 py-3 text-sm text-foreground whitespace-nowrap">{{ conn.host }}</td>
                        <td class="px-4 py-3 text-sm text-foreground whitespace-nowrap">{{ conn.port }}</td>
                        <td class="px-4 py-3 text-sm text-foreground whitespace-nowrap">{{ conn.username }}</td>
                        <td class="px-4 py-3 text-sm text-foreground whitespace-nowrap">{{ conn.auth_method }}</td>
                        <td class="px-4 py-3 text-sm text-foreground">
                          <div v-if="getConnectionTagNames(conn).length > 0" class="flex flex-wrap gap-1">
                              <span v-for="tagName in getConnectionTagNames(conn)" :key="tagName" class="px-2 py-0.5 text-xs rounded bg-background-alt border border-border text-text-secondary">
                                  {{ tagName }}
                              </span>
                          </div>
                          <span v-else class="text-text-alt italic">-</span>
                        </td>
                        <td class="px-4 py-3 text-sm text-foreground whitespace-nowrap">{{ formatTimestamp(conn.last_connected_at) }}</td>
                        <td class="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                          <button @click="connectToServer(conn.id)" class="px-2.5 py-1 text-xs rounded border transition-colors duration-150 mr-1.5 bg-green-600 text-white border-green-600 hover:bg-green-700 hover:border-green-700">{{ t('connections.actions.connect') }}</button>
                          <button @click="emit('edit-connection', conn)" class="px-2.5 py-1 text-xs rounded border transition-colors duration-150 mr-1.5 bg-yellow-500 text-gray-800 border-yellow-500 hover:bg-yellow-600 hover:border-yellow-600">{{ t('connections.actions.edit') }}</button>
                          <button @click="handleTestConnection(conn.id)" class="px-2.5 py-1 text-xs rounded border transition-colors duration-150 mr-1.5 bg-blue-600 text-white border-blue-600 hover:bg-blue-700 hover:border-blue-700 disabled:opacity-60 disabled:cursor-not-allowed disabled:bg-gray-500 disabled:border-gray-500" :disabled="testingState[conn.id]">{{ testingState[conn.id] ? t('connections.actions.testing') : t('connections.actions.test') }}</button>
                          <button @click="handleDelete(conn)" class="px-2.5 py-1 text-xs rounded border transition-colors duration-150 bg-red-600 text-white border-red-600 hover:bg-red-700 hover:border-red-700">{{ t('connections.actions.delete') }}</button>
                        </td>
                    </tr>
                </tbody>
            </table>
            <div v-else-if="groupName === '_untagged_'" class="p-4 text-sm text-text-secondary italic">
                  {{ t('connections.noUntaggedConnections') }}
             </div>
        </div>
     </div>
   </div>
 </template>

<script lang="ts">
// 在 <script setup> 之外定义需要在模板中调用的方法
export default {
  methods: {
    connectToServer(connectionId: number) {
      console.log(`请求连接到服务器 ID: ${connectionId}`);
      // 使用 router 实例进行导航
      this.$router.push({ name: 'Workspace', params: { connectionId: connectionId.toString() } });
    }
  }
}
</script>

<style scoped>

</style>
