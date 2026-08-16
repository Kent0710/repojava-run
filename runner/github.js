const fs = require("fs");
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");

async function downloadGitHubRepository(url) {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/);

  if (!match) {
    throw new Error("Invalid GitHub repository URL.");
  }

  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");

  console.log(`GitHub repository: ${owner}/${repo}`);

  const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`;

  console.log("Downloading repository...");

  const response = await fetch(zipUrl);

  if (!response.ok) {
    throw new Error(`Could not download repository. HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "javarun-"));

  const zipPath = path.join(tempDirectory, "repository.zip");

  fs.writeFileSync(zipPath, buffer);

  console.log("Extracting repository...");

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(tempDirectory, true);

  fs.unlinkSync(zipPath);

  const extractedFolders = fs
    .readdirSync(tempDirectory)
    .filter((file) => file !== "repository.zip");

  if (extractedFolders.length === 0) {
    throw new Error("Repository appears to be empty.");
  }

  const projectPath = path.join(tempDirectory, extractedFolders[0]);

  return {
    projectPath,
    tempDirectory,
  };
}

module.exports = {
  downloadGitHubRepository,
};
