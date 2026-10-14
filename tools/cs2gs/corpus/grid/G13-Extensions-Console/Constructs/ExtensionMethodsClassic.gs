// inventory: MethodDeclaration — classic `this`-parameter extension methods
// Extension methods on BCL types (string, int) and on a user type, including
// a chained call of the same extension.

package Corpus.Grid13.Constructs

import System

class Box {
    init(value int32) {
        Value = value
    }

    prop Value int32 {
        get;
    }
}

shared class ClassicExtensions { }

@ExtensionOwner(typeof(ClassicExtensions))
func (value string) Bracketed() string {
    return "[" + value + "]"
}

@ExtensionOwner(typeof(ClassicExtensions))
func (value int32) Squared() int32 {
    return value * value
}

@ExtensionOwner(typeof(ClassicExtensions))
func (box Box) Doubled() int32 {
    return box.Value * 2
}

shared class ExtensionMethodsClassicFixture {
    func Run() {
        Console.WriteLine("ExtensionMethodsClassic: bracketed=${"hi".Bracketed()}")
        // Issue #1883: an extension method invoked directly on an int
        // literal (`7.Squared()`) must translate to a parenthesized
        // receiver (`(7).Squared()`) — G#'s grammar never chains postfix
        // access onto a bare numeric-literal token (ADR-0054), so an
        // unparenthesized `7.Squared()` fails to parse (GS0005/GS0157).
        Console.WriteLine("ExtensionMethodsClassic: squared=${(7).Squared()}")
        let box = Box(21)
        Console.WriteLine("ExtensionMethodsClassic: userType=${ClassicExtensions.Doubled(box)}")
        Console.WriteLine("ExtensionMethodsClassic: chained=${"x".Bracketed().Bracketed()}")
    }
}
