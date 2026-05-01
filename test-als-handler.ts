import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { Effect } from "effect";

const als = new AsyncLocalStorage<string>();

function fireAndForget(handler: () => Promise<void>) {
  als.run("my-secret-context", () => {
    handler(); // Not awaited!
  });
}

fireAndForget(async () => {
  const post = AsyncResource.bind(async () => {
    // inside bound post
    const ctx = als.getStore();
    console.log("Inside bound post:", ctx);
    
    // Simulate chat-sdk channel.post which is async
    await new Promise(r => setTimeout(r, 10));
    
    // Simulate adapter postMessage
    console.log("Inside adapter postMessage:", als.getStore());
  });

  // Break the context!
  await Effect.runPromise(Effect.sleep("10 millis"));
  console.log("Before handler:", als.getStore()); // Should be undefined

  // Simulate handler calling post
  await post();
});
