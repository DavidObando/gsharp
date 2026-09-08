// file: NullCoalescingAssignment.gs
// ADR-0072 / issue #709: demonstrates the new `??=` null-coalescing
// compound assignment statement. `a ??= b` reads `a` once; if the
// current value is nil, it evaluates `b` (also once) and writes it
// through the same lvalue. Otherwise the right-hand side is not
// evaluated at all. Each block prints a small, unmistakable line so
// a reviewer can read the golden top-to-bottom and match it against
// the source.

package GSharp.Example.NullCoalescingAssignment

import System

// 1. Local nullable-reference target. The first `??=` fills in the
// default; the second is a no-op because the variable is already set.
var greeting string? = nil
greeting ??= "hello"
Console.WriteLine(greeting)
greeting ??= "ignored"
Console.WriteLine(greeting)

// 2. Local nullable value-type target. Same semantics — the second
// `??=` does not overwrite the already-set value.
var answer int32? = nil
answer ??= 42
Console.WriteLine(answer)
answer ??= 99
Console.WriteLine(answer)

// 3. Field LHS on a class instance. The receiver `b` is evaluated
// once; the field write goes through the live reference, so other
// aliases observe it too.
class Box {
    var Name string?
}

var b = Box{Name: nil}
b.Name ??= "set"
Console.WriteLine(b.Name)
b.Name ??= "ignored"
Console.WriteLine(b.Name)

// 4. Single-evaluation of the right-hand side. `computeDefault` runs
// only when the current value is nil — the second `??=` does not
// invoke it because the variable already holds a value.
var counter int32 = 0
func computeDefault() string {
    counter = counter + 1
    return "computed"
}

var slot string? = nil
slot ??= computeDefault()
Console.WriteLine("slot=$slot counter=$counter")
slot ??= computeDefault()
Console.WriteLine("slot=$slot counter=$counter")
