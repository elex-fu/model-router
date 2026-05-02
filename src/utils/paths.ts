import path from 'node:path';
import os from 'node:os';

export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.model-router');
export const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'config.json');
export const DEFAULT_DB_PATH = path.join(DEFAULT_CONFIG_DIR, 'logs.sqlite');
