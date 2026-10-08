<template>
  <div v-if="settings" class="space-y-6">

    <!-- 1. 终端与控制台 (Terminal & Console) -->
    <div class="bg-background border border-border rounded-xl shadow-sm overflow-hidden">
      <div class="px-6 py-4.5 border-b border-border/80 bg-header/30 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-base shrink-0">
            <i class="fas fa-terminal"></i>
          </div>
          <div>
            <h3 class="text-base sm:text-lg font-semibold text-foreground leading-snug">
              {{ $t('settings.workspace.terminalGroupTitle', '终端与控制台') }}
            </h3>
            <p class="text-sm text-text-secondary mt-1">
              {{ $t('settings.workspace.terminalGroupDesc', '控制终端输出缓冲区、鼠标右键交互、选中文本复制与命令同步') }}
            </p>
          </div>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 终端回滚行数 -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <label for="terminalScrollbackLimitInput" class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ t('settings.terminalScrollback.title', '终端回滚行数') }}
            </label>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ t('settings.terminalScrollback.limitHint', '设置终端保留的最大输出行数。0 或留空表示无限制 (使用默认值 5000)。') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <div class="relative flex items-center">
              <input
                type="number"
                id="terminalScrollbackLimitInput"
                v-model.number="terminalScrollbackLimitLocal"
                min="0"
                step="1"
                placeholder="5000"
                @change="handleUpdateTerminalScrollbackLimit"
                @keydown.enter.prevent="handleUpdateTerminalScrollbackLimit"
                class="w-32 sm:w-36 h-9 px-3 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <span class="text-sm text-text-secondary ml-2 shrink-0">{{ t('settings.terminalScrollback.unit', '行') }}</span>
            </div>
            <span v-if="!terminalScrollbackLimitSuccess && terminalScrollbackLimitMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ terminalScrollbackLimitMessage }}
            </span>
          </div>
        </div>

        <!-- 终端右键交互行为与自定义菜单 (Right Click Behavior) -->
        <div class="px-6 py-4.5 flex flex-col gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="flex-1 pr-2">
              <label for="terminalRightClickBehaviorSelect" class="text-[15px] sm:text-base font-medium text-foreground block">
                {{ $t('settings.workspace.terminalRightClickBehaviorTitle', '终端鼠标右键交互') }}
              </label>
              <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
                {{ $t('settings.workspace.terminalRightClickBehaviorDescription', '自定义在终端中点击鼠标右键的操作。未选中文本时直接粘贴剪贴板内容，选中文本时触发所选行为。') }}
              </p>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <select
                id="terminalRightClickBehaviorSelect"
                v-model="terminalRightClickBehaviorLocal"
                @change="handleUpdateTerminalRightClickBehavior"
                class="h-9 px-3.5 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8 cursor-pointer"
                style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.6rem center; background-size: 14px 10px;"
              >
                <option value="contextMenu">{{ $t('settings.workspace.rightClickBehaviorContextMenu', '弹出右键菜单 (默认)') }}</option>
                <option value="paste">{{ $t('settings.workspace.rightClickBehaviorPaste', '直接粘贴剪贴板内容') }}</option>
                <option value="copy">{{ $t('settings.workspace.rightClickBehaviorCopy', '复制选中文本') }}</option>
                <option value="openPath">{{ $t('settings.workspace.rightClickBehaviorOpenPath', '打开路径') }}</option>
                <option value="openFile">{{ $t('settings.workspace.rightClickBehaviorOpenFile', '打开文件') }}</option>
                <option value="saveQuickCommand">{{ $t('settings.workspace.rightClickBehaviorSaveQuickCommand', '保存为快捷命令') }}</option>
                <option value="none">{{ $t('settings.workspace.rightClickBehaviorNone', '无操作') }}</option>
              </select>
              <span v-if="!terminalRightClickBehaviorSuccess && terminalRightClickBehaviorMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
                <i class="fas fa-exclamation-circle text-xs"></i>
                {{ terminalRightClickBehaviorMessage }}
              </span>
            </div>
          </div>

          <!-- 自定义右键菜单项 (当选择弹出右键菜单时展示) -->
          <div
            v-if="terminalRightClickBehaviorLocal === 'contextMenu'"
            class="mt-1 pt-3.5 border-t border-border/50 flex flex-col gap-2.5 bg-muted/20 -mx-6 px-6 py-3"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-text-secondary flex items-center gap-1.5 uppercase tracking-wider">
                <i class="fas fa-list-check text-xs text-primary"></i>
                <span>{{ $t('settings.workspace.terminalContextMenuItemsTitle', '右键菜单功能项') }}</span>
              </span>
              <span v-if="!terminalContextMenuItemsSuccess && terminalContextMenuItemsMessage" class="text-xs text-red-500">
                {{ terminalContextMenuItemsMessage }}
              </span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 select-none">
              <button
                v-for="item in contextMenuItemDefinitions"
                :key="item.key"
                type="button"
                @click="toggleContextMenuItem(item.key)"
                class="px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-2 transition-all cursor-pointer outline-none"
                :class="terminalContextMenuItemsLocal[item.key]
                  ? 'bg-primary/10 border-primary/40 text-primary shadow-2xs font-semibold'
                  : 'bg-background/80 border-border/70 text-text-secondary hover:text-foreground hover:bg-muted/30'"
              >
                <i
                  :class="[
                    item.icon,
                    'text-xs shrink-0',
                    terminalContextMenuItemsLocal[item.key] ? 'text-primary' : 'text-text-secondary'
                  ]"
                ></i>
                <span class="truncate">{{ item.label }}</span>
                <i
                  class="fas text-[11px] ml-auto shrink-0"
                  :class="terminalContextMenuItemsLocal[item.key] ? 'fa-check text-primary' : 'fa-plus opacity-40'"
                ></i>
              </button>
            </div>
          </div>
        </div>

        <!-- 松开鼠标时自动复制选中文本 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.autoCopyOnSelect.title') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.autoCopyOnSelect.enableLabel') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!autoCopySuccess && autoCopyMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ autoCopyMessage }}
            </span>
            <ToggleSwitch
              v-model="autoCopyEnabled"
              @change="handleUpdateAutoCopySetting"
              aria-label="自动复制"
            />
          </div>
        </div>

        <!-- 不换行 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.workspace.terminalNoWrapTitle', '不换行') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.workspace.terminalNoWrapDescription', '开启后终端长行内容不自动折行，超出视口宽度时支持水平横向滑动查看；关闭时自适应视口自动折行') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!terminalNoWrapSuccess && terminalNoWrapMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ terminalNoWrapMessage }}
            </span>
            <ToggleSwitch
              v-model="terminalNoWrapLocal"
              :loading="terminalNoWrapLoading"
              @change="handleUpdateTerminalNoWrapSetting"
              aria-label="终端不换行"
            />
          </div>
        </div>

        <!-- 命令输入同步目标 -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <label for="commandInputSyncTargetSelect" class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.commandInputSync.title', '命令输入同步') }}
            </label>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.commandInputSync.description', '将命令输入框的内容实时同步到所选面板的搜索框。') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <select
              id="commandInputSyncTargetSelect"
              v-model="commandInputSyncTargetLocal"
              @change="handleUpdateCommandInputSyncTarget"
              class="h-9 px-3.5 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8 cursor-pointer"
              style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.6rem center; background-size: 14px 10px;"
            >
              <option value="none">{{ $t('settings.commandInputSync.targetNone', '无') }}</option>
              <option value="quickCommands">{{ $t('settings.commandInputSync.targetQuickCommands', '快捷指令') }}</option>
              <option value="commandHistory">{{ $t('settings.commandInputSync.targetCommandHistory', '历史命令') }}</option>
            </select>
            <span v-if="!commandInputSyncSuccess && commandInputSyncMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ commandInputSyncMessage }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. 文件管理与代码编辑 (File Manager & Editor) -->
    <div class="bg-background border border-border rounded-xl shadow-sm overflow-hidden">
      <div class="px-6 py-4.5 border-b border-border/80 bg-header/30 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-base shrink-0">
            <i class="fas fa-folder-open"></i>
          </div>
          <div>
            <h3 class="text-base sm:text-lg font-semibold text-foreground leading-snug">
              {{ $t('settings.workspace.fileManagerGroupTitle', '文件管理与代码编辑') }}
            </h3>
            <p class="text-sm text-text-secondary mt-1">
              {{ $t('settings.workspace.fileManagerGroupDesc', '配置文件编辑器展现形态、弹窗模式、多会话标签共享与防误触确认') }}
            </p>
          </div>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 弹窗编辑器 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.popupEditor.title') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.popupEditor.enableLabel') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!popupEditorSuccess && popupEditorMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ popupEditorMessage }}
            </span>
            <ToggleSwitch
              v-model="popupEditorEnabled"
              @change="handleUpdatePopupEditorSetting"
              aria-label="弹窗编辑器"
            />
          </div>
        </div>

        <!-- 弹窗文件管理器 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ t('settings.popupFileManager.title') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ t('settings.popupFileManager.enableLabel') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!showPopupFileManagerSuccess && showPopupFileManagerMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ showPopupFileManagerMessage }}
            </span>
            <ToggleSwitch
              v-model="showPopupFileManagerLocal"
              @change="handleUpdateShowPopupFileManager"
              aria-label="弹窗文件管理器"
            />
          </div>
        </div>

        <!-- 共享编辑器标签页 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.shareEditorTabs.title') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.shareEditorTabs.description') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!shareTabsSuccess && shareTabsMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ shareTabsMessage }}
            </span>
            <ToggleSwitch
              v-model="shareTabsEnabled"
              @change="handleUpdateShareTabsSetting"
              aria-label="共享编辑器标签页"
            />
          </div>
        </div>

        <!-- 文件管理器删除确认 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.workspace.fileManagerDeleteConfirmTitle', '文件管理器删除确认') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.workspace.fileManagerShowDeleteConfirmationLabel', '删除文件或文件夹时显示确认提示框') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!fileManagerShowDeleteConfirmationSuccess && fileManagerShowDeleteConfirmationMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ fileManagerShowDeleteConfirmationMessage }}
            </span>
            <ToggleSwitch
              v-model="fileManagerShowDeleteConfirmationLocal"
              @change="handleUpdateFileManagerDeleteConfirmation"
              aria-label="文件管理器删除确认"
            />
          </div>
        </div>

        <!-- 双击打开文件/文件夹 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.workspace.fileManagerDoubleClickToOpenTitle', '双击打开文件/文件夹') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.workspace.fileManagerDoubleClickToOpenDescription', '开启后需双击打开文件或进入文件夹，单击仅选中；关闭时单击即可直接打开') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!fileManagerDoubleClickToOpenSuccess && fileManagerDoubleClickToOpenMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ fileManagerDoubleClickToOpenMessage }}
            </span>
            <ToggleSwitch
              v-model="fileManagerDoubleClickToOpenLocal"
              :loading="fileManagerDoubleClickToOpenLoading"
              @change="handleUpdateFileManagerDoubleClickToOpen"
              aria-label="双击打开文件或文件夹"
            />
          </div>
        </div>

        <!-- Markdown 默认视图模式 (整合在同一个设置项中，两行标签胶囊，移动端自适应) -->
        <div class="px-6 py-4.5 flex flex-col xl:flex-row xl:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.workspace.markdownDefaultViewModeTitle', 'Markdown 默认视图模式') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.workspace.markdownDefaultViewModeDescription', '分别配置桌面端与移动端打开 Markdown 文件时的默认显示模式') }}
            </p>
          </div>
          <div class="w-full sm:w-auto flex flex-col gap-3 shrink-0">
            <!-- 桌面端设置胶囊 -->
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-3 w-full">
              <span class="text-xs font-semibold text-text-secondary w-14 shrink-0 flex items-center gap-1.5">
                <i class="fas fa-desktop text-xs opacity-75"></i>
                <span>{{ $t('settings.workspace.deviceDesktop', '桌面端') }}</span>
              </span>
              <div class="grid grid-cols-3 sm:flex p-1 bg-header/40 border border-border/80 rounded-lg gap-1 select-none w-full sm:w-auto">
                <button
                  v-for="opt in markdownViewModeOptions"
                  :key="'desktop-' + opt.value"
                  type="button"
                  :disabled="markdownDefaultViewModeLoading"
                  @click="handleSelectMarkdownDefaultViewMode(opt.value)"
                  class="h-8 sm:h-7.5 px-1.5 sm:px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1 sm:gap-1.5 transition-all cursor-pointer outline-none disabled:opacity-50 min-w-0"
                  :class="markdownDefaultViewModeLocal === opt.value
                    ? 'bg-primary text-primary-foreground shadow-2xs font-semibold'
                    : 'text-text-secondary hover:text-foreground hover:bg-muted/40'"
                  :title="opt.label"
                >
                  <i :class="[opt.icon, 'text-xs shrink-0']"></i>
                  <span class="truncate">{{ opt.label }}</span>
                </button>
              </div>
            </div>

            <!-- 移动端设置胶囊 -->
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-3 w-full">
              <span class="text-xs font-semibold text-text-secondary w-14 shrink-0 flex items-center gap-1.5">
                <i class="fas fa-mobile-alt text-xs opacity-75"></i>
                <span>{{ $t('settings.workspace.deviceMobile', '移动端') }}</span>
              </span>
              <div class="grid grid-cols-3 sm:flex p-1 bg-header/40 border border-border/80 rounded-lg gap-1 select-none w-full sm:w-auto">
                <button
                  v-for="opt in markdownViewModeOptions"
                  :key="'mobile-' + opt.value"
                  type="button"
                  :disabled="markdownDefaultViewModeMobileLoading"
                  @click="handleSelectMarkdownDefaultViewModeMobile(opt.value)"
                  class="h-8 sm:h-7.5 px-1.5 sm:px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1 sm:gap-1.5 transition-all cursor-pointer outline-none disabled:opacity-50 min-w-0"
                  :class="markdownDefaultViewModeMobileLocal === opt.value
                    ? 'bg-primary text-primary-foreground shadow-2xs font-semibold'
                    : 'text-text-secondary hover:text-foreground hover:bg-muted/40'"
                  :title="opt.label"
                >
                  <i :class="[opt.icon, 'text-xs shrink-0']"></i>
                  <span class="truncate">{{ opt.label }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. 工作区与侧边栏视图 (Sidebar & View Options) -->
    <div class="bg-background border border-border rounded-xl shadow-sm overflow-hidden">
      <div class="px-6 py-4.5 border-b border-border/80 bg-header/30 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-base shrink-0">
            <i class="fas fa-columns"></i>
          </div>
          <div>
            <h3 class="text-base sm:text-lg font-semibold text-foreground leading-snug">
              {{ $t('settings.workspace.viewGroupTitle', '工作区与侧边栏视图') }}
            </h3>
            <p class="text-sm text-text-secondary mt-1">
              {{ $t('settings.workspace.viewGroupDesc', '定制侧边栏抽屉交互、连接列表标签过滤与快捷指令标签展示') }}
            </p>
          </div>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 侧边栏持久化/固定行为 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.workspace.sidebarPersistentTitle') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.workspace.sidebarPersistentDescription') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!workspaceSidebarPersistentSuccess && workspaceSidebarPersistentMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ workspaceSidebarPersistentMessage }}
            </span>
            <ToggleSwitch
              v-model="workspaceSidebarPersistentEnabled"
              @change="handleUpdateWorkspaceSidebarSetting"
              aria-label="侧边栏固定行为"
            />
          </div>
        </div>

        <!-- 显示连接标签 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.workspace.showConnectionTagsTitle', '显示连接标签') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.workspace.showConnectionTagsDescription', '关闭后将隐藏连接列表中的标签，并从搜索中排除标签。') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!showConnectionTagsSuccess && showConnectionTagsMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ showConnectionTagsMessage }}
            </span>
            <ToggleSwitch
              v-model="showConnectionTagsLocal"
              @change="handleUpdateShowConnectionTags"
              aria-label="显示连接标签"
            />
          </div>
        </div>

        <!-- 显示快捷指令标签 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.workspace.showQuickCommandTagsTitle', '显示快捷指令标签') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.workspace.showQuickCommandTagsDescription', '关闭后将隐藏快捷指令列表中的标签，并从搜索中排除标签。') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!showQuickCommandTagsSuccess && showQuickCommandTagsMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ showQuickCommandTagsMessage }}
            </span>
            <ToggleSwitch
              v-model="showQuickCommandTagsLocal"
              @change="handleUpdateShowQuickCommandTags"
              aria-label="显示快捷指令标签"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 4. 系统监控与容器服务 (Monitoring & Containers) -->
    <div class="bg-background border border-border rounded-xl shadow-sm overflow-hidden">
      <div class="px-6 py-4.5 border-b border-border/80 bg-header/30 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-base shrink-0">
            <i class="fas fa-chart-line"></i>
          </div>
          <div>
            <h3 class="text-base sm:text-lg font-semibold text-foreground leading-snug">
              {{ $t('settings.workspace.monitoringGroupTitle', '系统监控与容器服务') }}
            </h3>
            <p class="text-sm text-text-secondary mt-1">
              {{ $t('settings.workspace.monitoringGroupDesc', '管理服务器实时性能指标刷新频率、IP 暴露以及 Docker 容器状态监控') }}
            </p>
          </div>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 状态监视器 IP 显示 (纯开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ $t('settings.statusMonitorShowIp.title', '状态监视器 IP 显示') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ $t('settings.statusMonitorShowIp.enableLabel', '在状态监视器中显示IP地址') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!statusMonitorShowIpSuccess && statusMonitorShowIpMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ statusMonitorShowIpMessage }}
            </span>
            <ToggleSwitch
              v-model="statusMonitorShowIpEnabled"
              :loading="statusMonitorShowIpLoading"
              @change="handleUpdateStatusMonitorShowIpSetting"
              aria-label="状态监视器IP显示"
            />
          </div>
        </div>

        <!-- 状态监视器刷新间隔 -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <label for="statusMonitorInterval" class="text-[15px] sm:text-base font-medium text-foreground block">
              {{ t('settings.statusMonitor.title') }}
            </label>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ t('settings.statusMonitor.refreshIntervalHint') }}
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <div class="relative flex items-center">
              <input
                type="number"
                id="statusMonitorInterval"
                v-model.number="statusMonitorIntervalLocal"
                min="1"
                step="1"
                required
                @change="handleUpdateStatusMonitorInterval"
                @keydown.enter.prevent="handleUpdateStatusMonitorInterval"
                class="w-28 sm:w-32 h-9 px-3 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <span class="text-sm text-text-secondary ml-2 shrink-0">{{ t('settings.statusMonitor.unit', '秒') }}</span>
            </div>
            <span v-if="!statusMonitorSuccess && statusMonitorMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ statusMonitorMessage }}
            </span>
          </div>
        </div>

        <!-- Docker 设置 (刷新间隔 + 开关) -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="text-[15px] sm:text-base font-medium text-foreground">
              {{ t('settings.docker.title') }}
            </div>
            <p class="text-sm text-text-secondary mt-1.5 leading-relaxed">
              {{ t('settings.docker.refreshIntervalHint') }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-4 shrink-0">
            <div class="flex items-center gap-2">
              <label for="dockerInterval" class="text-sm text-text-secondary font-medium">间隔</label>
              <input
                type="number"
                id="dockerInterval"
                v-model.number="dockerInterval"
                min="1"
                step="1"
                required
                @change="handleUpdateDockerSettings"
                @keydown.enter.prevent="handleUpdateDockerSettings"
                class="w-24 h-9 px-3 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <span class="text-sm text-text-secondary">秒</span>
            </div>
            <div class="flex items-center gap-2.5">
              <span class="text-sm text-foreground select-none font-medium">
                {{ t('settings.docker.defaultExpandLabel') }}
              </span>
              <ToggleSwitch
                v-model="dockerExpandDefault"
                size="md"
                @change="handleUpdateDockerSettings"
                aria-label="默认展开Docker容器"
              />
            </div>
            <span v-if="!dockerSettingsSuccess && dockerSettingsMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ dockerSettingsMessage }}
            </span>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsStore } from '../../stores/settings.store';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useWorkspaceSettings } from '../../composables/settings/useWorkspaceSettings';
