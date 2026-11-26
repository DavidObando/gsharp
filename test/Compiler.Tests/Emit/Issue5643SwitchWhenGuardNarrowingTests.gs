// <copyright file="Issue5643SwitchWhenGuardNarrowingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System.Collections.Generic
import Xunit

class Issue5643SwitchWhenGuardNarrowingTests {
    @Theory
    @MemberData("Rows")
    func RealDriver_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        Issue5470And5657RegionWalkerTests().EveryProbe_MatchesExpectedResult(
            name,
            source,
            expectedDiagnostics,
            kind,
            expectedOutput
        )
    }

    shared {
        public func Rows() IEnumerable[[]object] {
            yield []object{"repro_5643_when_nil_check_infers_string", `import System
func Run(s string?, n int32) int32 {
    let t = switch n { case 1 when s != nil: s default: "x" }
    let z string = t
    return z.Length
}
Console.WriteLine(Run("ab", 1))
Console.WriteLine(Run(nil, 1))`, "", "run", "2|1"}
            yield []object{"backward_goto_with_when_guard_narrows_arm_result", `import System
func Run(s string?, n int32) int32 {
    var cur = s
    var count = 0
    if cur != nil {
        Again:
        let t = switch n { case 1 when cur != nil: cur default: "x" }
        let z string = t
        count += z.Length
        if count < 3 {
            cur = nil
            goto Again
        }
    }
    return count
}
Console.WriteLine(Run("ab", 1))`, "", "run", "3"}
            yield []object{"backward_goto_without_when_guard_still_rejects", `import System
func Run(s string?, n int32) int32 {
    var cur = s
    if cur != nil {
        Again:
        let t string = switch n { case 1: cur default: "x" }
        if t.Length > 0 {
            cur = nil
            goto Again
        }
    }
    return 0
}
Console.WriteLine(Run("ab", 1))`, "GS0155@6:43", "reject", ""}
            yield []object{"pattern_variable_and_compound_when_guards_narrow", `import System
open class Base {
    var Label string = "base"
}
class Derived : Base {
    func Tag() string -> "derived:" + Label
}
class Box {
    let Text string? = "ok"
}
func Run(o object?, s string?, b Base, box Box?, n int32) string {
    let a string = switch o {
        case x is string? when x != nil: x
        default: "none"
    }
    let c string = switch n {
        case 1 when s != nil && s.Length > 1: s
        default: "short"
    }
    let d string = switch n {
        case 1 when b is Derived derived: derived.Tag()
        default: "other"
    }
    let e string = switch n {
        case 1 when box?.Text != nil: box.Text
        default: "nil"
    }
    return a + "|" + c + "|" + d + "|" + e
}
Console.WriteLine(Run("hi", "abc", Derived{Label: "x"}, Box{}, 1))
Console.WriteLine(Run(nil, "a", Base{}, nil, 1))`, "", "run", "hi|abc|derived:x|ok|none|short|other|nil"}
            yield []object{"null_conditional_length_when_guard_narrows_string", `import System
func Run(s string?, n int32) int32 {
    return switch n {
        case 1 when s?.Length != nil: s.Length
        default: -1
    }
}
Console.WriteLine(Run("abc", 1))
Console.WriteLine(Run(nil, 1))`, "", "run", "3|-1"}
            yield []object{"default_before_guarded_arm_with_clear_then_renarrow", `import System
func Run(n int32, drop bool) string {
    var s string? = "init"
    let touch = () -> {
        if drop {
            s = nil
        }
        return true
    }
    if s != nil {
        let t = switch n {
            default: "default"
            case 1 when touch() && s != nil: s
        }
        let z string = t
        return z
    }
    return "none"
}
Console.WriteLine(Run(1, false))
Console.WriteLine(Run(1, true))
Console.WriteLine(Run(0, false))`, "", "run", "init|default|default"}
            yield []object{"negative_guard_mutates_after_check_rejects", `import System
func Run(n int32) int32 {
    var s string? = "ab"
    let clear = () -> {
        s = nil
        return true
    }
    return switch n {
        case 1 when s != nil && clear(): s.Length
        default: 0
    }
}
Console.WriteLine(Run(1))`, "GS0158@9:44", "reject", ""}
            yield []object{"negative_second_arm_does_not_inherit_first_arm_guard", `import System
func Run(n int32) int32 {
    var s string? = "ab"
    return switch n {
        case 1 when s != nil: s.Length
        case 2: s.Length
        default: 0
    }
}
Console.WriteLine(Run(2))`, "GS0158@6:19", "reject", ""}
            yield []object{"negative_null_conditional_guard_mutating_receiver_rejects", `import System
class Box {
    var Text string? = "ok"
    func Touch(cb () -> void) string? {
        cb()
        return Text
    }
}
func Run(n int32) int32 {
    var box Box? = Box{}
    let clear = () -> { box = nil }
    return switch n {
        case 1 when box?.Touch(clear) != nil: (box.Text ?? "").Length
        default: 0
    }
}
Console.WriteLine(Run(1))`, "GS0158@13:52", "reject", ""}
        }
    }
}
