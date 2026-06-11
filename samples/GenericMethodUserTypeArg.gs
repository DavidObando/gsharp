// file: GenericMethodUserTypeArg.gs
// Issue #320: imported generic methods called with an explicit *user-defined*
// type as the type argument (e.g. `Array.Empty[Clock]()`,
// `Activator.CreateInstance[Clock]()`). Previously these failed with GS0159
// because a user type has no host CLR type during binding; the type argument
// is now closed with a placeholder and the real user-type token is emitted in
// the method specification, so reflection-based generics (`typeof(T)`) work.

package GSharp.Example.GenericMethodUserTypeArg

import System

type Clock class {
    var Ticks int32
    func Read() int32 {
        return Ticks
    }
}

// `Activator.CreateInstance[T]()` returns a bare `T`; the binder recovers the
// real `Clock` return type and the spec carries `Clock`, so `typeof(T)` inside
// the BCL method resolves to the emitted user type and constructs a `Clock`.
var c = Activator.CreateInstance[Clock]()
Console.WriteLine(c.Read())

// `Array.Empty[T]()` returns `T[]`; the user type flows through the method
// specification and the call returns an empty `Clock[]`.
var arr = Array.Empty[Clock]()
Console.WriteLine(arr.Length)

var c2 = Activator.CreateInstance[Clock]()
Console.WriteLine(c2.Read() + arr.Length)
