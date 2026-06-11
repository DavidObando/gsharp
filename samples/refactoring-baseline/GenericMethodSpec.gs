// file: GenericMethodSpec.gs
// Wave-1 P3-7 dedup: a call into a generic method whose type-argument is a
// user-declared type. Mirrors samples/GenericMethodUserTypeArg.gs but kept
// minimal — locks the MethodSpec cache key shape for user-type generic args.

package GSharp.Refactoring.GenericMethodSpec

import System

type Tag class {
    var Name string
}

var empties = Array.Empty[Tag]()
Console.WriteLine(empties.Length)

var t = Activator.CreateInstance[Tag]()
Console.WriteLine(t.Name == nil)


