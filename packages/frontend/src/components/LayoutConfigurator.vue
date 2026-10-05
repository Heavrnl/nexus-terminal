<script setup lang="ts">
import { ref, computed, watch, type Ref, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLayoutStore, type LayoutNode, type PaneName } from '../stores/layout.store';
import { useSettingsStore } from '../stores/settings.store';
import { storeToRefs } from 'pinia';
import draggable from 'vuedraggable';
import LayoutNodeEditor from './LayoutNodeEditor.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { useAlertDialog } from '../composables/useAlertDialog';



// --- Props ---
const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
});

// --- Emits ---
const emit = defineEmits(['close']);

// --- Setup ---
const { t } = useI18n();
const layoutStore = useLayoutStore();
const settingsStore = useSettingsStore(); // +++ Initialize settings store +++
const { layoutLockedBoolean } = storeToRefs(settingsStore); // +++ Get reactive state +++
const { showConfirmDialog } = useConfirmDialog();
const { showAlertDialog } = useAlertDialog();

// --- State ---
const localLayoutTree: Ref<LayoutNode | null> = ref(null);
// State for current edits
// const localLayoutTree: Ref<LayoutNode | null> = ref(null); // REMOVE DUPLICATE
const localSidebarPanes: Ref<{ left: PaneName[], right: PaneName[] }> = ref({ left: [], right: [] });
const localAvailablePanes: Ref<PaneName[]> = ref([]);

// State for original values to compare against
const originalLayoutTree: Ref<LayoutNode | null> = ref(null);
const originalSidebarPanes: Ref<{ left: PaneName[], right: PaneName[] }> = ref({ left: [], right: [] });

// --- Dialog State ---
const dialogRef = ref<HTMLElement | null>(null);

// --- Watchers ---
watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    // --- Load initial data and create original copies ---
    // Main layout
    const initialLayout = layoutStore.layoutTree ? JSON.parse(JSON.stringify(layoutStore.layoutTree)) : null;
    localLayoutTree.value = initialLayout;
    originalLayoutTree.value = JSON.parse(JSON.stringify(initialLayout)); // Deep copy for original

    // Sidebar config
    const initialSidebars = layoutStore.sidebarPanes ? JSON.parse(JSON.stringify(layoutStore.sidebarPanes)) : { left: [], right: [] };
    localSidebarPanes.value = initialSidebars;
    originalSidebarPanes.value = JSON.parse(JSON.stringify(initialSidebars)); // Deep copy for original

    // Initialize available panes: Include 'terminal' only if it's not already used.
    const initialUsed = getAllLocalUsedPaneNames(localLayoutTree.value, localSidebarPanes.value);
    if (initialUsed.has('terminal')) {
        // Terminal is used, available list excludes it
        localAvailablePanes.value = layoutStore.allPossiblePanes.filter(p => p !== 'terminal');
    } else {
        // Terminal is not used, available list includes all
        localAvailablePanes.value = [...layoutStore.allPossiblePanes];
    }
    // Ensure original order is maintained
    localAvailablePanes.value.sort((a, b) =>
        layoutStore.allPossiblePanes.indexOf(a) - layoutStore.allPossiblePanes.indexOf(b)
    );

    console.log('[LayoutConfigurator] Dialog opened, initial data loaded and original copies created.');

  } else {
    // --- Clear all state on close ---
    localLayoutTree.value = null;
    originalLayoutTree.value = null;
    localSidebarPanes.value = { left: [], right: [] };
    originalSidebarPanes.value = { left: [], right: [] };
    localAvailablePanes.value = [];
    console.log('[LayoutConfigurator] Dialog closed, state cleared.');
  }
});

// --- Helper Functions ---
function getMainLayoutUsedPaneNames(node: LayoutNode | null): Set<PaneName> {
  const usedNames = new Set<PaneName>();
  if (!node) return usedNames;
  function traverse(currentNode: LayoutNode) {
    if (currentNode.type === 'pane' && currentNode.component) {
      usedNames.add(currentNode.component);
    } else if (currentNode.type === 'container' && currentNode.children) {
      currentNode.children.forEach(traverse);
    }
  }
  traverse(node);
  return usedNames;
}

function getAllLocalUsedPaneNames(mainNode: LayoutNode | null, sidebars: { left: PaneName[], right: PaneName[] }): Set<PaneName> {
  const usedNames = getMainLayoutUsedPaneNames(mainNode);
  sidebars.left.forEach(pane => usedNames.add(pane));
  sidebars.right.forEach(pane => usedNames.add(pane));
  return usedNames;
}

