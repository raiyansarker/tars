import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();

function fireAndForget(handler: () => Promise<void>) {
  als.run("my-secret-context", () => {
    handler(); // Not awaited!
  });
}

fireAndForget(async () => {
  const bound = AsyncResource.bind(async () => {
    console.log("Inside bound fn:", als.getStore());
  });

  await new Promise(r => setTimeout(r, 100)); // Simulating API call

  console.log("Before bound call:", als.getStore());
  await bound();
});
