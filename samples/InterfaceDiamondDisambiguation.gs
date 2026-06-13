// file: InterfaceDiamondDisambiguation.gs
//
// ADR-0091 / issue #757: explicit-base interface call syntax for
// default-interface-method (DIM) diamond disambiguation. When a class
// implements two interfaces that both provide a default for `M()` ADR-0085
// requires the class to override and disambiguate. ADR-0091 lets the
// override delegate to one (or both) of the inherited defaults via
// `base[IFoo].M()` — a non-virtual `call instance ... IFoo::M(...)` so the
// inherited body is invoked rather than re-dispatched through the v-table.

package GSharp.Samples.InterfaceDiamondDisambiguation

import System

interface ILeft {
    func Tag() string {
        return "L"
    }
}

interface IRight {
    func Tag() string {
        return "R"
    }
}

// Diamond disambiguation: combine both inherited defaults via explicit
// base calls.
class Combined : ILeft, IRight {
    func Tag() string {
        return base[ILeft].Tag() + base[IRight].Tag()
    }
}

// "default + extra logic": a single inherited default reached through
// the base-call, augmented with a suffix.
interface IGreeter {
    func Hello() string {
        return "hi"
    }
}

class Loud : IGreeter {
    func Hello() string {
        return base[IGreeter].Hello() + "!"
    }
}

var c = Combined{}
var l = Loud{}
Console.WriteLine(c.Tag())
Console.WriteLine(l.Hello())

// Interface-typed receivers dispatch virtually through the override —
// which itself uses the non-virtual `call` from ADR-0091 to reach the
// inherited defaults. Same answer either way.
var il ILeft = c
var ir IRight = c
Console.WriteLine(il.Tag())
Console.WriteLine(ir.Tag())
