 <template>
  <div class="flex flex-col h-full overflow-hidden bg-background">
    <!-- Container for controls and list -->
    <div class="flex flex-col flex-grow overflow-hidden bg-background">
      <!-- Controls Area -->
      <div class="flex items-center p-2  flex-shrink-0 gap-2 bg-background"> <!-- Reduced padding p-3 to p-2 -->
        <input
          type="text"
          :placeholder="$t('quickCommands.searchPlaceholder', '搜索名称或指令...')"
          :value="localSearchTerm"
          data-focus-id="quickCommandsSearch"
          @input="updateSearchTerm($event)"
          @keydown="handleSearchInputKeydown"
          @blur="handleSearchInputBlur"
          ref="searchInputRef"
          class="flex-grow min-w-0 px-4 py-1.5 border border-border/50 rounded-lg bg-input text-foreground text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition duration-150 ease-in-out"
        />
        <!-- Sort Button -->
        <button @click="toggleSortBy" class="w-8 h-8 border border-border/50 rounded-lg text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150 flex-shrink-0 flex items-center justify-center" :title="sortButtonTitle">
          <i :class="[sortButtonIcon, 'text-base']"></i>
        </button>
        <!-- View Mode Toggle Button (Grid / List / Pills) -->
        <button @click="cycleViewMode"
                class="w-8 h-8 border border-border/50 rounded-lg text-text-secondary hover:bg-border hover:text-foreground transition-colors duration-150 flex-shrink-0 flex items-center justify-center cursor-pointer"
                :class="{ 'bg-primary/20 text-primary border-primary/40': currentViewMode !== 'list' }"
                :title="viewModeTitle">
          <i :class="['fas', viewModeIcon, 'text-base']"></i>
        </button>
        <!-- Add Button -->
        <button @click="openAddForm" class="w-8 h-8 bg-primary text-white border-none rounded-lg text-sm font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary flex-shrink-0 flex items-center justify-center" :title="$t('quickCommands.add', '添加快捷指令')">
          <i class="fas fa-plus text-base"></i>
        </button>
      </div>
      <!-- List Area -->
      <div class="flex-grow overflow-y-auto p-2">
        <!-- Loading State -->
        <div v-if="isLoading && quickCommandsStore.quickCommandsList.length === 0" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
            <i class="fas fa-spinner fa-spin text-xl mb-2"></i>
            <p>{{ t('common.loading', '加载中...') }}</p>
        </div>
        <!-- Empty State (No commands at all) -->
        <div v-else-if="!isLoading && quickCommandsStore.quickCommandsList.length === 0" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
            <i class="fas fa-bolt text-xl mb-2"></i>
            <p class="mb-3">{{ $t('quickCommands.empty', '没有快捷指令。') }}</p>
            <button @click="openAddForm" class="px-4 py-2 bg-primary text-white border-none rounded-lg text-sm font-semibold cursor-pointer shadow-md transition-colors duration-200 ease-in-out hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary">
             {{ $t('quickCommands.addFirst', '创建第一个快捷指令') }}
           </button>
       </div>
        <!-- No Results State (Commands exist, but filter yields no results) -->
        <div v-else-if="!isLoading && ((showQuickCommandTagsBoolean && filteredAndGroupedCommands.length === 0) || (!showQuickCommandTagsBoolean && flatFilteredCommands.length === 0)) && searchTerm" class="p-6 text-center text-text-secondary text-sm flex flex-col items-center justify-center h-full">
            <i class="fas fa-search text-xl mb-2"></i>
            <p>{{ t('quickCommands.noResults', '没有找到匹配的指令') }} "{{ searchTerm }}"</p>
        </div>

       <!-- Command List (Grouped or Flat) -->
       <div
        v-else
        class="list-none p-0 m-0 outline-none"
        ref="commandListContainerRef"
        tabindex="0"
        @wheel.ctrl.prevent="handleWheel"
        :style="{ '--qc-row-size-multiplier': quickCommandRowSizeMultiplier }"
        @keydown="handleSearchInputKeydown"
       >
            <!-- Grouped View -->
            <div v-if="showQuickCommandTagsBoolean">
                <div v-for="groupData in filteredAndGroupedCommands" :key="groupData.groupName" class="mb-1 last:mb-0">
                    <!-- Group Header - Modified for inline editing -->
                    <div
                        class="group font-semibold flex items-center text-foreground rounded-md hover:bg-header/80 transition-colors duration-150"
                        :style="{ padding: isCompactMode ? `calc(0.25rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` : `calc(0.5rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` }"
                        :class="{ 'cursor-pointer': editingTagId !== (groupData.tagId === null ? 'untagged' : groupData.tagId) }"
                        @click="editingTagId !== (groupData.tagId === null ? 'untagged' : groupData.tagId) ? toggleGroup(groupData.groupName) : null"
                    >
                        <i
                            :class="['fas', expandedGroups[groupData.groupName] ? 'fa-chevron-down' : 'fa-chevron-right', 'mr-2 w-4 text-center text-text-secondary group-hover:text-foreground transition-transform duration-200 ease-in-out', {'transform rotate-0': !expandedGroups[groupData.groupName]}]"
                            :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"
                            @click.stop="toggleGroup(groupData.groupName)"
                            class="cursor-pointer flex-shrink-0"
                        ></i>
                        <!-- Editing State -->
                        <input
                            v-if="editingTagId === (groupData.tagId === null ? 'untagged' : groupData.tagId)"
                            :key="groupData.tagId === null ? 'untagged-input' : `tag-input-${groupData.tagId}`"
                            :ref="(el) => setTagInputRef(el, groupData.tagId === null ? 'untagged' : groupData.tagId)"
                            type="text"
                            v-model="editedTagName"
                            class="bg-input border border-primary rounded px-1 py-0 w-full"
                            :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"
                            @blur="finishEditingTag"
                            @keydown.enter.prevent="finishEditingTag"
                            @keydown.esc.prevent="cancelEditingTag"
                            @click.stop
                        />
                        <!-- Display State -->
                        <span
                            v-else
                            class="inline-block overflow-hidden text-ellipsis whitespace-nowrap"
                            :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"
                            :class="{ 'cursor-pointer hover:underline': true }"
                            :title="t('quickCommands.tags.clickToEditTag', '点击编辑标签')"
                            @click.stop="startEditingTag(groupData.tagId, groupData.groupName)"
                        >
                            {{ groupData.groupName }}
                        </span>
                        <!-- Optional: Add count? -->
                        <!-- <span v-if="editingTagId !== (groupData.tagId === null ? 'untagged' : groupData.tagId)" class="ml-auto text-xs text-text-secondary pl-2">({{ groupData.commands.length }})</span> -->
                    </div>
                    <!-- Command Items List (only show if expanded) -->
                    <!-- Command Items List (only show if expanded) -->
                    <div v-show="quickCommandsStore.expandedGroups[groupData.groupName]" class="mt-1">
                        <!-- 1. 网格卡片模式 (Grid) -->
                        <div v-if="currentViewMode === 'grid'" class="qc-grid-container pl-3 pr-1 mb-2">
                            <div
                                v-for="(cmd) in groupData.commands"
                                :key="cmd.id"
                                :data-command-id="cmd.id"
                                class="group flex items-center justify-between cursor-pointer rounded-lg border border-border/50 bg-header/40 hover:bg-primary/10 hover:border-primary/50 transition-all duration-150 select-none overflow-hidden"
                                :class="{ 'bg-primary/20 border-primary font-medium': isCommandSelected(cmd.id) }"
                                 :style="{ padding: `calc(0.4rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))` }"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                                @touchstart="handleItemTouchStart($event, cmd)"
                                @touchmove="handleItemTouchMove"
                                @touchend="handleItemTouchEnd"
                                @touchcancel="handleItemTouchEnd"
                                :title="getCommandTooltip(cmd)"
                            >
                                <div class="flex-1 min-w-0 flex flex-col justify-center gap-0.5 mr-1.5">
                                    <div class="flex items-center text-foreground truncate"
                                         :style="{ fontSize: `calc(0.82em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                                        <i class="fas fa-terminal text-primary text-[10px] mr-1.5 flex-shrink-0"></i>
                                        <span class="font-medium truncate">{{ cmd.name || cmd.command }}</span>
                                    </div>
                                    <div v-if="cmd.name && cmd.command"
                                         class="truncate font-mono text-text-secondary"
                                         :style="{ fontSize: `calc(0.7em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                                        {{ cmd.command }}
                                    </div>
                                </div>
                                <div class="flex items-center flex-shrink-0">
                                    <button
                                        type="button"
                                        @click.stop="executeCommand(cmd)"
                                        class="rounded-md flex items-center justify-center text-primary bg-primary/15 border border-primary/25 group-hover:bg-primary group-hover:text-white transition-all duration-150"
                                        :style="{
                                            width: `calc(1.35rem * var(--qc-row-size-multiplier))`,
                                            height: `calc(1.35rem * var(--qc-row-size-multiplier))`
                                        }"
                                        :title="t('quickCommands.form.execute', '执行')"
                                    >
                                        <i class="fas fa-play text-[9px]"></i>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- 2. 药丸流式模式 (Pills) -->
                        <div v-else-if="currentViewMode === 'pills'" class="qc-pill-container pl-3 pr-1 mb-2">
                            <div
                                v-for="(cmd) in groupData.commands"
                                :key="cmd.id"
                                :data-command-id="cmd.id"
                                class="group inline-flex items-center cursor-pointer rounded-md border border-border/50 bg-header/40 hover:bg-primary/15 hover:border-primary/50 hover:text-primary text-foreground transition-all duration-150 select-none"
                                :class="{ 'bg-primary/25 border-primary text-primary font-medium': isCommandSelected(cmd.id) }"
                                :style="{
                                    padding: `calc(0.2rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))`,
                                    fontSize: `calc(0.78em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))`
                                }"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                                @touchstart="handleItemTouchStart($event, cmd)"
                                @touchmove="handleItemTouchMove"
                                @touchend="handleItemTouchEnd"
                                @touchcancel="handleItemTouchEnd"
                                :title="getCommandTooltip(cmd)"
                            >
                                <i class="fas fa-bolt text-amber-500 text-[10px] mr-1.5 flex-shrink-0"></i>
                                <span class="truncate max-w-[220px]">{{ cmd.name || cmd.command }}</span>
                            </div>
                        </div>

                        <!-- 3. 标准列表模式 (List) -->
                        <ul v-else class="list-none p-0 m-0 pl-3">
                            <li
                                v-for="(cmd) in groupData.commands"
                                :key="cmd.id"
                                :data-command-id="cmd.id"
                                class="group flex justify-between items-center mb-1 cursor-pointer rounded-md hover:bg-primary/10 transition-colors duration-150"
                                :style="{ padding: `calc(0.625rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` }"
                                :class="{ 'bg-primary/20 font-medium': isCommandSelected(cmd.id) }"
                                @click="handleCommandItemClick(cmd)"
                                @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                                @touchstart="handleItemTouchStart($event, cmd)"
                                @touchmove="handleItemTouchMove"
                                @touchend="handleItemTouchEnd"
                                @touchcancel="handleItemTouchEnd"
                            >
                                <div class="flex flex-col overflow-hidden mr-2 flex-grow">
                                    <span v-if="cmd.name"
                                          class="font-medium truncate text-foreground mb-0.5"
                                          :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.name }}</span>
                                    <span v-if="cmd.command"
                                          class="truncate font-mono"
                                          :class="{ 'text-sm': !cmd.name, 'text-text-secondary': true }"
                                          :style="{ fontSize: `calc(0.75em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.command }}</span>
                                </div>
                                <div class="flex items-center flex-shrink-0 opacity-100">
                                    <button @click.stop="copyCommand(cmd.command)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('commandHistory.copy', '复制')">
                                        <i class="fas fa-copy" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                                    </button>
                                    <button @click.stop="openEditForm(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('common.edit', '编辑')">
                                        <i class="fas fa-edit" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                                    </button>
                                    <button @click.stop="confirmDelete(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-error" :title="$t('common.delete', '删除')">
                                        <i class="fas fa-times" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                                    </button>
                                </div>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
            <!-- Flat View (无标签扁平视图) -->
            <div v-else>
                <!-- 1. 网格卡片模式 (Grid) -->
                <div v-if="currentViewMode === 'grid'" class="qc-grid-container pl-1 pr-1">
                    <div
                        v-for="(cmd) in flatFilteredCommands"
                        :key="cmd.id"
                        :data-command-id="cmd.id"
                        class="group flex items-center justify-between cursor-pointer rounded-lg border border-border/50 bg-header/40 hover:bg-primary/10 hover:border-primary/50 transition-all duration-150 select-none overflow-hidden"
                        :class="{ 'bg-primary/20 border-primary font-medium': isCommandSelected(cmd.id) }"
                        :style="{ padding: `calc(0.4rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))` }"
                        @click="handleCommandItemClick(cmd)"
                        @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                        @touchstart="handleItemTouchStart($event, cmd)"
                        @touchmove="handleItemTouchMove"
                        @touchend="handleItemTouchEnd"
                        @touchcancel="handleItemTouchEnd"
                        :title="getCommandTooltip(cmd)"
                    >
                        <div class="flex-1 min-w-0 flex flex-col justify-center gap-0.5 mr-1.5">
                            <div class="flex items-center text-foreground truncate"
                                 :style="{ fontSize: `calc(0.82em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                                <i class="fas fa-terminal text-primary text-[10px] mr-1.5 flex-shrink-0"></i>
                                <span class="font-medium truncate">{{ cmd.name || cmd.command }}</span>
                            </div>
                            <div v-if="cmd.name && cmd.command"
                                 class="truncate font-mono text-text-secondary"
                                 :style="{ fontSize: `calc(0.7em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))` }">
                                {{ cmd.command }}
                            </div>
                        </div>
                        <div class="flex items-center flex-shrink-0">
                            <button
                                type="button"
                                @click.stop="executeCommand(cmd)"
                                class="rounded-md flex items-center justify-center text-primary bg-primary/15 border border-primary/25 group-hover:bg-primary group-hover:text-white transition-all duration-150"
                                :style="{
                                    width: `calc(1.35rem * var(--qc-row-size-multiplier))`,
                                    height: `calc(1.35rem * var(--qc-row-size-multiplier))`
                                }"
                                :title="t('quickCommands.form.execute', '执行')"
                            >
                                <i class="fas fa-play text-[9px]"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 2. 药丸流式模式 (Pills) -->
                <div v-else-if="currentViewMode === 'pills'" class="qc-pill-container pl-1 pr-1">
                    <div
                        v-for="(cmd) in flatFilteredCommands"
                        :key="cmd.id"
                        :data-command-id="cmd.id"
                        class="group inline-flex items-center cursor-pointer rounded-md border border-border/50 bg-header/40 hover:bg-primary/15 hover:border-primary/50 hover:text-primary text-foreground transition-all duration-150 select-none"
                        :class="{ 'bg-primary/25 border-primary text-primary font-medium': isCommandSelected(cmd.id) }"
                        :style="{
                            padding: `calc(0.2rem * var(--qc-row-size-multiplier)) calc(0.55rem * var(--qc-row-size-multiplier))`,
                            fontSize: `calc(0.78em * max(0.8, var(--qc-row-size-multiplier) * 0.5 + 0.5))`
                        }"
                        @click="handleCommandItemClick(cmd)"
                        @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                        @touchstart="handleItemTouchStart($event, cmd)"
                        @touchmove="handleItemTouchMove"
                        @touchend="handleItemTouchEnd"
                        @touchcancel="handleItemTouchEnd"
                        :title="getCommandTooltip(cmd)"
                    >
                        <i class="fas fa-bolt text-amber-500 text-[10px] mr-1.5 flex-shrink-0"></i>
                        <span class="truncate max-w-[220px]">{{ cmd.name || cmd.command }}</span>
                    </div>
                </div>

                <!-- 3. 标准列表模式 (List) -->
                <ul v-else class="list-none p-0 m-0">
                    <li
                        v-for="(cmd) in flatFilteredCommands"
                        :key="cmd.id"
                        :data-command-id="cmd.id"
                        class="group flex justify-between items-center mb-1 cursor-pointer rounded-md hover:bg-primary/10 transition-colors duration-150"
                        :style="{ padding: `calc(0.625rem * var(--qc-row-size-multiplier)) calc(0.75rem * var(--qc-row-size-multiplier))` }"
                        :class="{ 'bg-primary/20 font-medium': isCommandSelected(cmd.id) }"
                        @click="handleCommandItemClick(cmd)"
                        @contextmenu.prevent="showQuickCommandContextMenu($event, cmd)"
                        @touchstart="handleItemTouchStart($event, cmd)"
                        @touchmove="handleItemTouchMove"
                        @touchend="handleItemTouchEnd"
                        @touchcancel="handleItemTouchEnd"
                    >
                        <div class="flex flex-col overflow-hidden mr-2 flex-grow">
                            <span v-if="cmd.name"
                                  class="font-medium truncate text-foreground mb-0.5"
                                  :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.name }}</span>
                            <span v-if="cmd.command"
                                  class="truncate font-mono"
                                  :class="{ 'text-sm': !cmd.name, 'text-text-secondary': true }"
                                  :style="{ fontSize: `calc(0.75em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }">{{ cmd.command }}</span>
                        </div>
                        <div class="flex items-center flex-shrink-0 opacity-100">
                            <button @click.stop="copyCommand(cmd.command)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('commandHistory.copy', '复制')">
                                <i class="fas fa-copy" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                            </button>
                            <button @click.stop="openEditForm(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-primary" :title="$t('common.edit', '编辑')">
                                <i class="fas fa-edit" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                            </button>
                            <button @click.stop="confirmDelete(cmd)" class="p-1.5 rounded hover:bg-black/10 transition-colors duration-150 text-text-secondary hover:text-error" :title="$t('common.delete', '删除')">
                                <i class="fas fa-times" :style="{ fontSize: `calc(0.875em * max(0.85, var(--qc-row-size-multiplier) * 0.6 + 0.4))` }"></i>
                            </button>
                        </div>
                    </li>
                </ul>
            </div>
        </div>
      </div>
    </div>

    <!-- 添加/编辑表单模态框 -->
    <AddEditQuickCommandForm
      v-if="isFormVisible"
      :command-to-edit="commandToEdit"
      @close="closeForm"
    />

    <!-- Context Menu for Quick Commands -->
    <div
      v-if="quickCommandContextMenuVisible"
      class="fixed bg-background border border-border/60 shadow-xl rounded-lg py-1.5 z-50 min-w-[190px] quick-command-context-menu backdrop-blur-md"
      :style="{ top: `${quickCommandContextMenuPosition.y}px`, left: `${quickCommandContextMenuPosition.x}px` }"
      @click.stop
    >
      <div v-if="quickCommandContextTargetCommand" class="px-3 py-1 text-xs text-text-secondary border-b border-border/40 font-mono truncate max-w-[220px]">
        {{ quickCommandContextTargetCommand.name || quickCommandContextTargetCommand.command }}
      </div>
      <ul v-if="quickCommandContextTargetCommand" class="list-none p-0 m-0 mt-1">
        <!-- 1. 执行 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('execute', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-play text-xs text-primary w-4 text-center"></i>
          <span>{{ t('quickCommands.form.execute', '执行') }}</span>
        </li>

        <!-- 2. 编辑 (打开编辑模态框) -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('edit', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-edit text-xs text-text-secondary group-hover:text-primary w-4 text-center"></i>
          <span>{{ t('common.edit', '编辑') }}</span>
        </li>

        <!-- 3. 复制命令 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('copy', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-copy text-xs text-text-secondary group-hover:text-primary w-4 text-center"></i>
          <span>{{ t('commandHistory.copy', '复制') }}</span>
        </li>

        <!-- 4. 发送到全部会话 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-foreground hover:bg-primary/10 hover:text-primary text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('sendToAllSessions', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-paper-plane text-xs text-text-secondary group-hover:text-primary w-4 text-center"></i>
          <span>{{ t('quickCommands.actions.sendToAllSessions', '发送到全部会话') }}</span>
        </li>

        <!-- 分割线 -->
        <div class="h-px bg-border/40 my-1 mx-1"></div>

        <!-- 5. 删除 -->
        <li
          class="group px-3 py-1.5 cursor-pointer flex items-center text-error hover:bg-error/10 text-sm transition-colors duration-150 rounded-md mx-1 gap-2.5"
          @click="handleQuickCommandMenuAction('delete', quickCommandContextTargetCommand!)"
        >
          <i class="fas fa-trash-alt text-xs text-error w-4 text-center"></i>
          <span>{{ t('common.delete', '删除') }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick, defineExpose, watch, watchEffect } from 'vue';
import { storeToRefs } from 'pinia';
import { useQuickCommandsStore, type QuickCommandFE, type QuickCommandSortByType, type GroupedQuickCommands } from '../stores/quickCommands.store';
import { useQuickCommandTagsStore } from '../stores/quickCommandTags.store'; 
import { useUiNotificationsStore } from '../stores/uiNotifications.store';
import { useI18n } from 'vue-i18n';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import AddEditQuickCommandForm from '../components/AddEditQuickCommandForm.vue';
import { useFocusSwitcherStore } from '../stores/focusSwitcher.store'; 
import { useSettingsStore } from '../stores/settings.store';
import { useWorkspaceEventEmitter } from '../composables/workspaceEvents';
import { useSessionStore } from '../stores/session.store';
import type { SessionState } from '../stores/session/types'; 
import { useConnectionsStore } from '../stores/connections.store';
import { useDeviceDetection } from '../composables/useDeviceDetection';
import { useComponentStateStore } from '../stores/componentState.store';
import { useLayoutStore } from '../stores/layout.store';

const quickCommandsStore = useQuickCommandsStore();
const quickCommandTagsStore = useQuickCommandTagsStore(); 
const uiNotificationsStore = useUiNotificationsStore();
const { t } = useI18n();
const { showConfirmDialog } = useConfirmDialog();
const focusSwitcherStore = useFocusSwitcherStore();
const settingsStore = useSettingsStore();
const emitWorkspaceEvent = useWorkspaceEventEmitter();
const sessionStore = useSessionStore(); 
const connectionsStore = useConnectionsStore();

const props = withDefaults(
  defineProps<{
    instanceId?: string;
  }>(),
  {
    instanceId: 'default',
  }
);

const emit = defineEmits<{
  (e: 'execute-command', command: string): void;
}>();

const { isMobile: isMobileDevice } = useDeviceDetection();
const isMobile = computed(() => isMobileDevice.value || (typeof window !== 'undefined' && window.innerWidth < 768));
const platform = computed<'mobile' | 'desktop'>(() => isMobile.value ? 'mobile' : 'desktop');

const componentStateStore = useComponentStateStore();
const layoutStore = useLayoutStore();

// 独立实例与分端存储的 Key
const storageKey = computed(() => `qc_view_mode:${platform.value}:${props.instanceId || 'default'}`); 

const hoveredItemId = ref<number | null>(null);
const isFormVisible = ref(false);
const commandToEdit = ref<QuickCommandFE | null>(null);
const commandListContainerRef = ref<HTMLDivElement | null>(null); // Changed ref name to match template
const searchInputRef = ref<HTMLInputElement | null>(null); // +++ Ref for the search input +++
let unregisterFocus: (() => void) | null = null; // +++ 保存注销函数 +++

// +++ State for inline tag editing +++
const editingTagId = ref<number | null | 'untagged'>(null);
const editedTagName = ref('');
const tagInputRefs = ref(new Map<string | number, HTMLInputElement | null>());

// +++ 右键菜单状态 +++
const quickCommandContextMenuVisible = ref(false);
const quickCommandContextMenuPosition = ref({ x: 0, y: 0 });
const quickCommandContextTargetCommand = ref<QuickCommandFE | null>(null);

const localSearchTerm = ref(quickCommandsStore.searchTerm);
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// --- 从 Store 获取状态和 Getter ---
const searchTerm = computed(() => quickCommandsStore.searchTerm);
const sortBy = computed(() => quickCommandsStore.sortBy);
// Use the new grouped getter
const filteredAndGroupedCommands = computed(() => quickCommandsStore.filteredAndGroupedCommands);
const isLoading = computed(() => quickCommandsStore.isLoading);

watch(searchTerm, (newVal) => {
  if (newVal !== localSearchTerm.value) {
    localSearchTerm.value = newVal;
  }
});

const { selectedIndex: storeSelectedIndex, flatVisibleCommands, expandedGroups } = storeToRefs(quickCommandsStore);
const {
  showQuickCommandTagsBoolean,
  quickCommandRowSizeMultiplierNumber: qcRowSizeMultiplierFromStore,
  quickCommandsCompactModeBoolean, // +++ 引入紧凑模式状态 +++
} = storeToRefs(settingsStore);

const quickCommandRowSizeMultiplier = ref(1.0);

watchEffect(() => {
  const storeVal = qcRowSizeMultiplierFromStore.value;
  if (storeVal && typeof storeVal === 'number' && storeVal > 0) {
    if (quickCommandRowSizeMultiplier.value !== storeVal) {
      quickCommandRowSizeMultiplier.value = storeVal;
      // console.log(`[QuickCmdView] Row size multiplier loaded from store: ${storeVal}`);
    }
  } else {
    // console.log(`[QuickCmdView] No valid row size multiplier in store for QuickCommands, using default: ${quickCommandRowSizeMultiplier.value}`);
  }
});

const handleWheel = (event: WheelEvent) => {
    // event.ctrlKey 和 event.preventDefault() 将由模板中的 .ctrl.prevent 修饰符处理
    const delta = event.deltaY > 0 ? -0.05 : 0.05;
    const newMultiplier = Math.max(0.5, Math.min(2.5, quickCommandRowSizeMultiplier.value + delta));
    const oldMultiplier = quickCommandRowSizeMultiplier.value;
    quickCommandRowSizeMultiplier.value = parseFloat(newMultiplier.toFixed(2));

    if (quickCommandRowSizeMultiplier.value !== oldMultiplier) {
      // console.log(`[QuickCmdView] Row size multiplier changed: ${quickCommandRowSizeMultiplier.value}. Saving to store...`);
      // 假设 settingsStore 有一个名为 updateQuickCommandRowSizeMultiplier 的 action
      if (settingsStore.updateQuickCommandRowSizeMultiplier) {
        settingsStore.updateQuickCommandRowSizeMultiplier(quickCommandRowSizeMultiplier.value);
      } else {
        console.warn('[QuickCmdView] settingsStore.updateQuickCommandRowSizeMultiplier action not found.');
      }
    }
};

// 计算属性，仅过滤和排序，不分组
const flatFilteredCommands = computed(() => {
    // 直接使用 store 中的 flatVisibleCommands，因为它已经处理了过滤和排序
    return quickCommandsStore.flatVisibleCommands;
});

// --- 三视图模式定义与持久化 (组件实例隔离 + 移动/桌面分端 + 后端持久化) ---
export type QuickCommandsViewMode = 'grid' | 'list' | 'pills';

const getDefaultViewMode = (): QuickCommandsViewMode => {
  if (quickCommandsCompactModeBoolean.value) {
    return 'pills';
  }
  return 'grid'; // 默认推荐使用高空间利用率的网格卡片
};

const currentViewMode = ref<QuickCommandsViewMode>(
  componentStateStore.getState<QuickCommandsViewMode>(storageKey.value, getDefaultViewMode())
);

// 监听 storageKey 变动（如分端切换或实例切换）自动同步
watch(storageKey, (newKey) => {
  const saved = componentStateStore.getState<QuickCommandsViewMode>(newKey, getDefaultViewMode());
  if (saved && ['grid', 'list', 'pills'].includes(saved)) {
    currentViewMode.value = saved;
  }
});

// 后端异步拉取完成时，更新至最新持久化设置
watch(() => componentStateStore.isLoaded, () => {
  const saved = componentStateStore.getState<QuickCommandsViewMode>(storageKey.value, currentViewMode.value);
  if (saved && ['grid', 'list', 'pills'].includes(saved)) {
    currentViewMode.value = saved;
  }
});

const isCompactMode = computed(() => currentViewMode.value === 'pills');

const cycleViewMode = () => {
  const modes: QuickCommandsViewMode[] = ['grid', 'list', 'pills'];
  const nextIndex = (modes.indexOf(currentViewMode.value) + 1) % modes.length;
  const nextMode = modes[nextIndex];
  currentViewMode.value = nextMode;
  componentStateStore.setState(storageKey.value, nextMode);
};

const viewModeIcon = computed(() => {
  switch (currentViewMode.value) {
    case 'grid': return 'fa-table-cells-large';
    case 'list': return 'fa-list';
    case 'pills': return 'fa-tags';
    default: return 'fa-table-cells-large';
  }
});

const viewModeTitle = computed(() => {
  const modeKey = currentViewMode.value;
  const modeName = t(`quickCommands.viewMode.${modeKey}`, modeKey);
  return t('quickCommands.viewMode.toggle', { mode: modeName }, `切换视图 (当前: ${modeName})`);
});

// --- Helper function for selection check ---
const isCommandSelected = (commandId: number): boolean => {
    // 使用 store 的 flatVisibleCommands 和 storeSelectedIndex
    if (storeSelectedIndex.value < 0 || !flatVisibleCommands.value[storeSelectedIndex.value]) {
        return false;
    }
    return flatVisibleCommands.value[storeSelectedIndex.value].id === commandId;
};

// 安全获取指令 Tooltip 描述
const getCommandTooltip = (cmd: QuickCommandFE): string => {
  if (cmd.command) {
    return cmd.name ? `${cmd.name}: ${cmd.command}` : cmd.command;
  }
  return cmd.name || '';
};



// --- 生命周期钩子 ---
onMounted(async () => { // Make onMounted async
    // 初始化组件实例后端状态仓库
    componentStateStore.initialize();
    // Load expanded groups state first
    quickCommandsStore.loadExpandedGroups();
    // Then fetch commands (which might initialize expandedGroups for new groups)
    await quickCommandsStore.fetchQuickCommands();
    // Also fetch the quick command tags using the correct store instance
    await quickCommandTagsStore.fetchTags();
    // +++ 注册自定义聚焦动作 +++
    unregisterFocus = focusSwitcherStore.registerFocusAction('quickCommandsSearch', focusSearchInput);
});

onBeforeUnmount(() => {
  // 当检测不到该组件存在于布局中时，移除该存储项（独立实例垃圾回收）
  const instance = props.instanceId;
  const permanentList = ['modal', 'default', 'sidebar-left', 'sidebar-right'];
  if (instance && !permanentList.includes(instance)) {
    try {
      const activeIds = layoutStore.getAllActivePaneIds ? layoutStore.getAllActivePaneIds() : new Set<string>();
      if (!activeIds.has(instance)) {
        void componentStateStore.removeState(`qc_view_mode:desktop:${instance}`);
        void componentStateStore.removeState(`qc_view_mode:mobile:${instance}`);
      }
    } catch (e) {
      console.warn('[QuickCommandsView] 卸载时清理组件状态失败:', e);
    }
  }
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  document.removeEventListener('click', closeQuickCommandContextMenu);
  // +++ 调用保存的注销函数 +++
  if (unregisterFocus) {
    unregisterFocus();
  }
});


// +++ Watcher to focus input when editing starts +++
watch(editingTagId, async (newId) => {
    if (newId !== null) {
        await nextTick();
        const inputRef = tagInputRefs.value.get(newId);
        if (inputRef) {
            inputRef.focus();
            inputRef.select();
        } else {
             console.error(`[QuickCmdView] Watcher: Input ref for ID ${newId} not found.`);
        }
    }
});

// 监听显示模式变化，重置选择
watch(showQuickCommandTagsBoolean, () => {
    quickCommandsStore.resetSelection();
});


// --- 事件处理 ---

// 更新搜索词 (带 120ms 防抖，消除连续打字掉帧)
const updateSearchTerm = (event: Event) => {
  const target = event.target as HTMLInputElement;
  localSearchTerm.value = target.value;
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    quickCommandsStore.setSearchTerm(localSearchTerm.value);
    searchDebounceTimer = null;
  }, 120);
};

// +++ 重构滚动逻辑 +++
const scrollToSelected = async (index: number) => {
    await nextTick(); // 等待 DOM 更新
    // 使用 store 的 flatVisibleCommands
    if (index < 0 || !commandListContainerRef.value || !flatVisibleCommands.value[index]) return;

    const selectedCommandId = flatVisibleCommands.value[index].id;
    const listContainer = commandListContainerRef.value;

    // Find the element using the data attribute (works for grid, list, and pills)
    const selectedElement = listContainer.querySelector(`[data-command-id="${selectedCommandId}"]`) as HTMLElement;

    if (selectedElement) {
        selectedElement.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
        });
    } else {
        console.warn(`[QuickCmdView] scrollToSelected: Could not find element for command ID ${selectedCommandId}`);
    }
};

