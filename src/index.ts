import { runInit } from "./commands/init.js";
import { runWatch } from "./commands/watch.js";
import readline from "node:readline";
import { stdin, stdout } from "node:process";

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (ans) => resolve(ans)));
}

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });

  try {
    var startupSequence = false;
    console.log("\nWelcome to Veiny — a codebase dependency analyzer\n");
    const walk = (
      await question(rl, "Would you like a quick walkthrough of Veiny? (y/n) ")
    )
      .trim()
      .toLowerCase();

    if (walk === "y" || walk === "yes") {
      console.log(
        "\nVeiny parses your project into a dependency graph and analyzes staged diffs for heuristic issues before commits land.",
      );
      console.log(
        "Commands: start (initialize agent state), watch (run analysis/watch mode), quit (exit).\n",
      );
    }
    startupSequence = true;

    // Main command loop
    while (startupSequence) {
      const line = (await question(rl, "Type a command (start|watch|quit): "))
        .trim()
        .toLowerCase();

      if (line === "start") {
        rl.close();
        await runInit();
        return;
      }

      if (line === "watch") {
        rl.close();
        await runWatch();
        return;
      }

      if (line === "quit") {
        console.log("Goodbye.");
        rl.close();
        return;
      }

      console.log("Invalid input. Please try again.\n");
    }
  } finally {
    try {
      rl.close();
    } catch {}
  }
}

void main();
