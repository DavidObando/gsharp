// file: NullableValueMember.gs
// Issue #517 (fixed): Nullable[T].Value / .HasValue exposed as instance
// members. Pins the lifted member-lookup shape for the read path.

package GSharp.Refactoring.NullableValueMember

import System

var s string? = "hi"
var n int32? = s?.Length
if n.HasValue {
    Console.WriteLine(n.Value)
} else {
    Console.WriteLine("none")
}
