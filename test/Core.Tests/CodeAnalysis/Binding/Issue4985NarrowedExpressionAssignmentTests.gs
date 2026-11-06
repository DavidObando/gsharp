// <copyright file="Issue4985NarrowedExpressionAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit

/// Issue #4985: an assignment inside an expression that sits in a narrowed
/// region (`if` statement, `if` expression, `&&`, `||`, ternary `?:`, `switch`
/// expression, or indexed write) invalidates the narrowing before any later
/// operand of the same expression is evaluated.
open class Issue4985NarrowedExpressionAssignmentTests {
    @Theory
    @MemberData("RejectedShapes")
    func AssignmentInsideNarrowedExpression_InvalidatesLaterReadAndReportsDiagnostic(
        name string,
        source string,
        expectedDiagnosticId string,
        expectedLine int32,
        expectedCharacter int32
    ) {
        let result = EmittedOracle.Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Id == expectedDiagnosticId &&
                d
                .Location
                .StartLine +
                1 == expectedLine &&
                d
                .Location
                .StartCharacter +
                1 == expectedCharacter
        )
    }

    @Theory
    @MemberData("AcceptedControlShapes")
    func ReadBeforeAssignmentInsideNarrowedExpression_RemainsValidAndRuns(
        name string,
        source string,
        expectedOutput string
    ) {
        let result = EmittedOracle.Evaluate(source)
        Assert.True(
            result.Diagnostics.IsEmpty,
            "${name}: unexpected diagnostics: " + string.Join("; ", result.Diagnostics)
        )
        Assert.Equal(expectedOutput + Environment.NewLine, result.Output.ReplaceLineEndings(Environment.NewLine))
    }

    shared {
        func RejectedShapes() IEnumerable[[]object] {
            yield[]object{"if_statement_argument_assignment", `import System
func consume(a string?, n int32) int32 -> n
func ifs(p string?) int32 {
    var s = p
    if s != nil { return consume((s = nil), s.Length) }
    return 0
}
Console.WriteLine(ifs("abc"))`, "GS0158", 5, 47}
            yield[]object{"if_expression_argument_assignment", `import System
func consume(a string?, n int32) int32 -> n
func ifx(p string?) int32 {
    var s = p
    return if s != nil { consume((s = nil), s.Length) } else { 0 }
}
Console.WriteLine(ifx("abc"))`, "GS0158", 5, 47}
            yield[]object{"logical_and_argument_assignment", `import System
func consume(a string?, n int32) int32 -> n
func andx(p string?) bool {
    var s = p
    return s != nil && consume((s = nil), s.Length) > 0
}
Console.WriteLine(andx("abc"))`, "GS0158", 5, 45}
            yield[]object{"ternary_conditional_argument_assignment", `import System
func consume(a string?, n int32) int32 -> n
func tern(p string?) int32 {
    var s = p
    return s != nil ? consume((s = nil), s.Length) : 0
}
Console.WriteLine(tern("abc"))`, "GS0158", 5, 44}
            yield[]object{"logical_or_argument_assignment", `import System
func consume(a string?, n int32) int32 -> n
func orx(p string?) bool {
    var s = p
    return s == nil || consume((s = nil), s.Length) > 0
}
Console.WriteLine(orx("abc"))`, "GS0158", 5, 45}
            yield[]object{"switch_expression_arm_argument_assignment", `import System
func consume(a string?, n int32) int32 -> n
func swx(p string?) int32 {
    var s = p
    return switch s {
        case is string: consume((s = nil), s.Length)
        default: 0
    }
}
Console.WriteLine(swx("abc"))`, "GS0158", 6, 46}
            yield[]object{"native_slice_index_assignment_invalidates_rhs", `import System
func Run(backing []int32, seed string?) int32 {
    var s = seed
    let sp = span[int32](backing)
    if s != nil {
        sp[(s = nil) == nil ? 0 : 1] = s.Length
        return sp[0]
    }
    return 0
}
Console.WriteLine(Run([]int32{1, 2}, "abc"))`, "GS0158", 6, 42}
            yield[]object{"native_slice_compound_index_assignment_invalidates_rhs", `import System
func Run(backing []int32, seed string?) int32 {
    var s = seed
    let sp = span[int32](backing)
    if s != nil {
        sp[(s = nil) == nil ? 0 : 1] += s.Length
        return sp[0]
    }
    return 0
}
Console.WriteLine(Run([]int32{1, 2}, "abc"))`, "GS0158", 6, 43}
            yield[]object{"from_end_index_assignment_invalidates_rhs", `import System
func Run(arr []int32, seed string?) int32 {
    var s = seed
    if s != nil {
        arr[^((s = nil) == nil ? 1 : 2)] = s.Length
        return arr[0]
    }
    return 0
}
Console.WriteLine(Run([]int32{1, 2}, "abc"))`, "GS0158", 5, 46}
        }

        func AcceptedControlShapes() IEnumerable[[]object] {
            yield[]object{"read_before_assignment_in_if_statement", `import System
func consume(n int32, a string?) int32 -> n
func ifs(p string?) int32 {
    var s = p
    if s != nil { return consume(s.Length, (s = nil)) }
    return 0
}
Console.WriteLine(ifs("abc"))`, "3"}
            yield[]object{"read_before_assignment_in_if_expression", `import System
func consume(n int32, a string?) int32 -> n
func ifx(p string?) int32 {
    var s = p
    return if s != nil { consume(s.Length, (s = nil)) } else { 0 }
}
Console.WriteLine(ifx("abc"))`, "3"}
            yield[]object{"read_before_assignment_in_logical_and", `import System
func consume(n int32, a string?) int32 -> n
func andx(p string?) bool {
    var s = p
    return s != nil && consume(s.Length, (s = nil)) == 3
}
Console.WriteLine(andx("abc"))`, "True"}
            yield[]object{"read_before_assignment_in_ternary", `import System
func consume(n int32, a string?) int32 -> n
func tern(p string?) int32 {
    var s = p
    return s != nil ? consume(s.Length, (s = nil)) : 0
}
Console.WriteLine(tern("abc"))`, "3"}
        }
    }
}
