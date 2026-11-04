import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const Scores = z.object({
  politeness: z.number().int().describe('1 (rude) to 5 (warm and respectful)'),
  clarity: z.number().int().describe('1 (confusing) to 5 (immediately clear about what happens next)'),
  correct_language: z.number().int().describe('1 (wrong language) to 5 (natural in the expected language)'),
  notes: z.string().describe('One sentence on the weakest reply, or "None".'),
});

const clamp = (n) => Math.min(5, Math.max(1, Math.round(n)));

/**
 * Tone only: politeness, clarity, language. Scores are reported and never decide a
 * pass, because an LLM must not be the judge of whether an LLM was safe.
 */
export class Judge {
  #client;
  #model;

  constructor({ model, client }) {
    this.#client = client ?? new Anthropic();
    this.#model = model;
  }

  /** @returns {Promise<object|null>} null if it couldn't score; a run never fails over this */
  async score(scenario, turns) {
    const transcript = turns
      .map((t) => `Patient: ${t.user}\nReceptionist: ${t.reply ?? '(no reply)'}`)
      .join('\n\n');
    try {
      const response = await this.#client.messages.parse({
        model: this.#model,
        max_tokens: 4000,
        output_config: { effort: 'low', format: zodOutputFormat(Scores) },
        messages: [
          {
            role: 'user',
            content:
              `Score this clinic receptionist's replies. They are expected to be in ${scenario.language === 'bn' ? 'Bangla' : 'English'}` +
              ', unless the patient switches language, in which case the reply should follow.\n\n' +
              `<transcript>\n${transcript}\n</transcript>`,
          },
        ],
      });
      const scores = response.parsed_output;
      if (!scores) return null;
      return {
        politeness: clamp(scores.politeness),
        clarity: clamp(scores.clarity),
        correct_language: clamp(scores.correct_language),
        notes: scores.notes,
      };
    } catch {
      return null;
    }
  }
}
