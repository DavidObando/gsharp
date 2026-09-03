// ADR-0174 D9. The G#-authored half of the concurrency library: the pieces that
// are ordinary code over the primitives, rather than the hot-path core (which
// stays C# in `Gsharp.Runtime.Channels`, per D1).
//
// Layout decisions:
//   * `package Gsharp.Concurrency` — the same namespace as `Chan[T]`, `Context`
//     and the rest of the runtime, because that namespace is implicitly
//     imported. A helper here is an ordinary name in an ordinary namespace: no
//     import to remember, and a program that wants the name for itself simply
//     declares its own (a user-defined `after` shadows this one).
//   * Top-level functions rather than a class with a `shared { … }` block, so
//     `after(d)` reads as a function call and not `Timers.After(d)`. They emit
//     as statics on `Gsharp.Concurrency.<Program>` and are reached by bare name
//     through the import hoisting ADR-0134 already does for package imports.
//   * `after` and `tick` return the runtime's timers, which are
//     `ISelectable[DateTime]` rather than channels — a select arm accepts
//     anything selectable (D8), so `case <-after(d)` works without pretending a
//     timer is a channel, and `tick`'s result stays `Dispose`-able.

package Gsharp.Concurrency

import System

/// A timer that fires once, after `due` — G#'s `time.After`.
///
/// Select on it for a timeout arm. The timer holds a CLR `Timer` until it
/// fires, so a one-shot needs no cleanup; a repeating
/// [tick](cref:Gsharp.Concurrency.tick) does.
///
/// ```gs
/// select {
/// case let v = <-work {
///     handle(v)
/// }
/// case <-after(TimeSpan.FromSeconds(2)) {
///     Console.WriteLine("timed out")
/// }
/// }
/// ```
/// @param due How long to wait before firing.
/// @returns A selectable that yields the firing time, once.
public func after(due TimeSpan) AfterTimer {
    return Timers.After(due)
}

/// A timer that fires repeatedly, every `period` — G#'s `time.Tick`.
///
/// Unlike `after`, this one keeps firing until it is disposed, so it leaks a
/// CLR timer if it is dropped: hold it in a `using let`, or dispose it when the
/// loop that selects on it ends. At most one tick is pending at a time — a
/// consumer that falls behind sees ticks dropped rather than queued.
/// @param period The interval between firings.
/// @returns A selectable that yields each firing time.
public func tick(period TimeSpan) TickTimer {
    return Timers.Tick(period)
}

/// Fans several channels into one — G#'s `merge`.
///
/// Every input is drained concurrently into the returned channel, which is
/// closed once every input has closed. The result is receive-only: the caller
/// consumes it, and only `merge` writes to it.
///
/// ```gs
/// for v in merge(left, right) {
///     Console.WriteLine(v)
/// }
/// ```
/// @param inputs The channels to drain.
/// @returns A receive-only channel carrying every input's values.
public func merge[T](inputs ...chan[T]) in chan[T] {
    let merged = Chan.Unbounded[T]()
    go mergeInto[T](merged, inputs)
    return merged
}

// Drains every input into `merged` under a scope, so `merged` is closed only
// once every forwarder has finished — including when one of them fails, in
// which case the scope's exception reaches the free-goroutine hook rather than
// leaving the consumer waiting on a channel nobody will close.
func mergeInto[T](merged chan[T], inputs []chan[T]) {
    try {
        scope {
            for input in inputs {
                go forwardInto[T](input, merged)
            }
        }
    } finally {
        merged.Close()
    }
}

func forwardInto[T](input in chan[T], merged out chan[T]) {
    for value in input {
        merged <- value
    }
}
