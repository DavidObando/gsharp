// <copyright file="TypeAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 2.7: `type UserId = int` declares a name that resolves to
/// the underlying type. Aliases are erased — no CIL is emitted for them.
open class TypeAliasTests {
    @Fact
    func TypeAlias_To_Int_Binds_VariableDeclaration() {
        Assert.Empty(Bind(`type UserId = int32
func F() {
 let id UserId = 7
 }
`))
    }

    @Fact
    func TypeAlias_Allows_Chained_Aliases() {
        Assert.Empty(Bind(`type A = int32
type B = A
func F() {
 let x B = 1
 }
`))
    }

    @Fact
    func TypeAlias_AssignmentTypeIncompatible_Reports_Error() {
        let diagnostics = Bind(`type UserId = int32
func F() {
 let id UserId = "x"
 }
`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func TypeAlias_ToUnknownType_Reports_Error() {
        let diagnostics = Bind("type X = NotAType\n")
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func TypeAlias_Cannot_Shadow_Primitive() {
        let diagnostics = Bind("type int32 = string\n")
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("already declared", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Theory
    @InlineData("uint8")
    @InlineData("int8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    @InlineData("nuint")
    @InlineData("float32")
    @InlineData("float64")
    @InlineData("decimal")
    @InlineData("char")
    @InlineData("object")
    func TypeAlias_Cannot_Shadow_New_Primitives(primitiveName string) {
        // ADR-0044 / ADR-0045: each primitive added in issue #142 must be
        // rejected as a redeclaration target, matching the existing
        // bool/int/string behaviour.
        let diagnostics = Bind((`type ` + "$primitiveName" + ` = string
`))
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("already declared", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Theory
    @InlineData("uint8")
    @InlineData("int8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    @InlineData("nuint")
    @InlineData("float32")
    @InlineData("float64")
    @InlineData("decimal")
    @InlineData("char")
    @InlineData("object")
    func TypeClause_Resolves_New_Primitive_As_Alias_Target(primitiveName string) {
        // The new keywords must be reachable from any type-clause position.
        // A type alias to one of them is the smallest exercise that does not
        // depend on the Phase 3 conversion table.
        let diagnostics = Bind((`type X = ` + "$primitiveName" + `
`))
        Assert.Empty(diagnostics)
    }

    @Fact
    func TypeAlias_Duplicate_Reports_Error() {
        let diagnostics = Bind(`type A = int32
type A = string
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("already declared", StringComparison.OrdinalIgnoreCase)
        )
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