// --- Restore Helper Functions for Terminal ---
// Helper to add 'terminal' back to available list if not present
function addPaneToAvailableList(paneName: PaneName) {
   // Only act if the pane is 'terminal' and it's not already available
   if (paneName === 'terminal' && !localAvailablePanes.value.includes('terminal')) {
       // Maintain original order if possible
       const originalIndex = layoutStore.allPossiblePanes.indexOf('terminal');
       let inserted = false;
       for (let i = 0; i < localAvailablePanes.value.length; i++) {
           const currentAvailablePane = localAvailablePanes.value[i];
           const currentOriginalIndex = layoutStore.allPossiblePanes.indexOf(currentAvailablePane);
           if (originalIndex < currentOriginalIndex) {
               localAvailablePanes.value.splice(i, 0, 'terminal');
               inserted = true;
               break;
           }
       }
       if (!inserted) {
            localAvailablePanes.value.push('terminal'); // Add to end if no suitable spot found
       }
       console.log(`[LayoutConfigurator] Added 'terminal' back to available panes.`);
   }
}

// Helper to remove 'terminal' from available list
function removePaneFromAvailableList(paneName: PaneName) {
    if (paneName === 'terminal') {
        const index = localAvailablePanes.value.indexOf('terminal');
        if (index > -1) {
            localAvailablePanes.value.splice(index, 1);
            console.log(`[LayoutConfigurator] Removed 'terminal' from available panes.`);
        }
    }
}
// --- Computed ---
// Panel Labels for display
// Real-time comparison to determine if changes exist
const isModified = computed(() => {
  // Compare current local state with the original snapshot
  const currentLayoutJson = JSON.stringify(localLayoutTree.value);
  const originalLayoutJson = JSON.stringify(originalLayoutTree.value);
  const currentSidebarJson = JSON.stringify(localSidebarPanes.value);
  const originalSidebarJson = JSON.stringify(originalSidebarPanes.value);

  // Return true if either layout or sidebars differ from the original
  const modified = currentLayoutJson !== originalLayoutJson || currentSidebarJson !== originalSidebarJson;
  // console.log(`[LayoutConfigurator] isModified computed: ${modified}`); // Debug log
  return modified;
});

const paneLabels = computed(() => ({ // Assuming labels might depend on i18n
  connections: t('layout.pane.connections', '连接列表'),
  terminal: t('layout.pane.terminal', '终端'),
  commandBar: t('layout.pane.commandBar', '命令栏'),
  fileManager: t('layout.pane.fileManager', '文件管理器'),
  editor: t('layout.pane.editor', '编辑器'),
  statusMonitor: t('layout.pane.statusMonitor', '状态监视器'),
  commandHistory: t('layout.pane.commandHistory', '命令历史'),
  quickCommands: t('layout.pane.quickCommands', '快捷指令'),
  dockerManager: t('layout.pane.dockerManager', 'Docker 管理器'),
  suspendedSshSessions: t('layout.pane.suspendedSshSessions'),
  multiLineCommandInput: t('layout.pane.multiLineCommandInput', '多行命令输入'),
}));

// --- Methods ---
// +++ Method to update layout lock setting +++
const handleLayoutLockChange = async () => { // Removed event parameter
  const isLocked = !layoutLockedBoolean.value; // Toggle the current state
  console.log(`[LayoutConfigurator] Layout lock toggled: ${isLocked}`);
  try {
    // +++ Convert boolean to string before sending +++
    await settingsStore.updateSetting('layoutLocked', String(isLocked));
    // No need to update local state directly, store watcher should handle it if needed,
    // but the button's appearance relies on layoutLockedBoolean which comes from the store.
  } catch (error) {
    console.error('[LayoutConfigurator] Failed to update layout lock setting:', error);
  }
};

const closeDialog = async () => {
  // Use the computed property for the check
  if (isModified.value) {
    const confirmed = await showConfirmDialog({
      message: t('layoutConfigurator.confirmClose', '有未保存的更改，确定要关闭吗？')
    });
    if (confirmed) {
      emit('close');
    }
  } else {
    emit('close');
  }
};

