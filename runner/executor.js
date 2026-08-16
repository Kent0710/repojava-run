const { spawn } = require("child_process");
const fs = require("fs");

function cleanupTemporaryDirectory(temporaryDirectory) {
  if (!temporaryDirectory) {
    return;
  }

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

function executeProject({
  projectPath,
  projectType,
  entryPoint = null,
  temporaryDirectory = null,
  command,
  interactive = true,
}) {
  return new Promise((resolve) => {
    /*
     * Build Docker arguments.
     *
     * Interactive CLI:
     *   docker run --rm -i ...
     *
     * HTTP API:
     *   docker run --rm ...
     *
     * The API does NOT attach stdin at all.
     */
    const dockerArgs = [
      "run",
      "--rm",
    ];

    if (interactive) {
      dockerArgs.push("-i");
    }

    dockerArgs.push(
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
    );

    const docker = spawn("docker", dockerArgs);

    const startTime = Date.now();

    let timedOut = false;
    let stdout = "";
    let stderr = "";

    /*
     * Only connect stdin when running interactively.
     *
     * When interactive === false, Docker has no stdin attached.
     * Java will therefore receive EOF immediately.
     */
    if (interactive) {
      process.stdin.pipe(docker.stdin);
    }

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

    docker.on("error", (error) => {
      clearTimeout(timeout);

      cleanupTemporaryDirectory(temporaryDirectory);

      const duration = (Date.now() - startTime) / 1000;

      resolve({
        status: "error",
        exitCode: null,
        duration,
        projectType,
        entryPoint,
        output: stdout,
        error: error.message,
        timedOut: false,
      });
    });

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

      cleanupTemporaryDirectory(temporaryDirectory);

      console.log("\nExecution result:");
      console.log(JSON.stringify(result, null, 2));

      resolve(result);
    });
  });
}

module.exports = {
  executeProject,
};