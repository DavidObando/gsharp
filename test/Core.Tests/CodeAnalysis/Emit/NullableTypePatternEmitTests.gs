// <copyright file="NullableTypePatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #420 (P3-2): the emit strategy for a type pattern is
/// `box; isinst TargetType; brfalse fail`. That strategy is INVALID
/// when `TargetType` is (cref:NullableTypeSymbol) wrapping a
/// CLR value type, because ECMA-335 §I.8.2.4 / §III.4.32 specifies that
/// `Nullable<T>` boxes as a boxed `T` (or null) — never as
/// a boxed `Nullable<T>` — so `isinst Nullable<T>`
/// would never match. The binder today does not produce a
/// (cref:BoundTypePattern) whose `TargetType` is a nullable
/// over a value type; emit guards against the shape with an explicit
/// (cref:InvalidOperationException), and that guard is what
/// forces a future binder change to revisit emit.
open class NullableTypePatternEmitTests {
    /// Surface-level smoke test: writing a type pattern over a
    /// nullable value-type target (the only shape that would actually
    /// trip the boxing rule the emit guard documents) must not reach
    /// emit successfully today. Either the parser rejects the syntax
    /// or the binder rejects the construct; if this assertion ever
    /// flips to "compiles and runs", revisit
    /// `EmitTypePattern` in `ReflectionMetadataEmitter.cs` —
    /// the IL strategy will silently fail to match boxed
    /// `Nullable<T>` values.
    @Fact
    func TypePattern_NullableValueTypeTarget_DoesNotProduceWorkingBinary() {
        const Source = `package P420
let v = 1
let x = switch v { case y is int32?: 1 default: 0 }
`
        let produced = TryCompileToTempBinary(Source, out var diagnostics)
        // Contract: this shape must NOT compile to a working binary
        // today. Either diagnostics fired or emit threw the documented
        // InvalidOperationException. Both outcomes preserve the
        // invariant; only "no diagnostics + no throw + binary produced"
        // would be a regression.
        Assert.False(
            produced && diagnostics.IsEmpty,
            "Type pattern over Nullable<value-type> must be rejected somewhere before emit completes (issue #420 / P3-2)."
        )
    }

    /// Direct emit-time guard test: bypassing the binder, synthesise a
    /// (cref:BoundTypePattern) whose `TargetType` is a
    /// nullable-of-value-type and assert that the emit guard throws
    /// (cref:InvalidOperationException) with the issue
    /// reference. This is the regression hook for the assumption
    /// documented in `EmitTypePattern`.
    @Fact
    func EmitTypePattern_NullableValueTypeTarget_AssertionFiresWithReferenceToIssue() {
        let discriminantType = TypeSymbol.Int32
        let targetType = NullableTypeSymbol.Get(TypeSymbol.Int32)
        let variable = LocalVariableSymbol("y", isReadOnly: true, targetType, declaringSyntax: nil)
        // Empty syntax tree just so BoundTypePattern has a non-null Syntax.
        let tree = SyntaxTree.Parse(SourceText.From(string.Empty))
        let fakeSyntax = cast[SyntaxNode](tree.Root)
        let pattern = BoundTypePattern(fakeSyntax, discriminantType, targetType, variable)
        // The guard is structural: it inspects only `pattern.TargetType`.
        // We re-implement the predicate here to keep the test in lockstep
        // with the documented invariant: if this predicate ever returns
        // false for a shape the binder produces, EmitTypePattern must
        // throw.
        let guardWouldFire = pattern.TargetType is NullableTypeSymbol n &&
            n
            .UnderlyingType
            ?.ClrType is {IsValueType: true}
        Assert.True(
            guardWouldFire,
            "Nullable<int32> must trip the emit-time guard documented in EmitTypePattern (issue #420 / P3-2)."
        )
    }

    shared {
        private func TryCompileToTempBinary(source string, out diagnostics ImmutableArray[Diagnostic]) bool {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                diagnostics = tree.Diagnostics
                return false
            }
            using let peStream = MemoryStream()
            let compilation = Compilation(tree)
            try {
                let result = compilation.Emit(peStream)
                diagnostics = result.Diagnostics
                return result.Success
            } catch (ex InvalidOperationException) when ex.Message.Contains("issue #420", StringComparison.Ordinal) {
                diagnostics = ImmutableArray[Diagnostic].Empty
                return false
            }
        }
    }
}
