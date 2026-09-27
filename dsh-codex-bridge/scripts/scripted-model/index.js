/**
 * Test-only plugin: a CONTROLLABLE model provider.
 *
 * A disposable home has no credentials and therefore no provider, so the real `ask_codex` tool could
 * never be reached by a model call. This registers a scripted provider through the documented
 * `ctx.llm.registerAdapter(providers, adapter)` entry, so the production loop, tool dispatcher,
 * waterwaters and retry path all run unchanged and only the model at the far end is steered.
 *
 * The script is deliberately minimal and ordered: the first model call emits a tool call for
 * `ask_codex`, the second emits a short text answer. That is exactly the shape of the loop under test
 * (ask, pause, resume, finish), and nothing about it bypasses the tool's own binding and lifecycle.
 *
 * This file is TEST INFRASTRUCTURE and is never installed into a profile's plugin set.
 *
 * @module dsh-codex-bridge/scripts/scripted-model
 */
import z from "@deepseek-ai/schemastery";

export const name = "scripted-model";

/** Needs the LLM runtime to register its provider. */
export const inject = ["llm"];

export const Config = z.object({
    /** Route id to register. */
    provider: z.string().default("scripted"),
    /** Model id offered on that route. */
    model: z.string().default("deepseek-v4.1-flash"),
    /** Tool name the first model call should invoke. */
    toolName: z.string().default("ask_codex"),
    /** The question text to pass to that tool. */
    toolQuestion: z.string().default("Should the retry use exponential backoff?"),
    /** Pre-built tool arguments, as JSON, when the tool under test is not the question tool. */
    toolArguments: z.string().default("")
});

export function apply(ctx, config) {
    /** How many model calls have been served, so the script can advance. */
    const state = { calls: 0 };

    const adapter = {
        /** @param provider - route id. @returns {object} display metadata. */
        providerInfo(provider) {
            return { id: provider, name: "scripted" };
        },
        /** @returns {undefined} use the shell's default retry policy. */
        providerRetryPolicy() {
            return undefined;
        },
        /**
         * Resolve one exact model on this route.
         * @param provider - route id.
         * @param requested - model id.
         * @returns {Promise<object>} the model descriptor.
         */
        async resolveModel(provider, requested) {
            return { provider, id: requested, name: requested, contextWindow: 100_000 };
        },
        /**
         * List the models offered. Every entry must carry `provider` equal to the route, or the whole
         * provider is rejected as invalid catalog metadata.
         * @param provider - route id.
         * @returns {Promise<Array<object>>} one model.
         */
        async listModels(provider) {
            return [{ provider, id: config.model, name: config.model, contextWindow: 100_000 }];
        },
        /**
         * Bind metadata and the dispatch entry point for one call generation.
         * @param provider - route id.
         * @param requested - model id.
         * @returns {Promise<{model: object, stream: Function}>} the binding.
         */
        async prepareCall(provider, requested) {
            return {
                model: await this.resolveModel(provider, requested),
                stream: (options) => this.stream(options)
            };
        },
        /**
         * Serve one scripted call: first a tool call, then a plain completion.
         * @returns {AsyncIterable<object>} the chunk stream.
         */
        async *stream() {
            state.calls += 1;
            if (state.calls === 1) {
                // Ask the question through the REAL tool, which then pauses for the controller.
                const id = "call-scripted-1";
                // A pre-built argument object lets the same scripted provider drive a tool other than the
                // question tool (for example `notify_controller`), so each real tool path can be exercised.
                const args = config.toolArguments.length > 0
                    ? config.toolArguments
                    : JSON.stringify({ question: config.toolQuestion });
                yield { type: "block-start", index: 0, blockType: "tool-call" };
                yield { type: "tool-call-delta", index: 0, id, name: config.toolName, argumentsDelta: args };
                yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: config.toolName, arguments: args } };
                yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
                yield { type: "finish", reason: { kind: "tool-calls" } };
                return;
            }
            // Second call: report completion, so the turn ends after the answer was consumed.
            const text = "Acknowledged the controller's answer.";
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text };
            yield { type: "block-end", index: 0, block: { type: "text", text } };
            yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
            yield { type: "finish", reason: { kind: "stop" } };
        }
    };

    ctx.llm.registerAdapter([config.provider], adapter);
    ctx.logger.info("scripted-model: provider %s serving model %s", config.provider, config.model);
}