const saveLayout = async () => { // Make async
  console.log('[LayoutConfigurator] Attempting to save layout...');
  try {
    // Save main layout and wait for persistence
    console.log('[LayoutConfigurator] Updating main layout tree in store...');
    await layoutStore.updateLayoutTree(localLayoutTree.value); // Await the async action
    console.log('[LayoutConfigurator] Main layout tree update awaited.');

    // Save sidebar config and wait for persistence
    const sidebarConfigToSave = JSON.parse(JSON.stringify(localSidebarPanes.value));
    console.log('[LayoutConfigurator] Updating sidebar panes in store:', sidebarConfigToSave);
    await layoutStore.updateSidebarPanes(sidebarConfigToSave); // Await the async action
    console.log('[LayoutConfigurator] Sidebar panes update awaited.');

    // isModified will update automatically based on comparison with original state after save
    emit('close'); // Close dialog *after* save is complete
    console.log('[LayoutConfigurator] Layout saved successfully, dialog closed.');
  } catch (error) {
      console.error('[LayoutConfigurator] Error saving layout:', error);
  }
};

const resetToDefault = async () => {
  const confirmed = await showConfirmDialog({
    message: t('layoutConfigurator.confirmReset', '确定要恢复默认布局和侧栏配置吗？当前更改将丢失。')
  });
  if (confirmed) {
    // Reset main layout
    const defaultLayout = layoutStore.getSystemDefaultLayout();
    localLayoutTree.value = JSON.parse(JSON.stringify(defaultLayout));

    // Reset sidebar config
    const defaultSidebarPanes = layoutStore.getSystemDefaultSidebarPanes();
    localSidebarPanes.value = JSON.parse(JSON.stringify(defaultSidebarPanes));

    // Reset available panes: Include 'terminal' only if it's not used in the default layout.
    const defaultUsed = getAllLocalUsedPaneNames(localLayoutTree.value, localSidebarPanes.value);
    if (defaultUsed.has('terminal')) {
        localAvailablePanes.value = layoutStore.allPossiblePanes.filter(p => p !== 'terminal');
    } else {
        localAvailablePanes.value = [...layoutStore.allPossiblePanes];
    }
    // Ensure original order
    localAvailablePanes.value.sort((a, b) =>
        layoutStore.allPossiblePanes.indexOf(a) - layoutStore.allPossiblePanes.indexOf(b)
    );

    console.log('[LayoutConfigurator] Reset to default layout, sidebar panes, and available panes.');
    // isModified computed property will detect the change automatically by comparing with original state
  }
};

// Clone function for dragging available panes
const clonePane = (paneName: PaneName): LayoutNode => {
  console.log(`[LayoutConfigurator] Cloning pane: ${paneName}`);
  return {
    id: layoutStore.generateId(),
    type: 'pane',
    component: paneName,
    size: 50, // Default size, can be adjusted later
  };
};

// Handle updates from LayoutNodeEditor (for main layout)
const handleNodeUpdate = (updatedNode: LayoutNode) => {
  console.log('[LayoutConfigurator] Received node update from editor:', updatedNode);
  localLayoutTree.value = updatedNode;
};

// Handle remove requests from LayoutNodeEditor (for main layout) - CORRECTED VERSION
function findAndRemoveNode(node: LayoutNode | null, parentNodeId: string | undefined, nodeIndex: number): LayoutNode | null {
    if (!node) return null;

    // Case 1: Found the parent container
    if (node.id === parentNodeId && node.type === 'container' && node.children && node.children[nodeIndex]) {
        const updatedChildren = [...node.children];
        const removedNode = updatedChildren.splice(nodeIndex, 1)[0]; // Remove and get the node
        console.log(`[LayoutConfigurator] Removing node at index ${nodeIndex} from parent ${parentNodeId}`);

        // If the removed node was the terminal pane, add it back to available list
        if (removedNode.type === 'pane' && removedNode.component === 'terminal') {
            addPaneToAvailableList('terminal');
        }
        // No need to handle containers specifically for adding back, only terminal matters.
        return { ...node, children: updatedChildren };
    }

    // Case 2: Traverse deeper
    if (node.type === 'container' && node.children) {
        const updatedChildren = node.children.map(child => findAndRemoveNode(child, parentNodeId, nodeIndex));
        // Check if any child subtree was modified
        if (updatedChildren.some((child, index) => child !== node.children![index])) {
            return { ...node, children: updatedChildren.filter(Boolean) as LayoutNode[] };
        }
    }

    // Case 3: No match or not a container
    return node;
}