// Watch for changes in the store's selectedIndex and scroll
watch(storeSelectedIndex, (newIndex) => {
  scrollToSelected(newIndex);
});

// Keyboard navigation now operates on the flat visible list from the store
const handleSearchInputKeydown = (event: KeyboardEvent) => {
    // 使用 store 的 flatVisibleCommands
    const commands = flatVisibleCommands.value;
    if (!commands.length) return;

    switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      quickCommandsStore.selectNextCommand(); // Use store action
      // scrollToSelected is handled by watcher
      break;
    case 'ArrowUp':
      event.preventDefault();
      quickCommandsStore.selectPreviousCommand(); // Use store action
      // scrollToSelected is handled by watcher
      break;
    case 'Enter':
      event.preventDefault();
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
        quickCommandsStore.setSearchTerm(localSearchTerm.value);
      }
      // 使用 store 的 storeSelectedIndex
      if (storeSelectedIndex.value >= 0 && storeSelectedIndex.value < commands.length) {
        executeCommand(commands[storeSelectedIndex.value]);
      }
      break;
  }
};

// 处理搜索框失焦事件
const handleSearchInputBlur = () => {
  // 延迟执行，以允许点击列表项事件先触发
  setTimeout(() => {
    // 检查焦点是否还在组件内部的其他可聚焦元素上（例如按钮）
    // 如果焦点移出整个组件区域，则重置选择
    if (document.activeElement !== searchInputRef.value && !commandListContainerRef.value?.contains(document.activeElement)) {
        quickCommandsStore.resetSelection();
    }
}, 100); // 短暂延迟
};

