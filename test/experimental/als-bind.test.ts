import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();

let globalBoundFn: () => Promise<void>;

function start() {
  als.run("active-context", () => {
    // inside run block, synchronous
    globalBoundFn = AsyncResource.bind(async () => {
      console.log("Inside bound fn:", als.getStore());
    });
  });
}

start(); // run block finishes and exits

// call it later
globalBoundFn!();
