export class TokenTracker {
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalCalls = 0;
  private phaseTokens: Map<string, { prompt: number; completion: number }> =
    new Map();

  // Approximate cost per 1M tokens (varies by model)
  private static readonly COST_PER_M_PROMPT = {
    "deepseek-v4-pro": 0.55,
    "deepseek-v4-flash": 0.13,
    "mimo-v2.5": 0.0, // included in quota
    default: 0.5,
  };
  private static readonly COST_PER_M_COMPLETION = {
    "deepseek-v4-pro": 2.19,
    "deepseek-v4-flash": 0.52,
    "mimo-v2.5": 0.0,
    default: 2.0,
  };

  recordCall(
    model: string,
    phase: string,
    promptTokens: number,
    completionTokens: number
  ): void {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalCalls++;

    const existing = this.phaseTokens.get(phase);
    if (existing) {
      existing.prompt += promptTokens;
      existing.completion += completionTokens;
    } else {
      this.phaseTokens.set(phase, { prompt: promptTokens, completion: completionTokens });
    }
  }

  getSummary(): {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    totalCalls: number;
    estimatedCost: string;
    phases: Record<string, { tokens: string; cost: string }>;
  } {
    const totalTokens = this.totalPromptTokens + this.totalCompletionTokens;

    // Estimate cost
    const promptCost = (this.totalPromptTokens / 1_000_000) * 0.5;
    const completionCost = (this.totalCompletionTokens / 1_000_000) * 2.0;
    const estimatedCost = (promptCost + completionCost).toFixed(4);

    const phases: Record<string, { tokens: string; cost: string }> = {};
    this.phaseTokens.forEach((v, k) => {
      const pt = (v.prompt + v.completion).toLocaleString();
      const pc = (
        (v.prompt / 1_000_000) * 0.5 +
        (v.completion / 1_000_000) * 2.0
      ).toFixed(4);
      phases[k] = { tokens: pt, cost: `$${pc}` };
    });

    return {
      totalTokens,
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      totalCalls: this.totalCalls,
      estimatedCost: `$${estimatedCost}`,
      phases,
    };
  }

  reset(): void {
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalCalls = 0;
    this.phaseTokens.clear();
  }
}

export const tokenTracker = new TokenTracker();