// 切换排序方式 (Action remains the same, store handles the logic change)
const toggleSortBy = () => {
    const newSortBy = sortBy.value === 'name' ? 'last_used' : 'name';
    quickCommandsStore.setSortBy(newSortBy);
};

// +++ Action to toggle group expansion +++
const toggleGroup = (groupName: string) => {
    quickCommandsStore.toggleGroup(groupName);
    // After toggling, selection might become invalid if the selected item is now hidden
    // Reset selection or check if the selected item is still visible
    nextTick(() => { // Wait for DOM update potentially caused by v-show
         // 使用 store 的 flatVisibleCommands 和 storeSelectedIndex
         const selectedCmdId = storeSelectedIndex.value >= 0 && flatVisibleCommands.value[storeSelectedIndex.value]
             ? flatVisibleCommands.value[storeSelectedIndex.value].id
             : null;
         if (selectedCmdId !== null) {
             const newIndex = flatVisibleCommands.value.findIndex(cmd => cmd.id === selectedCmdId);
             if (newIndex === -1) { // Selected item is no longer visible
                 quickCommandsStore.resetSelection();
             } else {
                 // Update index if it shifted, though usually reset is safer/simpler
                 // storeSelectedIndex.value = newIndex;
             }
         }
    });
};

// 计算排序按钮的 title 和 icon
const sortButtonTitle = computed(() => {
  return sortBy.value === 'name'
    ? t('quickCommands.sortByName', '按名称排序')
    : t('quickCommands.sortByLastUsed', '按最近使用排序');
});

