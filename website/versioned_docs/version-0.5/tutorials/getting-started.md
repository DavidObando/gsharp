---
title: "Tutorial: Getting started"
description: "Create a G# project and build a small data model with structural equality and copy-with-update."
sidebar_position: 1
---

# Tutorial: Getting started

Build a small data model and observe how values behave. You will create a point, copy it with one change, and compare the original with another point.

## Prerequisites

Complete [installation](../getting-started/install.md) first. You need the .NET 10 SDK and the published G# project templates.

## 1. Scaffold a console app

```bash
dotnet new gsharp-console -n PointApp
cd PointApp
```

## 2. Inspect the project file

Open `PointApp.gsproj`. The template selects `Gsharp.NET.Sdk`, declares an executable, and targets `net10.0`. The SDK includes `.gs` files automatically; you do not need to list `Program.gs` manually.

That is enough project configuration for this tutorial. [Projects and packages](project-and-packages.md) explains how to organize larger programs.

## 3. Replace the program

Replace `Program.gs` with the checked-in `samples/WebsiteData.gs` example:

```gsharp title="Program.gs"
package Website.Data

import System

data class Point(X int32, Y int32)

let origin = Point(0, 0)
let moved = origin with{X = 3}

Console.WriteLine("(${moved.X}, ${moved.Y})")
Console.WriteLine(origin == Point(0, 0))
```

`data class` declares a reference-typed data model with structural equality. The `with` expression creates a copy with a changed `X`; it does not modify `origin`.

String interpolation puts the coordinate values into the printed message. The second line compares points by their data rather than requiring them to be the same object.

## 4. Build and run

```bash
dotnet run
```

Expected output:

```text
(3, 0)
True
```

Try changing the copied `X` value or adding a `Y` update. The first output changes; the comparison of the unchanged original still prints `True`.

## 5. Try direct compiler output

Direct compiler invocation is optional. If you already have a source-built `gsc`, you can emit this same file with `/out` and run the resulting assembly. The [quickstart](../getting-started/quickstart.md#run-it-with-gsc-directly) shows the commands; ordinary application work can stay with the SDK.

## Next steps

Continue with [Projects and packages](project-and-packages.md), or explore [data and types](data-and-types.md) for value types, nullable data, and collections.
