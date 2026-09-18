'use strict';

// Windows ACL-confined Node test workers cannot reopen libuv named pipes.
// Anonymous, inherited stdio keeps the original spawn, token and Job membership.
// No token, ACL, command, environment, isolation or approval is widened.
const cp = require('node:child_process');
const fs = require('node:fs');
const { Readable } = require('node:stream');

function isTestWorker(file, options) {
  return file === process.execPath && options?.env?.NODE_TEST_CONTEXT === 'child-v8' &&
    Array.isArray(options.stdio) && options.stdio.length === 3 &&
    options.stdio.every(value => value === 'pipe');
}

function install() {
  const koffi = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  const createPipe = kernel.func('int __stdcall CreatePipe(void *, void *, void *, uint32_t)');
  const closeHandle = kernel.func('int __stdcall CloseHandle(void *)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');
  const peek = kernel.func('int __stdcall PeekNamedPipe(void *, void *, uint32_t, void *, void *, void *)');
  // Node owns a separate CRT descriptor table: ucrtbase's _open_osfhandle is wrong.
  const openHandle = koffi.load(null).func('int uv_open_osfhandle(intptr_t)');
  const original = cp.ChildProcess.prototype.spawn;

  function pipe() {
    const read = Buffer.alloc(8), write = Buffer.alloc(8);
    if (!createPipe(read, write, null, 0)) throw new Error('CreatePipe failed: ' + lastError());
    const handles = [read.readBigInt64LE(), write.readBigInt64LE()];
    const fds = [];
    try {
      for (const handle of handles) {
        const fd = openHandle(handle);
        if (fd < 0) throw new Error('uv_open_osfhandle failed');
        fds.push(fd);
      }
      return { fds, readHandle: handles[0] };
    } catch (error) {
      for (const fd of fds) fs.closeSync(fd);
      for (const handle of handles.slice(fds.length)) closeHandle(handle);
      throw error;
    }
  }

  function reader(fd, handle) {
    let timer;
    const stream = new Readable({
      read() { if (timer === undefined) poll(); },
      destroy(error, done) {
        clearTimeout(timer);
        try { fs.closeSync(fd); done(error); } catch (closeError) { done(error ?? closeError); }
      }
    });
    function poll() {
      timer = undefined;
      if (stream.destroyed) return;
      const available = Buffer.alloc(4);
      if (!peek(handle, null, 0, null, available, null)) {
        const code = lastError();
        if (code === 109) stream.push(null); // ERROR_BROKEN_PIPE: all writers closed.
        else stream.destroy(new Error('PeekNamedPipe failed: ' + code));
        return;
      }
      const size = Math.min(available.readUInt32LE(), 65536);
      if (size) {
        try {
          const bytes = Buffer.allocUnsafe(size);
          const count = fs.readSync(fd, bytes, 0, size, null);
          if (!stream.push(bytes.subarray(0, count))) return;
        } catch (error) { stream.destroy(error); return; }
      }
      // Poll available bytes instead of blocking libuv workers on idle pipes;
      // concurrent test files must not exhaust the pool and deadlock output.
      timer = setTimeout(poll, 5);
    }
    return stream;
  }

  cp.ChildProcess.prototype.spawn = function spawn(options) {
    const worker = { ...options, env: { NODE_TEST_CONTEXT: options.envPairs?.includes('NODE_TEST_CONTEXT=child-v8') ? 'child-v8' : undefined } };
    if (!isTestWorker(options.file, worker)) return original.apply(this, arguments);
    const pairs = [], owned = new Set();
    const child = this;
    try {
      for (let i = 0; i < 3; i++) {
        const pair = pipe(); pairs.push(pair);
        pair.fds.forEach(fd => owned.add(fd));
      }
      const childFds = [pairs[0].fds[0], pairs[1].fds[1], pairs[2].fds[1]];
      const result = original.call(child, { ...options, stdio: childFds });
      for (const fd of childFds) { owned.delete(fd); fs.closeSync(fd); }
      child.stdin = fs.createWriteStream(null, { fd: pairs[0].fds[1], autoClose: true });
      owned.delete(pairs[0].fds[1]);
      child.stdout = reader(pairs[1].fds[0], pairs[1].readHandle);
      owned.delete(pairs[1].fds[0]);
      child.stderr = reader(pairs[2].fds[0], pairs[2].readHandle);
      owned.delete(pairs[2].fds[0]);
      child.stdio = [child.stdin, child.stdout, child.stderr];
      // Numeric-fd stdio is not counted by ChildProcess's native close event.
      // Preserve the public guarantee that close follows captured output.
      const emit = child.emit;
      let remaining = 2, pendingClose;
      child.emit = function(event, ...values) {
        if (event === 'close' && remaining) { pendingClose = values; return false; }
        return emit.call(this, event, ...values);
      };
      for (const output of [child.stdout, child.stderr]) {
        output.once('close', () => {
          if (--remaining === 0 && pendingClose) emit.call(child, 'close', ...pendingClose);
        });
        output.on('error', error => { child.kill(); child.emit('error', error); });
      }
      child.stdin.on('error', error => { child.kill(); child.emit('error', error); });
      child.once('exit', () => child.stdin.destroy());
      child.once('error', () => child.stdio.forEach(stream => stream.destroy()));
      return result;
    } catch (error) {
      child?.kill();
      child?.stdio?.forEach(stream => stream?.destroy());
      for (const fd of owned) fs.closeSync(fd);
      throw error; // No unrestricted or isolation-disabled retry.
    }
  };
}

module.exports = { isTestWorker };
if (process.platform === 'win32' && process.execArgv.includes('--test') &&
    process.env.NODE_TEST_CONTEXT !== 'child-v8') install();
