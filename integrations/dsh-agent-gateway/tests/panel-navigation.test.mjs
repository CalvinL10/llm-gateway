import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../panel.js', import.meta.url), 'utf8');
const navigation = source.slice(source.indexOf('    const stopPolling = () =>'),
  source.indexOf('    async function cancel()'));

async function openWithDelay(readyAt, {toggleAvailable = true, toggleReadyAt = 0, delayedCloseEvent = false} = {}) {
  let elapsed = 0, opened = 0, foreignOpened = 0, closed = 0, reopened = 0;
  let toggleClicks = 0, workspaceClicks = 0, inertToggleClicks = 0, inertWorkspaceClicks = 0;
  let intervalStarts = 0, intervalClears = 0, refreshes = 0, nextInterval = 0;
  let deferClose = delayedCloseEvent, queuedClose = false;
  const activeIntervals = new Set(['initial']);
  const selectors = [];
  const error = {textContent: ''};
  const target = {textContent: '目标任务 · 12345678', click() { opened++; }};
  const foreign = {textContent: '目标任务 · 87654321', click() { foreignOpened++; }};
  const dialog = {
    open: true,
    close() {
      closed++;
      this.open = false;
      if (deferClose) {
        deferClose = false;
        queuedClose = true;
      } else {
        this.onclose?.();
      }
    },
    showModal() { reopened++; this.open = true; },
    flushQueuedClose() {
      if (!queuedClose) return;
      queuedClose = false;
      this.onclose?.();
    },
  };
  const toggle = {click() { toggleClicks++; if (dialog.open) inertToggleClicks++; }};
  const workspace = {textContent: 'Authorized workspace', click() {
    workspaceClicks++; if (dialog.open) inertWorkspaceClicks++;
  }};
  const context = {
    state: {selectedTaskId: '12345678-original'},
    latest: {tasks: [{id: '12345678-original', workspaceId: 'authorized'}],
      workspaces: [{id: 'authorized', label: 'Authorized workspace'}]},
    document: {
      querySelector(selector) {
        selectors.push(selector);
        return toggleAvailable && elapsed >= toggleReadyAt
          && selector === 'button[aria-label="打开侧边栏"],button[aria-label="Open sidebar"]'
          ? toggle : null;
      },
      querySelectorAll: selector => selector === '[role="treeitem"]'
        ? [workspace, foreign, ...(toggleClicks && elapsed >= readyAt ? [target] : [])] : [],
    },
    $: () => error, dialog, timer: 'initial',
    refresh() { refreshes++; },
    clearInterval(id) { if (activeIntervals.delete(id)) intervalClears++; },
    setInterval() {
      intervalStarts++;
      const id = 'restored-' + ++nextInterval;
      activeIntervals.add(id);
      return id;
    },
    setTimeout(callback, milliseconds) { elapsed += milliseconds; queueMicrotask(callback); },
  };
  await runInNewContext(navigation + '\nopenNative()', context);
  const dialogOpenBeforeUserClose = dialog.open;
  const activeBeforeStaleClose = activeIntervals.size;
  dialog.flushQueuedClose();
  const activeAfterStaleClose = activeIntervals.size;
  if (reopened) dialog.close();
  return {elapsed, opened, foreignOpened, closed, reopened, dialogOpenBeforeUserClose,
    toggleClicks, workspaceClicks, inertToggleClicks, inertWorkspaceClicks,
    intervalStarts, intervalClears, refreshes, activeBeforeStaleClose, activeAfterStaleClose,
    activeAfterUserClose: activeIntervals.size, selectors, error: error.textContent};
}

test('opening a recovered task releases the modal before using the exact sidebar toggle', async () => {
  const result = await openWithDelay(600);
  assert.equal(result.opened, 1); assert.equal(result.foreignOpened, 0);
  assert.equal(result.closed, 1); assert.equal(result.reopened, 0);
  assert.equal(result.toggleClicks, 1); assert.equal(result.inertToggleClicks, 0);
  assert.equal(result.activeAfterUserClose, 0);
  assert.deepEqual(result.selectors,
    ['button[aria-label="打开侧边栏"],button[aria-label="Open sidebar"]']);
  assert.equal(result.error, '');
});

test('native sidebar hydration may finish after the recovered task panel without losing navigation', async () => {
  const result = await openWithDelay(600, {toggleReadyAt:300});
  assert.equal(result.opened, 1); assert.equal(result.foreignOpened, 0);
  assert.equal(result.toggleClicks, 1); assert.equal(result.inertToggleClicks, 0);
  assert.equal(result.reopened, 0); assert.equal(result.activeAfterUserClose, 0);
});

test('missing native session restores one polling interval and later close releases it', async () => {
  const result = await openWithDelay(Infinity, {delayedCloseEvent: true});
  assert.equal(result.opened, 0); assert.equal(result.foreignOpened, 0);
  assert.equal(result.closed, 2); assert.equal(result.reopened, 1);
  assert.equal(result.dialogOpenBeforeUserClose, true);
  assert.equal(result.toggleClicks, 1); assert.equal(result.workspaceClicks, 1);
  assert.equal(result.inertToggleClicks, 0); assert.equal(result.inertWorkspaceClicks, 0);
  assert.equal(result.refreshes, 1); assert.equal(result.intervalStarts, 1);
  assert.equal(result.activeBeforeStaleClose, 1);
  assert.equal(result.activeAfterStaleClose, 1, 'a delayed close event must not clear restored polling');
  assert.equal(result.activeAfterUserClose, 0);
  assert.equal(result.intervalClears, 2, 'both the original and restored intervals must be released');
  assert.match(result.error, /正确的宿主会话暂未出现/);
});

test('missing sidebar toggle still fails closed, restores polling, and never opens another session', async () => {
  const result = await openWithDelay(Infinity, {toggleAvailable: false});
  assert.equal(result.toggleClicks, 0); assert.equal(result.opened, 0); assert.equal(result.foreignOpened, 0);
  assert.equal(result.reopened, 1); assert.equal(result.dialogOpenBeforeUserClose, true);
  assert.equal(result.intervalStarts, 1); assert.equal(result.activeBeforeStaleClose, 1);
  assert.equal(result.activeAfterUserClose, 0);
  assert.match(result.error, /不要在其他会话处理审批/);
});
