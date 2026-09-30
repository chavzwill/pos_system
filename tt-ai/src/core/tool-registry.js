import { assertReadPermission } from "./policy.js";

export class ToolRegistry {
  #tools = new Map();

  register(definition) {
    if (!definition?.name) throw new Error("TOOL_NAME_REQUIRED");
    if (this.#tools.has(definition.name)) throw new Error("TOOL_ALREADY_REGISTERED");
    if (definition.mode !== "read") throw new Error("TT_AI_V0_READ_ONLY");
    if (typeof definition.execute !== "function") throw new Error("TOOL_EXECUTE_REQUIRED");
    this.#tools.set(definition.name, Object.freeze({ ...definition }));
  }

  manifest() {
    return [...this.#tools.values()].map(({ name, description, permission, mode, source }) => ({
      name,
      description,
      permission,
      mode,
      source,
    }));
  }

  async execute(name, input, context) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error("TOOL_NOT_FOUND");
    assertReadPermission(context, tool.permission);
    return tool.execute(input, context);
  }
}
