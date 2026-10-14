// <copyright file="Issue1912ExplicitEnumMemberValueTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1912: Emitted-oracle coverage for explicit enum member value.
open class Issue1912ExplicitEnumMemberValueTests {
    @Fact
    func ExplicitPositiveValues_AssignRequestedOrdinals() {
        let symbol = BindEnum("enum Fruit { Apple = 1, Banana = 2, Cherry = 4 }")
        Assert.Equal([]int32{1, 2, 4}, symbol.Members.Select((m EnumMemberSymbol) -> m.Value))
    }

    @Fact
    func ExplicitValue_ImplicitMembersContinueCountingFromIt() {
        // C# §19.4: an implicit member after an explicit one continues from
        // (explicit value + 1), not from the declaration-order ordinal.
        let symbol = BindEnum("enum E { A = 5, B, C }")
        Assert.Equal([]int32{5, 6, 7}, symbol.Members.Select((m EnumMemberSymbol) -> m.Value))
    }

    @Fact
    func NegativeExplicitValue_Binds() {
        let symbol = BindEnum("enum StatusCode { Unknown = -1, Ok = 200 }")
        Assert.Equal(-1, symbol.Members[0].Value)
        Assert.Equal(200, symbol.Members[1].Value)
    }

    @Fact
    func MinValueExplicitValue_Binds() {
        // Regression: the decimal literal 2147483648 (int.MinValue's magnitude)
        // lexes as uint, not int, per the integer-literal type lattice (it
        // doesn't fit int32). Negating it is the standard C#/G# spelling of
        // int.MinValue and must still fold.
        let symbol = BindEnum("enum X { Reserved = -2147483648 }")
        Assert.Equal(int32.MinValue, symbol.Members[0].Value)
    }

    @Fact
    func MinValueExplicitValue_EvaluatesToTheRequestedRuntimeInt() {
        let result = Evaluate(`
enum X { Reserved = -2147483648 }
int32(X.Reserved)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int32.MinValue, result.Value)
    }

    @Fact
    func FlagsBitShiftAndOrExpressions_FoldToCorrectValues() {
        let symbol = BindEnum("enum Access { None = 0, Read = 1 << 2, Write = 1 << 3, ReadWrite = Read | Write }")
        Assert.Equal([]int32{0, 4, 8, 12}, symbol.Members.Select((m EnumMemberSymbol) -> m.Value))
    }

    @Fact
    func AliasMemberReferencingSibling_ResolvesToSameValue() {
        let symbol = BindEnum("enum StatusCode { ServerError = 500, DefaultError = ServerError }")
        Assert.Equal(500, symbol.Members.Single((m EnumMemberSymbol) -> m.Name == "ServerError").Value)
        Assert.Equal(500, symbol.Members.Single((m EnumMemberSymbol) -> m.Name == "DefaultError").Value)
    }

    @Fact
    func NonConstantValue_Diagnoses() {
        let diagnostics = BindDiagnostics(`
func F() int32 { return 1 }
enum E { A = F() }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("must be a constant int32 expression", StringComparison.Ordinal)
        )
    }

    @Fact
    func FlagsAnnotation_ResolvesToClrFlagsAttribute() {
        let diagnostics = BindDiagnostics(`
import System

@Flags
enum Access { None = 0, Read = 1, Write = 2 }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ExplicitEnumValues_EvaluateToTheRequestedRuntimeInts() {
        let result = Evaluate(`
enum Fruit { Apple = 1, Banana = 2, Cherry = 4 }
let picked = Fruit.Banana
int32(picked)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func AliasMember_EqualsOriginalMemberAtRuntime() {
        let result = Evaluate(`
enum StatusCode { ServerError = 500, DefaultError = ServerError }
StatusCode.DefaultError == StatusCode.ServerError
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func MinValueLiteral_InExpressionPosition_BindsAndEvaluatesAsInt32() {
        // Issue #3684 (family F14): the same lattice quirk applies OUTSIDE an
        // enum-member initializer — the enum folder special-cased
        // `-2147483648` but the general expression binder still saw a negation
        // of `uint32` and reported GS0128, so every migrated
        // `Assert.Equal(-2147483648, …)` failed to compile.
        let result = Evaluate("-2147483648")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int32.MinValue, result.Value)
    }

    shared {
        private func BindEnum(source string) EnumSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            Assert.Empty(globalScope.Diagnostics)
            return Assert.Single(globalScope.Enums)
        }

        private func BindDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return globalScope.Diagnostics
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