// CORRECTED handleNodeRemove
const handleNodeRemove = async (payload: { parentNodeId: string | undefined; nodeIndex: number }) => {
  console.log('[LayoutConfigurator] Received node remove request:', payload);
  if (payload.parentNodeId === undefined && payload.nodeIndex === 0) {
    const confirmed = await showConfirmDialog({
      message: t('layoutConfigurator.confirmClearLayout', '确定要清空整个布局吗？所有面板将返回可用列表。')
    });
    if (confirmed) {
      localLayoutTree.value = null;
    }
  } else if (payload.parentNodeId) {
     // Update the local tree; isModified will react automatically
     localLayoutTree.value = findAndRemoveNode(localLayoutTree.value, payload.parentNodeId, payload.nodeIndex);
  } else {
     console.warn('[LayoutConfigurator] Invalid remove payload:', payload);
  }
};

// Remove pane from sidebar list
const removeSidebarPane = (side: 'left' | 'right', index: number) => {
   const removedPane = localSidebarPanes.value[side].splice(index, 1)[0]; // Remove and get pane name
   if (removedPane) {
       console.log(`[LayoutConfigurator] Removed pane '${removedPane}' from ${side} sidebar at index ${index}.`);
       // If the removed pane was 'terminal', add it back to available list
       if (removedPane === 'terminal') {
           addPaneToAvailableList('terminal');
       }
   }
   // isModified will react automatically
};

// Handler for vuedraggable end event to ensure changes flag is set and handle added items
const onDraggableChange = (event: any, side: 'left' | 'right') => { // Add side parameter
    console.log(`[LayoutConfigurator] Draggable change event detected on ${side} sidebar:`, event);

    // Check if an element was added to the sidebar list
    if (event.added) {
        const addedElement = event.added.element;
        const targetList = localSidebarPanes.value[side]; // Use the side parameter directly
        const addedIndex = event.added.newIndex;

        // Check if the added element is a LayoutNode object (dragged from available panes)
        if (targetList && typeof addedElement === 'object' && addedElement !== null && addedElement.type === 'pane' && typeof addedElement.component === 'string') {
            // Replace the added LayoutNode object with its component name (PaneName)
            targetList.splice(addedIndex, 1, addedElement.component);
            console.log(`[LayoutConfigurator] Replaced added LayoutNode at index ${addedIndex} on ${side} sidebar with PaneName: ${addedElement.component}`);
        } else {
             console.log(`[LayoutConfigurator] Added event detected on ${side} sidebar, but element was not a LayoutNode:`, addedElement);
        }
    } else if (event.moved || event.removed) {
         console.log(`[LayoutConfigurator] Item moved or removed within/from ${side} sidebar.`);
    }

    // isModified will react automatically
};

// Handle drag end from the available panes list
const handleAvailablePaneDragEnd = (event: any) => {
    // Check if the item was dropped into a different list
    if (event.to !== event.from) {
        const paneName = event.oldIndex !== undefined ? localAvailablePanes.value[event.oldIndex] : null;

        // If 'terminal' was dragged out, remove it from the available list
        if (paneName === 'terminal') {
            removePaneFromAvailableList('terminal');
        } else if (paneName) {
             console.log(`[LayoutConfigurator] Non-terminal pane "${paneName}" dropped elsewhere (clone).`);
             // Other panes are clones, do nothing to the available list
        } else {
             console.error('[LayoutConfigurator] Could not determine dragged pane name in handleAvailablePaneDragEnd.');
        }
    } else {
         console.log('[LayoutConfigurator] Item dropped back into available list or drag cancelled.');
    }
};

</script>