import { useSystemSettings } from '../../composables/settings/useSystemSettings';
import ToggleSwitch from '../common/ToggleSwitch.vue';

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);
const { t } = useI18n();

const workspaceSettings = useWorkspaceSettings();
const systemSettings = useSystemSettings();

const {
  popupEditorEnabled,
  popupEditorMessage,
  popupEditorSuccess,
  handleUpdatePopupEditorSetting,
  shareTabsEnabled,
  shareTabsMessage,
  shareTabsSuccess,
  handleUpdateShareTabsSetting,
  autoCopyEnabled,
  autoCopyMessage,
  autoCopySuccess,
  handleUpdateAutoCopySetting,
  workspaceSidebarPersistentEnabled,
  workspaceSidebarPersistentMessage,
  workspaceSidebarPersistentSuccess,
  handleUpdateWorkspaceSidebarSetting,
  commandInputSyncTargetLocal,
  commandInputSyncMessage,
  commandInputSyncSuccess,
  handleUpdateCommandInputSyncTarget,
  showConnectionTagsLocal,
  showConnectionTagsMessage,
  showConnectionTagsSuccess,
  handleUpdateShowConnectionTags,
  showQuickCommandTagsLocal,
  showQuickCommandTagsMessage,
  showQuickCommandTagsSuccess,
  handleUpdateShowQuickCommandTags,
  terminalScrollbackLimitLocal,
  terminalScrollbackLimitMessage,
  terminalScrollbackLimitSuccess,
  handleUpdateTerminalScrollbackLimit,
  fileManagerShowDeleteConfirmationLocal,
  fileManagerShowDeleteConfirmationMessage,
  fileManagerShowDeleteConfirmationSuccess,
  handleUpdateFileManagerDeleteConfirmation,
  fileManagerDoubleClickToOpenLocal,
  fileManagerDoubleClickToOpenLoading,
  fileManagerDoubleClickToOpenMessage,
  fileManagerDoubleClickToOpenSuccess,
  handleUpdateFileManagerDoubleClickToOpen,
  terminalEnableRightClickPasteLocal,
  terminalEnableRightClickPasteLoading,
  terminalEnableRightClickPasteMessage,
  terminalEnableRightClickPasteSuccess,
  handleUpdateTerminalRightClickPasteSetting,
  terminalRightClickBehaviorLocal,
  terminalRightClickBehaviorLoading,
  terminalRightClickBehaviorMessage,
  terminalRightClickBehaviorSuccess,
  handleUpdateTerminalRightClickBehavior,
  terminalContextMenuItemsLocal,
  terminalContextMenuItemsLoading,
  terminalContextMenuItemsMessage,
  terminalContextMenuItemsSuccess,
  handleUpdateTerminalContextMenuItems,
  terminalNoWrapLocal,
  terminalNoWrapLoading,
  terminalNoWrapMessage,
  terminalNoWrapSuccess,
  handleUpdateTerminalNoWrapSetting,
  showPopupFileManagerLocal,
  showPopupFileManagerMessage,
  showPopupFileManagerSuccess,
  handleUpdateShowPopupFileManager,
  statusMonitorShowIpEnabled,
  statusMonitorShowIpLoading,
  statusMonitorShowIpMessage,
  statusMonitorShowIpSuccess,
  handleUpdateStatusMonitorShowIpSetting,
  markdownDefaultViewModeLocal,
  markdownDefaultViewModeLoading,
  markdownDefaultViewModeMessage,
  markdownDefaultViewModeSuccess,
  handleUpdateMarkdownDefaultViewMode,
  markdownDefaultViewModeMobileLocal,
  markdownDefaultViewModeMobileLoading,
  markdownDefaultViewModeMobileMessage,
  markdownDefaultViewModeMobileSuccess,
  handleUpdateMarkdownDefaultViewModeMobile,
} = workspaceSettings;

