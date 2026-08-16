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

function createWebSocketServer(server) {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
  });

  wss.on("connection", (ws) => {
    console.log("WebSocket client connected.");

    let docker = null;
    let temporaryDirectory = null;

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === "start") {
          if (docker) {
            send(ws, {
              type: "error",
              message: "A project is already running.",
            });

            return;
          }

          await startProject(data);
        }

        if (data.type === "input") {
          if (!docker || !docker.stdin.writable) {
            send(ws, {
              type: "error",
              message: "No running project.",
            });

            return;
          }

          docker.stdin.write(data.input);
        }

        if (data.type === "stop") {
          stopProject();
        }
      } catch (error) {
        send(ws, {
          type: "error",
          message: error.message,
        });
      }
    });

    ws.on("close", () => {
      console.log("WebSocket client disconnected.");

      stopProject();
    });

    async function startProject(data) {
      if (!data.githubUrl) {
        send(ws, {
          type: "error",
          message: "githubUrl is required.",
        });

        return;
      }

      if (!data.githubUrl.startsWith("https://github.com/")) {
        send(ws, {
          type: "error",
          message: "Only GitHub URLs are currently supported.",
        });

        return;
      }

      try {
        send(ws, {
          type: "status",
          message: "Downloading repository...",
        });

        const result = await downloadGitHubRepository(
          data.githubUrl,
        );

        const projectPath = result.projectPath;
        temporaryDirectory = result.tempDirectory;

        send(ws, {
          type: "status",
          message: "Repository downloaded.",
        });

        const projectType = detectProject(projectPath);

        send(ws, {
          type: "status",
          message: `Detected project: ${projectType}`,
        });

        let command;
        let entryPoint = null;

        switch (projectType) {
          case "plain-java": {
            const sourceRoot = findSourceRoot(projectPath);

            const javaFiles = findJavaFiles(sourceRoot);

            const mainClass = detectMainClass(javaFiles);

            if (!mainClass) {
              throw new Error(
                "Could not find a Java main() entry point.",
              );
            }

            entryPoint = mainClass.fullyQualifiedName;

            send(ws, {
              type: "status",
              message: `Entry point: ${entryPoint}`,
            });

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
            throw new Error(
              "Unsupported or unknown Java project.",
            );
        }

        send(ws, {
          type: "status",
          message: "Starting Java application...",
        });

        docker = spawn("docker", [
          "run",
          "--rm",
          "-i",

          // Security
          "--network=none",
          "--memory=512m",
          "--cpus=1",
          "--pids-limit=128",

          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",

          // Repository
          "-v",
          `${projectPath}:/input:ro`,

          "javarun-java17",

          "sh",
          "-c",
          `
            cp -r --no-preserve=all /input/. /app/ &&
            cd /app &&
            ${command}
          `,
        ]);

        send(ws, {
          type: "status",
          message: "Java application started.",
        });

        docker.stdout.on("data", (data) => {
          send(ws, {
            type: "output",
            data: data.toString(),
          });
        });

        docker.stderr.on("data", (data) => {
          send(ws, {
            type: "output",
            data: data.toString(),
          });
        });

        docker.on("close", (code) => {
          docker = null;

          cleanup();

          send(ws, {
            type: "exit",
            code,
          });
        });

        docker.on("error", (error) => {
          docker = null;

          cleanup();

          send(ws, {
            type: "error",
            message: error.message,
          });
        });
      } catch (error) {
        cleanup();

        send(ws, {
          type: "error",
          message: error.message,
        });
      }
    }

    function stopProject() {
      if (docker) {
        docker.kill("SIGKILL");
        docker = null;
      }

      cleanup();
    }

    function cleanup() {
      if (!temporaryDirectory) {
        return;
      }

      try {
        fs.rmSync(temporaryDirectory, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        console.error(
          `Failed to clean temporary files: ${error.message}`,
        );
      }

      temporaryDirectory = null;
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