import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBuiltinPlatformInferenceAccessAdmissionReadiness} from '../../../src/saas/supply/platform-inference-access-admission-readiness.js';

const scope={providerId:'openai-codex',productId:'codex-chatgpt',publicModelId:'published-codex',publicModelVersion:'1',resolvedModel:'gpt-5-codex',providerProtocol:'responses' as const,endpoint:'/v1/responses',workflow:'responses-http-full' as const};
test('Codex HTTP/full stays blocked while the reviewed registry is empty',()=>{
  assert.deepEqual(createBuiltinPlatformInferenceAccessAdmissionReadiness().check(scope),{status:'blocked',code:'TRUSTED_USAGE_BOUNDS_UNAVAILABLE'});
});
test('Codex unsupported workflows/protocol paths are not sold by a generic ready flag',()=>{
  assert.deepEqual(createBuiltinPlatformInferenceAccessAdmissionReadiness().check({...scope,providerProtocol:'openai'}),{status:'blocked',code:'WORKFLOW_UNSUPPORTED'});
  assert.deepEqual(createBuiltinPlatformInferenceAccessAdmissionReadiness().check({...scope,endpoint:'/v1/responses/compact'}),{status:'blocked',code:'WORKFLOW_UNSUPPORTED'});
});
test('non-Codex static admission retains its existing supported path',()=>{
  assert.deepEqual(createBuiltinPlatformInferenceAccessAdmissionReadiness().check({...scope,providerId:'kimi',productId:'kimi-code',providerProtocol:'openai',endpoint:'/v1/chat/completions'}),{status:'ready'});
});
