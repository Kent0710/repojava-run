const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const {
  detectProject,
  findSourceRoot,
  findJavaFiles,
  detectMainClass,
} = require("./detector");

const { downloadGitHubRepository } = require("./github");

let temporaryDirectory = null;

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.error(
      "Usage: npm run run-java -- <project-directory-or-github-url>",
    );
    process.exit(1);
  }

  let projectPath;

  try {
    if (input.startsWith("https://github.com/")) {
      const result = await downloadGitHubRepository(input);

      projectPath = result.projectPath;
      temporaryDirectory = result.tempDirectory;
    } else {
      projectPath = path.resolve(input);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  const projectType = detectProject(projectPath);

  console.log(`Project path: ${projectPath}`);
  console.log(`Detected type: ${projectType}\n`);

  let command;
  let entryPoint = null;

  switch (projectType) {
    case "plain-java": {
      const sourceRoot = findSourceRoot(projectPath);
      const javaFiles = findJavaFiles(sourceRoot);
      const mainClass = detectMainClass(javaFiles);

      if (!mainClass) {
        console.error("Could not find a Java main() entry point.");
        process.exit(1);
      }

      entryPoint = mainClass.fullyQualifiedName;

      console.log(`Source root: ${sourceRoot}`);
      console.log(`Entry point: ${entryPoint}\n`);

      command = `
        mkdir -p /tmp/javarun-classes &&
        find . -name "*.java" -print0 |
        xargs -0 javac -d /tmp/javarun-classes &&
        java -cp /tmp/javarun-classes ${entryPoint}
      `;

      break;
    }

    case "maven":
      command = "mvn compile exec:java";
      break;

    case "gradle":
      command = "./gradlew build";
      break;

    default:
      console.error("Unsupported or unknown Java project.");
      process.exit(1);
  }

  const docker = spawn("docker", [
    "run",
    "--rm",
    "-i",

    // Security limits
    "--network=none",
    "--memory=512m",
    "--cpus=1",
    "--pids-limit=128",

    // Drop Linux capabilities
    "--cap-drop=ALL",

    // Prevent privilege escalation
    "--security-opt=no-new-privileges",

    // Repository is read-only
    "-v",
    `${projectPath}:/input:ro`,

    "javarun-java17",

    "sh",
    "-c",
    `
      cp -a /input/. /app/ &&
      ${command}
    `,
  ]);

  const startTime = Date.now();

  let timedOut = false;
  let stdout = "";
  let stderr = "";

  const timeout = setTimeout(() => {
    timedOut = true;

    console.log("\nExecution timed out.");

    docker.kill("SIGKILL");
  }, 30000);

  docker.stdout.on("data", (data) => {
    const output = data.toString();

    stdout += output;

    process.stdout.write(output);
  });

  docker.stderr.on("data", (data) => {
    const output = data.toString();

    stderr += output;

    process.stderr.write(output);
  });

  // Forward terminal input to the Java application
  process.stdin.pipe(docker.stdin);

  docker.on("close", (code) => {
    clearTimeout(timeout);

    const duration = (Date.now() - startTime) / 1000;

    const result = {
      status: timedOut
        ? "timeout"
        : code === 0
          ? "success"
          : "error",

      exitCode: code,

      duration,

      projectType,

      entryPoint,

      output: stdout,

      error: stderr,

      timedOut,
    };

    console.log(`\nProcess exited with code ${code}`);
    console.log(`Execution time: ${duration.toFixed(2)}s`);

    // Clean up downloaded repository
    if (temporaryDirectory) {
      try {
        fs.rmSync(temporaryDirectory, {
          recursive: true,
          force: true,
        });

        console.log("Temporary files cleaned up.");
      } catch (error) {
        console.error(
          `Failed to clean temporary files: ${error.message}`,
        );
      }
    }

    console.log("\nExecution result:");
    console.log(JSON.stringify(result, null, 2));
  });
}

main();