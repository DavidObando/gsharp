---
title: "Tour: Concurrency"
sidebar_position: 5
draft: false
---

# Tour: Concurrency

G# brings Go-inspired concurrency syntax to the CLR. The core pieces are `go` for concurrent calls, `scope` for structured joining, channels for communication, and `select` for waiting on channel operations.

## Go and scope

`go` starts a function call concurrently. The binder requires the operand to be a call. A `scope` block tracks child tasks started inside it and waits for them before leaving the block.

```gsharp title="GoScope.gs"
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

```text
6
```

Without `scope`, started work is not joined by the enclosing code. Prefer `scope` when the parent operation should wait for child work and observe failures.

## Channels

Channels use `chan T`, are created with `make(chan T)` or `make(chan T, capacity)`, send with `ch <- value`, and receive with `<-ch`.

```gsharp title="Channels.gs"
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

```text
1
2
3
0
```

The closed receive in this sample returns the element type's default value.

## Select

`select` waits over receive, receive-bind, send, and `default` cases.

```gsharp title="Select.gs"
package GSharp.Samples.Select

import System

let ready = make(chan int32, 1)
ready <- 7
select {
case let v = <-ready {
    Console.WriteLine("recv: $v")
}
}

let empty = make(chan int32, 1)
select {
case let v = <-empty {
    Console.WriteLine("unexpected: $v")
}
default {
    Console.WriteLine("default")
}
}
```

```text
recv: 7
default
```

## Async functions in scopes

`async func` and `await` integrate with .NET tasks. A scoped goroutine can call an async function and the scope waits for it to complete.

```gsharp title="AsyncGoScopeJoin.gs"
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

```text
ran
done
```

The interpreter implements `go` with `Task.Run` and executes with some serialization internally, so timing behavior may differ from emitted assemblies. Use emitted builds for production concurrency behavior.

Next: [Tour: .NET interop](/docs/tour/dotnet-interop).
