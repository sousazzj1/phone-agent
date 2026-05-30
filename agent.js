import WebSocket from 'ws';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(__dirname, 'projects');
const PANEL_URL = process.env.PANEL_URL || 'ws://localhost:3000';

if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

let ws = null;
let reconnectTimer = null;
let metricsInterval = null;
let logSubscriptions = new Map();
let pm2Processes = new Map();

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { timeout: 60000, encoding: 'utf-8', ...opts }).trim();
  } catch (e) {
    return e.stdout?.trim() || '';
  }
}

function getPM2List() {
  const out = run('pm2 jlist 2>/dev/null || echo []');
  try { return JSON.parse(out); } catch { return []; }
}

function ensurePM2() {
  try { execSync('pm2 --version', { stdio: 'ignore' }); } catch {
    log('Installing PM2...');
    run('npm install -g pm2');
  }
}

function getMetrics() {
  const cpus = os.cpus();
  const cpuLoad = cpus.reduce((s, c) => {
    const total = Object.values(c.times).reduce((a, b) => a + b, 0);
    const idle = c.times.idle;
    return s + (1 - idle / total) * 100;
  }, 0) / cpus.length;

  const ram = {
    total: os.totalmem() / 1024 ** 3,
    used: (os.totalmem() - os.freemem()) / 1024 ** 3,
    free: os.freemem() / 1024 ** 3,
  };

  let disk = { total: 0, used: 0, free: 0 };
  try {
    const df = run("df -k / | tail -1");
    const parts = df.split(/\s+/).filter(Boolean);
    if (parts.length >= 4) {
      const total = parseInt(parts[1]) * 1024;
      const used = parseInt(parts[2]) * 1024;
      const free = parseInt(parts[3]) * 1024;
      disk = {
        total: total / 1024 ** 3,
        used: used / 1024 ** 3,
        free: free / 1024 ** 3,
      };
    }
  } catch {}

  return { cpu: cpuLoad, ram, disk, uptime: os.uptime() };
}

