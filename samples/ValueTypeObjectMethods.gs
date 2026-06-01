// file: ValueTypeObjectMethods.gs
// Regression coverage: calling a System.Object/System.ValueType method that a
// value-type receiver inherits (rather than overrides) must box the receiver.
// GetType() in particular is declared on System.Object, so a double/int32/bool
// receiver has to be boxed before the call. Without the box the raw value bits
// are reinterpreted as an object reference, which throws AccessViolationException
// (double) or NullReferenceException (int32) at runtime.

package GSharp.Example.ValueTypeObjectMethods

import System

const half = 100.0

let a = (half / 2.0)
let b = (100.0 / 2.0)
let n = 42
let flag = true

Console.WriteLine(a.GetType())
Console.WriteLine(b.GetType())
Console.WriteLine(n.GetType())
Console.WriteLine(flag.GetType())

// Methods the value type overrides itself resolve directly (no box).
Console.WriteLine(a.ToString())
Console.WriteLine(n.ToString())
Console.WriteLine(n.Equals(42))