const markdownViewModeOptions = computed(() => [
  { value: 'preview' as const, label: t('settings.workspace.markdownViewModePreview', '仅预览'), icon: 'fas fa-eye' },
  { value: 'split' as const, label: t('settings.workspace.markdownViewModeSplit', '分屏预览'), icon: 'fas fa-columns' },
  { value: 'edit' as const, label: t('settings.workspace.markdownViewModeEdit', '代码编辑'), icon: 'fas fa-code' },
]);

const handleSelectMarkdownDefaultViewMode = async (mode: 'preview' | 'split' | 'edit') => {
  if (markdownDefaultViewModeLocal.value === mode) return;
  markdownDefaultViewModeLocal.value = mode;
  await handleUpdateMarkdownDefaultViewMode();
};

const handleSelectMarkdownDefaultViewModeMobile = async (mode: 'preview' | 'split' | 'edit') => {
  if (markdownDefaultViewModeMobileLocal.value === mode) return;
  markdownDefaultViewModeMobileLocal.value = mode;
};

const contextMenuItemDefinitions = computed(() => [
  { key: 'copy' as const, label: t('terminal.contextMenu.copy', '复制'), icon: 'fas fa-copy' },
  { key: 'paste' as const, label: t('terminal.contextMenu.paste', '粘贴'), icon: 'fas fa-paste' },
  { key: 'openPath' as const, label: t('terminal.contextMenu.openPath', '打开路径'), icon: 'fas fa-folder-open' },
  { key: 'openFile' as const, label: t('terminal.contextMenu.openFile', '打开文件'), icon: 'fas fa-file-code' },
  { key: 'saveQuickCommand' as const, label: t('terminal.contextMenu.saveQuickCommand', '保存为快捷命令'), icon: 'fas fa-bolt' },
]);

const toggleContextMenuItem = async (key: 'copy' | 'paste' | 'openPath' | 'openFile' | 'saveQuickCommand') => {
  terminalContextMenuItemsLocal.value = {
    ...terminalContextMenuItemsLocal.value,
    [key]: !terminalContextMenuItemsLocal.value[key],
  };
  await handleUpdateTerminalContextMenuItems();
};

const {
  statusMonitorIntervalLocal,
  statusMonitorMessage,
  statusMonitorSuccess,
  handleUpdateStatusMonitorInterval,
  dockerInterval,
  dockerExpandDefault,
  dockerSettingsMessage,
  dockerSettingsSuccess,
  handleUpdateDockerSettings,
} = systemSettings;
</script>
