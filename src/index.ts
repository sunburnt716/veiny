const command = process.argb[2];

if (command === "start") runInit();
else if (command === "watch") runWatch();
else console.log("Usage: veiny [start|watch]");

function runInit() {
  console.log("Initializing project...");
  // Add initialization logic here
}

function runWatch() {
  console.log("Watching for changes...");
  // Add watch logic here
}
