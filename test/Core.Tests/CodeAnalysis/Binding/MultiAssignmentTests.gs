// <copyright file="MultiAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 2.3: `a, b = b, a` multi-target assignment with sequential
/// evaluation via synthesized temporaries. The short-var multi-decl form
/// `a, b := 1, 2` was removed by ADR-0077 / issue #717; the parser
/// now emits GS0305 for that spelling — covered by
/// (cref:GSharp.Core.Tests.CodeAnalysis.Syntax.Issue717ColonEqualsRemovedParserTests).
/// ADR-0168 instead permits explicit fresh targets such as
/// `existing, let fresh = Pair()`.
open class MultiAssignmentTests {
    @Fact
    func MutableTupleDeconstruction_WithDiscard_Executes() {
        let result = EmittedOracle.Evaluate(`var kept = 0
kept, _ = (7, 2)
kept`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func MutableTupleDeclaration_Executes() {
        let result = EmittedOracle.Evaluate(`var (left, right) = (3, 4)
left = 5
(left * 10) + right`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(54, result.Value)
    }

    @Fact
    func MixedFreshAndExistingTargets_Execute() {
        let result = EmittedOracle.Evaluate(`var existing = 0
existing, let fresh = (2, 3)
var mutableExisting = 0
var mutable, mutableExisting = 4, 5
mutable = 6
(existing * 1000) + (fresh * 100) + (mutable * 10) + mutableExisting`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2365, result.Value)
    }

    @Fact
    func MultiDecl_AsTwoVarLines_Binds() {
        Assert.Empty(Bind(`func F() {
 var a = 1
 var b = 2
 var s = a + b
 }
`))
    }

    @Fact
    func MultiAssignment_Swap_Binds() {
        Assert.Empty(Bind(`func F() {
 var a = 1
 var b = 2
 a, b = b, a
 }
`))
    }

    @Fact
    func MultiAssignment_Three_Way_Binds() {
        Assert.Empty(Bind(`func F() {
 var a = 1
 var b = 2
 var c = 3
 a, b, c = c, a, b
 }
`))
    }

    @Fact
    func MultiAssignment_Count_Mismatch_Reports_Error() {
        let diagnostics = Bind(`func F() {
 var a = 1
 var b = 2
 a, b = 1, 2, 3
 }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("target", StringComparison.OrdinalIgnoreCase))
    }

    @Fact
    func MultiAssignment_To_Readonly_Reports_Error() {
        let diagnostics = Bind(`func F() {
 let a = 1
 var b = 2
 a, b = b, a
 }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("read-only", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func MultiAssignment_To_Undefined_Reports_Error() {
        let diagnostics = Bind(`func F() {
 var a = 1
 a, missing = 1, 2
 }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("doesn't exist", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func MultiAssignment_StorageTargets_AndTupleRhs_Bind() {
        let diagnostics = Bind(`package P

class Box {
    var Field int32
    prop Value int32 {
        get { return Field }
        set(v) { Field = v }
    }
}

func Pair() (int32, int32) { return (5, 6) }

func F() {
    var values = []int32{0, 0}
    var box = Box{}
    var boxes = []Box{box}
    var local = 0
    values[0], box.Field, box.Value, boxes[0].Field, local = 1, 2, 3, 4, 5
    local, values[1] = Pair()
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func MultiAssignment_TupleRhsArityMismatch_ReportsExactDiagnostic() {
        let diagnostics = Bind(`func Pair() (int32, int32, int32) { return (1, 2, 3) }
func F() {
    var a = 0
    var b = 0
    a, b = Pair()
}`)
        let diagnostic = Assert.Single(diagnostics.Where((d Diagnostic) -> d.Id == "GS0167"))
        Assert.Equal("Multi-assignment has 2 target(s) but 3 value(s).", diagnostic.Message)
    }

    @Fact
    func MultiAssignment_InvalidTarget_ReportsExactDiagnostic() {
        let diagnostics = Bind(`func Get() int32 { return 0 }
func F() {
    var a = 0
    Get(), a = 1, 2
}`)
        let diagnostic = Assert.Single(diagnostics.Where((d Diagnostic) -> d.Id == "GS0526"))
        Assert.Equal(
            "Multi-assignment target must be a writable variable, field, property, array element, indexer, or pointer dereference.",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData(
        "func F() { let a = 0 var b = 0 a, b = 1, 2 }",
        "GS0127",
        "Variable 'a' is read-only and cannot be assigned to."
    )
    @InlineData(
        "class Box { prop Value int32 { get; init; } } func F(box Box) { var b = 0 box.Value, b = 1, 2 }",
        "GS0372",
        "Init-only property 'Value' can only be assigned during object initialization (in a constructor, an object initializer, or an 'init' accessor)."
    )
    @InlineData(
        "class Box { private var Value int32 } func F(box Box) { var b = 0 box.Value, b = 1, 2 }",
        "GS0472",
        "'Box.Value' is inaccessible due to its protection level: a 'private' member is only accessible within 'Box'."
    )
    @InlineData(
        "func F() { var a int32 var b int32 a, b = (1, \"two\") }",
        "GS0155",
        "Cannot convert type 'string' to 'int32'."
    )
    func MultiAssignment_ReusesExactSingleAssignmentDiagnostics(source string, id string, message string) {
        let diagnostic = Assert.Single(Bind(source).Where((d Diagnostic) -> d.Id == id))
        Assert.Equal(message, diagnostic.Message)
    }

    @Fact
    func MultiAssignment_MalformedExpressionTarget_RecoversWithOneTargetDiagnostic() {
        let diagnostics = Bind(`func F() {
    var a = 0
    var b = 0
    a + 1, b = 2, 3
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0526", diagnostic.Id)
    }

    @Fact
    func MultiDecl_DifferentTypes_AsTwoVarLines_Binds() {
        Assert.Empty(Bind(`func F() {
 var a = 1
 var b = "two"
 var s = b
 var n = a
 }
`))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
