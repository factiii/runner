import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ollamaTakesTools, parameterBillions } from './askEngines';

// A model that lists "tools" but is too small to use them answers without
// them: Llama 3.2 1B wrote the tool definitions back as its answer.

const show = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test('parameterBillions reads Ollama sizes', () => {
  assert.equal(parameterBillions('1.2B'), 1.2);
  assert.ok(Math.abs(parameterBillions('494.03M')! - 0.49403) < 1e-9);
  assert.equal(parameterBillions('70.6B'), 70.6);
  assert.equal(parameterBillions(undefined), null);
  assert.equal(parameterBillions('big'), null);
});

test('a small model that lists tools gets none', async () => {
  const fetchImpl = show({ capabilities: ['completion', 'tools'], details: { parameter_size: '1.2B' } });
  assert.equal(await ollamaTakesTools('http://x', 'llama3.2:1b', fetchImpl), false);
});

test('a big enough model that lists tools gets them', async () => {
  const fetchImpl = show({ capabilities: ['completion', 'tools'], details: { parameter_size: '14.8B' } });
  assert.equal(await ollamaTakesTools('http://x', 'qwen2.5:14b', fetchImpl), true);
});

test('no stated size leaves it to the capability', async () => {
  const fetchImpl = show({ capabilities: ['tools'] });
  assert.equal(await ollamaTakesTools('http://x', 'm', fetchImpl), true);
});

test('no tools capability is no, whatever the size', async () => {
  const fetchImpl = show({ capabilities: ['completion'], details: { parameter_size: '70B' } });
  assert.equal(await ollamaTakesTools('http://x', 'm', fetchImpl), false);
});
