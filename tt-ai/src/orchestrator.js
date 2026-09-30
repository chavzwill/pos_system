import { classifyAnswer, FACT_KIND, requireEmployeeContext } from "./core/policy.js";

export class TTAIOrchestrator {
  constructor({ tools }) {
    if (!tools) throw new Error("TOOL_REGISTRY_REQUIRED");
    this.tools = tools;
  }

  async askReadOnly({ context, plan }) {
    requireEmployeeContext(context);
    if (!Array.isArray(plan) || plan.length === 0) {
      return {
        kind: FACT_KIND.UNKNOWN,
        answer: null,
        reason: "NO_EVIDENCE_PLAN",
        evidence: [],
      };
    }

    const evidence = [];
    for (const step of plan) {
      if (!step?.tool) throw new Error("PLAN_TOOL_REQUIRED");
      const data = await this.tools.execute(step.tool, step.input || {}, context);
      evidence.push({
        tool: step.tool,
        source: step.source,
        data,
        observedAt: new Date().toISOString(),
      });
    }

    return {
      kind: classifyAnswer({ evidence }),
      answer: null,
      reason: "MODEL_SYNTHESIS_NOT_CONFIGURED",
      evidence,
    };
  }
}
