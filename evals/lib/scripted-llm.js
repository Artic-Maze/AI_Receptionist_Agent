/**
 * Replays a fixed script instead of calling a model. It answers one question: given
 * this model behaviour, good or bad, does the code do the right thing? A script can
 * misbehave on purpose in ways a real model rarely does on demand, which is how the
 * guards get exercised. It says nothing about how well a real model behaves.
 *
 * Steps:
 *   { call: 'find_patient', input: {...} }   a tool call
 *   { say: 'text' }                          a reply
 *   { stop: 'refusal' | 'max_tokens' }       an abnormal stop
 *   { throw: 'message' }                     an API failure
 *
 * @implements {import('../../src/agent/llm.js').LLMClient}
 */
export class ScriptedLLM {
  #queue = [];
  #calls = 0;
  requests = [];

  /** Adds the steps for the next turn. */
  load(steps = []) {
    this.#queue.push(...steps);
  }

  get remaining() {
    return this.#queue.length;
  }

  async complete(request) {
    this.requests.push(structuredClone(request.messages));
    const step = this.#queue.shift();
    const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const base = { usage: empty, model: 'scripted' };
    if (!step) throw new ScriptExhaustedError();
    if (step.throw) throw new Error(step.throw);
    if (step.stop) return { ...base, content: [], text: '', toolUses: [], stopReason: step.stop };
    if (step.call) {
      this.#calls += 1;
      const id = `toolu_scripted_${this.#calls}`;
      return {
        ...base,
        content: [{ type: 'tool_use', id, name: step.call, input: step.input ?? {} }],
        text: '',
        toolUses: [{ id, name: step.call, input: step.input ?? {} }],
        stopReason: 'tool_use',
      };
    }
    const text = step.say ?? '';
    return {
      ...base,
      content: text ? [{ type: 'text', text }] : [],
      text,
      toolUses: [],
      stopReason: 'end_turn',
    };
  }
}

/** The agent asked for more than the script provided: the flow was not what was authored. */
export class ScriptExhaustedError extends Error {
  constructor() {
    super('The script ran out of steps');
    this.name = 'ScriptExhaustedError';
  }
}
