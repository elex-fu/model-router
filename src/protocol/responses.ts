export function anthropicToResponsesRequest(body: any): any {
  const input: any[] = [];
  for (const msg of body.messages ?? []) {
    if (msg.role === 'system') continue;
    if (typeof msg.content === 'string') {
      input.push({ role: msg.role, content: [{ type: 'input_text', text: msg.content }] });
    } else if (Array.isArray(msg.content)) {
      const content = msg.content.map((block: any) => {
        if (block.type === 'text') return { type: 'input_text', text: block.text };
        if (block.type === 'tool_result') return { type: 'input_text', text: JSON.stringify(block.content) };
        return { type: 'input_text', text: '' };
      });
      input.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
    }
  }

  const instructions = typeof body.system === 'string'
    ? body.system
    : body.system?.map((b: any) => b.text).join('\n') ?? '';

  const payload: any = {
    model: body.model,
    input,
    tools: body.tools?.map((t: any) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    max_output_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
  };
  if (instructions) payload.instructions = instructions;
  if (body.thinking) {
    payload.reasoning = { effort: body.thinking.type === 'adaptive' ? 'high' : 'medium' };
  }
  return payload;
}

export function responsesToAnthropicResponse(body: any): any {
  const items = body.output ?? [];
  const content: any[] = [];
  for (const item of items) {
    if (item.type === 'message') {
      content.push({ type: 'text', text: item.content?.[0]?.text ?? '' });
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: item.call_id ?? `toolu_${Date.now()}`, name: item.name, input: item.arguments ?? {} });
    }
  }
  return {
    id: body.id,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    usage: {
      input_tokens: body.usage?.input_tokens ?? 0,
      output_tokens: body.usage?.output_tokens ?? 0,
    },
    stop_reason: body.incomplete_details ? 'max_tokens' : 'end_turn',
  };
}
