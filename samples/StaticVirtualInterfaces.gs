// file: StaticVirtualInterfaces.gs
//
// ADR-0089 / issue #755: static-virtual interface members (SVIM). An
// interface may declare `static func` members — both abstract (no body)
// and default (with body). Implementers supply the static via the
// existing `shared { ... }` block. A generic method constrained by the
// interface can dispatch through `T.M(...)` and the call resolves to
// the implementer's static method (CLR-level
// `constrained. !!T  call <iface>::<method>`).

package GSharp.Samples.StaticVirtualInterfaces

import System

// An abstract static slot ("static abstract"): every implementer MUST
// supply Add. A default body would make the slot "static virtual" —
// implementers may override but don't have to.
sealed interface IAdd {
    static func Add(a int32, b int32) int32

    static func Zero() int32 {
        return 0
    }
}

class Plus : IAdd {
    shared {
        func Add(a int32, b int32) int32 {
            return a + b
        }
    }
}

class Times : IAdd {
    shared {
        func Add(a int32, b int32) int32 {
            return a * b
        }

        // Override the default Zero too — for multiplication the
        // identity element is 1, not 0.
        func Zero() int32 {
            return 1
        }
    }
}

// Apply takes a witness T value (the type-arg inference workaround used
// by both backends — see ADR-0089 §6 / ADR-0087 R5-R7) and dispatches
// through the interface's static slots.
func Apply[T IAdd](w T, a int32, b int32) int32 {
    return T.Add(a, b)
}

func IdentityOf[T IAdd](w T) int32 {
    return T.Zero()
}

Console.WriteLine(Apply(Plus{}, 3, 4))
Console.WriteLine(Apply(Times{}, 3, 4))
Console.WriteLine(IdentityOf(Plus{}))
Console.WriteLine(IdentityOf(Times{}))
