import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"

type SummarizeBody = { providerID: string; modelID: string }

/**
 * Agent-callable context compaction tool.
 *
 * Fires summarize without awaiting (fire-and-forget) while the agent is still
 * running: the compaction part lands in the running loop and is processed
 * between steps, so a supervisor can compact its own context mid-work and keep
 * going afterwards.
 *
 * NEVER await the summarize call from the tool: the summarize handler invokes
 * `promptSvc.loop`, whose `ensureRunning` waits for the currently running loop
 * to finish, and the loop waits for this tool to return — a deadlock.
 */
export const CompactContextPlugin: Plugin = async (ctx) => {
  const resolveModelBody = async (sessionID: string): Promise<SummarizeBody | undefined> => {
    const msgs = await ctx.client.session.messages({ path: { id: sessionID } })
    const assistant = msgs.data
      ?.map((m) => m.info)
      .filter((m) => m.role === "assistant")
      .pop()
    return assistant
      ? { providerID: assistant.providerID, modelID: assistant.modelID }
      : undefined
  }

  return {
    tool: {
      compact_context: tool({
        description: [
          "Compact the current session's context using OpenCode's native ",
          "compaction. Use this when the conversation has grown large, key ",
          "details are being lost, or the context window is filling up. ",
          "Compaction summarizes earlier messages into a concise summary, ",
          "freeing tokens while preserving important information. ",
          "It runs while the agent is still working: the running loop picks ",
          "the compaction up between steps and the agent continues afterwards. ",
          "Useful for long-running supervisor agents that want to compact ",
          "between sub-tasks.",
        ].join(""),
        args: {
          reason: tool.schema
            .string()
            .optional()
            .describe(
              "Optional reason why compaction is needed, e.g. 'context too large, need to free tokens for the next phase'",
            ),
        },
        async execute(args, context) {
          const sessionID = context.sessionID
          const reason = args.reason ?? "no reason given"

          // Fire-and-forget summarize: compactSvc.create immediately writes a
          // compaction part, which the running loop picks up on its next
          // iteration (prompt.ts tasks.pop), compacts between steps, and with
          // auto:true creates a continue message so the agent keeps going.
          // The summarize HTTP call itself resolves only when the whole run
          // finishes — that is why we do not await it here.
          void (async () => {
            try {
              const body = await resolveModelBody(sessionID)
              if (!body) throw new Error("no assistant message found in session")
              // auto:true is REQUIRED: without it compaction does not create a
              // continue message and the agent stops after the compaction.
              // SDK types lag behind the server schema (SummarizePayload has an
              // optional `auto` field), hence the intersection cast.
              const summarizeBody: SummarizeBody & { auto: boolean } = { ...body, auto: true }
              await ctx.client.session.summarize({ path: { id: sessionID }, body: summarizeBody })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              await ctx.client.tui.showToast({
                body: { message: `Compaction failed: ${message}`, variant: "error" },
              })
            }
          })()

          return {
            title: "Compaction requested",
            output:
              "Context compaction has been requested and will run asynchronously. " +
              "The running conversation is compacted between steps; work continues " +
              "afterwards with the compacted context.",
            metadata: { sessionID, reason },
          }
        },
      }),
    },
  }
}

export default CompactContextPlugin
