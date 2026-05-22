// file: Loop.gs
// Demonstrates the constructs the front-end accepts today: top-level
// statements, var declarations, the `for i := lo ... hi` range form,
// BCL interop via `Console.WriteLine`, and string interpolation
// (Phase 1.1). The original aspirational form (C-style for, decrement,
// `args[0]` indexing) is preserved in `design/Gsharp-design-v0.1.md`
// and will be reintroduced as later phases land — see
// `docs/adr/0010-aspirational-samples.md`.

package GSharp.Example.Loop

import System

var count = 5

// `lo ... hi` is half-open (prints `lo` through `hi - 1`),
// so use `count + 1` to print 1 through `count` inclusive.
for i := 1 ... count + 1 {
    Console.WriteLine("Count value: $i")
}
