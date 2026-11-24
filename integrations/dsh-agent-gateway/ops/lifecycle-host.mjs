import {open, unlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const key = {
      '--launcher': 'launcher', '--patch': 'patch', '--home': 'home', '--workspace': 'workspace',
      '--host': 'host', '--port': 'port', '--permission-mode': 'permissionMode', '--control-pipe': 'controlPipe',
      '--lease': 'lease',
    }[argv[index]];
    if (!key) throw new Error(`Unknown lifecycle host argument: ${argv[index]}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value for ${argv[index - 1]}`);
    result[key] = value;
  }
  for (const key of ['launcher', 'patch', 'home', 'workspace', 'host', 'port', 'permissionMode', 'controlPipe', 'lease']) {
    if (!result[key]) throw new Error(`Missing lifecycle host option: ${key}`);
  }
  return result;
}

// A peer may disconnect before receiving the acknowledgement. A valid stop must
// still drain the host, and EPIPE must not terminate it before lease cleanup.
export function lifecycleControlHandler(requestShutdown) {
  let stopping = false;
  return socket => {
    let request = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => { request += chunk; });
    socket.on('end', () => {
      if (request.trim() !== 'stop') { socket.end('invalid\n'); return; }
      if (!stopping) { stopping = true; requestShutdown(); }
      socket.end('stopping\n');
    });
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let requestShutdown;
  const shutdownRequested = new Promise(resolvePromise => { requestShutdown = resolvePromise; });
  const lease = await open(options.lease, 'wx');
  await lease.writeFile(JSON.stringify({pid: process.pid, controlPipe: options.controlPipe}) + '\n');
  const control = createServer(lifecycleControlHandler(requestShutdown));

  try {
    await new Promise((resolvePromise, reject) => {
      control.once('error', reject);
      control.listen(options.controlPipe, resolvePromise);
    });
    process.env.DSH_HOME = options.home;
    process.env.DSH_PERMISSION_MODE = options.permissionMode;
    process.chdir(options.workspace);
    process.argv = [process.execPath, options.launcher, 'web', '--patch', options.patch, '--no-open',
      '--host', options.host, '--port', String(options.port)];
    const {runCli} = await import(pathToFileURL(options.launcher).href);
    await runCli();
    await shutdownRequested;
    await new Promise(resolvePromise => control.close(resolvePromise));
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  } finally {
    await new Promise(resolvePromise => control.close(resolvePromise)).catch(() => {});
    await lease.close();
    await unlink(options.lease).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
