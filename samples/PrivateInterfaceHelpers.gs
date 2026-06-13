// file: PrivateInterfaceHelpers.gs
//
// ADR-0090 / issue #756: `private` helper methods inside an interface.
// Private interface helpers are part of the interface's own implementation
// — sibling default methods can call them via implicit `this`, but
// implementers and external code cannot see them. CLR emit targets
// `.method private hidebysig instance` with a body on the interface
// TypeDef; the helper is NOT part of the interface's v-table. The
// interpreter mirrors the same dispatch.

package GSharp.Samples.PrivateInterfaceHelpers

import System

interface ICalculator {
    // Public default method — visible to all callers.
    func Double(x int32) int32 {
        return Helper(x) + Helper(x)
    }

    // Public default that also leans on the helper.
    func Triple(x int32) int32 {
        return Helper(x) + Helper(x) + Helper(x)
    }

    // Private helper — only sibling default methods may call it.
    // Implementers cannot override it; external code cannot see it.
    private func Helper(x int32) int32 {
        return x
    }
}

class Calc : ICalculator {
}

class CustomCalc : ICalculator {
    // Custom override of the public default — the private helper remains
    // invisible to this implementer; it sees only the public surface.
    func Double(x int32) int32 {
        return x * 4
    }
}

var c = Calc{}
Console.WriteLine(c.Double(5))
Console.WriteLine(c.Triple(5))

var cc ICalculator = CustomCalc{}
Console.WriteLine(cc.Double(5))
Console.WriteLine(cc.Triple(5))
