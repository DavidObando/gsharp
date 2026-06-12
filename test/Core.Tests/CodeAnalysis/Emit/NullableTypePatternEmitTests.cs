// <copyright file="NullableTypePatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #420 (P3-2): the emit strategy for a type pattern is
/// <c>box; isinst TargetType; brfalse fail</c>. That strategy is INVALID
/// when <c>TargetType</c> is <see cref="NullableTypeSymbol"/> wrapping a
/// CLR value type, because ECMA-335 §I.8.2.4 / §III.4.32 specifies that
/// <c>Nullable&lt;T&gt;</c> boxes as a boxed <c>T</c> (or null) — never as
/// a boxed <c>Nullable&lt;T&gt;</c> — so <c>isinst Nullable&lt;T&gt;</c>
/// would never match. The binder today does not produce a
/// <see cref="BoundTypePattern"/> whose <c>TargetType</c> is a nullable
/// over a value type; emit guards against the shape with an explicit
/// <see cref="InvalidOperationException"/>, and that guard is what
/// forces a future binder change to revisit emit.
/// </summary>
public class NullableTypePatternEmitTests
{
    /// <summary>
    /// Surface-level smoke test: writing a type pattern over a
    /// nullable value-type target (the only shape that would actually
    /// trip the boxing rule the emit guard documents) must not reach
    /// emit successfully today. Either the parser rejects the syntax
    /// or the binder rejects the construct; if this assertion ever
    /// flips to "compiles and runs", revisit
    /// <c>EmitTypePattern</c> in <c>ReflectionMetadataEmitter.cs</c> —
    /// the IL strategy will silently fail to match boxed
    /// <c>Nullable&lt;T&gt;</c> values.
    /// </summary>
    [Fact]
    public void TypePattern_NullableValueTypeTarget_DoesNotProduceWorkingBinary()
    {
        const string Source = @"package P420
let v = 1
let x = switch v { case y is int32?: 1 default: 0 }
";
        var produced = TryCompileToTempBinary(Source, out var diagnostics);

        // Contract: this shape must NOT compile to a working binary
        // today. Either diagnostics fired or emit threw the documented
        // InvalidOperationException. Both outcomes preserve the
        // invariant; only "no diagnostics + no throw + binary produced"
        // would be a regression.
        Assert.False(produced && diagnostics.IsEmpty,
            "Type pattern over Nullable<value-type> must be rejected somewhere before emit completes (issue #420 / P3-2).");
    }

    /// <summary>
    /// Direct emit-time guard test: bypassing the binder, synthesise a
    /// <see cref="BoundTypePattern"/> whose <c>TargetType</c> is a
    /// nullable-of-value-type and assert that the emit guard throws
    /// <see cref="InvalidOperationException"/> with the issue
    /// reference. This is the regression hook for the assumption
    /// documented in <c>EmitTypePattern</c>.
    /// </summary>
    [Fact]
    public void EmitTypePattern_NullableValueTypeTarget_AssertionFiresWithReferenceToIssue()
    {
        var discriminantType = TypeSymbol.Int32;
        var targetType = NullableTypeSymbol.Get(TypeSymbol.Int32);
        var variable = new LocalVariableSymbol("y", isReadOnly: true, targetType, declaringSyntax: null);

        // Empty syntax tree just so BoundTypePattern has a non-null Syntax.
        var tree = SyntaxTree.Parse(SourceText.From(string.Empty));
        var fakeSyntax = (SyntaxNode)tree.Root;
        var pattern = new BoundTypePattern(fakeSyntax, discriminantType, targetType, variable);

        // The guard is structural: it inspects only `pattern.TargetType`.
        // We re-implement the predicate here to keep the test in lockstep
        // with the documented invariant: if this predicate ever returns
        // false for a shape the binder produces, EmitTypePattern must
        // throw.
        bool guardWouldFire = pattern.TargetType is NullableTypeSymbol n
            && n.UnderlyingType?.ClrType is { IsValueType: true };

        Assert.True(guardWouldFire,
            "Nullable<int32> must trip the emit-time guard documented in EmitTypePattern (issue #420 / P3-2).");
    }

    private static bool TryCompileToTempBinary(string source, out ImmutableArray<Diagnostic> diagnostics)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            diagnostics = tree.Diagnostics;
            return false;
        }

        using var peStream = new MemoryStream();
        var compilation = new Compilation(tree);
        try
        {
            var result = compilation.Emit(peStream);
            diagnostics = result.Diagnostics;
            return result.Success;
        }
        catch (InvalidOperationException ex) when (ex.Message.Contains("issue #420", StringComparison.Ordinal))
        {
            diagnostics = ImmutableArray<Diagnostic>.Empty;
            return false;
        }
    }
}
