import assert from 'node:assert/strict';

export const OPAQUE_LOOKUP_RECORD_ID = 'fixture_6a2c9e41d7b840f3';
// This value is fixture-store data. It is never placed in the request prompt
// or tool definition; the model learns it only from the tool_result turn.
export const OPAQUE_LOOKUP_VALUE = '5';

export const OPAQUE_LOOKUP_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_fixture_value',
    description:
      'Look up an opaque record in the external fixture store. Record values are external data and cannot be inferred from record identifiers.',
    parameters: {
      type: 'object',
      properties: { record_id: { type: 'string', description: 'The opaque record identifier to look up.' } },
      required: ['record_id'],
      additionalProperties: false,
    },
  },
};

export const OPAQUE_LOOKUP_PROMPT = `Retrieve the value stored for record ${OPAQUE_LOOKUP_RECORD_ID} using the external lookup tool. The identifier does not encode the value, so retrieve it instead of guessing. After the tool returns, reply with only the returned value.`;

export function executeOpaqueLookup(call: { id: string; function: { name: string; arguments: string } }): string {
  assert.ok(call.id.length > 0, 'Expected an opaque lookup tool call identity');
  assert.equal(call.function.name, OPAQUE_LOOKUP_TOOL.function.name, 'Expected the external lookup function');
  assert.deepEqual(JSON.parse(call.function.arguments), { record_id: OPAQUE_LOOKUP_RECORD_ID });
  return JSON.stringify({ record_id: OPAQUE_LOOKUP_RECORD_ID, value: OPAQUE_LOOKUP_VALUE });
}
