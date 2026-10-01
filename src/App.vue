<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { statusLabel, useCollation } from './composables/useCollation';
import type { AlignmentRow, DifferenceStatus, PendingVerdict } from './types';

const {
  versions,
  leftVersionId,
  rightVersionId,
  rows,
  rules,
  selectedRowId,
  selectedRowIds,
  processing,
  progress,
  message,
  canUndo,
  canRedo,
  selectedRow,
  differenceCount,
  acceptedCount,
  unresolvedCount,
  runAlignment,
  recalculate,
  toggleRule,
  updateRow,
  shiftPairing,
  moveRow,
  acceptRows,
  acceptAll,
  nextDifference,
  addVersion,
  undo,
  redo,
  exportMarkdown,
  exportJson,
  tabLabel,
  mode,
  lockHolder,
  lockStale,
  clock,
  storageWarning,
  stashInfo,
  orphanStashes,
  verdictCount,
  reviewCount,
  pendingVerdicts,
  beginWriting,
  releaseWriting,
  mergeOffline,
  mergeOrphanStash,
  discardOfflineChanges,
  resolveVerdict,
  locateVerdictRow
} = useCollation();

const importVisible = ref(false);
const onlyDifferences = ref(false);
const rowQuery = ref('');
const noteDraft = ref('');
const sourceDraft = ref('');
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);

const columns = [
  { title: '状态', dataIndex: 'status', slotName: 'status', width: 122, fixed: 'left' as const },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 330 },
  { title: '对准操作', dataIndex: 'align', slotName: 'align', width: 112, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 330 },
  { title: '校记 / 来源', dataIndex: 'note', slotName: 'note', width: 240 }
];

const filteredRows = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    if (onlyDifferences.value && row.status === 'same') return false;
    if (!query) return true;
    return [row.left?.text, row.right?.text, row.note, row.source, statusLabel(row.status)]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query));
  });
});

const rowSelection = computed(() => ({
  type: 'checkbox' as const,
  showCheckedAll: true,
  selectedRowKeys: selectedRowIds.value,
  onlyCurrent: false
}));

watch(
  selectedRow,
  (row) => {
    noteDraft.value = row?.note ?? '';
    sourceDraft.value = row?.source ?? '';
  },
  { immediate: true }
);

function statusColor(status: DifferenceStatus) {
  return {
    same: 'gray',
    changed: 'orange',
    added: 'green',
    removed: 'red',
    misaligned: 'arcoblue'
  }[status] as 'gray' | 'orange' | 'green' | 'red' | 'arcoblue';
}

function rowClass(record: AlignmentRow) {
  return [
    record.id === selectedRowId.value ? 'row-active' : '',
    record.pendingVerdictId ? 'row-verdict' : '',
    record.needsReview ? 'row-review' : ''
  ];
}

function onSelectionChange(keys: (string | number)[]) {
  selectedRowIds.value = keys;
}

function updateStatus(status: unknown) {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, { status: String(status) as DifferenceStatus });
}

function onRowClick(record: Record<string, unknown>) {
  const row = record as unknown as AlignmentRow;
  selectedRowId.value = row.id;
}

function saveAnnotation() {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, {
    note: noteDraft.value.trim(),
    source: sourceDraft.value.trim()
  });
  Message.success('校勘说明已保存');
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleExport(kind: 'markdown' | 'json') {
  if (verdictCount.value > 0) {
    Message.warning(`还有 ${verdictCount.value} 条待裁决冲突，处理前不能导出`);
    return;
  }
  const content = kind === 'markdown' ? exportMarkdown() : exportJson();
  if (!content) return;
  if (kind === 'markdown') {
    download('校勘记.md', content, 'text/markdown;charset=utf-8');
  } else {
    download('校勘数据.json', content, 'application/json;charset=utf-8');
  }
}

function openImport() {
  importForm.value = { name: `导入版本 ${versions.value.length + 1}`, source: '', text: '' };
  importVisible.value = true;
}

function confirmImport() {
  if (!importForm.value.text.trim()) {
    Message.warning('请粘贴版本正文或选择文本文件');
    return;
  }
  addVersion(importForm.value.name, importForm.value.source, importForm.value.text.trim());
  importVisible.value = false;
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    importForm.value.text = text;
    if (!importForm.value.name || importForm.value.name.startsWith('导入版本')) {
      importForm.value.name = file.name.replace(/\.[^.]+$/, '');
    }
  });
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  } else if (event.key.toLowerCase() === 'a' && selectedRowIds.value.length) {
    acceptRows(selectedRowIds.value.map(String));
  }
}

