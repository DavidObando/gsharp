---
title: "Tutorial: Concurrency"
sidebar_position: 5
draft: false
---

# Tutorial: Concurrency

In this tutorial, you will use G#'s Go-shaped concurrency surface: `go`, channels, `select`, and `scope`. The surface is Go-inspired, but it lowers to .NET tasks and `System.Threading.Channels`.

## Prerequisites

- A working G# project.
- Basic familiarity with functions and loops.

## 1. Send and receive on a channel

Create channels with `make(chan T)` or `make(chan T, capacity)`. Send with `ch <- value` and receive with `<-ch`:

```gsharp title="Channels.gs"
// file: Channels.gs
//
// Phase E exit sample. Exercises the channel emit path landed in this PR
// without yet requiring goroutines (Phase F) or select (Phase G): create a
// buffered channel, send values into it, drain them in source order, then
// close it and observe the closed-channel default value via receive.

package GSharp.Samples.Channels

import System

let ch = make(chan int32, 3)
ch <- 1
ch <- 2
ch <- 3
close(ch)

let a = <-ch
let b = <-ch
let c = <-ch
let d = <-ch

Console.WriteLine(a)
Console.WriteLine(b)
Console.WriteLine(c)
Console.WriteLine(d)
```

Expected output:

```text
1
2
3
0
```

Receiving from a closed, drained channel returns the element type's zero value.

## 2. Join goroutines with `scope`

A `go` statement starts a function call concurrently. Inside `scope`, child tasks are registered and joined before control leaves the block:

```gsharp title="GoScope.gs"
// file: GoScope.gs
//
// Phase F exit sample. Exercises emitted `go` statements registered with an
// enclosing `scope`: each goroutine captures the shared buffered channel,
// sends a value, and the scope waits before the main body drains the channel.

package GSharp.Samples.GoScope

import System

func send(value int32, ch chan int32) int32 {
    ch <- value
    return 0
}

let ch = make(chan int32, 3)
scope {
    go send(1, ch)
    go send(2, ch)
    go send(3, ch)
}

let a = <-ch
let b = <-ch
let c = <-ch
Console.WriteLine(a + b + c)
```

Expected output:

```text
6
```

Use `scope` for structured concurrency. A free `go` outside `scope` is fire-and-forget and has a weaker exception story.

## 3. Select among channel operations

`select` can receive, bind a received value, send, or run a `default` arm when nothing is ready:

```gsharp title="Select.gs"
// file: Select.gs
//
// Phase G exit sample. Exercises emitted select receive, send, default,
// and blocking WhenAny retry paths deterministically.

package GSharp.Samples.Select

import System
import System.Threading

func delayedSend(ch chan int32) int32 {
    Thread.Sleep(10)
    ch <- 40
    return 0
}

let ready = make(chan int32, 1)
ready <- 7
select {
case v := <-ready {
    Console.WriteLine("recv: $v")
}
}

let sendCh = make(chan int32, 1)
select {
case sendCh <- 11 {
    Console.WriteLine("sent")
}
}
let sentValue = <-sendCh
Console.WriteLine(sentValue)

let empty = make(chan int32, 1)
select {
case v := <-empty {
    Console.WriteLine("unexpected: $v")
}
default {
    Console.WriteLine("default")
}
}

let blocking = make(chan int32)
scope {
    go delayedSend(blocking)
    select {
    case v := <-blocking {
        Console.WriteLine("blocked: $v")
    }
    }
}
```

Expected output:

```text
recv: 7
sent
11
default
blocked: 40
```

The implementation re-checks ready cases in source order after waiting, so deterministic samples can rely on preloaded channels.

## 4. Join async work launched with `go`

A scoped `go` can target an `async func`; the scope waits for the returned task:

```gsharp title="AsyncGoScopeJoin.gs"
// file: AsyncGoScopeJoin.gs
//
// Regression for #291: a `scope { go asyncFunc() }` must run the spawned async
// task to completion (structured join) before the scope — and therefore the
// trailing top-level statement — completes. Before the fix the go-thunk was
// emitted as an `Action` that discarded the returned `Task`, so the scope never
// awaited it and "ran" was never observed before "done".

package GSharp.Samples.AsyncGoScopeJoin

import System
import System.Threading.Tasks

async func work() {
    await Task.Delay(1)
    Console.WriteLine("ran")
}

scope {
    go work()
}

Console.WriteLine("done")
```

Expected output:

```text
ran
done
```

## 5. Put the pieces together

The `PortScan` sample combines scoped goroutines, buffered channels, a draining loop, and a timeout channel:

```gsharp title="PortScan.gs"
// file: aspirational/PortScan.gs
//
// Phase 5 exit sample. Combines the entire Go-shaped concurrency surface that
// landed in Phase 5: `chan T` (5.4), send/receive (5.5), `go` (5.3), structured
// concurrency `scope { ... }` (5.7), and a `select { ... }` with a timeout arm
// (5.6) — all on the interpreter backend. The synthetic "scanner" assigns even
// ports as open and odd ports as closed; the timeout demo prefers a pre-loaded
// timeout channel over a worker that never sends.
//
// Lives under samples/aspirational/ because Phase 5 emit is deferred (ADR-0022
// §Consequences). The matching test harness — AspirationalSamplesTests in
// test/Core.Tests/LanguageConformance — runs this through the interpreter and
// matches stdout against PortScan.golden.

package GSharp.Samples.PortScan

import System
import System.Threading

func scan(port int32, results chan int32) int32 {
    Thread.Sleep(5)
    if port % 2 == 0 {
        results <- port
    } else {
        results <- 0
    }
    return 0
}

let results = make(chan int32, 4)
scope {
    go scan(80, results)
    go scan(81, results)
    go scan(443, results)
    go scan(8080, results)
}

// After the scope exits, all four results are buffered on `results`. Drain
// them through a `select` with a single receive arm — exercises the source-
// order TryRead path of the select algorithm without any racing.
var opened = 0
var i = 0
for i < 4 {
    select {
    case v := <-results {
        if v > 0 {
            opened = opened + 1
        }
    }
    }
    i = i + 1
}
Console.WriteLine("open ports: $opened")

// Timeout demo: a slow worker that never arrives, raced against a buffered
// "timeout" channel pre-loaded with a sentinel. The select picks the ready
// arm deterministically (source order, TryRead succeeds first).
let slow = make(chan int32, 1)
let timeoutCh = make(chan int32, 1)
timeoutCh <- 1
select {
case v := <-slow {
    Console.WriteLine("got value: $v")
}
case <-timeoutCh {
    Console.WriteLine("timed out")
}
}
```

Expected output:

```text
open ports: 2
timed out
```

This sample lives under the repository's aspirational samples because it documents the full concurrency story, including areas that originally shipped on the interpreter path before emit parity work.

## What you learned

- Channels are typed as `chan T` and created with `make`.
- `go f(args)` requires a call expression.
- `scope` is the structured way to wait for spawned work and propagate failures.
- `select` coordinates receive, send, and default cases.
