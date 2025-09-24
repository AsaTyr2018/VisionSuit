import { strict as assert } from 'node:assert';
import test from 'node:test';

import { derivePrimaryLoraContext, mergeLoraExtras } from '../src/lib/generator/loraContext';

test('derivePrimaryLoraContext surfaces filename and strengths for the first LoRA selection', () => {
  const selections = [{ strength: 0.85 }];
  const payloads = [{ filename: 'models/loras/hero-lora.safetensors', key: 'loras/hero-lora.safetensors' }];

  const context = derivePrimaryLoraContext(selections, payloads);

  assert.deepEqual(context, {
    primary_lora_name: 'hero-lora.safetensors',
    primary_lora_strength_model: 0.85,
    primary_lora_strength_clip: 0.85,
  });
});

test('derivePrimaryLoraContext falls back to object key when filename is missing', () => {
  const selections = [{ strength: 1.2 }];
  const payloads = [{ key: 'loras/custom/subdir/my-lora.safetensors' }];

  const context = derivePrimaryLoraContext(selections, payloads);

  assert.deepEqual(context, {
    primary_lora_name: 'my-lora.safetensors',
    primary_lora_strength_model: 1.2,
    primary_lora_strength_clip: 1.2,
  });
});

test('derivePrimaryLoraContext returns an empty object when no payloads are provided', () => {
  const context = derivePrimaryLoraContext([{ strength: 0.5 }], []);
  assert.deepEqual(context, {});
});

test('mergeLoraExtras retains the payload list alongside derived context', () => {
  const selections = [{ strength: 0.6 }];
  const payloads = [{ filename: 'loras/paired.safetensors', key: 'loras/paired.safetensors' }];

  const context = mergeLoraExtras(selections, payloads);

  assert.deepEqual(context, {
    loras: payloads,
    primary_lora_name: 'paired.safetensors',
    primary_lora_strength_model: 0.6,
    primary_lora_strength_clip: 0.6,
  });
});
