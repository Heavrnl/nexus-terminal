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
          </div>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 终端回滚行数 -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="flex items-center gap-1.5">
              <label for="terminalScrollbackLimitInput" class="text-[15px] sm:text-base font-medium text-foreground cursor-pointer">
                {{ t('settings.terminalScrollback.title', '终端回滚行数') }}
              </label>
              <HelpTooltip :text="t('settings.terminalScrollback.limitHint', '设置终端保留的最大输出行数。0 表示无限制 (使用默认值 5000)。此设置将在下次打开终端时生效。')" />
            </div>
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
              <div class="flex items-center gap-1.5">
                <label for="terminalRightClickBehaviorSelect" class="text-[15px] sm:text-base font-medium text-foreground cursor-pointer">
                  {{ $t('settings.workspace.terminalRightClickBehaviorTitle', '终端鼠标右键交互') }}
                </label>
                <HelpTooltip :text="$t('settings.workspace.terminalRightClickBehaviorDescription', '自定义在终端中点击鼠标右键的操作。未选中文本时直接粘贴剪贴板内容，选中文本时触发所选行为。')" />
              </div>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <AppSelect
                id="terminalRightClickBehaviorSelect"
                v-model="terminalRightClickBehaviorLocal"
                @change="handleUpdateTerminalRightClickBehavior"
                class="h-9 px-3.5 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8 cursor-pointer"
              >
                <option value="contextMenu">{{ $t('settings.workspace.rightClickBehaviorContextMenu', '弹出右键菜单 (默认)') }}</option>
                <option value="paste">{{ $t('settings.workspace.rightClickBehaviorPaste', '直接粘贴剪贴板内容') }}</option>
                <option value="copy">{{ $t('settings.workspace.rightClickBehaviorCopy', '复制选中文本') }}</option>
                <option value="openPath">{{ $t('settings.workspace.rightClickBehaviorOpenPath', '打开路径') }}</option>
                <option value="openFile">{{ $t('settings.workspace.rightClickBehaviorOpenFile', '打开文件') }}</option>
                <option value="saveQuickCommand">{{ $t('settings.workspace.rightClickBehaviorSaveQuickCommand', '保存为快捷命令') }}</option>
                <option value="none">{{ $t('settings.workspace.rightClickBehaviorNone', '无操作') }}</option>
              </AppSelect>
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
        <SettingToggle
          setting-key="autoCopyOnSelect"
          title-key="settings.autoCopyOnSelect.title"
          title-fallback="自动复制"
          desc-key="settings.autoCopyOnSelect.enableLabel"
          success-key="settings.autoCopyOnSelect.success.saved"
          error-key="settings.autoCopyOnSelect.error.saveFailed"
        />

        <!-- 不换行 (纯开关) -->
        <SettingToggle
          setting-key="terminalNoWrap"
          title-key="settings.workspace.terminalNoWrapTitle"
          title-fallback="不换行"
          desc-key="settings.workspace.terminalNoWrapDescription"
          desc-fallback="开启后终端长行内容不自动折行，超出视口宽度时支持水平横向滑动查看；关闭时自适应视口自动折行"
          success-key="settings.workspace.terminalNoWrapSuccess"
          error-key="settings.workspace.terminalNoWrapError"
        />

        <!-- 分屏终端焦点切换快捷键 -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="flex items-center gap-1.5">
              <label for="terminalSwitchShortcutInput" class="text-[15px] sm:text-base font-medium text-foreground cursor-pointer">
                {{ $t('settings.workspace.terminalSwitchPaneShortcutTitle', '分屏终端切换快捷键') }}
              </label>
              <HelpTooltip :text="$t('settings.workspace.terminalSwitchPaneShortcutDescription', '工作区布局内存在多个终端时，按此组合键快速轮流切换活动终端并呈现紫色高亮边框 (默认 Alt+`，可配置 Alt+`、Alt+W、Ctrl+Shift+T 等)')" />
            </div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="terminalSwitchPaneShortcutMessage" :class="terminalSwitchPaneShortcutSuccess ? 'text-xs text-emerald-400' : 'text-xs text-red-500'" class="flex items-center gap-1">
              <i :class="terminalSwitchPaneShortcutSuccess ? 'fas fa-check' : 'fas fa-exclamation-circle'"></i>
              {{ terminalSwitchPaneShortcutMessage }}
            </span>
            <div class="flex items-center gap-2">
              <input
                id="terminalSwitchShortcutInput"
                type="text"
                v-model="terminalSwitchPaneShortcutLocal"
                placeholder="例如 Alt+`"
                class="w-32 h-9 px-3 text-sm font-mono border border-border rounded-lg bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-purple-500 focus:border-purple-500 text-center"
                @blur="handleUpdateTerminalSwitchPaneShortcut"
                @keyup.enter="handleUpdateTerminalSwitchPaneShortcut"
              />
              <button
                type="button"
                @click="terminalSwitchPaneShortcutLocal = 'Alt+`'; handleUpdateTerminalSwitchPaneShortcut();"
                title="重置为默认组合键 (Alt+`)"
                class="px-2.5 h-9 text-xs border border-border rounded-lg hover:bg-hover text-text-secondary hover:text-foreground transition-colors cursor-pointer"
              >
                {{ $t('common.reset', '重置') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 命令输入同步目标 -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="flex items-center gap-1.5">
              <label for="commandInputSyncTargetSelect" class="text-[15px] sm:text-base font-medium text-foreground cursor-pointer">
                {{ $t('settings.commandInputSync.title', '命令输入同步') }}
              </label>
              <HelpTooltip :text="$t('settings.commandInputSync.description', '将命令输入框的内容实时同步到所选面板的搜索框。')" />
            </div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <AppSelect
              id="commandInputSyncTargetSelect"
              v-model="commandInputSyncTargetLocal"
              @change="handleUpdateCommandInputSyncTarget"
              class="h-9 px-3.5 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8 cursor-pointer"
            >
              <option value="none">{{ $t('settings.commandInputSync.targetNone', '无') }}</option>
              <option value="quickCommands">{{ $t('settings.commandInputSync.targetQuickCommands', '快捷指令') }}</option>
              <option value="commandHistory">{{ $t('settings.commandInputSync.targetCommandHistory', '历史命令') }}</option>
            </AppSelect>
            <span v-if="!commandInputSyncSuccess && commandInputSyncMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ commandInputSyncMessage }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 1.5 目标机自托管会话与跨端同步 (Remote Session Hosting & Workspace Sync) -->
    <div class="bg-background border border-border rounded-xl shadow-sm overflow-hidden">
      <div class="px-6 py-4.5 border-b border-border/80 bg-header/30 flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-base shrink-0">
            <i class="fas fa-server"></i>
          </div>
          <div>
            <h3 class="text-base sm:text-lg font-semibold text-foreground leading-snug">
              {{ $t('settings.remoteHosting.groupTitle', '目标机自托管会话与跨端接力') }}
            </h3>
          </div>
        </div>
        <div v-if="remoteAgentStatus" class="flex items-center gap-2 text-xs text-text-secondary">
          <span
            class="px-2 py-0.5 rounded-full border font-medium"
            :class="remoteAgentStatus.availableTargets.length > 0 ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/25' : 'bg-amber-500/10 text-amber-500 border-amber-500/25'"
          >
            {{
              remoteAgentStatus.availableTargets.length > 0
                ? $t('settings.remoteHosting.bundledTargets', { count: remoteAgentStatus.availableTargets.length })
                : $t('settings.remoteHosting.noBundledBinaries', '未内置代理二进制（将自动降级）')
            }}
          </span>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 总开关：启用目标机自托管会话 -->
        <SettingToggle
          setting-key="remoteSessionHostingEnabled"
          title-key="settings.remoteHosting.enableTitle"
          title-fallback="目标服务器自托管 SSH 会话"
          desc-key="settings.remoteHosting.enableDesc"
          desc-fallback="由目标主机本地轻量代理（nexus-mux）直接托管 PTY 与终端屏幕状态，支持 Web 端、移动端与桌面端实时同步无缝接管，后端重启或网络抖动均不断线。"
          success-key="settings.remoteHosting.success.saved"
          error-key="settings.remoteHosting.error.saveFailed"
        />

        <!-- 自动部署开关 -->
        <SettingToggle
          setting-key="remoteSessionAutoDeploy"
          title-key="settings.remoteHosting.autoDeployTitle"
          title-fallback="首次连接自动静默部署代理"
          desc-key="settings.remoteHosting.autoDeployDesc"
          desc-fallback="通过当前 SSH 通道推送并校验对应架构的轻量代理，无需开放额外端口或访问公网；不支持的架构或只读环境将自动静默降级为传统 SSH 模式。"
          success-key="settings.remoteHosting.success.saved"
          error-key="settings.remoteHosting.error.saveFailed"
        />

        <!-- 活跃脱离会话空闲回收时长 -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="flex items-center gap-1.5">
              <label for="remoteSessionDetachedIdleHoursInput" class="text-[15px] sm:text-base font-medium text-foreground cursor-pointer">
                {{ $t('settings.remoteHosting.idleHoursTitle', '脱离托管会话空闲自动回收') }}
              </label>
              <HelpTooltip :text="$t('settings.remoteHosting.idleHoursHint', '设置脱离客户端后无任何输出活动的目标机托管会话自动回收时长（小时）。0 表示永不自动强杀运行中会话。')" />
            </div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <div class="relative flex items-center">
              <input
                type="number"
                id="remoteSessionDetachedIdleHoursInput"
                v-model.number="remoteSessionDetachedIdleHoursLocal"
                min="0"
                max="8760"
                step="1"
                placeholder="0"
                @change="handleUpdateRemoteSessionDetachedIdleHours"
                @keydown.enter.prevent="handleUpdateRemoteSessionDetachedIdleHours"
                class="w-28 sm:w-32 h-9 px-3 text-sm border border-border rounded-lg shadow-2xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              />
              <span class="text-sm text-text-secondary ml-2 shrink-0">{{ $t('settings.remoteHosting.hoursUnit', '小时 (0=不限)') }}</span>
            </div>
            <span v-if="!remoteSessionDetachedIdleHoursSuccess && remoteSessionDetachedIdleHoursMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ remoteSessionDetachedIdleHoursMessage }}
            </span>
          </div>
        </div>

        <!-- 桌面端工作区云端实时同步开关与当前模式（仅桌面客户端展示） -->
        <template v-if="isDesktop">
          <SettingToggle
            setting-key="desktopWorkspaceSyncEnabled"
            title-key="settings.remoteHosting.desktopWorkspaceSyncTitle"
            title-fallback="桌面端接入云端工作区实时同步"
            desc-key="settings.remoteHosting.desktopWorkspaceSyncDesc"
            desc-fallback="配置云端同步后，桌面端将与 Web 端共享实时工作区与互斥接管租约，并接力目标机托管会话；关闭或未配置云端时仍保留桌面本地工作区自动恢复。"
            success-key="settings.remoteHosting.success.saved"
            error-key="settings.remoteHosting.error.saveFailed"
          />
          <div class="px-6 py-3.5 bg-muted/15 flex items-center justify-between gap-3 text-xs text-text-secondary">
            <span>{{ $t('settings.remoteHosting.currentSyncModeLabel', '当前工作区同步模式') }}</span>
            <span class="font-medium text-foreground">{{ desktopSyncModeLabel }}</span>
          </div>
        </template>
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
          </div>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 弹窗编辑器 (纯开关) -->
        <SettingToggle
          setting-key="showPopupFileEditor"
          title-key="settings.popupEditor.title"
          title-fallback="弹窗编辑器"
          desc-key="settings.popupEditor.enableLabel"
          success-key="settings.popupEditor.success.saved"
          error-key="settings.popupEditor.error.saveFailed"
        />

        <!-- 弹窗文件管理器 (纯开关) -->
        <SettingToggle
          setting-key="showPopupFileManager"
          title-key="settings.popupFileManager.title"
          title-fallback="弹窗文件管理器"
          desc-key="settings.popupFileManager.enableLabel"
          success-key="settings.popupFileManager.success.saved"
          error-key="settings.popupFileManager.error.saveFailed"
        />

        <!-- 共享编辑器标签页 (纯开关) -->
        <SettingToggle
          setting-key="shareFileEditorTabs"
          title-key="settings.shareEditorTabs.title"
          title-fallback="共享编辑器标签页"
          desc-key="settings.shareEditorTabs.description"
          success-key="settings.shareEditorTabs.success.saved"
          error-key="settings.shareEditorTabs.error.saveFailed"
        />

        <!-- 打开大文件前二次确认 (纯开关) -->
        <SettingToggle
          setting-key="fileEditorLargeFileConfirm"
          title-key="settings.workspace.largeFileConfirmTitle"
          title-fallback="打开大文件前提示"
          desc-key="settings.workspace.largeFileConfirmDescription"
          desc-fallback="打开超过 3MB 的文件时先弹窗确认，避免误点大文件把编辑器卡住。在弹窗里勾选「记住」后会自动关闭此项。"
          success-key="settings.workspace.largeFileConfirmSuccess"
          error-key="settings.workspace.largeFileConfirmError"
        />

        <!-- 文件管理器删除确认 (纯开关) -->
        <SettingToggle
          setting-key="fileManagerShowDeleteConfirmation"
          title-key="settings.workspace.fileManagerDeleteConfirmTitle"
          title-fallback="文件管理器删除确认"
          desc-key="settings.workspace.fileManagerShowDeleteConfirmationLabel"
          desc-fallback="删除文件或文件夹时显示确认提示框"
          success-key="settings.workspace.fileManagerDeleteConfirmSuccess"
          error-key="settings.workspace.fileManagerDeleteConfirmError"
        />

        <!-- 双击打开文件/文件夹 (纯开关) -->
        <SettingToggle
          setting-key="fileManagerDoubleClickToOpen"
          title-key="settings.workspace.fileManagerDoubleClickToOpenTitle"
          title-fallback="双击打开文件/文件夹"
          desc-key="settings.workspace.fileManagerDoubleClickToOpenDescription"
          desc-fallback="开启后需双击打开文件或进入文件夹，单击仅选中；关闭时单击即可直接打开"
          success-key="settings.workspace.fileManagerDoubleClickToOpenSuccess"
          error-key="settings.workspace.fileManagerDoubleClickToOpenError"
        />

        <!-- 文件列表变动高亮 (纯开关) -->
        <SettingToggle
          setting-key="fileManagerHighlightChanges"
          title-key="settings.workspace.fileManagerHighlightChangesTitle"
          title-fallback="文件列表变动高亮"
          desc-key="settings.workspace.fileManagerHighlightChangesDescription"
          desc-fallback="目录内容发生变化时，新增加的文件显示绿色、被修改的显示琥珀色并短暂闪烁；关闭后不再高亮"
          success-key="settings.workspace.fileManagerHighlightChangesSuccess"
          error-key="settings.workspace.fileManagerHighlightChangesError"
        />

        <!-- 打开文件的方式 (仅桌面客户端；Web/移动端没有"外部程序"这一概念) -->
        <div
          v-if="isDesktop"
          class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors"
        >
          <div class="flex-1 pr-2">
            <div class="flex items-center gap-1.5">
              <span class="text-[15px] sm:text-base font-medium text-foreground">
                {{ $t('settings.workspace.fileOpenModeTitle', '打开文件的方式') }}
              </span>
              <HelpTooltip :text="$t('settings.workspace.fileOpenModeDescription', '选择在文件管理器里打开文件时使用内置编辑器还是系统默认程序。选择「系统默认程序」后，远程文件会先下载成本地临时副本再交给外部程序；在外部程序里保存后会自动同步回远程，若远程在此期间也被修改过，会先询问你是覆盖远程还是保留远程版本。')" />
            </div>
            <p v-if="fileOpenModeLocal === 'external'" class="mt-1 text-xs text-text-secondary flex items-center gap-1.5">
              <i class="fas fa-info-circle text-[11px] shrink-0"></i>
              <span>{{ $t('settings.workspace.fileOpenModeExternalHint', '外部程序里保存后会自动同步回远程；若远程在此期间也被修改，会弹窗询问覆盖还是保留远程。') }}</span>
            </p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <span v-if="!fileOpenModeSuccess && fileOpenModeMessage" class="text-sm font-medium text-red-500 flex items-center gap-1">
              <i class="fas fa-exclamation-circle text-xs"></i>
              {{ fileOpenModeMessage }}
            </span>
            <div class="grid grid-cols-2 sm:flex p-1 bg-header/40 border border-border/80 rounded-lg gap-1 select-none">
              <button
                v-for="opt in fileOpenModeOptions"
                :key="opt.value"
                type="button"
                :disabled="fileOpenModeLoading"
                @click="handleSelectFileOpenMode(opt.value)"
                class="h-8 sm:h-7.5 px-2.5 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 transition-all cursor-pointer outline-none disabled:opacity-50"
                :class="fileOpenModeLocal === opt.value
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

        <!-- Markdown 默认视图模式 (整合在同一个设置项中，两行标签胶囊，移动端自适应) -->
        <div class="px-6 py-4.5 flex flex-col xl:flex-row xl:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="flex items-center gap-1.5">
              <span class="text-[15px] sm:text-base font-medium text-foreground">
                {{ $t('settings.workspace.markdownDefaultViewModeTitle', 'Markdown 默认视图模式') }}
              </span>
              <HelpTooltip :text="$t('settings.workspace.markdownDefaultViewModeDescription', '分别配置桌面端与移动端打开 Markdown 文件时的默认显示模式')" />
            </div>
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
          </div>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 侧边栏持久化/固定行为 (纯开关) -->
        <SettingToggle
          setting-key="workspaceSidebarPersistent"
          title-key="settings.workspace.sidebarPersistentTitle"
          title-fallback="侧边栏固定行为"
          desc-key="settings.workspace.sidebarPersistentDescription"
          success-key="settings.workspace.success.sidebarPersistentSaved"
          error-key="settings.workspace.error.sidebarPersistentSaveFailed"
        />

        <!-- 显示连接文件夹 (纯开关) -->
        <SettingToggle
          setting-key="showConnectionFolders"
          title-key="settings.workspace.showConnectionFoldersTitle"
          title-fallback="显示连接文件夹"
          desc-key="settings.workspace.showConnectionFoldersDescription"
          desc-fallback="关闭后将隐藏连接列表中的文件夹，并从搜索中排除文件夹名。"
          success-key="settings.workspace.success.showConnectionFoldersSaved"
          error-key="settings.workspace.error.showConnectionFoldersSaveFailed"
          native-boolean
        />

        <!-- 显示快捷指令文件夹 (纯开关) -->
        <SettingToggle
          setting-key="showQuickCommandFolders"
          title-key="settings.workspace.showQuickCommandFoldersTitle"
          title-fallback="显示快捷指令文件夹"
          desc-key="settings.workspace.showQuickCommandFoldersDescription"
          desc-fallback="关闭后将隐藏快捷指令列表中的文件夹，并从搜索中排除文件夹名。"
          success-key="settings.workspace.success.showQuickCommandFoldersSaved"
          error-key="settings.workspace.error.showQuickCommandFoldersSaveFailed"
          native-boolean
        />
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
          </div>
        </div>
      </div>
      <div class="divide-y divide-border/40">
        <!-- 状态监视器 IP 显示 (纯开关) -->
        <SettingToggle
          setting-key="showStatusMonitorIpAddress"
          title-key="settings.statusMonitorShowIp.title"
          title-fallback="状态监视器 IP 显示"
          desc-key="settings.statusMonitorShowIp.enableLabel"
          desc-fallback="在状态监视器中显示IP地址"
          success-key="settings.statusMonitorShowIp.success.saved"
          error-key="settings.statusMonitorShowIp.error.saveFailed"
        />

        <!-- 状态监视器刷新间隔 -->
        <div class="px-6 py-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-muted/15 transition-colors">
          <div class="flex-1 pr-2">
            <div class="flex items-center gap-1.5">
              <label for="statusMonitorInterval" class="text-[15px] sm:text-base font-medium text-foreground cursor-pointer">
                {{ t('settings.statusMonitor.title') }}
              </label>
              <HelpTooltip :text="t('settings.statusMonitor.refreshIntervalHint')" />
            </div>
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
            <div class="flex items-center gap-1.5">
              <span class="text-[15px] sm:text-base font-medium text-foreground">
                {{ t('settings.docker.title') }}
              </span>
              <HelpTooltip :text="t('settings.docker.refreshIntervalHint')" />
            </div>
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
import { computed, onMounted, ref } from 'vue';
import { useSettingsStore } from '../../stores/settings.store';
import { useWorkspaceSyncStore } from '../../stores/workspaceSync.store';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import apiClient from '../../utils/apiClient';
import { useWorkspaceSettings } from '../../composables/settings/useWorkspaceSettings';
import { useSystemSettings } from '../../composables/settings/useSystemSettings';
import { useStringSettingControl } from '../../composables/settings/useSettingControl';
import { SETTING_DEFAULTS } from '../../stores/settings.schema.generated';
import { isDesktopApp } from '../../utils/platform';
import type { DesktopFileOpenMode } from '../../stores/settings.store';
import ToggleSwitch from '../common/ToggleSwitch.vue';
import HelpTooltip from '../common/HelpTooltip.vue';
import SettingToggle from './SettingToggle.vue';
import AppSelect from '../common/AppSelect.vue';

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);
const { t } = useI18n();

const workspaceSettings = useWorkspaceSettings();
const systemSettings = useSystemSettings();

const {
  commandInputSyncTargetLocal,
  commandInputSyncMessage,
  commandInputSyncSuccess,
  handleUpdateCommandInputSyncTarget,
  terminalScrollbackLimitLocal,
  terminalScrollbackLimitMessage,
  terminalScrollbackLimitSuccess,
  handleUpdateTerminalScrollbackLimit,
  remoteSessionDetachedIdleHoursLocal,
  remoteSessionDetachedIdleHoursMessage,
  remoteSessionDetachedIdleHoursSuccess,
  handleUpdateRemoteSessionDetachedIdleHours,
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
  terminalSwitchPaneShortcutLocal,
  terminalSwitchPaneShortcutLoading,
  terminalSwitchPaneShortcutMessage,
  terminalSwitchPaneShortcutSuccess,
  handleUpdateTerminalSwitchPaneShortcut,
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

// --- 桌面客户端：打开文件的方式（内置编辑器 / 系统默认程序） ---
// Web 与移动端没有"外部程序"这一概念，这一块只在桌面客户端渲染。
const isDesktop = computed(() => isDesktopApp());
const workspaceSyncStore = useWorkspaceSyncStore();
const { runtimeMode: workspaceRuntimeMode } = storeToRefs(workspaceSyncStore);

const remoteAgentStatus = ref<{
  availableTargets: Array<{ os: string; arch: string; version: string }>;
} | null>(null);

const desktopSyncModeLabel = computed(() => {
  switch (workspaceRuntimeMode.value) {
    case 'desktop_cloud_synced':
      return t('settings.remoteHosting.modeCloudSynced', '云端实时同步（已连通）');
    case 'desktop_cloud_offline':
      return t('settings.remoteHosting.modeCloudOffline', '云端离线降级（本地缓存）');
    default:
      return t('settings.remoteHosting.modeLocalOnly', '纯本地工作区恢复');
  }
});

onMounted(async () => {
  try {
    const res = await apiClient.get('/connections/remote-agent/status');
    if (res.data?.success && res.data?.data) {
      remoteAgentStatus.value = res.data.data;
    }
  } catch {
    // 忽略状态加载失败
  }
  if (isDesktop.value) {
    void workspaceSyncStore.fetchRuntimeMode();
  }
});

const fileOpenModeOptions = computed(() => [
  { value: 'builtin' as const, label: t('settings.workspace.fileOpenModeBuiltin', '内置编辑器'), icon: 'fas fa-window-maximize' },
  { value: 'external' as const, label: t('settings.workspace.fileOpenModeExternal', '系统默认程序'), icon: 'fas fa-external-link-alt' },
]);

const {
  local: fileOpenModeLocal,
  loading: fileOpenModeLoading,
  message: fileOpenModeMessage,
  success: fileOpenModeSuccess,
  save: saveFileOpenMode,
} = useStringSettingControl({
  key: 'desktopFileOpenMode',
  defaultValue: SETTING_DEFAULTS.desktopFileOpenMode ?? 'builtin',
  successMessage: () => t('common.saved', '已保存'),
  errorMessage: () => t('common.saveFailed', '保存失败'),
  clearMessageAfterMs: 2500,
});

const handleSelectFileOpenMode = async (mode: DesktopFileOpenMode) => {
  if (fileOpenModeLocal.value === mode) return;
  fileOpenModeLocal.value = mode;
  await saveFileOpenMode();
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
