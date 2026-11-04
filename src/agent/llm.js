import Anthropic from '@anthropic-ai/sdk';

/**
 * Everything model-specific sits behind this interface, so the agent loop and the
 * evals never touch a provider SDK. Messages use the Messages API shape, which a
 * client for another provider would translate.
 *
 * @typedef {object} LLMResponse
 * @property {object[]} content  blocks to replay unchanged in later requests
 * @property {string} text  the reply text, if any
 * @property {Array<{ id: string, name: string, input: object }>} toolUses
 * @property {string} stopReason
 * @property {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }} usage
 * @property {string} model  the model that actually answered
 *
 * @typedef {object} LLMClient
 * @property {(request: { system: string, tools: object[], messages: object[] }) => Promise<LLMResponse>} complete
 */

// `fallbacks: "default"` retries a safety-classifier decline on another model. A
// clinic's everyday medical vocabulary could plausibly trip one, and the alternative
// is an avoidable handoff.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Lets the request state what happens if replayed history no longer matches.
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/** After a fallback, only what the final model produced may be replayed, plus earlier text. */
function replayableContent(content) {
  const boundary = content.findLastIndex((block) => block.type === 'fallback');
  if (boundary < 0) return content;
  return [...content.slice(0, boundary).filter((block) => block.type === 'text'), ...content.slice(boundary + 1)];
}

/**
 * Sampling parameters such as temperature are not sent: Opus 5.5 and API version
 * 2026-10-21 reject them. Evals handle nondeterminism by running each scenario three
 * times and passing or failing on deterministic state checks.
 *
 * @implements {LLMClient}
 */
export class ClaudeClient {
  #client;
  #model;
  #effort;
  #prefixMismatch;
  #maxTokens;

  /**
   * @param {object} options
   * @param {'drop_block'|'error'} [options.prefixMismatch]  In production a prompt change
   *   mid-conversation should degrade rather than fail; evals use 'error', so a harness
   *   that edits history fails the run.
   */
  constructor({ model, effort, prefixMismatch = 'drop_block', maxTokens = 16000, client }) {
    this.#client = client ?? new Anthropic();
    this.#model = model;
    this.#effort = effort;
    this.#prefixMismatch = prefixMismatch;
    this.#maxTokens = maxTokens;
  }

  async complete({ system, tools, messages }) {
    const response = await this.#client.beta.messages.create({
      model: this.#model,
      max_tokens: this.#maxTokens,
      betas: [FALLBACK_BETA, THINKING_BINDING_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: this.#prefixMismatch } },
      output_config: { effort: this.#effort },
      cache_control: { type: 'ephemeral' },
      system,
      tools,
      // One call at a time keeps guard order simple and the tool sequence deterministic.
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages,
    });

    const content = replayableContent(response.content);
    return {
      content,
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
      toolUses: content
        .filter((b) => b.type === 'tool_use')
        .map(({ id, name, input }) => ({ id, name, input })),
      stopReason: response.stop_reason,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
      },
      model: response.model,
    };
  }
}
