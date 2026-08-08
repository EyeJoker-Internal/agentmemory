import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync("deploy/coolify/Dockerfile", "utf-8");
const compose = readFileSync("deploy/coolify/docker-compose.yml", "utf-8");
const dockerignore = readFileSync(".dockerignore", "utf-8");

describe("Coolify source deployment", () => {
  it("builds the checked-out repository instead of reinstalling the npm release", () => {
    expect(dockerfile).toContain("FROM node:22-slim AS builder");
    expect(dockerfile).toContain("COPY --from=builder /src/dist");
    expect(dockerfile).not.toContain('npm install "@agentmemory/agentmemory@');
  });

  it("uses the repository root as the Docker build context", () => {
    expect(compose).toMatch(/context:\s*\.\.\/\.\./);
    expect(compose).toMatch(/dockerfile:\s*deploy\/coolify\/Dockerfile/);
  });

  it("excludes local build artifacts from the Docker context", () => {
    expect(dockerignore).toContain("node_modules");
    expect(dockerignore).toContain(".git");
    expect(dockerignore).toContain("dist");
  });
});