window.addEventListener('keydown', handleKeydown);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);

function heartbeatText() {
  if (!lockHolder.value) return '无页签持锁';
  const age = Math.max(0, Math.round((clock.value - lockHolder.value.heartbeatAt) / 1000));
  return `${age} 秒前心跳`;
}

function verdictOptionText(verdict: PendingVerdict, side: 'mine' | 'theirs') {
  const option = verdict[side];
  if (verdict.kind === 'rules') return option.fields.note;
  return `${statusLabel(option.fields.status)} · 校记：${option.fields.note || '（空）'} · 来源：${option.fields.source || '（空）'}${option.fields.accepted ? ' · 已接受' : ''}`;
}

function verdictBaseText(verdict: PendingVerdict) {
  if (!verdict.base) return '';
  if (verdict.kind === 'rules') return verdict.base.fields.note;
  return `${statusLabel(verdict.base.fields.status)} · 校记：${verdict.base.fields.note || '（空）'} · 来源：${verdict.base.fields.source || '（空）'}${verdict.base.fields.accepted ? ' · 已接受' : ''}`;
}

function onRuleChange(field: 'ignorePunctuation' | 'ignoreVariants', value: boolean | Array<string | number | boolean>) {
  toggleRule(field, Boolean(value));
}

function switchVersion(side: 'left' | 'right', value: unknown) {
  const id = String(value);
  // 先取得写入权（对方在线则分叉离线），再落地选择，避免分叉装载主稿时盖掉本次改动。
  beginWriting();
  if (side === 'left') leftVersionId.value = id;
  else rightVersionId.value = id;
  void runAlignment();
}
</script>

