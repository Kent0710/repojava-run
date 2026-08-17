const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const fs = require("fs");

const {
  detectProject,
  findSourceRoot,
  findJavaFiles,
  detectMainClass,
} = require("../runner/detector");

const { downloadGitHubRepository } = require("../runner/github");

// ─── Concurrency limit ────────────────────────────────────────────────────────
const MAX_CONCURRENT_EXECUTIONS = 5;
let activeExecutions = 0;

// ─── Limits ───────────────────────────────────────────────────────────────────
const LIMITS = {
  COMPILE_TIMEOUT_MS:  30_000,   // 30 seconds to compile
  EXEC_TIMEOUT_MS:     120_000,  // 120 seconds max runtime
  IDLE_TIMEOUT_MS:     20_000,   // 20 seconds idle timeout (count for the startup time)
  MEMORY:              "256m",    // 64 MB RAM per execution
  CPUS:                "0.5",    // half a CPU core
  PIDS:                50,       // max 10 processes inside container
  OUTPUT_MAX_BYTES:    1_048_576 // 1 MB stdout cap
};

function createWebSocketServer(server) {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
  });

  wss.on("connection", (ws) => {
    console.log("WebSocket client connected.");

    let docker          = null;
    let containerId     = null;   // track container so we can force-kill it
    let temporaryDirectory = null;
    let execTimer       = null;
    let compileTimer    = null;
    let idleTimer       = null;
    let outputBytes     = 0;
    let outputCapped    = false;

    // ── Helpers ──────────────────────────────────────────────────────────────

    function clearTimers() {
      if (execTimer)    { clearTimeout(execTimer);    execTimer    = null; }
      if (compileTimer) { clearTimeout(compileTimer); compileTimer = null; }
      if (idleTimer)    { clearTimeout(idleTimer);    idleTimer    = null; }
    }

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
      send(ws, {
        type: "error",
        message: "Session ended due to inactivity.",
      });
      stopProject();
      }, LIMITS.IDLE_TIMEOUT_MS);
    }

    function cleanup() {
      if (!temporaryDirectory) return;
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch (err) {
        console.error(`Failed to clean temporary files: ${err.message}`);
      }
      temporaryDirectory = null;
    }

    // Kill the entire Docker container process tree, not just the Node child.
    function killContainer() {
      if (containerId) {
        try {
          spawn("docker", ["kill", "--signal=SIGKILL", containerId]);
        } catch (_) {}
        containerId = null;
      }
      if (docker) {
        try { docker.kill("SIGKILL"); } catch (_) {}
        docker = null;
      }
    }

    function stopProject() {
      clearTimers();
      killContainer();
      cleanup();
      if (activeExecutions > 0) activeExecutions--;
    }

    // ── Message handler ───────────────────────────────────────────────────────

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === "start") {
          if (docker) {
            send(ws, { type: "error", message: "A project is already running." });
            return;
          }
          await startProject(data);
        }

        if (data.type === "input") {
          if (!docker || !docker.stdin.writable) {
            send(ws, { type: "error", message: "No running project." });
            return;
          }
          // Reasonable stdin size guard (4 KB per message)
          const input = String(data.input).slice(0, 4096);
          docker.stdin.write(input);
    	  resetIdleTimer();
        }

        if (data.type === "stop") {
          stopProject();
          send(ws, { type: "exit", code: null, reason: "stopped-by-user" });
        }
      } catch (error) {
        send(ws, { type: "error", message: error.message });
      }
    });

    ws.on("close", () => {
      console.log("WebSocket client disconnected.");
      stopProject();
    });

    // ── Start project ─────────────────────────────────────────────────────────

    async function startProject(data) {
      // Concurrency gate
      if (activeExecutions >= MAX_CONCURRENT_EXECUTIONS) {
        send(ws, {
          type: "error",
          message: `Server is busy (max ${MAX_CONCURRENT_EXECUTIONS} concurrent executions). Please try again shortly.`,
        });
        return;
      }

      if (!data.githubUrl) {
        send(ws, { type: "error", message: "githubUrl is required." });
        return;
      }

      if (!data.githubUrl.startsWith("https://github.com/")) {
        send(ws, { type: "error", message: "Only GitHub URLs are currently supported." });
        return;
      }

      activeExecutions++;
      outputBytes  = 0;
      outputCapped = false;

      try {
        send(ws, { type: "status", message: "Downloading repository..." });

        const result = await downloadGitHubRepository(data.githubUrl);
        const projectPath  = result.projectPath;
        temporaryDirectory = result.tempDirectory;

        send(ws, { type: "status", message: "Repository downloaded." });

        const projectType = detectProject(projectPath);
        send(ws, { type: "status", message: `Detected project: ${projectType}` });

        let command;
        let entryPoint = null;

        switch (projectType) {
          case "plain-java": {
            const sourceRoot = findSourceRoot(projectPath);
            const javaFiles  = findJavaFiles(sourceRoot);
            const mainClass  = detectMainClass(javaFiles);

            if (!mainClass) {
              throw new Error("Could not find a Java main() entry point.");
            }

            entryPoint = mainClass.fullyQualifiedName;
            send(ws, { type: "status", message: `Entry point: ${entryPoint}` });

            // Compile timeout is handled by the wrapping timeout below.
            // ulimit -t caps CPU seconds; ulimit -f caps file writes (blocks).
            command = `
              mkdir -p /tmp/javarun-classes &&
              find . -name "*.java" -print0 | xargs -0 javac -d /tmp/javarun-classes &&
              exec java \
                -Xmx180m -Xms32m \
                -XX:+UseSerialGC \
                -cp /tmp/javarun-classes ${entryPoint}
            `;
            break;
          }

          case "maven":
            command = `
              mvn -q -B compile exec:java \
                -Dexec.mainClass=$(mvn -q -B help:evaluate \
                  -Dexpression=exec.mainClass -DforceStdout 2>/dev/null || echo 'Main') \
                -Djvm.fork.jvmArgs="-Xmx56m -XX:+UseSerialGC"
            `;
            break;

          case "gradle":
            command = "./gradlew --no-daemon build run";
            break;

          default:
            throw new Error("Unsupported or unknown Java project.");
        }

        send(ws, { type: "status", message: "Starting Java application..." });

        // ── Docker run — all limits enforced here ─────────────────────────
        //
        //  --memory=64m          Hard RAM cap (OOM-killer fires if exceeded)
        //  --memory-swap=64m     Disable swap (same value = no swap)
        //  --cpus=0.5            Half a vCPU — prevents infinite CPU loops
        //  --pids-limit=10       Max 10 PIDs (prevents fork bombs)
        //  --network=none        No internet, no internal services
        //  --cap-drop=ALL        Drop every Linux capability
        //  --no-new-privileges   No setuid/privilege escalation
        //  --read-only           Root filesystem is read-only
        //  --tmpfs /tmp          Writable tmp with 32 MB size cap
        //  --tmpfs /app          Writable /app with 32 MB size cap
        //  -u 1000:1000          Run as non-root user (uid 1000)
        //  -v ... :ro            Source code mounted read-only
        // ─────────────────────────────────────────────────────────────────

        docker = spawn("docker", [
          "run",
          "--rm",
          "-i",
          "--cidfile", `/tmp/cid-${Date.now()}`,   // we'll read this below

          // Memory
          "--memory=256m",
          "--memory-swap=256m",

          // CPU (prevents while(true) from burning cores)
          `--cpus=${LIMITS.CPUS}`,

          // Process limit (prevents fork bombs / thread explosions)
          "--pids-limit=50",

          // Network isolation
          "--network=none",

          // Filesystem isolation — read-only root + small writable tmpfs
          "--read-only",
          "--tmpfs", "/tmp:size=32m",
          "--tmpfs", "/app:size=32m,uid=1001,gid=1001",
          "--tmpfs", "/home/javarun/.m2:size=32m,uid=1001,gid=1001",

          // Capability & privilege hardening
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",

          // Non-root user
          "-u", "1001:1001",

          // Source code (read-only)
          "-v", `${projectPath}:/input:ro`,

          "javarun-java17",

          "sh", "-c",
          `cp -r --no-preserve=all /input/. /app/ && cd /app && ${command}`,
        ]);

        // Grab the container ID so we can docker-kill the whole tree
        if (docker.spawnargs) {
          const cidIndex = docker.spawnargs.indexOf("--cidfile");
          if (cidIndex !== -1) {
            const cidFile = docker.spawnargs[cidIndex + 1];
            // Poll briefly for the cid file to appear
            const pollCid = setInterval(() => {
              try {
                const cid = fs.readFileSync(cidFile, "utf8").trim();
                if (cid) { containerId = cid; clearInterval(pollCid); }
              } catch (_) {}
            }, 200);
          }
        }

        send(ws, { type: "status", message: "Java application started." });
	resetIdleTimer();

        // ── Execution timeout ─────────────────────────────────────────────
        execTimer = setTimeout(() => {
          send(ws, {
            type: "error",
            message: `Execution timed out after ${LIMITS.EXEC_TIMEOUT_MS / 1000} seconds.`,
          });
          stopProject();
        }, LIMITS.EXEC_TIMEOUT_MS);

        // ── stdout / stderr with output cap ───────────────────────────────
        function handleOutput(chunk) {
          if (outputCapped) return;

          outputBytes += chunk.length;

          if (outputBytes > LIMITS.OUTPUT_MAX_BYTES) {
            outputCapped = true;
            send(ws, {
              type: "error",
              message: "Output limit exceeded (1 MB). Stopping execution.",
            });
            stopProject();
            return;
          }

          send(ws, { type: "output", data: chunk.toString() });
        }

        docker.stdout.on("data", handleOutput);
        docker.stderr.on("data", handleOutput);

        // ── Process exit ──────────────────────────────────────────────────
        docker.on("close", (code) => {
          clearTimers();
          docker      = null;
          containerId = null;
          cleanup();
          if (activeExecutions > 0) activeExecutions--;
          send(ws, { type: "exit", code });
        });

        docker.on("error", (error) => {
          clearTimers();
          docker      = null;
          containerId = null;
          cleanup();
          if (activeExecutions > 0) activeExecutions--;
          send(ws, { type: "error", message: error.message });
        });

      } catch (error) {
        clearTimers();
        killContainer();
        cleanup();
        if (activeExecutions > 0) activeExecutions--;
        send(ws, { type: "error", message: error.message });
      }
    }
  });

  return wss;
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

module.exports = {
  createWebSocketServer,
};