const sortButtonIcon = computed(() => {
  // 使用 Font Awesome 图标示例
  return sortBy.value === 'name' ? 'fas fa-sort-alpha-down' : 'fas fa-clock';
});


const openAddForm = () => {
  commandToEdit.value = null;
  isFormVisible.value = true;
};

const openEditForm = (command: QuickCommandFE) => {
  commandToEdit.value = command;
  isFormVisible.value = true;
};

const closeForm = () => {
  isFormVisible.value = false;
  commandToEdit.value = null;
};

const confirmDelete = async (command: QuickCommandFE) => {
  const confirmed = await showConfirmDialog({
    message: t('quickCommands.confirmDelete', { name: command.name || command.command })
  });
  if (confirmed) {
    quickCommandsStore.deleteQuickCommand(command.id);
  }
};

// 复制命令到剪贴板
const copyCommand = async (command: string) => {
  try {
    await navigator.clipboard.writeText(command);
    uiNotificationsStore.showSuccess(t('commandHistory.copied', '已复制到剪贴板'));
  } catch (err) {
    console.error('使用Clipboard API复制命令失败:', err);
    // 备用方案：使用临时文本区域和execCommand
    try {
      const textarea = document.createElement('textarea');
      textarea.value = command;
      textarea.style.position = 'fixed'; // 避免滚动到页面底部
      textarea.style.opacity = '0'; // 隐藏文本区域
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (successful) {
        uiNotificationsStore.showSuccess(t('commandHistory.copied', '已复制到剪贴板'));
      } else {
        uiNotificationsStore.showError(t('commandHistory.copyFailed', '复制失败'));
      }
    } catch (fallbackErr) {
      console.error('备用复制方法也失败:', fallbackErr);
      uiNotificationsStore.showError(t('commandHistory.copyFailed', '复制失败'));
    }
  }
};

