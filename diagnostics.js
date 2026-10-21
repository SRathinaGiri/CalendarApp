/**
 * In-app diagnostics log. Loaded before app.js so start-up errors are captured too.
 * Phones have no visible console, so errors and warnings are kept in a small in-memory ring
 * buffer that the Diagnostics screen can show and copy. Nothing is stored or sent anywhere.
 */
(function () {
  const MAX_ENTRIES = 300;
  const entries = [];
  const started = Date.now();

  function stringify(arg) {
    if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? '\n' + arg.stack.split('\n').slice(1, 4).join('\n') : ''}`;
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch (e) { return String(arg); }
  }

  function record(level, args) {
    const text = Array.from(args).map(stringify).join(' ').slice(0, 800);
    entries.push({ t: ((Date.now() - started) / 1000).toFixed(1), level, text });
    if (entries.length > MAX_ENTRIES) entries.shift();
  }

  ['error', 'warn', 'info'].forEach(level => {
    const original = console[level].bind(console);
    console[level] = function () {
      record(level, arguments);
      original.apply(console, arguments);
    };
  });

  window.addEventListener('error', e => {
    record('error', [`Uncaught ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`]);
  });
  window.addEventListener('unhandledrejection', e => {
    record('error', ['Unhandled promise rejection:', e.reason]);
  });

  window.SRGDiagnostics = {
    entries: () => entries.slice(),
    record: (level, ...args) => record(level, args)
  };
})();
