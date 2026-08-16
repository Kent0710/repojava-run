const express = require("express");
const path = require("path");

const {
  detectProject,
  findSourceRoot,
  findJavaFiles,
  detectMainClass,
} = require("../runner/detector");

const { downloadGitHubRepository } = require("../runner/github");

const { executeProject } = require("../runner/executor");

const app = express();

const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

app.get("/", (req, res) => {
  res.json({
    name: "JavaRun",
    status: "running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

app.post("/api/run", async (req, res) => {
  const { githubUrl } = req.body;

  if (!githubUrl) {
    return res.status(400).json({
      error: "githubUrl is required",
    });
  }

  if (!githubUrl.startsWith("https://github.com/")) {
    return res.status(400).json({
      error: "Only GitHub URLs are currently supported",
    });
  }

  let temporaryDirectory = null;

  try {
    const result = await downloadGitHubRepository(githubUrl);

    const projectPath = result.projectPath;
    temporaryDirectory = result.tempDirectory;

    console.log(`Project path: ${projectPath}`);

    const projectType = detectProject(projectPath);

    console.log(`Detected type: ${projectType}`);

    let command;
    let entryPoint = null;

    switch (projectType) {
      case "plain-java": {
        const sourceRoot = findSourceRoot(projectPath);

        const javaFiles = findJavaFiles(sourceRoot);

        const mainClass = detectMainClass(javaFiles);

        if (!mainClass) {
          throw new Error("Could not find a Java main() entry point.");
        }

        entryPoint = mainClass.fullyQualifiedName;

        console.log(`Source root: ${sourceRoot}`);

        console.log(`Entry point: ${entryPoint}`);

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
        throw new Error("Unsupported or unknown Java project.");
    }

    const executionResult = await executeProject({
      projectPath,
      projectType,
      entryPoint,
      temporaryDirectory,
      command,
      interactive: false,
    });

    temporaryDirectory = null;

    return res.json(executionResult);
  } catch (error) {
    console.error(`Error: ${error.message}`);

    if (temporaryDirectory) {
      const fs = require("fs");

      try {
        fs.rmSync(temporaryDirectory, {
          recursive: true,
          force: true,
        });
      } catch {}
    }

    const statusCode = getErrorStatusCode(error);

    return res.status(statusCode).json({
      status: "error",
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`JavaRun server running at http://localhost:${PORT}`);
});

function getErrorStatusCode(error) {
  const message = error.message.toLowerCase();

  if (message.includes("invalid") || message.includes("required")) {
    return 400;
  }

  if (
    message.includes("not found") ||
    message.includes("repository does not exist") ||
    message.includes("repository not found")
  ) {
    return 404;
  }

  if (message.includes("unsupported") || message.includes("main()")) {
    return 422;
  }

  return 500;
}
