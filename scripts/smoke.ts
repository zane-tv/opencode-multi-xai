import mod from "../lib/plugin.js";

async function main(): Promise<void> {
  console.log("default export keys:", Object.keys(mod));
  console.log("id:", (mod as { id?: string }).id, "| server is fn:", typeof mod.server);
  const hooks = await mod.server({
    // minimal stub PluginInput
    client: {} as never,
    project: {} as never,
    directory: ".",
    worktree: ".",
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as never,
    experimental_workspace: { register() {} } as never,
  });
  console.log("hook keys:", Object.keys(hooks));
  console.log("auth.provider:", hooks.auth?.provider);
  console.log(
    "auth.methods:",
    hooks.auth?.methods?.map((m) => ({ type: m.type, label: m.label })),
  );
  console.log("tool keys:", hooks.tool ? Object.keys(hooks.tool) : "(none)");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
