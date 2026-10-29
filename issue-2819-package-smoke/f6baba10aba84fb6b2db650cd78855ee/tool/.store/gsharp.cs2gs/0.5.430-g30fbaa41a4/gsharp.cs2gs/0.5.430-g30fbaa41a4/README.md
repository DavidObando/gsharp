# Gsharp.NET.Sdk

The MSBuild Project SDK for the [GSharp programming language](https://github.com/DavidObando/gsharp). This package enables `.gsproj` files to build with `dotnet build` just like any other .NET project.

## Quick Start

1. Install the GSharp templates:

   ```bash
   dotnet new install Gsharp.Templates
   ```

2. Create a new GSharp console app:

   ```bash
   dotnet new gsharp-console -n MyApp
   cd MyApp
   dotnet run
   ```

## What's Included

- Full MSBuild integration — build, publish, and pack `.gs` files with the standard `dotnet` CLI.
- The `gsc` compiler, bundled inside the package under `tools/compiler/`.
- SDK props/targets that wire everything together automatically.

## Requirements

- .NET 10.0 SDK or later.

## Learn More

- [Repository & Documentation](https://github.com/DavidObando/gsharp)
- [License (MIT)](https://github.com/DavidObando/gsharp/blob/main/LICENSE)
