#!/usr/bin/env node
import { captureConfig, runInit, validateGitRepo } from "./commands/init.js";
import { runWatch } from "./commands/watch.js";
import {
  buildDependencyGraph,
  dependencyGraphExists,
} from "./utils/dependencyGraph.js";
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
        "Commands: start (initialize agent state + build the dependency graph), watch (interactive analysis), quit (exit).",
      );
      console.log(
        "In watch mode Veiny prompts you with metrics whenever it catches staged changes, asks you to verify accuracy after each commit, and stops on 'quit' or Ctrl+C.\n",
      );
    }
    startupSequence = true;

    // Main command loop
    while (startupSequence) {
      const line = (await question(rl, "Type a command (start|watch|quit): "))
        .trim()
        .toLowerCase();

      if (line === "start") {
        // Close the loop's interface before runInit so its own readline prompt has sole
        // ownership of stdin.
        rl.close();
        await runInit();

        // runInit returns void, so re-derive repoRoot + config from the exported helpers to
        // feed the dependency-graph build.
        const repoRoot = validateGitRepo();
        if (repoRoot.startsWith("Error:")) {
          console.error(repoRoot);
          return;
        }
        const config = captureConfig(repoRoot);

        // Build automatically when no graph exists yet; otherwise ask before reparsing.
        let shouldBuild = true;
        if (dependencyGraphExists(repoRoot)) {
          const rl2 = readline.createInterface({
            input: stdin,
            output: stdout,
            terminal: true,
          });
          try {
            const answer = (
              await question(
                rl2,
                "A Veiny dependency graph already exists. Reparse the codebase and update it? (y/n) ",
              )
            )
              .trim()
              .toLowerCase();
            shouldBuild = answer === "y" || answer === "yes";
          } finally {
            rl2.close();
          }
          if (!shouldBuild) {
            console.log("Keeping the existing dependency graph.");
          }
        }

        if (shouldBuild) {
          buildDependencyGraph(repoRoot, config);
        }

        // `start` flows straight into watch mode: once the agent state and dependency graph are
        // ready, begin watching for staged changes without making the user issue a second command.
        console.log("\nEntering watch mode...\n");
        await runWatch();
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
