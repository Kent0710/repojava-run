const path = require("path");

const {
  detectProject,
  findSourceRoot,
  findJavaFiles,
  detectMainClass,
} = require("./detector");

const { downloadGitHubRepository } = require("./github");
const { executeProject } = require("./executor");

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

  await executeProject({
    projectPath,
    projectType,
    entryPoint,
    temporaryDirectory,
    command,
  });
}

main();