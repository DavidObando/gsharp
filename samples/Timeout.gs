// file: Timeout.gs
//
// ADR-0174 pattern 8: a timeout, in three lines. `after(d)` is a selectable
// timer from the implicitly imported `Gsharp.Concurrency` package, so a
// timeout arm is an ordinary `select` receive — Go's `case <-time.After(d)`
// with the same shape.
//
// The second select shows the other end of the same mechanism: `case
// cancelled` turns the block's cancellation into an arm rather than an unwind,
// which is what Go spells `case <-ctx.Done()`.

package GSharp.Samples.Timeout

import Gsharp.Concurrency
import System

let quiet = chan [int32](1)

scope {
    select {
        case let v = <- quiet {
            Console.WriteLine("got value: $v")
        }
        case <- after(TimeSpan.FromMilliseconds(50)) {
            Console.WriteLine("timed out")
        }
    }
}

scope {
    ctx.TryCancel()
    select {
        case let v = <- quiet {
            Console.WriteLine("got value: $v")
        }
        case cancelled {
            Console.WriteLine("cancelled")
        }
    }
}