// 执行命令
const executeCommand = (cmd: QuickCommandFE) => {
  // 1. 增加使用次数
  quickCommandsStore.incrementUsage(cmd.id);

  let processedCommand = cmd.command;
  const savedVariables = cmd.variables || {}; // 使用已保存的变量

  // 2. 执行变量替换
  for (const varName in savedVariables) {
    const placeholder = new RegExp(`\\$\\{${varName}\\}`, 'g');
    processedCommand = processedCommand.replace(placeholder, savedVariables[varName]);
  }

  // 3. 检查未定义变量
  const variablePlaceholders = cmd.command.match(/\$\{[^\}]+\}/g) || [];
  const undefinedVariables: string[] = [];
  variablePlaceholders.forEach(placeholder => {
    const varName = placeholder.substring(2, placeholder.length - 1);
    if (!savedVariables.hasOwnProperty(varName)) {
      undefinedVariables.push(varName);
    }
  });



  // 4. 获取当前激活的 SSH 会话 ID
  const activeSessionId = sessionStore.activeSessionId;
  if (!activeSessionId) {
    uiNotificationsStore.showError(t('quickCommands.form.errorNoActiveSession', '没有活动的SSH会话可执行指令。'));
    return;
  }

  // 5. 触发 quickCommand:executeProcessed 事件
  emitWorkspaceEvent('quickCommand:executeProcessed', {
    command: processedCommand,
    sessionId: activeSessionId
  });
  emit('execute-command', processedCommand);
};

