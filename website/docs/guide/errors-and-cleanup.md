---
title: "Errors and cleanup"
sidebar_position: 7
draft: false
---

# Errors and cleanup

G# uses CLR exceptions, nullable values, `defer`, and `using` for error and lifetime management. This page focuses on the implemented language surface.

## Exceptions

Use `throw` to raise an exception and `try` with `catch` and/or `finally` to handle cleanup or recovery. A `try` statement must have at least one catch or finally semantically. `throw e` can also appear in value position, where it behaves as a bottom-typed expression that converts to the surrounding target type.

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

A catch clause takes one of four forms: `catch (name Type)` binds the exception
to `name`, `catch (Type)` names the type it handles without binding anything,
`catch` alone is `catch (Exception)` with no binder, and any of them may carry a
`when` filter. Prefer specific exception types at library boundaries and reserve
broad catches for top-level reporting or cleanup.

```gsharp
try {
    process(request)
} catch (e HttpRequestException) when e.StatusCode == 429 {
    retryLater(request)
} catch (OperationCanceledException) {
    // The type is all this handler needs; no local is bound.
    Console.WriteLine("cancelled")
} catch {
    Console.WriteLine("unexpected")
}
```

A `when` filter must be a `bool` expression, and it is emitted as a real CLR
filter region: it runs during the first pass — before any intervening `finally`
unwinds the stack — and when it is false the exception falls through to the next
clause exactly as it does in C#. A filter cannot `await` (`GS0572`) because there
is no suspension point in the first pass, and a clause that an earlier
*unfiltered* clause already covers can never run (`GS0573`).

```gsharp
func requireName(name string?) string {
    return name ?? throw ArgumentNullException("name")
}
```


## Rethrowing

Inside a `catch` handler, `rethrow` re-raises the exception being handled while
keeping its original throw site. Re-throwing the caught binder instead
(`throw e`) raises the same object but resets `StackTrace` to the line that
re-threw it, which loses the frames that actually failed.

```gsharp
try {
    process(order)
} catch (e IOException) {
    Console.WriteLine("retrying: " + e.Message)
    rethrow
}
```

`rethrow` is only valid lexically inside a `catch` body. Writing it anywhere
else is `GS0570`, and writing it in a `finally` nested inside that `catch` is
`GS0571` — by then the runtime has already left the handler. A `rethrow` inside
a nested `catch` re-raises that inner exception, not the outer one.

## Nullable absence is not an exception

Use nullable types and `nil` for expected absence. Use exceptions for failure paths that interrupt normal control flow. `??` is the null-coalescing operator, `?.` is null-conditional access, and `!!` asserts non-null.

```gsharp
let display = user?.Name ?? "anonymous"
```

## Defer

`defer call` schedules a call to run when the current scope exits. The parser accepts an expression, but binding requires a call. Keep deferred calls short and side-effect focused, such as unlocking, closing, or logging.

```gsharp
lock.Enter
defer lock.Exit
```

## Using

`using` introduces a variable declaration whose value must be disposable. It is a resource-scope statement rather than an expression.

```gsharp
using let stream = File.OpenRead(path)
```

Use `using` when a value owns an unmanaged or disposable resource. Use `defer` when the cleanup operation is not itself represented by an `IDisposable` value.


## Finally and structured cleanup

`finally` always expresses exception-safe cleanup around a region. Prefer `using` for disposable resources, `defer` for small cleanup calls, and `finally` when cleanup depends on several statements or must coordinate with catch logic.
