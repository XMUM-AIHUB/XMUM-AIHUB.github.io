/*!
 * XMUM AIHUB – AIT GPU Server guide · progressive enhancement
 *
 * Plain JavaScript (ES2020) with no dependencies and no network requests.
 * The page is fully readable without it; each feature below only enhances the
 * markup in index.html and does nothing if that markup is missing.
 *
 * The DOM-free helpers in `Pure` are exported for Node, e.g.
 *   node -e "const P = require('./assets/js/main.js'); console.log(P.buildScript(P.BUILDER_DEFAULTS))"
 */
(function () {
  'use strict';

  /* =========================================================================
   * Pure helpers (no DOM)
   * ========================================================================= */

  const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
  const HOST_RE = /^(?!-)(?=.*[A-Za-z0-9])[A-Za-z0-9.:-]{1,253}$/;
  const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
  const IO_RE = /^(?!-)[A-Za-z0-9_.\/%+-]{1,128}$/;
  const MODULE_RE = /^[A-Za-z0-9_.+\/-]+(?: [A-Za-z0-9_.+\/-]+)*$/;
  // Slurm --time formats: M, M:S, H:M:S, D-H, D-H:M, D-H:M:S
  const TIME_RE = /^(?:(\d{1,4})-(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?|(\d{1,5})(?::(\d{1,2}))?(?::(\d{1,2}))?)$/;
  const MEM_RE = /^([1-9]\d{0,6})(?:([MGTmgt])[Bb]?)?$/;
  const NAME_HELP = 'Use letters, digits, dots, dashes or underscores, with no spaces.';
  const COMMENT_COLUMN = 39; // "#SBATCH …" is padded so comments start in column 40

  const BUILDER_DEFAULTS = Object.freeze({
    file: 'my_job_script.sh',
    job: 'my_job',
    out: 'output_%j.txt',
    err: 'error_%j.txt',
    gpus: 1,
    time: '00:30:00',
    mem: '500M',
    module: 'anaconda',
    env: '',
    cmd: 'python my_script.py',
  });

  function isUser(s) { return typeof s === 'string' && USER_RE.test(s); }
  function isHost(s) { return typeof s === 'string' && HOST_RE.test(s); }
  function isPort(n) { return Number.isInteger(n) && n >= 1024 && n <= 65535; }
  function isSshPort(s) { return typeof s === 'string' && /^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535; }

  function cleanUser(raw) { return String(raw == null ? '' : raw).trim(); }
  function cleanPort(raw) { return String(raw == null ? '' : raw).trim().replace(/^0+(?=\d)/, ''); }

  /** The port in "ssh -p 2222 …", "host:2222" or "ssh://host:2222", or '' */
  function portFrom(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const m = s.match(/(?:^|\s)-p\s*(\d+)(?:\s|$)/) || s.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^:\s\/]+:(\d+)(?:\/.*)?$/i);
    return m ? cleanPort(m[1]) : '';
  }

  /** "SSH://Server.Example.edu:22/path" → "server.example.edu" */
  function cleanHost(raw) {
    let s = String(raw == null ? '' : raw).trim().replace(/^ssh\s+/i, '');
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    s = s.replace(/\/.*$/, '');
    s = s.replace(/^([^:]+):\d+$/, '$1'); // host:port (not IPv6)
    return s.toLowerCase();
  }

  /** "alice@192.0.2.10", "ssh -p 2222 alice@host" or "alice@host:2222" → { user, host, port }; otherwise null */
  function splitUserHost(raw) {
    const port = portFrom(raw);
    const s = String(raw == null ? '' : raw).trim().replace(/^ssh\s+/i, '').replace(/(?:^|\s)-p\s*\d+(?=\s|$)/, '').trim();
    const at = s.lastIndexOf('@');
    if (at <= 0 || at === s.length - 1) return null;
    return { user: s.slice(0, at), host: s.slice(at + 1), port };
  }

  function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(String(str))) {
      h ^= byte;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /** A stable per-user Jupyter port in 20000–29999, the same on every device. */
  function portFor(username) { return 20000 + (fnv1a32(String(username).toLowerCase()) % 10000); }

  function randomPort(exclude) {
    let p;
    do { p = 20000 + Math.floor(Math.random() * 10000); } while (p === exclude);
    return p;
  }

  /** Slurm time string → seconds, or null if invalid or zero. */
  function parseTime(raw) {
    const m = TIME_RE.exec(String(raw == null ? '' : raw).trim());
    if (!m) return null;
    let secs;
    if (m[1] !== undefined) secs = +m[1] * 86400 + +m[2] * 3600 + +(m[3] || 0) * 60 + +(m[4] || 0); // D-H[:M[:S]]
    else if (m[7] !== undefined) secs = +m[5] * 3600 + +m[6] * 60 + +m[7]; // H:M:S
    else if (m[6] !== undefined) secs = +m[5] * 60 + +m[6]; // M:S
    else secs = +m[5] * 60; // M
    return secs > 0 ? secs : null;
  }

  function formatDuration(secs) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const parts = [];
    if (d) parts.push(d + (d === 1 ? ' day' : ' days'));
    if (h) parts.push(h + ' h');
    if (m) parts.push(m + ' min');
    if (s) parts.push(s + ' s');
    return parts.join(' ');
  }

  /** Human hint for the builder's time field. */
  function describeTime(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return 'No limit set, so the server default applies.';
    const secs = parseTime(s);
    if (secs === null) return '';
    let text = '= ' + formatDuration(secs);
    if (/^\d+:\d{1,2}$/.test(s)) text += ' (minutes:seconds). For hours, write HH:MM:SS, e.g. 01:30:00.';
    return text;
  }

  /** "500MB" → "500M", "8g" → "8G", "1024" → "1024M"; invalid → null */
  function normMem(raw) {
    const m = MEM_RE.exec(String(raw == null ? '' : raw).trim());
    return m ? m[1] + (m[2] ? m[2].toUpperCase() : 'M') : null;
  }

  function memLabel(mem) { return mem.slice(0, -1) + ' ' + mem.slice(-1) + 'B'; }

  function hasJobId(pattern) { return /%\d{0,2}[jJA]/.test(pattern); }

  /** Output pattern → the file name to `cat`, e.g. "output_%j.txt" → "output_<job_id>.txt" */
  function resolveOutput(pattern, ctx) {
    const c = ctx || {};
    if (!pattern) return 'slurm-<job_id>.out';
    return pattern.replace(/%(%|\d{0,2}[A-Za-z])/g, (all, code) => {
      if (code === '%') return '%';
      const ch = code.slice(-1);
      if (ch === 'j' || ch === 'J' || ch === 'A') return '<job_id>';
      if (ch === 'x') return c.job || c.file || 'my_job';
      if (ch === 'u') return c.user || 'username';
      return '*';
    });
  }

  function directive(option, comment) {
    const d = '#SBATCH ' + option;
    return (d.length < COMMENT_COLUMN ? d.padEnd(COMMENT_COLUMN) : d + '  ') + '# ' + comment;
  }

  /** Builds a job script from validated values (see validateBuilder). */
  function buildScript(v) {
    const lines = ['#!/bin/bash'];
    if (v.job) lines.push(directive('--job-name=' + v.job, 'Job name'));
    if (v.out) lines.push(directive('--output=' + v.out, hasJobId(v.out) ? 'Output file name with job ID' : 'Output file name'));
    if (v.err && v.err !== v.out) lines.push(directive('--error=' + v.err, hasJobId(v.err) ? 'Error file name with job ID' : 'Error file name'));
    if (v.gpus > 0) lines.push(directive('--gres=gpu:' + v.gpus, 'Number of GPUs'));
    if (v.time) lines.push(directive('--time=' + v.time, 'Time limit (' + formatDuration(parseTime(v.time)) + ')'));
    if (v.mem) lines.push(directive('--mem=' + v.mem, 'Memory (' + memLabel(v.mem) + ')'));
    if (v.module) lines.push('', '# Load necessary modules', 'module load ' + v.module);
    if (v.env) {
      // Plain `conda activate` fails in non-interactive shells; the hook sets it up first.
      lines.push('', '# Activate your conda environment (works in non-interactive jobs)',
        'eval "$(conda shell.bash hook)"', 'conda activate ' + v.env);
    }
    lines.push('', '# Run the job command', v.cmd);
    return lines.join('\n') + '\n';
  }

  function shQuote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }

  /** The interactive equivalent. Commands with shell syntax are wrapped in bash -c. */
  function buildSrun(v) {
    const lines = [];
    if (v.module) lines.push('module load ' + v.module);
    if (v.env) lines.push('eval "$(conda shell.bash hook)"', 'conda activate ' + v.env);
    const parts = ['srun'];
    if (v.gpus > 0) parts.push('--gres=gpu:' + v.gpus);
    if (v.time) parts.push('--time=' + v.time);
    if (v.mem) parts.push('--mem=' + v.mem);
    const needsShell = /[;&|<>()`$\\]|^\s*(?:cd|source|\.|export|set|unset|conda|module)\b/.test(v.cmd);
    parts.push(needsShell ? 'bash -c ' + shQuote(v.cmd) : v.cmd);
    lines.push(parts.join(' '));
    return lines.join('\n');
  }

  /** Validates and normalizes raw builder input. Blank optional fields are left out. */
  function validateBuilder(raw) {
    const r = raw || {};
    const get = (k) => String(r[k] == null ? '' : r[k]).trim();
    const v = {};
    const errors = {};
    const warnings = {};

    v.file = get('file');
    if (!v.file) errors.file = 'Enter a file name, e.g. my_job_script.sh.';
    else if (!NAME_RE.test(v.file)) errors.file = NAME_HELP;
    else if (!/\.sh$/.test(v.file)) warnings.file = 'Job scripts usually end in .sh.';

    v.job = get('job');
    if (v.job && !NAME_RE.test(v.job)) errors.job = NAME_HELP;

    v.out = get('out');
    if (v.out && !IO_RE.test(v.out)) errors.out = 'Use a file name with no spaces, e.g. output_%j.txt.';
    else if (v.out && !hasJobId(v.out)) warnings.out = 'Without %j, every job overwrites this file.';

    v.err = get('err');
    if (v.err && !IO_RE.test(v.err)) errors.err = 'Use a file name with no spaces, e.g. error_%j.txt.';
    else if (v.err && v.err === v.out) warnings.err = 'Same as the output file, so errors go there too.';
    else if (v.err && !hasJobId(v.err)) warnings.err = 'Without %j, every job overwrites this file.';

    const gpus = Number(get('gpus'));
    v.gpus = Number.isInteger(gpus) && gpus >= 0 && gpus <= 16 ? gpus : BUILDER_DEFAULTS.gpus;

    v.time = get('time');
    if (v.time && parseTime(v.time) === null) {
      errors.time = 'Use HH:MM:SS (e.g. 01:30:00), minutes (e.g. 90) or D-HH:MM:SS.';
    }

    const mem = get('mem');
    v.mem = '';
    if (mem) {
      const n = normMem(mem);
      if (n) v.mem = n;
      else if (/^0+[A-Za-z]*$/.test(mem)) errors.mem = "0 would request all of the server's memory. Use e.g. 8G.";
      else errors.mem = 'Use a whole number with M or G, e.g. 500M or 8G.';
    }

    v.module = get('module').replace(/\s+/g, ' ');
    if (v.module && !MODULE_RE.test(v.module)) errors.module = 'Use module names separated by spaces, e.g. anaconda.';

    v.env = get('env');
    if (v.env && !NAME_RE.test(v.env)) errors.env = NAME_HELP;
    else if (v.env && !v.module) warnings.env = 'conda usually needs the anaconda module loaded first.';

    v.cmd = get('cmd');
    if (!v.cmd) errors.cmd = 'Enter the command to run, e.g. python my_script.py.';
    else if (/[\r\n]/.test(v.cmd) || v.cmd.length > 500) errors.cmd = 'Keep the command on one line.';
    else if (v.cmd.startsWith('#')) errors.cmd = "A command can't start with #, because that makes it a comment.";
    else if (/^sbatch\b/.test(v.cmd)) warnings.cmd = 'sbatch inside a job script submits another job. Run your program directly instead.';
    else if (/^srun\b/.test(v.cmd)) warnings.cmd = 'No need for srun here: the script already runs on the resources you requested.';

    return { ok: Object.keys(errors).length === 0, values: v, errors, warnings };
  }

  /** Normalizes text before it goes to the clipboard or a file. */
  function cleanCopyText(text) {
    return String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .replace(/[​-‍⁠﻿]/g, '')
      .replace(/^\s*\n/, '') // leading blank lines (keeps the shebang on line 1)
      .replace(/\s+$/, ''); // trailing newline, so pasting doesn't run the command
  }

  /** "<job_id>"-style placeholders the reader still has to replace. */
  function placeholdersIn(text) { return Array.from(new Set(String(text).match(/<[A-Za-z_]+>/g) || [])); }

  function listJoin(items) {
    if (items.length < 2) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  const Pure = {
    BUILDER_DEFAULTS, isUser, isHost, isPort, cleanUser, cleanHost, splitUserHost, fnv1a32, portFor,
    randomPort, parseTime, formatDuration, describeTime, normMem, memLabel, hasJobId, resolveOutput,
    buildScript, buildSrun, shQuote, validateBuilder, cleanCopyText, placeholdersIn, listJoin,
  };

  if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = Pure;
  if (typeof document === 'undefined') return;

  /* =========================================================================
   * DOM helpers
   * ========================================================================= */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, val]) => {
      if (val === false || val == null) return;
      if (k === 'class') node.className = val;
      else node.setAttribute(k, val === true ? '' : String(val));
    });
    return node;
  }

  function span(className, text) {
    const s = document.createElement('span');
    s.className = className;
    s.textContent = text;
    return s;
  }

  function svgIcon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function debounce(fn, ms) {
    let timer;
    const debounced = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }

  const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  /* ---------- Storage: localStorage with an in-memory fallback ---------- */
  const store = (() => {
    const PREFIX = 'aihub:v1:';
    const mem = new Map();
    let ls = null;
    try {
      ls = window.localStorage;
      ls.setItem(PREFIX + 'probe', '1');
      ls.removeItem(PREFIX + 'probe');
    } catch (e) {
      ls = null; // blocked (private mode, cookies off) or unavailable
    }
    return {
      persistent: !!ls,
      key: (k) => PREFIX + k,
      get(k, fallback) {
        const key = PREFIX + k;
        if (mem.has(key)) return mem.get(key);
        if (ls) {
          try {
            const raw = ls.getItem(key);
            if (raw !== null) {
              const value = JSON.parse(raw);
              mem.set(key, value);
              return value;
            }
          } catch (e) { /* corrupt value: use the fallback */ }
        }
        return fallback;
      },
      set(k, value) {
        const key = PREFIX + k;
        mem.set(key, value);
        if (ls) { try { ls.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ } }
      },
      remove(k) {
        const key = PREFIX + k;
        mem.delete(key);
        if (ls) { try { ls.removeItem(key); } catch (e) { /* ignore */ } }
      },
      forget(fullKey) { mem.delete(fullKey); }, // after a change in another tab
    };
  })();

  /* ---------- Screen-reader announcements ---------- */
  let announceTimer;
  function announce(message) {
    const region = document.getElementById('sr-status');
    if (!region) return;
    region.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { region.textContent = message; }, 60);
  }

  /* =========================================================================
   * Theme: System → Light → Dark
   * ========================================================================= */
  function initTheme() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const root = document.documentElement;
    const MODES = ['system', 'light', 'dark'];
    const LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
    const ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
    const BAR_COLOR = { light: '#f6f7fb', dark: '#0a0f1c' };
    const metas = $$('meta[name="theme-color"]');
    metas.forEach((m) => { m.dataset.original = m.getAttribute('content'); });
    const use = $('use', btn);
    const label = $('.visually-hidden', btn);
    let mode = store.get('theme', 'system');
    if (!MODES.includes(mode)) mode = 'system';

    function apply(say) {
      if (mode === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', mode);
      if (use) use.setAttribute('href', '#i-' + ICON[mode]);
      const text = 'Color theme: ' + LABEL[mode];
      if (label) label.textContent = text;
      btn.title = text + ' (click to change)';
      metas.forEach((m) => m.setAttribute('content', mode === 'system' ? m.dataset.original : BAR_COLOR[mode]));
      if (say) announce(text);
    }

    btn.addEventListener('click', () => {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      if (mode === 'system') store.remove('theme');
      else store.set('theme', mode);
      apply(true);
    });
    apply(false);
  }

  /* =========================================================================
   * Personalization: username, hostname, SSH port (and the Jupyter port via a getter)
   * ========================================================================= */
  const Vars = (() => {
    const values = { username: '', hostname: '', sshport: '' };
    const getters = {};
    const LABELS = { username: 'username', hostname: 'server address', sshport: 'SSH port', jport: 'Jupyter port' };
    let userIn = null;
    let hostIn = null;
    let sshPortIn = null;

    function load() {
      const saved = store.get('vars', null);
      values.username = saved && isUser(saved.username) ? saved.username : '';
      values.hostname = saved && isHost(saved.hostname) ? saved.hostname : '';
      values.sshport = saved && isSshPort(saved.sshport) ? saved.sshport : '';
    }

    function get(name) { return getters[name] ? getters[name]() : values[name] || ''; }
    function register(name, fn) { getters[name] = fn; }

    /** Fills every <var data-var> token. Text only: user input never becomes HTML. */
    function apply(root) {
      $$('var[data-var]', root).forEach((v) => {
        if (v.dataset.ph === undefined) v.dataset.ph = v.textContent;
        const name = v.dataset.var;
        const value = get(name);
        const text = value || v.dataset.ph;
        if (v.textContent !== text) v.textContent = text;
        v.classList.toggle('is-unset', !value);
        if (value) v.removeAttribute('title');
        else v.title = 'Click to fill in your ' + (LABELS[name] || name);
      });
    }

    function applyAll() {
      apply(document);
      document.dispatchEvent(new CustomEvent('aihub:vars'));
    }

    function setMessage(input, message, kind) {
      const box = document.getElementById(input.id + '-msg');
      if (message && kind === 'error') input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      if (!box) return;
      box.textContent = message || '';
      box.hidden = !message;
      box.classList.toggle('is-warning', kind === 'warning');
    }

    function check(input) {
      if (input === sshPortIn) {
        const port = cleanPort(input.value);
        return !port || isSshPort(port) ? ['', ''] : ['Enter just the port number, between 1 and 65535, e.g. 22.', 'error'];
      }
      const isUserField = input === userIn;
      const value = isUserField ? cleanUser(input.value) : cleanHost(input.value);
      if (!value) return ['', ''];
      if (isUserField) {
        if (!isUser(value)) return [NAME_HELP, 'error'];
        if (/[A-Z]/.test(value)) return ['Usernames are case-sensitive, so check this matches yours exactly.', 'warning'];
        return ['', ''];
      }
      return isHost(value) ? ['', ''] : ['Enter just the IP address or hostname, e.g. 192.0.2.10 or gpu.example.edu.', 'error'];
    }

    const showLater = debounce((input) => setMessage(input, ...check(input)), 500);

    function commit(source) {
      // A pasted "user@host" (or "ssh user@host") in either field fills both.
      // A port in it ("-p 2222" or "host:2222") fills the port field.
      const pasted = source && source !== sshPortIn ? splitUserHost(source.value) : null;
      const port = pasted ? pasted.port : source === hostIn ? portFrom(hostIn.value) : '';
      if (pasted) {
        userIn.value = cleanUser(pasted.user);
        hostIn.value = cleanHost(pasted.host);
      }
      if (port) sshPortIn.value = port;
      const u = cleanUser(userIn.value);
      const h = cleanHost(hostIn.value);
      const p = cleanPort(sshPortIn.value);
      values.username = isUser(u) ? u : '';
      values.hostname = isHost(h) ? h : '';
      values.sshport = isSshPort(p) ? p : '';
      if (values.username || values.hostname || values.sshport) {
        store.set('vars', { username: values.username, hostname: values.hostname, sshport: values.sshport });
      } else store.remove('vars');

      [userIn, hostIn, sshPortIn].forEach((input) => {
        const [message] = check(input);
        if (!message) setMessage(input, '', '');
        else if (input === source && !pasted) showLater(input);
        else setMessage(input, ...check(input));
      });
      applyAll();
    }

    function focusInput(name) {
      if (name === 'jport') {
        const jport = document.getElementById('in-jport');
        if (jport) jport.focus();
        return;
      }
      Nav.reveal(name === 'hostname' ? hostIn : name === 'sshport' ? sshPortIn : userIn);
    }

    function init() {
      userIn = $('[data-input="username"]');
      hostIn = $('[data-input="hostname"]');
      sshPortIn = $('[data-input="sshport"]');
      load();

      if (userIn && hostIn && sshPortIn) {
        userIn.value = values.username;
        hostIn.value = values.hostname;
        sshPortIn.value = values.sshport;
        [userIn, hostIn, sshPortIn].forEach((input) => {
          input.addEventListener('input', () => commit(input));
          input.addEventListener('blur', () => { showLater.cancel(); setMessage(input, ...check(input)); });
        });

        const clear = document.getElementById('details-clear');
        if (clear) {
          clear.addEventListener('click', () => {
            userIn.value = '';
            hostIn.value = '';
            sshPortIn.value = '';
            commit(null);
            announce('Your details were cleared.');
            userIn.focus();
          });
        }

        const note = document.getElementById('storage-note');
        if (note) note.hidden = store.persistent;

        // Keep several open tabs in sync.
        window.addEventListener('storage', (e) => {
          if (e.key !== store.key('vars')) return;
          store.forget(e.key);
          load();
          if (document.activeElement !== userIn) userIn.value = values.username;
          if (document.activeElement !== hostIn) hostIn.value = values.hostname;
          if (document.activeElement !== sshPortIn) sshPortIn.value = values.sshport;
          applyAll();
        });
      }

      // Clicking an unfilled token jumps to the matching input.
      document.addEventListener('click', (e) => {
        const token = e.target instanceof Element ? e.target.closest('var[data-var].is-unset') : null;
        if (token) focusInput(token.dataset.var);
      });

      apply(document);
    }

    return { init, get, register, apply, applyAll, focusInput };
  })();

  /* =========================================================================
   * Clipboard (with fallbacks for file:// and older browsers)
   * ========================================================================= */
  async function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) { /* fall back below */ }
    }
    const active = document.activeElement;
    const ta = el('textarea', { readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;';
    document.body.append(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (active && typeof active.focus === 'function') active.focus({ preventScroll: true });
    return ok;
  }

  function selectContents(node) {
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* =========================================================================
   * Code blocks: Copy and Download buttons
   * ========================================================================= */
  const Code = (() => {
    const timers = new WeakMap();
    const resizer = 'ResizeObserver' in window
      ? new ResizeObserver((entries) => entries.forEach(({ target }) => {
        // Make sideways-scrolling code reachable by keyboard.
        if (target.scrollWidth > target.clientWidth + 1) target.tabIndex = 0;
        else target.removeAttribute('tabindex');
      }))
      : null;

    function codeText(block) {
      const code = $('pre code', block) || $('pre', block);
      return cleanCopyText(code ? code.textContent : '');
    }

    function shortLabel(block) {
      if (block.dataset.title) return block.dataset.title;
      const first = codeText(block).split('\n')[0];
      return first.length > 40 ? first.slice(0, 39) + '…' : first;
    }

    function missing(block, text) {
      const unset = $$('var[data-var].is-unset', block).map((v) => v.textContent);
      return Array.from(new Set(unset.concat(placeholdersIn(text))));
    }

    function feedback(btn, text, ok) {
      const label = $('.code__btn-text', btn);
      const use = $('use', btn);
      const kind = btn.dataset.kind;
      clearTimeout(timers.get(btn));
      label.textContent = text;
      btn.classList.toggle('is-done', ok);
      if (ok && use) use.setAttribute('href', '#i-check');
      timers.set(btn, setTimeout(() => {
        label.textContent = kind === 'copy' ? 'Copy' : 'Download';
        btn.classList.remove('is-done');
        if (use) use.setAttribute('href', '#i-' + kind);
      }, 2000));
    }

    async function copy(block, btn) {
      const text = codeText(block);
      const todo = missing(block, text);
      const reminder = todo.length ? ' Replace ' + listJoin(todo) + ' before running it.' : '';
      if (await writeClipboard(text)) {
        feedback(btn, 'Copied', true);
        announce('Copied to clipboard.' + reminder);
      } else {
        selectContents($('pre', block));
        const keys = isMac() ? '⌘C' : 'Ctrl+C';
        feedback(btn, 'Press ' + keys, false);
        announce("Couldn't copy automatically. The text is selected, so press " + keys + ' to copy it.');
      }
    }

    function download(block, btn) {
      const name = block.dataset.download || 'script.sh';
      const text = codeText(block) + '\n';
      const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
      const link = el('a', { href: url, download: name, hidden: true });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      const todo = missing(block, text);
      feedback(btn, 'Downloaded', true);
      announce('Downloaded ' + name + '.' + (todo.length ? ' Replace ' + listJoin(todo) + ' in it before running it.' : ''));
    }

    function makeButton(kind, block) {
      const btn = el('button', { type: 'button', class: 'code__btn code__btn--' + kind, 'data-kind': kind });
      btn.append(svgIcon(kind), span('code__btn-text', kind === 'copy' ? 'Copy' : 'Download'));
      btn.addEventListener('click', () => (kind === 'copy' ? copy(block, btn) : download(block, btn)));
      return btn;
    }

    /** Accessible names include what is copied, e.g. "Copy: module avail". */
    function relabel(block) {
      $$('.code__btn', block).forEach((btn) => {
        btn.setAttribute('aria-label', btn.dataset.kind === 'copy'
          ? 'Copy: ' + shortLabel(block)
          : 'Download ' + (block.dataset.download || 'file'));
      });
    }

    function enhance(root) {
      $$('.code', root).forEach((block) => {
        const pre = $('pre', block);
        if (!pre || block.dataset.enhanced) return;
        block.dataset.enhanced = 'true';
        const actions = el('div', { class: 'code__actions' });
        if (block.dataset.copy !== 'false') actions.append(makeButton('copy', block));
        if (block.dataset.download) actions.append(makeButton('download', block));
        if (actions.childElementCount) block.append(actions);
        relabel(block);
        if (resizer) resizer.observe(pre);
      });
    }

    return { enhance, relabel };
  })();

  /* =========================================================================
   * Tabs (WAI-ARIA tabs pattern; panels stay stacked without JS)
   * ========================================================================= */
  function detectOS() {
    const p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (p.includes('win')) return 'windows';
    if (p.includes('mac') || p.includes('iphone') || p.includes('ipad')) return 'macos';
    if (p.includes('linux') || p.includes('x11') || p.includes('cros')) return 'linux';
    return null;
  }

  function initTabs() {
    $$('.tabs[data-tabs]').forEach((box) => {
      const key = box.dataset.tabs;
      const panels = $$(':scope > .tabs__panel', box);
      if (panels.length < 2) return;
      const list = el('div', { class: 'tabs__list', role: 'tablist', 'aria-label': box.dataset.tabsLabel || 'Options' });
      const tabs = panels.map((panel) => {
        const heading = $('.tabs__heading', panel);
        const tab = el('button', {
          type: 'button',
          class: 'tabs__tab',
          role: 'tab',
          id: 'tab-' + key + '-' + panel.dataset.tab,
          'aria-controls': panel.id,
        });
        tab.textContent = heading ? heading.textContent : panel.dataset.tab;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        panel.tabIndex = 0;
        return tab;
      });
      list.append(...tabs);
      box.prepend(list);
      box.classList.add('is-enhanced');

      function select(index, focus, remember) {
        tabs.forEach((tab, i) => {
          const on = i === index;
          tab.setAttribute('aria-selected', String(on));
          tab.tabIndex = on ? 0 : -1;
          panels[i].hidden = !on;
        });
        if (focus) tabs[index].focus();
        if (remember) store.set('tab-' + key, panels[index].dataset.tab);
      }

      list.addEventListener('click', (e) => {
        const tab = e.target.closest('[role="tab"]');
        if (tab) select(tabs.indexOf(tab), false, true);
      });
      list.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        const next = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        select(next, true, true);
      });

      const ids = panels.map((p) => p.dataset.tab);
      let initial = panels.findIndex((p) => '#' + p.id === location.hash);
      if (initial < 0) initial = ids.indexOf(store.get('tab-' + key, ''));
      if (initial < 0 && key === 'os') initial = ids.indexOf(detectOS());
      select(Math.max(initial, 0), false, false);
    });
  }

  /* =========================================================================
   * Navigation: mobile drawer and "you are here" highlighting
   * ========================================================================= */
  const Nav = (() => {
    let sidebar = null;
    let toggle = null;
    let backdrop = null;
    let mq = null;

    const isDesktop = () => !mq || mq.matches;
    const isOpen = () => !!sidebar && sidebar.classList.contains('is-open');

    function setOpenState(on) {
      ['main', '.site-footer'].forEach((sel) => {
        const node = $(sel);
        if (node) node.inert = on;
      });
      document.body.classList.toggle('drawer-open', on);
      toggle.setAttribute('aria-expanded', String(on));
      const use = $('use', toggle);
      const label = $('.icon-btn__label', toggle);
      if (use) use.setAttribute('href', on ? '#i-x' : '#i-menu');
      if (label) label.textContent = on ? 'Close' : 'Contents';
    }

    function open(focusTarget) {
      if (!sidebar || !toggle || isDesktop()) return;
      sidebar.classList.add('is-open');
      backdrop.hidden = false;
      setOpenState(true);
      const target = focusTarget || $('input, button, a[href]', sidebar);
      if (target) target.focus({ preventScroll: true });
    }

    function close(returnFocus) {
      if (!isOpen()) return;
      sidebar.classList.remove('is-open');
      backdrop.hidden = true;
      setOpenState(false);
      if (returnFocus) toggle.focus();
    }

    /** Shows an input in the sidebar: opens the drawer on mobile, highlights the panel on desktop. */
    function reveal(input) {
      if (!input) return;
      if (!isDesktop()) {
        open(input);
        return;
      }
      input.focus();
      const panel = input.closest('.panel');
      if (panel) {
        panel.classList.remove('is-flash');
        void panel.offsetWidth; // restart the animation
        panel.classList.add('is-flash');
      }
    }

    function initDrawer() {
      sidebar = document.getElementById('sidebar');
      toggle = document.getElementById('nav-toggle');
      if (!sidebar || !toggle) return;
      mq = window.matchMedia('(min-width: 64em)');
      backdrop = el('div', { class: 'nav-backdrop', hidden: true });
      document.body.append(backdrop);

      toggle.addEventListener('click', () => (isOpen() ? close(true) : open()));
      backdrop.addEventListener('click', () => close(true));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen()) close(true);
      });
      sidebar.addEventListener('click', (e) => {
        if (e.target.closest('a[href^="#"]') && !isDesktop()) close(false);
      });
      const onChange = () => { if (isDesktop()) close(false); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    function initScrollspy() {
      const items = $$('#toc a[href^="#"]')
        .map((a) => ({ a, target: document.getElementById(decodeURIComponent(a.hash.slice(1))) }))
        .filter((item) => item.target);
      if (!items.length) return;
      const header = $('.site-header');
      let current = null;
      let ticking = false;

      function update() {
        ticking = false;
        const line = (header ? header.offsetHeight : 56) + window.innerHeight * 0.25;
        let active = null;
        for (const item of items) {
          if (item.target.getBoundingClientRect().top <= line) active = item;
          else break;
        }
        const doc = document.documentElement;
        if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) active = items[items.length - 1];
        const link = active ? active.a : null;
        if (link === current) return;
        if (current) current.removeAttribute('aria-current');
        if (link) link.setAttribute('aria-current', 'location');
        current = link;
      }

      const schedule = () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(update);
        }
      };
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule, { passive: true });
      update();
    }

    return {
      init() { initDrawer(); initScrollspy(); },
      open,
      close,
      reveal,
    };
  })();

  /* =========================================================================
   * Progress: "I've finished step N" checkboxes
   * ========================================================================= */
  function initProgress() {
    const boxes = $$('input[type="checkbox"][data-done]');
    if (!boxes.length) return;
    const bar = document.getElementById('progress-bar');
    const count = document.getElementById('progress-count');
    const reset = document.getElementById('progress-reset');
    const saved = store.get('progress', []);
    const done = new Set(Array.isArray(saved) ? saved : []);
    boxes.forEach((box) => { box.checked = done.has(box.dataset.done); });

    function update(save) {
      const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.done);
      if (save) store.set('progress', ids);
      const total = boxes.length;
      if (bar) {
        bar.max = total;
        bar.value = ids.length;
      }
      if (count) {
        count.textContent = ids.length === total ? 'All ' + total + ' done' : ids.length + ' of ' + total + ' done';
        count.parentElement.classList.toggle('is-complete', ids.length === total);
      }
      $$('#toc [data-done-for]').forEach((a) => {
        const on = ids.includes(a.dataset.doneFor);
        a.classList.toggle('is-done', on);
        let note = $('.toc__done', a);
        if (on && !note) a.append(span('visually-hidden toc__done', ' (done)'));
        else if (!on && note) note.remove();
      });
      boxes.forEach((b) => {
        const holder = b.closest('.step, .section');
        if (holder) holder.classList.toggle('is-done', b.checked);
      });
      return ids.length === total;
    }

    boxes.forEach((box) => box.addEventListener('change', () => {
      const all = update(true);
      if (box.checked && all) announce('All steps done. You are ready to use the AIT GPU Server!');
    }));
    if (reset) {
      reset.addEventListener('click', () => {
        boxes.forEach((b) => { b.checked = false; });
        update(true);
        announce('Progress reset.');
      });
    }
    update(false);
  }

  /* =========================================================================
   * srun flags: hovering a flag highlights its explanation (and vice versa)
   * ========================================================================= */
  function initFlags() {
    const scope = document.getElementById('method-1');
    if (!scope) return;
    const parts = $$('[data-flag]', scope);
    const highlight = (name, on) => parts.forEach((p) => { if (p.dataset.flag === name) p.classList.toggle('is-hl', on); });
    scope.addEventListener('pointerover', (e) => {
      const t = e.target.closest('[data-flag]');
      if (t) highlight(t.dataset.flag, true);
    });
    scope.addEventListener('pointerout', (e) => {
      const t = e.target.closest('[data-flag]');
      if (t && !(e.relatedTarget instanceof Node && t.contains(e.relatedTarget))) highlight(t.dataset.flag, false);
    });
  }

  /* =========================================================================
   * Jupyter port: derived from the username, or the reader's own choice
   * ========================================================================= */
  function initJupyter() {
    const input = document.getElementById('in-jport');
    if (!document.getElementById('jupyter') || !input) return;
    const hint = document.getElementById('jport-hint');
    const message = document.getElementById('jport-msg');
    const shuffle = document.getElementById('jport-new');
    let override = store.get('jport', null);
    if (!isPort(override)) override = null;

    const port = () => {
      if (override) return String(override);
      const user = Vars.get('username');
      return user ? String(portFor(user)) : '';
    };
    Vars.register('jport', port);

    function setMessage(text) {
      if (text) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      if (message) {
        message.textContent = text;
        message.hidden = !text;
      }
    }
    const showLater = debounce(setMessage, 500);

    function sync() {
      const value = port();
      if (document.activeElement !== input) input.value = value;
      input.placeholder = value ? '' : 'PORT';
      if (!hint) return;
      if (override) hint.textContent = 'Your own choice. Clear the box to go back to the suggested port.';
      else if (value) hint.textContent = 'Suggested from your username, so it is the same on every device. Use it wherever PORT appears below.';
      else hint.textContent = 'Enter your username under "Your details" for a suggested port, or pick one.';
    }

    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D+/g, '');
      if (digits !== input.value) input.value = digits;
      if (!digits) {
        override = null;
        store.remove('jport');
        showLater.cancel();
        setMessage('');
      } else if (isPort(Number(digits))) {
        override = Number(digits);
        store.set('jport', override);
        showLater.cancel();
        setMessage('');
      } else {
        showLater('Use a number from 1024 to 65535.');
        return;
      }
      Vars.apply(document);
      sync();
    });
    input.addEventListener('blur', () => {
      showLater.cancel();
      setMessage('');
      sync(); // an invalid entry snaps back to the port in use
    });
    if (shuffle) {
      shuffle.addEventListener('click', () => {
        override = randomPort(Number(port()) || 0);
        store.set('jport', override);
        setMessage('');
        Vars.apply(document);
        sync();
        announce('Your Jupyter port is now ' + override + '.');
      });
    }
    document.addEventListener('aihub:vars', sync);
    Vars.apply(document);
    sync();
  }

  /* =========================================================================
   * Job script builder
   * ========================================================================= */
  function renderCode(codeEl, text) {
    const frag = document.createDocumentFragment();
    text.replace(/\n$/, '').split('\n').forEach((line, i) => {
      if (i) frag.append('\n');
      const m = /^(#SBATCH)( +)(\S+)( *)(#.*)?$/.exec(line);
      if (m) {
        frag.append(span('tok-key', m[1]), m[2], span('tok-flag', m[3]), m[4] || '');
        if (m[5]) frag.append(span('tok-comment', m[5]));
      } else if (line.startsWith('#')) {
        frag.append(span('tok-comment', line));
      } else {
        line.split(/(\s--[A-Za-z][\w-]*=\S+)/).forEach((part, j) => {
          if (j % 2) frag.append(part[0], span('tok-flag', part.slice(1)));
          else if (part) frag.append(part);
        });
      }
    });
    codeEl.replaceChildren(frag);
  }

  function initBuilder() {
    const form = document.getElementById('builder-form');
    if (!form) return;
    const FIELDS = ['file', 'job', 'out', 'err', 'gpus', 'time', 'mem', 'module', 'env', 'cmd'];
    const inputs = {};
    FIELDS.forEach((k) => { inputs[k] = form.elements.namedItem(k); });
    if (FIELDS.some((k) => !inputs[k])) return;
    const scriptBlock = document.getElementById('b-script-block');
    const scriptCode = document.getElementById('b-script');
    const srunBlock = document.getElementById('b-srun-block');
    const srunCode = document.getElementById('b-srun');
    const status = document.getElementById('builder-status');
    const timeMeaning = document.getElementById('b-time-meaning');
    const reset = document.getElementById('b-reset');
    if (!scriptBlock || !scriptCode || !srunBlock || !srunCode) return;

    const saved = store.get('builder', null);
    if (saved && typeof saved === 'object') {
      FIELDS.forEach((k) => { if (typeof saved[k] === 'string') inputs[k].value = saved[k]; });
      if (inputs.gpus.value === '') inputs.gpus.value = String(BUILDER_DEFAULTS.gpus); // option no longer offered
    }

    let last = null;

    function readRaw() {
      const raw = {};
      FIELDS.forEach((k) => { raw[k] = inputs[k].value; });
      return raw;
    }

    function showMessages(result, onlyClear) {
      FIELDS.forEach((k) => {
        const input = inputs[k];
        const box = document.getElementById(input.id + '-msg');
        const error = result.errors[k];
        const text = error || result.warnings[k] || '';
        if (onlyClear && text) return; // keep the old message until the pause is over
        if (error) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
        if (box) {
          box.textContent = text;
          box.hidden = !text;
          box.classList.toggle('is-warning', !error && !!text);
        }
      });
      if (status && !onlyClear) status.textContent = result.ok ? '' : 'Fix the highlighted field to update the script.';
    }
    const showLater = debounce(() => { if (last) showMessages(last, false); }, 400);

    function render(typing) {
      const raw = readRaw();
      const result = validateBuilder(raw);
      last = result;
      if (timeMeaning) timeMeaning.textContent = describeTime(raw.time);

      if (typing) {
        showMessages(result, true); // clear fixed fields at once…
        showLater(); // …and show new problems after a short pause
      } else {
        showLater.cancel();
        showMessages(result, false);
      }

      if (result.ok) {
        const v = result.values;
        renderCode(scriptCode, buildScript(v));
        renderCode(srunCode, buildSrun(v));
        scriptBlock.dataset.title = v.file;
        scriptBlock.dataset.download = v.file;
        $$('[data-b="file"]').forEach((n) => { n.textContent = v.file; });
        const out = resolveOutput(v.out, { job: v.job, file: v.file, user: Vars.get('username') });
        $$('[data-b="out"]').forEach((n) => { n.textContent = out; });
        if (typing) store.set('builder', raw); // valid states only, so a reload never restores a broken form
      }
      [scriptBlock, srunBlock].forEach((block) => {
        block.classList.toggle('is-stale', !result.ok);
        $$('.code__btn', block).forEach((b) => { b.disabled = !result.ok; });
        Code.relabel(block);
      });
    }

    form.addEventListener('input', () => render(true));
    form.addEventListener('change', () => render(true));
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('focusout', () => {
      if (!last) return;
      showLater.cancel();
      showMessages(last, false);
    });
    if (reset) {
      reset.addEventListener('click', () => {
        form.reset(); // back to the values in the HTML
        store.remove('builder');
        render(false);
        announce('The builder is back to its defaults.');
      });
    }
    document.addEventListener('aihub:vars', () => render(false));
    render(false);
  }

  /* =========================================================================
   * Cheat sheet: built from every .code[data-cheat] block on the page
   * ========================================================================= */
  function buildCheatsheet() {
    const list = document.getElementById('cheat-list');
    if (!list) return;
    $$('.code[data-cheat]').forEach((block) => {
      if (block.closest('#cheatsheet')) return;
      const item = el('li', { class: 'cheat__item' });
      const meta = el('div', { class: 'cheat__meta' });
      meta.append(span('cheat__desc', block.dataset.cheat));
      const source = block.closest('[data-label]');
      if (source && source.id) {
        const link = el('a', { class: 'cheat__src', href: '#' + source.id });
        link.textContent = source.dataset.label;
        meta.append(link);
      }
      const clone = block.cloneNode(true);
      clone.removeAttribute('id');
      ['data-cheat', 'data-keywords', 'data-title', 'data-download', 'data-enhanced'].forEach((a) => clone.removeAttribute(a));
      $$('[id]', clone).forEach((n) => n.removeAttribute('id'));
      item.dataset.search = [block.dataset.cheat, block.dataset.keywords, block.textContent, source && source.dataset.label]
        .filter(Boolean).join(' ').toLowerCase();
      item.append(meta, clone);
      list.append(item);
    });
  }

  function initCheatsearch() {
    const input = document.getElementById('cheat-search');
    const list = document.getElementById('cheat-list');
    if (!input || !list) return;
    const count = document.getElementById('cheat-count');
    const empty = document.getElementById('cheat-empty');
    const items = Array.from(list.children);
    const total = items.length;
    const plural = (n) => n + (n === 1 ? ' command' : ' commands');

    const updateCount = debounce((shown, filtered) => {
      if (count) count.textContent = filtered ? shown + ' of ' + plural(total) + ' match' : plural(total);
    }, 250);

    function run() {
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      items.forEach((item) => {
        const match = words.every((w) => item.dataset.search.includes(w));
        item.hidden = !match;
        if (match) shown += 1;
      });
      if (empty) empty.hidden = shown > 0;
      updateCount(shown, words.length > 0);
    }

    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        input.value = '';
        run();
      }
    });
    // "/" jumps to the search box, unless you're typing somewhere.
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      e.preventDefault();
      Nav.close(false);
      input.focus();
      input.select();
    });
    run();
  }

  /* =========================================================================
   * Small extras
   * ========================================================================= */
  function initMisc() {
    // Hero "Personalize commands" button.
    $$('[data-action="personalize"]').forEach((btn) => {
      btn.addEventListener('click', () => Vars.focusInput('username'));
    });
    // Print every collapsed explanation.
    const opened = [];
    window.addEventListener('beforeprint', () => {
      $$('details:not([open])').forEach((d) => {
        d.open = true;
        opened.push(d);
      });
    });
    window.addEventListener('afterprint', () => {
      opened.splice(0).forEach((d) => { d.open = false; });
    });
  }

  /* =========================================================================
   * Boot. Each feature is isolated so one failure can't break the rest.
   * Order matters: the cheat sheet is cloned before copy buttons and
   * personalization are applied, so the copies get both.
   * ========================================================================= */
  function boot() {
    [
      ['theme', initTheme],
      ['cheatsheet', buildCheatsheet],
      ['code', () => Code.enhance(document)],
      ['vars', Vars.init],
      ['jupyter', initJupyter],
      ['tabs', initTabs],
      ['nav', Nav.init],
      ['progress', initProgress],
      ['flags', initFlags],
      ['builder', initBuilder],
      ['cheatsearch', initCheatsearch],
      ['misc', initMisc],
    ].forEach(([name, fn]) => {
      try {
        fn();
      } catch (err) {
        console.error('[aihub] ' + name + ' failed:', err);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
