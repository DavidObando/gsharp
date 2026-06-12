// file: GsharpExtensionsOptional.gs
// Issue #724 / ADR-0084: idiomatic helpers over T? from Gsharp.Extensions.
// Demonstrates Map / FlatMap / OrElse / OrCompute / OrThrow / IfPresent /
// Filter on reference-typed nullables, plus the value-typed *Value
// companions (MapValue / OrElseValue / FilterValue / IfPresentValue).
// The Gsharp.Extensions.* namespaces are explicit-import only — nothing here
// is auto-imported, even with the implicit-imports compiler option enabled.

package GSharp.Example.OptionalHelpers

import System
import Gsharp.Extensions.Optional

// --- Reference-typed nullables (T : class) -----------------------------------

let name string? = "ada"

// Map: lift a pure function over the present value.
let upper = name.Map(func(s string) string { return s.ToUpper() })
Console.WriteLine(upper ?: "<absent>")

// FlatMap: chain a function that itself returns T?.
let firstChar = upper.FlatMap(func(s string) string? {
    if s.Length > 0 {
        return s.Substring(0, 1)
    }
    return nil
})
Console.WriteLine(firstChar ?: "<absent>")

// OrElse: project to a non-nullable fallback.
let absent string? = nil
Console.WriteLine(absent.OrElse("default"))

// OrCompute: lazily compute the fallback only when absent.
Console.WriteLine(absent.OrCompute(func() string { return "computed" }))

// Filter: drop the value when it fails the predicate.
let short = name.Filter(func(s string) bool { return s.Length <= 2 })
Console.WriteLine(short ?: "<filtered out>")

// IfPresent: side-effect only when present.
name.IfPresent(func(s string) {
    Console.WriteLine("present: " + s)
})

absent.IfPresent(func(s string) {
    Console.WriteLine("(this should not print)")
})

// OrThrow: project to T or raise; we demonstrate the happy path here.
Console.WriteLine(name.OrThrow("name was missing"))

// --- Value-typed nullables (T : struct) --------------------------------------
// G# overload resolution does not currently honour CLR generic constraints
// (see ADR-0084 Known Limitations / language gap #L1). Value-typed helpers
// therefore live under the *Value name suffix.

let count int32? = 7
let doubled = count.MapValue(func(n int32) int32 { return n * 2 })
Console.WriteLine(doubled.OrElseValue(-1))

let none int32? = nil
Console.WriteLine(none.OrElseValue(-1))

let positive = count.FilterValue(func(n int32) bool { return n > 0 })
Console.WriteLine(positive.OrElseValue(-1))

count.IfPresentValue(func(n int32) {
    Console.WriteLine("count present: " + n.ToString())
})
