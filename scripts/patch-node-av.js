'use strict';

// node-av 5.2.4 polls a full demux packet queue with setImmediate(). Our
// timestamp-paced consumer intentionally keeps that queue full, so the poll
// loop consumes roughly one complete CPU core per active stream. Yielding for
// 10ms only when all queues are already full preserves more than two seconds
// of buffered media while eliminating the busy-spin.
const fs = require('node:fs');
const path = require('node:path');

function patchNodeAv(root = path.dirname(require.resolve('node-av'))) {
  const target = path.join(root, 'api', 'demuxer.js');
  const before = fs.readFileSync(target, 'utf8');
  const oldBlock = `if (allQueuesFull) {\n                        await new Promise(setImmediate);\n                        continue;\n                    }`;
  const newBlock = `if (allQueuesFull) {\n                        await new Promise((resolve) => setTimeout(resolve, 10));\n                        continue;\n                    }`;
  if (before.includes(newBlock)) return false;
  const occurrences = before.split(oldBlock).length - 1;
  if (occurrences !== 1) {
    throw new Error(`node-av demux backpressure patch expected one match, found ${occurrences}`);
  }
  fs.writeFileSync(target, before.replace(oldBlock, newBlock));
  return true;
}

if (require.main === module) {
  const changed = patchNodeAv();
  console.log(changed ? 'patched node-av demux backpressure polling' : 'node-av demux backpressure patch already applied');
}

module.exports = { patchNodeAv };