// +++ 聚焦搜索框的方法 +++
const focusSearchInput = (): boolean => {
  if (searchInputRef.value) {
    searchInputRef.value.focus();
    return true;
  }
  return false;
};
defineExpose({ focusSearchInput });

// +++ Methods for inline tag editing +++
const setTagInputRef = (el: any, id: string | number) => {
  if (el) {
    tagInputRefs.value.set(id, el as HTMLInputElement);
  } else {
    tagInputRefs.value.delete(id);
  }
};

const startEditingTag = (tagId: number | null, currentName: string) => {
  editingTagId.value = tagId === null ? 'untagged' : tagId;
  editedTagName.value = tagId === null ? '' : currentName; // Clear input for "Untagged"
  // Focus logic is handled by the watcher
};

const finishEditingTag = async () => {
  const currentEditingId = editingTagId.value;
  const newName = editedTagName.value.trim();
  const originalGroup = filteredAndGroupedCommands.value.find(g => g.tagId === currentEditingId); // Find original group data

  // Basic validation
  if (newName === '' && currentEditingId !== 'untagged') {
    cancelEditingTag();
    return;
  }
   if (newName === '' && currentEditingId === 'untagged') {
     cancelEditingTag();
     return;
   }

  let operationSuccess = false;

  try {
    if (currentEditingId === 'untagged') {
      // --- Create new tag and assign commands ---
      console.log(`[QuickCmdView] Creating new tag: ${newName}`);
      const newTag = await quickCommandTagsStore.addTag(newName);
      if (newTag) {
        operationSuccess = true;
        uiNotificationsStore.showSuccess(t('quickCommands.tags.createSuccess')); // Use specific translation key
        const untaggedGroup = filteredAndGroupedCommands.value.find(g => g.tagId === null);
        const commandIdsToAssign = untaggedGroup ? untaggedGroup.commands.map(c => c.id) : [];

        if (commandIdsToAssign.length > 0) {
          console.log(`[QuickCmdView] Assigning ${commandIdsToAssign.length} commands to new tag ID: ${newTag.id}`);
          console.log(`[QuickCmdView] Command IDs to assign: ${JSON.stringify(commandIdsToAssign)}`); 
          // Call the store action to assign commands to the new tag
          const assignSuccess = await quickCommandsStore.assignCommandsToTagAction(commandIdsToAssign, newTag.id);
          if (assignSuccess) {
            // Success/Error Notifications and list refresh are handled within the store action
            console.log(`[QuickCmdView] assignCommandsToTagAction reported success.`);
          } else {
             console.error(`[QuickCmdView] assignCommandsToTagAction reported failure.`);
             // Optionally show a specific error here if the store action doesn't cover all cases
          }
          // Remove TODO and temporary warning/refresh
          // console.warn("TODO: Implement assignCommandsToTagAction in quickCommands.store and backend");
          // uiNotificationsStore.showWarning("标签已创建，但指令分配功能尚未实现");
          // await quickCommandsStore.fetchQuickCommands(); // Store action handles refresh
        } else {
          uiNotificationsStore.showInfo(t('quickCommands.tags.noCommandsToAssign'));
        }

        // Update expanded group state
        const untaggedGroupName = t('quickCommands.untagged', '未标记');
        if (expandedGroups.value[untaggedGroupName] !== undefined) {
          const currentState = expandedGroups.value[untaggedGroupName];
          delete expandedGroups.value[untaggedGroupName]; // Remove old key
          expandedGroups.value[newName] = currentState; // Add new key
        }
      }
      // addTag failure handled in store
    } else if (typeof currentEditingId === 'number') {
      // --- Update existing tag ---
      const originalTagName = originalGroup?.groupName;
      if (!originalTagName) {
         console.error(`[QuickCmdView] Cannot find original group name for tag ID ${currentEditingId}`);
         cancelEditingTag();
         return;
      }
      if (originalTagName === newName) {
        operationSuccess = true; // No change needed
      } else {
        console.log(`[QuickCmdView] Updating tag ID ${currentEditingId} from "${originalTagName}" to "${newName}"`);
        const updateResult = await quickCommandTagsStore.updateTag(currentEditingId, newName);
        if (updateResult) {
          operationSuccess = true;
          // uiNotificationsStore.showSuccess(t('quickCommands.tags.updateSuccess'));
          // Update expanded group state
          if (expandedGroups.value[originalTagName] !== undefined) {
            const currentState = expandedGroups.value[originalTagName];
            delete expandedGroups.value[originalTagName];
            expandedGroups.value[newName] = currentState;
          }
           // Refresh commands to reflect potential grouping changes if names clashed etc.
           await quickCommandsStore.fetchQuickCommands();
        }
        // updateTag failure handled in store
      }
    }
  } catch (error: any) {
    console.error("[QuickCmdView] Error during finishEditingTag:", error);
    uiNotificationsStore.showError(t('common.unexpectedError'));
  } finally {
    editingTagId.value = null; // Exit edit mode regardless of success
  }
};

