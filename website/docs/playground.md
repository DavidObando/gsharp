---
title: "Playground (status)"
draft: false
---

# Playground (status)

A live browser Playground is intentionally deferred for this release. The current documentation site is static and hosted on GitHub Pages, while running G# code requires `gsc` to parse, bind, and either interpret code in a .NET process or compile it to a managed assembly.

## Why it is deferred

The Go Playground is backed by a separate sandbox service that compiles and runs programs with CPU, memory, network, filesystem, and time limits. G# needs the same class of backend. GitHub Pages can serve HTML, CSS, JavaScript, and static assets, but it cannot run `gsc`, start isolated .NET processes, enforce resource limits, or clean up execution environments.

A safe public G# Playground would need at least:

- process or container isolation for every run;
- CPU, memory, wall-clock, stdout/stderr, network, and filesystem limits;
- deterministic cleanup after each request;
- rate limiting and abuse monitoring;
- a deployment target separate from GitHub Pages;
- a strategy for diagnostics, runtime output, and possibly snippet sharing.

Without that sandbox, accepting arbitrary source code from the public internet would be unsafe.

## Possible future architecture

A future Playground could keep the documentation site static and add an isolated backend service.

```text
Browser editor on GitHub Pages → HTTPS API → sandboxed .NET worker → gsc → stdout/stderr/diagnostics
```

One practical shape would be:

1. A static React or Docusaurus frontend embedded in the docs site.
2. A separately hosted API, for example on Azure Container Apps, Fly.io, or another container platform.
3. Per-request workers that invoke `gsc` in interpreter mode or emit mode inside a locked-down container.
4. Strict resource budgets and no ambient network or filesystem access from the user program.
5. Optional snippet sharing through encoded URLs or a small persistent store.

## What to use now

Use the local toolchain and the static Tour while the live Playground is deferred:

- install G# locally with the [installation guide](/docs/getting-started/install);
- work through the [Tour](/docs/tour);
- run examples with `dotnet run` for `.gsproj` projects or `gsc` for direct compiler experiments.

```bash
dotnet new install Gsharp.Templates
dotnet new gsharp-console -n MyApp
cd MyApp
dotnet run
```

The goal is to add browser execution later without compromising user safety or repository hosting simplicity.