function getProjectMetrics(name) {
  try {
    const out = run(`ps -p $(pm2 pid ${name} 2>/dev/null) -o %cpu,rss --no-headers 2>/dev/null`);
    if (!out) return { cpu: 0, memory: 0 };
    const [cpu, rss] = out.trim().split(/\s+/).map(Number);
    return { cpu: cpu || 0, memory: (rss || 0) / 1024 };
  } catch {
    return { cpu: 0, memory: 0 };
  }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function getProjectsDir(projectId) {
  const dir = path.join(PROJECTS_DIR, projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listFilesRecursive(dir, basePath = '') {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(basePath, entry.name);
      if (entry.isDirectory()) {
        results.push({ name: entry.name, path: relPath, isDirectory: true });
        results.push(...listFilesRecursive(fullPath, relPath));
      } else {
        results.push({ name: entry.name, path: relPath, isDirectory: false, size: fs.statSync(fullPath).size });
      }
    }
  } catch {}
  return results;
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', _id: msg._id });
      break;

    case 'get_metrics': {
      const m = getMetrics();
      send({ type: 'metrics', data: m, _id: msg._id });
      break;
    }

    case 'list_projects': {
      const pm2List = getPM2List();
      const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
        const p = path.join(PROJECTS_DIR, d);
        return fs.statSync(p).isDirectory();
      });
      const data = dirs.map(id => {
        const p = pm2List.find(proc => proc.name === id);
        return {
          id,
          name: id,
          status: p ? p.pm2_env?.status || 'stopped' : 'stopped',
          port: p?.pm2_env?.port || null,
        };
      });
      send({ type: 'projects', data, _id: msg._id });
      break;
    }

    case 'deploy': {
      const { projectId, name, filePath, originalName } = msg;
      const projectDir = getProjectsDir(projectId);
      try {
        if (filePath && originalName?.endsWith('.zip')) {
          const tmpDir = path.join(PROJECTS_DIR, `_tmp_${projectId}`);
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
          fs.mkdirSync(tmpDir, { recursive: true });

          run(`unzip -o "${filePath}" -d "${tmpDir}"`);

          const items = fs.readdirSync(tmpDir);
          if (items.length === 1 && fs.statSync(path.join(tmpDir, items[0])).isDirectory()) {
            const inner = path.join(tmpDir, items[0]);
            const innerItems = fs.readdirSync(inner);
            for (const item of innerItems) {
              fs.cpSync(path.join(inner, item), path.join(projectDir, item), { recursive: true });
            }
          } else {
            for (const item of items) {
              fs.cpSync(path.join(tmpDir, item), path.join(projectDir, item), { recursive: true });
            }
          }
          fs.rmSync(tmpDir, { recursive: true });
          try { fs.unlinkSync(filePath); } catch {}
        }

        if (fs.existsSync(path.join(projectDir, 'package.json'))) {
          run('npm install', { cwd: projectDir });
        }

        send({ type: 'deploy_result', projectId, success: true, message: 'Deployed', _id: msg._id });
      } catch (e) {
        send({ type: 'deploy_result', projectId, success: false, message: e.message, _id: msg._id });
      }
      break;
    }

    case 'start': {
      const { projectId } = msg;
      const projectDir = getProjectsDir(projectId);
      const pkg = path.join(projectDir, 'package.json');
      let entry = 'index.js';
      if (fs.existsSync(pkg)) {
        try {
          const p = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
          entry = p.main || entry;
        } catch {}
      }

      const existing = getPM2List().find(p => p.name === projectId);
      if (existing) {
        run(`pm2 delete ${projectId}`);
      }

      const port = 5000 + Math.floor(Math.random() * 900);
      const cmd = run(`pm2 start "${path.join(projectDir, entry)}" --name "${projectId}" -- --port ${port}`, { cwd: projectDir });
      const success = !cmd.includes('error');

      send({ type: 'action_result', projectId, action: 'start', success, port, _id: msg._id });
      break;
    }

    case 'stop': {
      const { projectId } = msg;
      run(`pm2 stop ${projectId}`);
      send({ type: 'action_result', projectId, action: 'stop', success: true, _id: msg._id });
      break;
    }

    case 'restart': {
      const { projectId } = msg;
      run(`pm2 restart ${projectId}`);
      send({ type: 'action_result', projectId, action: 'restart', success: true, _id: msg._id });
      break;
    }

    case 'delete_project': {
      const { projectId } = msg;
      run(`pm2 delete ${projectId} 2>/dev/null`);
      const dir = path.join(PROJECTS_DIR, projectId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      send({ type: 'action_result', projectId, action: 'delete', success: true, _id: msg._id });
      break;
    }

    case 'list_files': {
      const projectDir = getProjectsDir(msg.projectId);
      const files = listFilesRecursive(projectDir);
      send({ type: 'files', projectId: msg.projectId, data: files, _id: msg._id });
      break;
    }

    case 'read_file': {
      const projectDir = getProjectsDir(msg.projectId);
      const fp = path.join(projectDir, msg.path);
      try {
        const data = fs.readFileSync(fp, 'utf-8');
        send({ type: 'file_content', projectId: msg.projectId, path: msg.path, data, _id: msg._id });
      } catch (e) {
        send({ type: 'file_content', projectId: msg.projectId, path: msg.path, data: '', error: e.message, _id: msg._id });
      }
      break;
    }

    case 'write_file': {
      const projectDir = getProjectsDir(msg.projectId);
      const fp = path.join(projectDir, msg.path);
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, msg.content, 'utf-8');
        send({ type: 'action_result', projectId: msg.projectId, action: 'write', success: true, _id: msg._id });
      } catch (e) {
        send({ type: 'action_result', projectId: msg.projectId, action: 'write', success: false, error: e.message, _id: msg._id });
      }
      break;
    }

    case 'delete_file': {
      const projectDir = getProjectsDir(msg.projectId);
      const fp = path.join(projectDir, msg.path);
      try {
        if (fs.statSync(fp).isDirectory()) fs.rmSync(fp, { recursive: true });
        else fs.unlinkSync(fp);
        send({ type: 'action_result', projectId: msg.projectId, action: 'delete_file', success: true, _id: msg._id });
      } catch (e) {
        send({ type: 'action_result', projectId: msg.projectId, action: 'delete_file', success: false, error: e.message, _id: msg._id });
      }
      break;
    }

    case 'subscribe_logs': {
      logSubscriptions.set(msg.subId, msg.projectId);
      break;
    }

    case 'unsubscribe_logs': {
      logSubscriptions.delete(msg.subId);
      break;
    }
  }
}

function streamLogs() {
  if (logSubscriptions.size === 0) return;
  const seen = new Set();

  for (const [subId, projectId] of logSubscriptions) {
    try {
      const out = run(`pm2 logs "${projectId}" --nostream --lines 5 2>/dev/null || echo ""`);
      const lines = out.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const key = `${projectId}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        send({ type: 'log', projectId, data: line, subId });
      }
    } catch {}
  }
}

function connect() {
  if (ws) ws.terminate();

  log(`Connecting to ${PANEL_URL}...`);
  ws = new WebSocket(PANEL_URL);

  ws.on('open', () => {
    log('Connected to panel');
    clearInterval(metricsInterval);
    metricsInterval = setInterval(() => {
      const m = getMetrics();
      send({ type: 'metrics', data: m });
      streamLogs();
    }, 3000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(msg);
    } catch (e) {
      log('Invalid message: ' + e.message);
    }
  });

  ws.on('close', () => {
    log('Disconnected');
    clearInterval(metricsInterval);
    scheduleReconnect();
  });

  ws.on('error', (e) => {
    log('WS error: ' + e.message);
    ws.terminate();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

ensurePM2();
log('Agent starting...');
connect();

process.on('SIGINT', () => { clearInterval(metricsInterval); process.exit(); });
process.on('SIGTERM', () => { clearInterval(metricsInterval); process.exit(); });
