'use strict';

// The parent only needs to know whether this Node event loop is responsive.
// Media and Discord status are checked separately by their own components.
if (typeof process.send === 'function') {
  process.on('message', message => {
    if (message === 'supervisor:ping') {
      try { process.send('supervisor:pong', () => {}); } catch { /* parent is shutting down */ }
    }
  });
}
