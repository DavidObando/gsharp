// file: Loop.gs
// Demonstrates statements added across Phases 1 and 2: implicit
// `import System` (Phase 1.5), string interpolation (Phase 1.1),
// the C-style `for init; cond; post { … }` clause form (Phase 2.4),
// and the `i--` decrement statement (Phase 2.2). This is the v0.1
// design — see `design/Gsharp-design-v0.1.md` and ADR-0010.

package GSharp.Example.Loop

import System

var count = 5

for var i = count; i > 0; i-- {
    Console.WriteLine("Count value: $i")
}
