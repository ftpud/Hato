export default {
  id: "__driver", moduleApiVersion: 1,
  async activate(ctx) {
    try {
      const call = (method, args) => ctx.modules.call("persistence", method, args);
      await call("conversations.insert", { conversation: { id: "paged-history", workspaceId: "history-test", acpProfileId: "codex", title: "History" } });
      for (let i = 1; i <= 165; i++) await call("messages.upsert", { id: "history-" + i, conversationId: "paged-history", kind: "user", payload: { text: "Message " + i } });
      const latest = await call("messages.list", { conversationId: "paged-history", limit: 81 });
      check("latest page is ordered and bounded", latest.length === 81 && latest[0].sequence === 85 && latest[80].sequence === 165);
      const older = await call("messages.list", { conversationId: "paged-history", limit: 81, beforeSequence: 86 });
      check("cursor is exclusive and returns the preceding page", older.length === 81 && older[0].sequence === 5 && older[80].sequence === 85);
      await call("messages.upsert", { id: "history-new", conversationId: "paged-history", kind: "assistant", payload: { text: "New live message" } });
      const stable = await call("messages.list", { conversationId: "paged-history", limit: 81, beforeSequence: 86 });
      check("new messages do not shift older cursor results", JSON.stringify(stable.map(m => m.id)) === JSON.stringify(older.map(m => m.id)));
      let rejected = false;
      try { await call("messages.list", { conversationId: "paged-history", beforeSequence: -1 }); } catch { rejected = true; }
      check("invalid cursors are rejected", rejected);
      const page = await ctx.modules.call("ai-sessions", "loadOlder", { conversationId: "paged-history" });
      check("session loads older history on demand", page.loaded === 80 && page.hasOlder === true, page);
      const last = await ctx.modules.call("ai-sessions", "loadOlder", { conversationId: "paged-history" });
      check("final page marks the beginning of history", last.loaded === 6 && last.hasOlder === false, last);
    } catch (e) { check("uncaught", false, e.message + "\n" + e.stack); }
    await finish();
  },
};
