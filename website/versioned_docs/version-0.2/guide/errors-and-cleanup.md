---
title: "Errors and cleanup"
sidebar_position: 7
draft: false
---

# Errors and cleanup

G# uses CLR exceptions, nullable values, `defer`, and `using` for error and lifetime management. This page focuses on the implemented language surface.

## Exceptions

Use `throw` to raise an exception and `try` with `catch` and/or `finally` to handle cleanup or recovery. A `try` statement must have at least one catch or finally semantically.

```gsharp title="samples/Exceptions.gs"
package GSharp.Example.Exceptions

import System

var trace = ""

try {
    trace = trace + "t"
} finally {
    trace = trace + "f"
}

Console.WriteLine(trace)

var caught = "before"
try {
    var n = Int32.Parse("not a number")
} catch (e Exception) {
    caught = "caught"
}

Console.WriteLine(caught)
```

Catch clauses name a local and may specify a type. Prefer specific exception types at library boundaries and reserve broad catches for top-level reporting or cleanup.

Error-handling rationale is in [ADR-0005](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0005-error-handling.md).

## Nullable absence is not an exception

Use nullable types and `nil` for expected absence. Use exceptions for failure paths that interrupt normal control flow. `?:` is the null-coalescing operator, `?.` is null-conditional access, and `!!` asserts non-null.

```gsharp
let display = user?.Name ?: "anonymous"
```

## Defer

`defer call()` schedules a call to run when the current scope exits. The parser accepts an expression, but binding requires a call. Keep deferred calls short and side-effect focused, such as unlocking, closing, or logging.

```gsharp
lock.Enter()
defer lock.Exit()
```

## Using

`using` introduces a variable declaration whose value must be disposable. It is a resource-scope statement rather than an expression.

```gsharp
using let stream = File.OpenRead(path)
```

Use `using` when a value owns an unmanaged or disposable resource. Use `defer` when the cleanup operation is not itself represented by an `IDisposable` value.

The scope rules for `defer` and `using` are covered by [ADR-0030](https://github.com/DavidObando/gsharp/blob/main/docs/adr/0030-defer-and-using-block-scope.md).

## Finally and structured cleanup

`finally` always expresses exception-safe cleanup around a region. Prefer `using` for disposable resources, `defer` for small cleanup calls, and `finally` when cleanup depends on several statements or must coordinate with catch logic.
