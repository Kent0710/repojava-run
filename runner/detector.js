const fs = require("fs");
const path = require("path");

function findJavaFiles(directory) {
  const results = [];

  const entries = fs.readdirSync(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "target" ||
        entry.name === "build"
      ) {
        continue;
      }

      results.push(...findJavaFiles(fullPath));
    } else if (entry.name.endsWith(".java")) {
      results.push(fullPath);
    }
  }

  return results;
}

function detectMainClass(javaFiles) {
  const mainClasses = [];

  for (const file of javaFiles) {
    const content = fs.readFileSync(file, "utf8");

    const hasMainMethod =
      /public\s+static\s+void\s+main\s*\(\s*String\s*(\[\s*\]|\.\.\.)\s+\w+\s*\)/.test(
        content
      );

    if (!hasMainMethod) {
      continue;
    }

    const packageMatch = content.match(
      /^\s*package\s+([a-zA-Z_][\w.]*)\s*;/m
    );

    const classMatch = content.match(
      /\b(?:public\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/
    );

    if (!classMatch) {
      continue;
    }

    const className = classMatch[1];

    const fullyQualifiedName = packageMatch
      ? `${packageMatch[1]}.${className}`
      : className;

    mainClasses.push({
      file,
      className,
      fullyQualifiedName,
    });
  }

  if (mainClasses.length === 0) {
    return null;
  }

  if (mainClasses.length > 1) {
    console.warn(
      `Warning: Multiple main() methods detected. Using ${mainClasses[0].fullyQualifiedName}`
    );
  }

  return mainClasses[0];
}

function detectProject(projectPath) {
  if (fs.existsSync(path.join(projectPath, "pom.xml"))) {
    return "maven";
  }

  if (
    fs.existsSync(path.join(projectPath, "build.gradle")) ||
    fs.existsSync(path.join(projectPath, "build.gradle.kts"))
  ) {
    return "gradle";
  }

  const javaFiles = findJavaFiles(projectPath);

  if (javaFiles.length > 0) {
    return "plain-java";
  }

  return "unknown";
}

function findSourceRoot(projectPath) {
  const commonSourceDirectories = [
    "src/main/java",
    "src",
  ];

  for (const directory of commonSourceDirectories) {
    const fullPath = path.join(projectPath, directory);

    if (fs.existsSync(fullPath)) {
      const javaFiles = findJavaFiles(fullPath);

      if (javaFiles.length > 0) {
        return fullPath;
      }
    }
  }

  return projectPath;
}

module.exports = {
  detectProject,
  findJavaFiles,
  findSourceRoot,
  detectMainClass,
};