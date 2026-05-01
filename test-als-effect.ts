import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { Effect } from "effect";

const als = new AsyncLocalStorage<string>();

function fireAndForget(handler: () => Promise<void>) {
  als.run("my-secret-context", () => {
    handler(); // Not awaited!
  });
}

fireAndForget(async () => {
  const bound = AsyncResource.bind(async () => {
    console.log("Inside bound fn:", als.getStore());
    // Simulate chat-sdk internal promises
    await new Promise(r => setTimeout(r, 10));
    console.log("Inside bound fn after await:", als.getStore());
  });

  console.log("Before Effect:", als.getStore());
  await Effect.runPromise(Effect.sleep("50 millis"));
  
  console.log("After Effect:", als.getStore()); // Should be undefined or different
  
  await bound();
});
