import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createModelPlazaSettingsProvider,
  MODEL_PLAZA_ENV_VARS,
  MODEL_PLAZA_SETTINGS_DEFAULTS,
  MODEL_PLAZA_SETTINGS_KEYS,
  ModelPlazaSettingsError,
  parseModelPlazaSettingValue,
  resolveModelPlazaSettings,
} from '../../../src/saas/gateway/model-plaza/settings.js';

test('defaults are fail-closed: disabled, anonymous-allowed, no description, no exclusive groups', () => {
  const settings = resolveModelPlazaSettings({}, {});
  assert.equal(settings.enabled, false);
  assert.equal(settings.requireAuth, false);
  assert.equal(settings.description, '');
  assert.deepEqual([...settings.exclusiveGroupIds], []);
});

test('environment values apply when the store overlay is absent', () => {
  const settings = resolveModelPlazaSettings(undefined, {
    [MODEL_PLAZA_ENV_VARS.enabled]: 'true',
    [MODEL_PLAZA_ENV_VARS.requireAuth]: 'true',
    [MODEL_PLAZA_ENV_VARS.description]: '  Showcase  ',
    [MODEL_PLAZA_ENV_VARS.exclusiveGroups]: 'vip, enterprise ',
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.requireAuth, true);
  assert.equal(settings.description, 'Showcase');
  assert.deepEqual([...settings.exclusiveGroupIds].sort(), ['enterprise', 'vip']);
});

test('store overlay values win over the environment (store-first)', () => {
  const settings = resolveModelPlazaSettings(
    {
      [MODEL_PLAZA_SETTINGS_KEYS.enabled]: false,
      [MODEL_PLAZA_SETTINGS_KEYS.requireAuth]: true,
      [MODEL_PLAZA_SETTINGS_KEYS.description]: 'store',
      [MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups]: ['vip'],
    },
    {
      [MODEL_PLAZA_ENV_VARS.enabled]: 'true',
      [MODEL_PLAZA_ENV_VARS.requireAuth]: 'false',
      [MODEL_PLAZA_ENV_VARS.description]: 'env',
      [MODEL_PLAZA_ENV_VARS.exclusiveGroups]: 'enterprise',
    },
  );
  assert.equal(settings.enabled, false);
  assert.equal(settings.requireAuth, true);
  assert.equal(settings.description, 'store');
  assert.deepEqual([...settings.exclusiveGroupIds], ['vip']);
});

test('invalid overlay values fail closed instead of widening visibility', () => {
  assert.throws(
    () => resolveModelPlazaSettings({ [MODEL_PLAZA_SETTINGS_KEYS.enabled]: 'yes' }, {}),
    ModelPlazaSettingsError,
  );
  assert.throws(
    () => resolveModelPlazaSettings({ [MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups]: ['not a valid id!'] }, {}),
    ModelPlazaSettingsError,
  );
  assert.throws(
    () => resolveModelPlazaSettings({ [MODEL_PLAZA_SETTINGS_KEYS.description]: 'x'.repeat(513) }, {}),
    ModelPlazaSettingsError,
  );
  assert.throws(() => resolveModelPlazaSettings({}, { [MODEL_PLAZA_ENV_VARS.enabled]: '1' }), ModelPlazaSettingsError);
});

test('the settings provider degrades to defaults when resolution throws', async () => {
  const provider = createModelPlazaSettingsProvider({
    overlay: () => {
      throw new Error('store unreadable');
    },
  });
  const settings = await provider();
  assert.deepEqual(settings, MODEL_PLAZA_SETTINGS_DEFAULTS);
});

test('the registry grammar accepts only typed store values', () => {
  assert.equal(parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.enabled, true), true);
  assert.equal(parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.requireAuth, false), false);
  assert.deepEqual(parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups, ['a', 'b']), ['a', 'b']);
  assert.equal(parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.description, ' Plaza '), 'Plaza');
  assert.throws(() => parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.enabled, 'true'), ModelPlazaSettingsError);
  assert.throws(() => parseModelPlazaSettingValue('saas.plaza.unknown', true), ModelPlazaSettingsError);
  assert.throws(
    () => parseModelPlazaSettingValue(MODEL_PLAZA_SETTINGS_KEYS.exclusiveGroups, ['a', 'a']),
    ModelPlazaSettingsError,
  );
});