const cancelEditingTag = () => {
  editingTagId.value = null;
};

// --- 长按检测 (Touch Long Press) 与右键菜单统一控制 ---
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartX = 0;
let touchStartY = 0;
const isLongPressActive = ref(false);

const openContextMenuAt = (x: number, y: number, command: QuickCommandFE) => {
  quickCommandContextTargetCommand.value = command;
  quickCommandContextMenuPosition.value = { x, y };
  quickCommandContextMenuVisible.value = true;
  document.addEventListener('click', closeQuickCommandContextMenu, { once: true });

  // 使用 nextTick 获取菜单尺寸并调整位置以防止超出屏幕
  nextTick(() => {
    const menuElement = document.querySelector('.quick-command-context-menu') as HTMLElement;
    if (menuElement) {
      const menuRect = menuElement.getBoundingClientRect();
      let finalX = quickCommandContextMenuPosition.value.x;
      let finalY = quickCommandContextMenuPosition.value.y;
      const menuWidth = menuRect.width;
      const menuHeight = menuRect.height;

      // 调整水平位置
      if (finalX + menuWidth > window.innerWidth) {
        finalX = window.innerWidth - menuWidth - 8;
      }

      // 调整垂直位置
      if (finalY + menuHeight > window.innerHeight) {
        finalY = window.innerHeight - menuHeight - 8;
      }

      // 确保菜单不超出屏幕左上角
      finalX = Math.max(8, finalX);
      finalY = Math.max(8, finalY);

      quickCommandContextMenuPosition.value = { x: finalX, y: finalY };
    }
  });
};