<template>
  <a-layout class="workbench-shell">
    <a-layout-header class="topbar">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%">
        <div class="brand-mark">校</div>
        <div>
          <h1 class="brand-title">校异斋 · 多版本校勘台</h1>
          <div class="brand-subtitle">自动对齐、人工修正、校记导出，双页签离线接力，全程本地保存</div>
        </div>
        <a-space style="margin-left: auto" wrap>
          <a-button :disabled="!canUndo" @click="undo">撤销</a-button>
          <a-button :disabled="!canRedo" @click="redo">重做</a-button>
          <a-button type="primary" :loading="processing" @click="runAlignment()">重新自动对齐</a-button>
          <a-button @click="openImport">导入版本</a-button>
          <a-dropdown>
            <a-button :disabled="verdictCount > 0">导出校勘记</a-button>
            <template #content>
              <a-doption @click="handleExport('markdown')">Markdown 校勘记</a-doption>
              <a-doption @click="handleExport('json')">JSON 校勘数据</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
    </a-layout-header>

    <!-- 多页签接力状态条 -->
    <div class="relay-bar">
      <a-space wrap size="medium">
        <a-tag :color="mode === 'writer' ? 'green' : mode === 'offline' ? 'orange' : 'arcoblue'">
          {{ tabLabel }} ·
          {{ mode === 'writer' ? '正在写入（持有心跳锁）' : mode === 'offline' ? '离线编辑中' : '只读' }}
        </a-tag>
        <template v-if="mode === 'writer'">
          <span class="relay-hint">本页签独占写入；心跳停止超过 8 秒，其他页签可接回草稿。</span>
          <a-button size="mini" status="warning" @click="releaseWriting">停止心跳并让出写入权</a-button>
        </template>
        <template v-else-if="mode === 'offline'">
          <a-tag color="orangered" v-if="lockHolder && lockStale">写入页签「{{ lockHolder.label }}」心跳已停止</a-tag>
          <a-tag color="arcoblue" v-else-if="lockHolder">等待「{{ lockHolder.label }}」让出写入权 · {{ heartbeatText() }}</a-tag>
          <span class="relay-hint" v-if="stashInfo">
            离线草稿分叉于修订 {{ stashInfo.baseRevision }}（{{ new Date(stashInfo.updatedAt).toLocaleTimeString('zh-CN') }} 自动保存）
          </span>
          <a-button size="mini" type="primary" status="success" @click="mergeOffline">合并离线改动</a-button>
          <a-button size="mini" status="danger" @click="discardOfflineChanges">放弃离线改动</a-button>
        </template>
        <template v-else>
          <span class="relay-hint" v-if="lockHolder">
            写入页签：{{ lockHolder.label }}（{{ heartbeatText() }}<template v-if="lockStale">，已停止</template>）
          </span>
          <span class="relay-hint" v-else>当前无人写入</span>
          <a-button size="mini" type="primary" @click="beginWriting()">
            {{ lockHolder && lockStale ? '接回草稿并接管写入' : '取得写入权开始编辑' }}
          </a-button>
        </template>
        <a-tag v-if="orphanStashes.length" color="purple">发现 {{ orphanStashes.length }} 份其他页签遗留的离线草稿</a-tag>
      </a-space>
    </div>

    <!-- 遗留离线草稿列表 -->
    <div v-if="orphanStashes.length && mode === 'writer'" class="relay-bar orphan-bar">
      <div v-for="stash in orphanStashes" :key="stash.tabId" class="orphan-item">
        <a-tag color="purple">遗留草稿</a-tag>
        <span>页签「{{ stash.tabLabel }}」分叉于修订 {{ stash.base.revision }}，{{ new Date(stash.updatedAt).toLocaleString('zh-CN') }} 保存</span>
        <a-button size="mini" type="outline" @click="mergeOrphanStash(stash)">代为合并</a-button>
      </div>
    </div>

    <a-alert v-if="storageWarning" type="error" :show-icon="true" style="border-radius: 0">
      {{ storageWarning }}
    </a-alert>

    <!-- 待裁决横幅 -->
    <div v-if="verdictCount" class="verdict-banner">
      <a-alert type="warning" :show-icon="true">
        <template #title>
          有 {{ verdictCount }} 条双方改动的待裁决冲突，处理前不能接受建议或导出校勘记
        </template>
      </a-alert>
    </div>

    <a-layout class="main-layout">
      <a-layout-sider class="left-panel" :width="282">
        <section class="panel-section">
          <h2 class="panel-title">比对版本</h2>
          <div style="display: grid; gap: 10px">
            <a-select
              :model-value="leftVersionId"
              aria-label="底本"
              @change="(value: unknown) => switchVersion('left', value)"
            >
              <template #prefix>底本</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-select
              :model-value="rightVersionId"
              aria-label="参校本"
              @change="(value: unknown) => switchVersion('right', value)"
            >
              <template #prefix>参校</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-button long type="outline" @click="runAlignment()">执行分片自动对齐</a-button>
          </div>
          <a-progress v-if="processing" :percent="progress" size="small" style="margin-top: 12px" />
          <div v-if="processing" style="margin-top: 6px; color: #86909c; font-size: 12px">
            正在让出主线程，长文本编辑不会一直卡住
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill>
            <a-checkbox
              :model-checked="rules.ignorePunctuation"
              @change="(value: boolean | Array<string | number | boolean>) => onRuleChange('ignorePunctuation', value)"
            >
              忽略标点差异
            </a-checkbox>
            <a-checkbox
              :model-checked="rules.ignoreVariants"
              @change="(value: boolean | Array<string | number | boolean>) => onRuleChange('ignoreVariants', value)"
            >
              忽略常见异体字
            </a-checkbox>
          </a-space>
          <div style="margin-top: 10px; color: #86909c; font-size: 12px; line-height: 1.6">
            规则只影响相同/改动判断，原始正文始终保留。规则一改，已接受的校勘记录立即失效重算；人工挪动保留并标记待复核。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理进度</h2>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number">{{ differenceCount }}</div>
              <div class="stat-label">全部差异</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ unresolvedCount }}</div>
              <div class="stat-label">待校勘</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #00875a">{{ acceptedCount }}</div>
              <div class="stat-label">已接受</div>
            </div>
            <div class="stat-card">
              <div class="stat-number">{{ rows.length }}</div>
              <div class="stat-label">对齐句段</div>
            </div>
          </div>
          <a-tag v-if="reviewCount" color="orangered" style="margin-top: 10px">{{ reviewCount }} 行待复核（规则变更/冲突裁决）</a-tag>
          <a-button
            long
            type="primary"
            status="success"
            style="margin-top: 12px"
            :disabled="!unresolvedCount || verdictCount > 0"
            @click="acceptAll"
          >
            批量接受全部建议
          </a-button>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处未接受差异</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div style="color: #4e5969; font-size: 12px; line-height: 2">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处差异</div>
            <div><a-tag size="small">A</a-tag> 接受勾选建议</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <a-layout-content class="center-panel">
        <!-- 待裁决清单 -->
        <a-card v-if="verdictCount" class="verdict-card" :bordered="false" style="margin-bottom: 12px">
          <div v-for="verdict in pendingVerdicts" :key="verdict.id" class="verdict-item">
            <div class="verdict-head">
              <a-tag color="red">{{ verdict.kind === 'rules' ? '规则冲突' : '同行双改' }}</a-tag>
              <span class="verdict-title">
                {{ verdict.kind === 'rules' ? '两个页签修改了不同的比较规则' : `对齐行「${verdict.rowLabel}…」` }}
              </span>
              <a-button v-if="verdict.rowId" size="mini" @click="locateVerdictRow(verdict.rowId)">跳到该行</a-button>
            </div>
            <div v-if="verdict.base" class="verdict-base">
              分叉时底稿：{{ verdictBaseText(verdict) }}
            </div>
            <div class="verdict-options">
              <div class="verdict-option">
                <div class="verdict-who">{{ verdict.mine.tabLabel }}（合并发起方）{{ new Date(verdict.mine.at).toLocaleTimeString('zh-CN') }}</div>
                <div class="verdict-text">{{ verdictOptionText(verdict, 'mine') }}</div>
                <a-button size="mini" type="primary" :disabled="mode !== 'writer'" @click="resolveVerdict(verdict.id, 'mine')">
                  采用这一判断
                </a-button>
              </div>
              <div class="verdict-option">
                <div class="verdict-who">{{ verdict.theirs.tabLabel }}（离线一方）{{ new Date(verdict.theirs.at).toLocaleTimeString('zh-CN') }}</div>
                <div class="verdict-text">{{ verdictOptionText(verdict, 'theirs') }}</div>
                <a-button size="mini" type="primary" :disabled="mode !== 'writer'" @click="resolveVerdict(verdict.id, 'theirs')">
                  采用这一判断
                </a-button>
              </div>
            </div>
          </div>
        </a-card>

        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、校记或来源" allow-clear style="max-width: 360px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-tag color="arcoblue">{{ filteredRows.length }} / {{ rows.length }} 行</a-tag>
            <a-tag v-if="selectedRowIds.length" color="green">{{ selectedRowIds.length }} 行已勾选</a-tag>
            <a-button
              v-if="selectedRowIds.length"
              type="primary"
              status="success"
              size="small"
              style="margin-left: auto"
              :disabled="verdictCount > 0"
              @click="acceptRows(selectedRowIds.map(String))"
            >
              接受勾选建议
            </a-button>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="unresolvedCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message }}<span v-if="unresolvedCount"> · {{ unresolvedCount }} 条差异尚未接受</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredRows"
            :pagination="false"
            :row-selection="rowSelection"
            :row-class="rowClass"
            :scroll="{ x: 1160, y: 'calc(100vh - 420px)' }"
            :virtual-list-props="{ height: 560, threshold: 40 }"
            @selection-change="onSelectionChange"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <div v-if="record.manuallyAdjusted" style="margin-top: 4px; color: #165dff; font-size: 11px">人工调整</div>
              <a-tag v-if="record.pendingVerdictId" size="small" color="red" style="margin-top: 4px">待裁决</a-tag>
              <a-tag v-else-if="record.needsReview" size="small" color="orangered" style="margin-top: 4px">待复核</a-tag>
            </template>

            <template #left="{ record }">
              <div v-if="record.left">
                <div class="paragraph-label">段 {{ record.left.paragraphOrder }} · 句 {{ record.left.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'removed' ? 'removed' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.left.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应底本句</div>
            </template>

            <template #align="{ record }">
              <a-space direction="vertical" size="mini">
                <a-button size="mini" @click.stop="shiftPairing(record.id, -1)">配对上移</a-button>
                <a-button size="mini" @click.stop="shiftPairing(record.id, 1)">配对下移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, -1)">整行上移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, 1)">整行下移</a-button>
                <a-tooltip :content="record.pendingVerdictId ? '该行有待裁决冲突，处理前不能接受' : '接受这一行的自动判断'">
                  <a-button
                    size="mini"
                    status="success"
                    :disabled="Boolean(record.pendingVerdictId) || verdictCount > 0"
                    @click.stop="acceptRows([record.id])"
                  >
                    接受
                  </a-button>
                </a-tooltip>
              </a-space>
            </template>

            <template #right="{ record }">
              <div v-if="record.right">
                <div class="paragraph-label">段 {{ record.right.paragraphOrder }} · 句 {{ record.right.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'added' ? 'added' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.right.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应参校本句</div>
            </template>

            <template #note="{ record }">
              <div style="font-size: 12px; line-height: 1.6; color: #4e5969">
                <div>{{ record.note || '尚未填写校勘说明' }}</div>
                <div v-if="record.source" style="margin-top: 5px; color: #86909c">来源：{{ record.source }}</div>
                <a-tag v-if="record.pendingVerdictId" size="small" color="red" style="margin-top: 7px">待裁决</a-tag>
                <a-tag v-else-if="record.needsReview" size="small" color="orangered" style="margin-top: 7px">待复核</a-tag>
                <a-tag v-else-if="record.accepted" size="small" color="green" style="margin-top: 7px">已接受</a-tag>
                <a-tag v-else size="small" color="orange" style="margin-top: 7px">待处理</a-tag>
              </div>
            </template>

            <template #empty>
              <a-empty description="没有符合条件的对齐行" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="340">
        <section class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-tag v-if="selectedRow" color="arcoblue" style="margin-left: auto">{{ statusLabel(selectedRow.status) }}</a-tag>
          </div>
        </section>

        <template v-if="selectedRow">
          <a-alert
            v-if="selectedRow.pendingVerdictId"
            type="error"
            :show-icon="true"
            style="margin: 0 16px 12px"
          >
            该行双方都改过，列为待裁决；请在上方冲突清单中选择一方判断，处理前不能接受或导出。
          </a-alert>
          <a-alert v-else-if="selectedRow.needsReview" type="warning" :show-icon="true" style="margin: 0 16px 12px">
            比较规则已变更，原接受结论失效；人工挪动已保留，请核对后重新接受。
          </a-alert>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">判断类别</div>
            <a-select
              :model-value="selectedRow.status"
              style="width: 100%"
              :disabled="Boolean(selectedRow.pendingVerdictId)"
              @change="updateStatus"
            >
              <a-option value="same">相同</a-option>
              <a-option value="changed">改动</a-option>
              <a-option value="added">右侧新增</a-option>
              <a-option value="removed">左侧删减</a-option>
              <a-option value="misaligned">疑错位</a-option>
            </a-select>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">底本 / 参校本</div>
            <div class="diff-text same">{{ selectedRow.left?.text || '（无）' }}</div>
            <div style="height: 8px" />
            <div class="diff-text changed">{{ selectedRow.right?.text || '（无）' }}</div>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">校勘说明</div>
            <a-textarea
              v-model="noteDraft"
              placeholder="记录字形、词句、标点或语义差异的判断依据"
              :auto-size="{ minRows: 5, maxRows: 10 }"
            />
            <a-input v-model="sourceDraft" placeholder="来源，如：某刻本、某整理者" style="margin-top: 10px" />
            <a-button long type="primary" style="margin-top: 10px" @click="saveAnnotation">保存校勘说明</a-button>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">错位修正</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="shiftPairing(selectedRow.id, -1)">配对向前</a-button>
              <a-button @click="shiftPairing(selectedRow.id, 1)">配对向后</a-button>
              <a-button @click="moveRow(selectedRow.id, -1)">整行上移</a-button>
              <a-button @click="moveRow(selectedRow.id, 1)">整行下移</a-button>
            </div>
            <a-alert type="info" style="margin-top: 10px" :show-icon="true">
              配对移动只交换左栏句段，不会改写底本或参校本原文；规则变更后挪动保留并标待复核。
            </a-alert>
          </section>

          <section class="panel-section">
            <a-button
              long
              :status="selectedRow.accepted ? 'normal' : 'success'"
              :type="selectedRow.accepted ? 'outline' : 'primary'"
              :disabled="Boolean(selectedRow.pendingVerdictId) || verdictCount > 0"
              @click="updateRow(selectedRow.id, { accepted: !selectedRow.accepted })"
            >
              {{ selectedRow.accepted ? '撤回接受状态' : '接受这条校勘建议' }}
            </a-button>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div>
            <div style="font-size: 30px; color: #c9cdd4">择</div>
            <p>选择中间表格的一行<br />即可调整错位并填写校勘说明</p>
          </div>
        </div>

        <section class="panel-section" style="margin-top: auto">
          <div style="color: #86909c; font-size: 11px; line-height: 1.7">
            最近状态：{{ message }}<br />
            数据保存在当前浏览器；写入页签崩溃后，其他页签可凭心跳锁接回草稿。
          </div>
        </section>
      </a-layout-sider>
    </a-layout>
  </a-layout>

  <a-modal v-model:visible="importVisible" title="导入同一作品的新版本" width="700px" @ok="confirmImport">
    <a-form :model="importForm" layout="vertical">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="importForm.name" placeholder="如：某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="importForm.source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="选择文本文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleFile" />
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea
          v-model="importForm.text"
          placeholder="空行分段；句号、问号、感叹号或分号后自动分句"
          :auto-size="{ minRows: 10, maxRows: 18 }"
        />
      </a-form-item>
      <a-alert type="info" :show-icon="true">导入仅写入当前浏览器。对齐过程会分片执行，原文不会被自动改写。</a-alert>
    </a-form>
  </a-modal>
</template>
