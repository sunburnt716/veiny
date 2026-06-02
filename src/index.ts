import { runInit } from "./commands/init.js";
import { runWatch } from "./commands/watch.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

async function main(): Promise<void> {
  const interfaceInstance = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    while (true) {
      console.log("Type start, watch, or quit:");

      const command = (await interfaceInstance.question("> "))
        .trim()
        .toLowerCase();

      if (command === "start") {
        await runInit();
        return;
      }

      if (command === "watch") {
        await runWatch();
        return;
      }

      if (command === "quit") {
        console.log("Goodbye.");
        return;
      }

      console.log("Invalid input. Please try again.");
    }
  } finally {
    interfaceInstance.close();
  }
}

void main();
