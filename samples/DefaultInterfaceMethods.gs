// file: DefaultInterfaceMethods.gs
//
// ADR-0085 / issue #726: default-interface methods (DIM). Interfaces may
// carry method bodies that implementers inherit unless they explicitly
// override. CLR-level emission targets `.method virtual` with a body on
// the interface TypeDef; the interpreter mirrors the same dispatch.

package GSharp.Samples.DefaultInterfaceMethods

import System

interface IGreeter {
    func Hello() string {
        return "hello (default)"
    }

    func Required(name string) string
}

class Quiet : IGreeter {
    func Required(name string) string {
        return "(quiet) $name"
    }
}

class Loud : IGreeter {
    func Hello() string {
        return "HELLO (override)"
    }

    func Required(name string) string {
        return "(loud) $name"
    }
}

// Direct dispatch on the runtime class type — Quiet inherits the default,
// Loud uses its override.
var q = Quiet{}
var l = Loud{}
Console.WriteLine(q.Hello())
Console.WriteLine(l.Hello())
Console.WriteLine(q.Required("Ada"))
Console.WriteLine(l.Required("Eva"))

// Dispatch through an interface-typed reference — same semantics, but the
// call site uses the interface slot.
var g IGreeter = q
Console.WriteLine(g.Hello())
g = l
Console.WriteLine(g.Hello())
