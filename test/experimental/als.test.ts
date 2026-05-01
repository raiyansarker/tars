import { AsyncLocalStorage } from "node:async_hooks";
import { Effect } from "effect";

const als = new AsyncLocalStorage<string>();

als.run("test-context", async () => {
  console.log("Before Effect:", als.getStore());
  await Effect.runPromise(Effect.sleep("100 millis"));
  console.log("After Effect:", als.getStore());
});
