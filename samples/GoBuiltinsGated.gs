// file: GoBuiltinsGated.gs
//
// Issue #723 / ADR-0083. End-to-end sample for the per-file gate on
// the Go-style built-in functions. Every gated built-in below is
// exercised at least once — `len` (slice / string / map receiver),
// `cap` (slice receiver), `append` (slice receiver), and
// `delete(map, key)`. The channel-cluster built-ins (`close(ch)` and
// `make(chan T)`, gated through ADR-0082 / GS0316) round out the
// surface by showing the two diagnostics share the same import root.
//
// The single line that makes all of this legal is the
// `import Gsharp.Extensions.Go` below the package declaration.
// Removing it makes the binder emit GS0317 for `len`, `cap`,
// `append`, and `delete`, and GS0316 for `close` and the `chan T`
// type clause inside `make(chan ...)`.
//
// The output is deterministic so the sample participates in the
// regular SampleConformance harness.

package GSharp.Samples.GoBuiltinsGated

import System
import Gsharp.Extensions.Go

// len / cap / append on a slice.
var xs = []int32{10, 20, 30}
Console.WriteLine(len(xs))
Console.WriteLine(cap(xs))
xs = append(xs, 40)
Console.WriteLine(len(xs))
Console.WriteLine(xs[3])

// len on a string.
Console.WriteLine(len("hello"))

// len / delete on a map.
var m = map[string,int32]{"a": 1, "b": 2, "c": 3}
Console.WriteLine(len(m))
delete(m, "b")
Console.WriteLine(len(m))

// close + make(chan T) — ADR-0082 / GS0316 surface.
let ch = make(chan int32, 1)
ch <- 7
close(ch)
let v = <-ch
Console.WriteLine(v)
