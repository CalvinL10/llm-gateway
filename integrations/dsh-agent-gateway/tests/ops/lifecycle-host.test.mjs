import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {lifecycleControlHandler} from '../../ops/lifecycle-host.mjs';

function peer(handler, fail = false) {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.end = value => {
    socket.reply = value;
    if (fail) socket.emit('error', Object.assign(new Error('peer closed'), {code: 'EPIPE'}));
  };
  handler(socket);
  return socket;
}
function send(socket, command) { socket.emit('data', command); socket.emit('end'); }

test('disconnected stop peer still requests shutdown exactly once without uncaught EPIPE', () => {
  let stops = 0;
  const handler = lifecycleControlHandler(() => { stops++; });
  assert.doesNotThrow(() => send(peer(handler, true), 'stop'));
  assert.equal(stops, 1);
  send(peer(handler), 'stop');
  assert.equal(stops, 1);
});

test('invalid control requests do not authorize shutdown', () => {
  let stops = 0;
  const socket = peer(lifecycleControlHandler(() => { stops++; }), true);
  assert.doesNotThrow(() => send(socket, 'restart'));
  assert.equal(socket.reply, 'invalid\n');
  assert.equal(stops, 0);
});