<template>
  <div v-if="isVisible" class="fixed inset-0 bg-overlay flex justify-center items-center z-[1000]" @click.self="closeDialog">
    <div ref="dialogRef" class="bg-background text-foreground rounded-lg shadow-xl w-auto h-auto min-w-[800px] min-h-[600px] max-w-[95vw] max-h-[90vh] flex flex-col overflow-auto relative pointer-events-auto cursor-default">

      <header class="flex justify-between items-center p-4 border-b border-border bg-header">
        <h2 class="text-lg font-semibold">{{ t('layoutConfigurator.title', '布局管理器') }}</h2>
        <button class="bg-transparent border-none text-2xl cursor-pointer text-text-secondary hover:text-foreground leading-none p-0" @click="closeDialog" :title="t('common.close', '关闭')">&times;</button>
      </header>

      <!-- Grid Layout -->
      <main class="flex-grow p-6 overflow-y-auto grid grid-cols-[220px_1fr] gap-6 min-h-[450px]">

        <!-- Available Panes -->
        <section class="flex flex-col overflow-y-auto border-r border-border pr-6 min-w-[200px]">
          <h3 class="mt-0 mb-4 text-base font-semibold text-text-secondary">{{ t('layoutConfigurator.availablePanes', '可用面板') }}</h3>
          <draggable
            :list="localAvailablePanes"
            tag="ul"
            class="list-none p-0 m-0 flex-grow"
            @end="handleAvailablePaneDragEnd"
            :item-key="(element: PaneName) => element"
            :group="{ name: 'layout-items', pull: 'clone', put: false }"
            :sort="false"
            :clone="clonePane"
          >
            <template #item="{ element }: { element: PaneName }">
              <li class="flex items-center p-2 mb-2 bg-background-alt border border-border rounded cursor-grab transition-colors duration-150 hover:bg-hover active:cursor-grabbing active:bg-border text-sm">
                <i class="fas fa-grip-vertical mr-2 text-text-alt cursor-grab active:cursor-grabbing"></i>
                {{ paneLabels[element] || element }}
              </li>
            </template>
            <template #footer>
              <li v-if="localAvailablePanes.length === 0" class="text-text-alt italic p-2 text-sm">
                {{ t('layoutConfigurator.noAvailablePanes', '所有面板都已在布局中') }}
              </li>
            </template>
          </draggable>
        </section>

        <!-- Main Layout Preview & Sidebar Config -->
        <div class="flex flex-col">
            <!-- Main Layout Preview -->
            <section class="flex flex-col min-w-[350px] flex-grow">
              <div class="flex justify-between items-center mb-4"> <!-- +++ Flex container for title and switch +++ -->
                <h3 class="mt-0 mb-0 text-base font-semibold text-text-secondary">{{ t('layoutConfigurator.layoutPreview', '主布局预览（拖拽到此处）') }}</h3>
                <!-- +++ Layout Lock Switch +++ -->
                <div class="flex items-center gap-2">
                   <label id="layout-lock-label" class="text-sm text-text-secondary cursor-pointer select-none" @click="handleLayoutLockChange">{{ t('layoutConfigurator.lockLayout', '锁定布局') }}</label>
                   <button
                     type="button"
                     @click="handleLayoutLockChange"
                     :class="[
                       'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
                       layoutLockedBoolean ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                     ]"
                     role="switch"
                     :aria-checked="layoutLockedBoolean"
                     aria-labelledby="layout-lock-label"
                   >
                     <span
                       aria-hidden="true"
                       :class="[
                         'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
                         layoutLockedBoolean ? 'translate-x-5' : 'translate-x-0'
                       ]"
                     ></span>
                   </button>
                 </div>
              </div>
              <div class="flex-grow border-2 border-dashed border-border-alt rounded p-4 bg-background-alt flex flex-col overflow-auto min-h-[250px]">
                <LayoutNodeEditor
                  v-if="localLayoutTree"
                  :node="localLayoutTree"
                  :parent-node="null"
                  :node-index="0"
                  :pane-labels="paneLabels"
                  @update:node="handleNodeUpdate"
                  @removeNode="handleNodeRemove"
                  :group="'layout-items'"
                  class="flex-grow"
                />
                <p v-else class="text-center text-text-alt p-8 italic text-sm w-full">
                  {{ t('layoutConfigurator.emptyLayout', '布局为空，请从左侧拖拽面板或添加容器。') }}
                </p>
              </div>
              <div class="mt-4 flex gap-2">
                 <button @click="resetToDefault" class="py-2 px-4 rounded text-sm transition-colors duration-150 bg-button text-button-text hover:bg-button-hover border border-border">
                   {{ t('layoutConfigurator.resetDefault', '恢复默认') }}
                 </button>
               </div>
            </section>

            <!-- Sidebar Configuration Container -->
            <div class="grid grid-cols-2 gap-6 border-t border-border pt-4 mt-4 min-h-[150px]">
                <!-- Left Sidebar Config -->
                <section class="flex flex-col">
                    <h3 class="mt-0 mb-4 text-base font-semibold text-text-secondary">{{ t('layoutConfigurator.leftSidebar', '左侧栏面板') }}</h3>
                    <draggable
                        :list="localSidebarPanes.left"
                        tag="ul"
                        class="list-none p-0 m-0 min-h-[120px] bg-background-alt border border-dashed border-border-alt rounded p-2 flex-grow overflow-y-auto"
                        :item-key="(element: PaneName) => `left-${element}`"
                        group="layout-items"
                        :sort="true"
                        @change="(event) => onDraggableChange(event, 'left')"
                    >
                        <template #item="{ element, index }: { element: PaneName, index: number }">
                            <li class="flex items-center justify-between p-2 mb-2 bg-hover border border-border rounded cursor-grab transition-colors duration-150 hover:bg-border active:cursor-grabbing active:bg-border-alt text-sm">
                                <div class="flex items-center overflow-hidden">
                                    <i class="fas fa-grip-vertical mr-2 text-text-alt cursor-grab active:cursor-grabbing flex-shrink-0"></i>
                                    <span class="flex-grow mr-2 overflow-hidden text-ellipsis whitespace-nowrap">{{ paneLabels[element] || element }}</span>
                                </div>
                                <button @click="removeSidebarPane('left', index)" class="bg-transparent border-none text-text-alt text-lg cursor-pointer p-1 leading-none flex-shrink-0 hover:text-error" :title="t('common.remove', '移除')">&times;</button>
                            </li>
                        </template>
                        <template #footer>
                            <li v-if="localSidebarPanes.left.length === 0" class="text-center text-text-alt p-4 italic text-sm w-full min-h-[50px] flex items-center justify-center">
                                {{ t('layoutConfigurator.dropHere', '从可用面板拖拽到此处') }}
                            </li>
                        </template>
                    </draggable>
                </section>

                <!-- Right Sidebar Config -->
                <section class="flex flex-col">
                    <h3 class="mt-0 mb-4 text-base font-semibold text-text-secondary">{{ t('layoutConfigurator.rightSidebar', '右侧栏面板') }}</h3>
                     <draggable
                        :list="localSidebarPanes.right"
                        tag="ul"
                        class="list-none p-0 m-0 min-h-[120px] bg-background-alt border border-dashed border-border-alt rounded p-2 flex-grow overflow-y-auto"
                        :item-key="(element: PaneName) => `right-${element}`"
                        group="layout-items"
                        :sort="true"
                        @change="(event) => onDraggableChange(event, 'right')"
                    >
                        <template #item="{ element, index }: { element: PaneName, index: number }">
                             <li class="flex items-center justify-between p-2 mb-2 bg-hover border border-border rounded cursor-grab transition-colors duration-150 hover:bg-border active:cursor-grabbing active:bg-border-alt text-sm">
                                <div class="flex items-center overflow-hidden">
                                    <i class="fas fa-grip-vertical mr-2 text-text-alt cursor-grab active:cursor-grabbing flex-shrink-0"></i>
                                    <span class="flex-grow mr-2 overflow-hidden text-ellipsis whitespace-nowrap">{{ paneLabels[element] || element }}</span>
                                </div>
                                <button @click="removeSidebarPane('right', index)" class="bg-transparent border-none text-text-alt text-lg cursor-pointer p-1 leading-none flex-shrink-0 hover:text-error" :title="t('common.remove', '移除')">&times;</button>
                            </li>
                        </template>
                         <template #footer>
                            <li v-if="localSidebarPanes.right.length === 0" class="text-center text-text-alt p-4 italic text-sm w-full min-h-[50px] flex items-center justify-center">
                                 {{ t('layoutConfigurator.dropHere', '从可用面板拖拽到此处') }}
                            </li>
                        </template>
                    </draggable>
                </section>
            </div>
        </div>

      </main>

      <footer class="p-4 border-t border-border flex justify-end gap-3 bg-header">
        <button @click="closeDialog" class="py-2 px-4 rounded text-sm transition-colors duration-150 bg-button text-button-text hover:bg-button-hover border border-border">{{ t('common.cancel', '取消') }}</button>
        <button @click="saveLayout" class="py-2 px-4 rounded text-sm transition-colors duration-150 bg-primary text-white hover:bg-primary-dark disabled:bg-gray-400 disabled:opacity-70 disabled:cursor-not-allowed" :disabled="!isModified">
          {{ t('common.save', '保存') }}{{ isModified ? '*' : '' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style>


</style>
