// file: GenericMethodTypeArgs.gs
// Issue #311: invoking a generic method with an EXPLICIT type-argument list
// (`Method[T](...)`) is supported for imported CLR methods. This covers the
// forms that type inference cannot supply because the type argument *is* the
// information being provided (e.g. `Array.Empty[T]()`, `Enumerable.Empty[T]()`).
// All calls below run under bare `gsc /targetframework` (no explicit `/r:`),
// keeping the sample independent of the cross-load-context concern (#310).

package GSharp.Example.GenericMethodTypeArgs

import System
import System.Linq
import System.Collections.Generic

// Static generic method, single explicit type argument, no value arguments.
// Inference cannot supply the element type, so the explicit `[string]` is
// required.
var emptyStrings = Array.Empty[string]()
Console.WriteLine(emptyStrings.Length)

// Static generic method on a LINQ helper with an explicit type argument.
var emptyInts = Enumerable.Empty[int32]()
Console.WriteLine(emptyInts.Count())

// Static generic method with MULTIPLE explicit type arguments.
var pair = KeyValuePair.Create[string, int32]("answer", 42)
Console.WriteLine(pair.Key)
Console.WriteLine(pair.Value)

// Generic extension method invoked with instance syntax and an explicit type
// argument (overriding what inference would otherwise compute).
var words = List[string]()
words.Add("alpha")
words.Add("beta")
var wordArray = words.ToArray[string]()
Console.WriteLine(wordArray.Length)

// Type inference still works alongside the explicit form.
var repeated = Enumerable.Repeat("x", 3)
Console.WriteLine(repeated.Count())