// 触屏长按处理 (移动端/触摸屏)
const handleItemTouchStart = (event: TouchEvent, command: QuickCommandFE) => {
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  isLongPressActive.value = false;

  if (longPressTimer) {
    clearTimeout(longPressTimer);
  }
  longPressTimer = setTimeout(() => {
    isLongPressActive.value = true;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate?.(40);
    }
    openContextMenuAt(touch.clientX, touch.clientY, command);
  }, 450);
};

const handleItemTouchMove = (event: TouchEvent) => {
  if (!longPressTimer) return;
  const touch = event.touches[0];
  const deltaX = Math.abs(touch.clientX - touchStartX);
  const deltaY = Math.abs(touch.clientY - touchStartY);
  // 滑移超过 10px 视为滚动页面，取消长按定时器
  if (deltaX > 10 || deltaY > 10) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};

const handleItemTouchEnd = () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  if (isLongPressActive.value) {
    // 延迟 150ms 重置标志位，以阻断随后的原生 click 事件触发执行
    setTimeout(() => {
      isLongPressActive.value = false;
    }, 150);
  }
};

// 拦截长按触发后的误触点击
const handleCommandItemClick = (cmd: QuickCommandFE) => {
  if (isLongPressActive.value) {
    isLongPressActive.value = false;
    return;
  }
  executeCommand(cmd);
};

// 右键点击处理
const showQuickCommandContextMenu = (event: MouseEvent, command: QuickCommandFE) => {
  event.preventDefault();
  openContextMenuAt(event.clientX, event.clientY, command);
};

const closeQuickCommandContextMenu = () => {
  quickCommandContextMenuVisible.value = false;
  quickCommandContextTargetCommand.value = null;
  document.removeEventListener('click', closeQuickCommandContextMenu);
};

// 右键/长按菜单动作处理
type QuickCommandMenuAction = 'execute' | 'edit' | 'copy' | 'sendToAllSessions' | 'delete';

const handleQuickCommandMenuAction = (action: QuickCommandMenuAction, command: QuickCommandFE) => {
  closeQuickCommandContextMenu();
  switch (action) {
    case 'execute':
      executeCommand(command);
      break;
    case 'edit':
      openEditForm(command);
      break;
    case 'copy':
      copyCommand(command.command);
      break;
    case 'sendToAllSessions': {
      const activeSshSessions = Array.from(sessionStore.sessions.values()).filter(
        (s: SessionState) => {
          if (s.wsManager.connectionStatus.value !== 'connected') return false;
          const connInfo = connectionsStore.connections.find(c => c.id === Number(s.connectionId));
          return connInfo?.type === 'SSH';
        }
      );

      if (activeSshSessions.length > 0) {
        activeSshSessions.forEach((session: SessionState) => {
          emitWorkspaceEvent('terminal:sendCommand', { sessionId: session.sessionId, command: command.command });
        });
        uiNotificationsStore.addNotification({
          message: t('quickCommands.notifications.sentToAllSessions', { count: activeSshSessions.length }),
          type: 'success',
        });
      } else {
        uiNotificationsStore.addNotification({
          message: t('quickCommands.notifications.noActiveSshSessions'),
          type: 'info',
        });
      }
      break;
    }
    case 'delete':
      confirmDelete(command);
      break;
  }
};
</script>

<style scoped>
/* 自适应网格卡片容器 (纯布局响应式，色彩全面继承主题类) */
.qc-grid-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(calc(170px * var(--qc-row-size-multiplier, 1)), 1fr));
  gap: calc(0.45rem * var(--qc-row-size-multiplier, 1));
}

/* 药丸胶囊流容器 (纯布局响应式) */
.qc-pill-container {
  display: flex;
  flex-wrap: wrap;
  gap: calc(0.35rem * var(--qc-row-size-multiplier, 1));
}
</style>
