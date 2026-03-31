#!/usr/bin/env node
/**
 * OpenClaw Config Fixer
 * Automatically fixes known config issues before gateway starts
 * Usage: node config-fixer.mjs [--restore] [--check]
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILE = '/root/.openclaw/openclaw.json';
const BACKUP_DIR = '/root/.openclaw/config-backups';

// Known deprecated/invalid properties that should be removed
// Format: 'path.to.property' - supports nested properties using dot notation
const DEPRECATED_PROPS = [
  'channels.feishu.accounts.default.botName',
  // Add more deprecated properties here as needed
];

const args = process.argv.slice(2);
const shouldRestore = args.includes('--restore');
const shouldCheckOnly = args.includes('--check');

function log(msg) {
  console.log(`[config-fixer] ${msg}`);
}

function ensureBackupDir() {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function getLatestBackup() {
  ensureBackupDir();
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('openclaw.json.backup-'))
    .map(f => ({
      name: f,
      path: join(BACKUP_DIR, f),
      mtime: statSync(join(BACKUP_DIR, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0] : null;
}

function createBackup() {
  ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${BACKUP_DIR}/openclaw.json.backup-${timestamp}`;
  copyFileSync(CONFIG_FILE, backupPath);
  log(`Created backup: ${backupPath}`);
  return backupPath;
}

function restoreFromBackup() {
  const latest = getLatestBackup();
  if (!latest) {
    log('ERROR: No backup found to restore');
    return false;
  }
  try {
    copyFileSync(latest.path, CONFIG_FILE);
    log(`Restored from backup: ${latest.name}`);
    return true;
  } catch (err) {
    log(`ERROR: Failed to restore: ${err.message}`);
    return false;
  }
}

function getNestedProperty(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts.slice(0, -1)) {
    if (current[part] === undefined) return undefined;
    current = current[part];
  }
  const lastKey = parts[parts.length - 1];
  return { parent: current, key: lastKey, value: current?.[lastKey] };
}

function removeProperty(obj, path) {
  const result = getNestedProperty(obj, path);
  if (result && result.parent && result.key in result.parent) {
    delete result.parent[result.key];
    return true;
  }
  return false;
}

function hasProperty(obj, path) {
  const result = getNestedProperty(obj, path);
  return result && result.value !== undefined;
}

function fixConfig() {
  log('Checking config...');

  if (!existsSync(CONFIG_FILE)) {
    log('Config file not found, skipping fix');
    return true;
  }

  let config;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    config = JSON.parse(raw);
  } catch (err) {
    log(`ERROR: Failed to parse config: ${err.message}`);
    // Try to restore from backup if config is corrupted
    log('Attempting to restore from backup...');
    return restoreFromBackup();
  }

  const fixes = [];

  // Check for deprecated properties
  for (const prop of DEPRECATED_PROPS) {
    if (hasProperty(config, prop)) {
      if (removeProperty(config, prop)) {
        fixes.push(prop);
      }
    }
  }

  if (shouldCheckOnly) {
    if (fixes.length > 0) {
      log(`Found ${fixes.length} issue(s):`);
      fixes.forEach(f => log(`  - ${f}`));
      return false;
    }
    log('No config issues found');
    return true;
  }

  if (fixes.length === 0) {
    log('No config issues found');
    return true;
  }

  log(`Found ${fixes.length} issue(s) to fix:`);
  fixes.forEach(f => log(`  - Removed: ${f}`));

  // Create backup before modifying
  createBackup();

  // Write fixed config
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
    log('Config fixed successfully');
    return true;
  } catch (err) {
    log(`ERROR: Failed to write config: ${err.message}`);
    return false;
  }
}

// Main
if (shouldRestore) {
  const success = restoreFromBackup();
  process.exit(success ? 0 : 1);
} else {
  const success = fixConfig();
  process.exit(success ? 0 : 1);
}
