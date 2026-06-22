// file: GsharpExtensionsOptional.gs
// Issue #724 / ADR-0084: idiomatic helpers over T? from Gsharp.Extensions.
// Demonstrates Map / FlatMap / OrElse / OrCompute / OrThrow / IfPresent /
// Filter on both reference-typed and value-typed nullables. After
// ADR-0088 / issue #750 the value-typed surface uses the same names as
// the reference-typed surface: the G# binder honours generic constraints
// (`where T : class` vs `where T : struct`) during overload resolution
// and picks the correct overload based on the receiver type.
// Issue #752 / ADR-0084 L3 also closed the last value-typed gap: the
// null-coalescing (`??`) operator now emits verifiable IL on a nullable struct
// receiver, so `count ?? -1` is preferred over `.OrElse(-1)` in
// idiomatic G# code (the helper remains available for lazy/computed
// fallbacks and for receiver clauses that need a method call shape).
// The Gsharp.Extensions.* namespaces are explicit-import only — nothing here
// is auto-imported, even with the implicit-imports compiler option enabled.

package GSharp.Example.OptionalHelpers

import System
import Gsharp.Extensions.Optional

// --- Reference-typed nullables (T : class) -----------------------------------

let name string? = "ada"

// Map: lift a pure function over the present value.
let upper = name.Map(func(s string) string { return s.ToUpper() })
Console.WriteLine(upper ?? "<absent>")

// FlatMap: chain a function that itself returns T?.
let firstChar = upper.FlatMap(func(s string) string? {
    if s.Length > 0 {
        return s.Substring(0, 1)
    }
    return nil
})
Console.WriteLine(firstChar ?? "<absent>")

// OrElse: project to a non-nullable fallback.
let absent string? = nil
Console.WriteLine(absent.OrElse("default"))

// OrCompute: lazily compute the fallback only when absent.
Console.WriteLine(absent.OrCompute(func() string { return "computed" }))

// Filter: drop the value when it fails the predicate.
let short = name.Filter(func(s string) bool { return s.Length <= 2 })
Console.WriteLine(short ?? "<filtered out>")

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
// ADR-0088 / issue #750: the binder picks the struct overload based on the
// receiver's CLR shape (Nullable<T>) and the `where T : struct` constraint.
// Issue #752 / ADR-0084 L3: `??` is now the canonical fallback shape; the
// `OrCompute` helper remains for the deferred-default case.

let count int32? = 7
let doubled = count.Map(func(n int32) int32 { return n * 2 })
Console.WriteLine(doubled ?? -1)

let none int32? = nil
Console.WriteLine(none ?? -1)

let positive = count.Filter(func(n int32) bool { return n > 0 })
Console.WriteLine(positive ?? -1)

count.IfPresent(func(n int32) {
    Console.WriteLine("count present: " + n.ToString())
})
