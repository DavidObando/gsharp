// <copyright file="Issue1912ExplicitEnumMemberValueTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1912: cs2gs silently dropped explicit C# enum member values
/// (`Banana = 2`), `[Flags]`, negative values, and alias members
/// (`DefaultError = ServerError`), re-numbering every case sequentially from
/// 0 and silently changing the runtime int32 value. G# itself had no grammar
/// for an explicit enum-member value at all — this adds that language
/// feature (`Name = constExpr`), constant-folded at bind time, so the
/// translator has somewhere to put the preserved value. Covers positive
/// literals, negative literals, `[Flags]`-style bit-shift/OR expressions, and
/// name-reference aliases, both at the binder (<see cref="EnumMemberSymbol.Value"/>)
/// and at runtime (the interpreter's evaluated int32 cast).
/// </summary>
public class Issue1912ExplicitEnumMemberValueTests
{
    [Fact]
    public void ExplicitPositiveValues_AssignRequestedOrdinals()
    {
        var symbol = BindEnum(@"enum Fruit { Apple = 1, Banana = 2, Cherry = 4 }");

        Assert.Equal(new[] { 1, 2, 4 }, symbol.Members.Select(m => m.Value));
    }

    [Fact]
    public void ExplicitValue_ImplicitMembersContinueCountingFromIt()
    {
        // C# §19.4: an implicit member after an explicit one continues from
        // (explicit value + 1), not from the declaration-order ordinal.
        var symbol = BindEnum(@"enum E { A = 5, B, C }");

        Assert.Equal(new[] { 5, 6, 7 }, symbol.Members.Select(m => m.Value));
    }

    [Fact]
    public void NegativeExplicitValue_Binds()
    {
        var symbol = BindEnum(@"enum StatusCode { Unknown = -1, Ok = 200 }");

        Assert.Equal(-1, symbol.Members[0].Value);
        Assert.Equal(200, symbol.Members[1].Value);
    }

    [Fact]
    public void FlagsBitShiftAndOrExpressions_FoldToCorrectValues()
    {
        var symbol = BindEnum(@"enum Access { None = 0, Read = 1 << 2, Write = 1 << 3, ReadWrite = Read | Write }");

        Assert.Equal(new[] { 0, 4, 8, 12 }, symbol.Members.Select(m => m.Value));
    }

    [Fact]
    public void AliasMemberReferencingSibling_ResolvesToSameValue()
    {
        var symbol = BindEnum(@"enum StatusCode { ServerError = 500, DefaultError = ServerError }");

        Assert.Equal(500, symbol.Members.Single(m => m.Name == "ServerError").Value);
        Assert.Equal(500, symbol.Members.Single(m => m.Name == "DefaultError").Value);
    }

    [Fact]
    public void NonConstantValue_Diagnoses()
    {
        var diagnostics = BindDiagnostics(@"
func F() int32 { return 1 }
enum E { A = F() }
");

        Assert.Contains(diagnostics, d => d.Message.Contains("must be a constant int32 expression", System.StringComparison.Ordinal));
    }

    [Fact]
    public void FlagsAnnotation_ResolvesToClrFlagsAttribute()
    {
        var diagnostics = BindDiagnostics(@"
import System

@Flags
enum Access { None = 0, Read = 1, Write = 2 }
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ExplicitEnumValues_EvaluateToTheRequestedRuntimeInts()
    {
        var result = Evaluate(@"
enum Fruit { Apple = 1, Banana = 2, Cherry = 4 }
let picked = Fruit.Banana
int32(picked)
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void AliasMember_EqualsOriginalMemberAtRuntime()
    {
        var result = Evaluate(@"
enum StatusCode { ServerError = 500, DefaultError = ServerError }
StatusCode.DefaultError == StatusCode.ServerError
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    private static EnumSymbol BindEnum(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        Assert.Empty(globalScope.Diagnostics);
        return Assert.Single(globalScope.Enums);
    }

    private static ImmutableArray<Diagnostic> BindDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return globalScope.Diagnostics;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
