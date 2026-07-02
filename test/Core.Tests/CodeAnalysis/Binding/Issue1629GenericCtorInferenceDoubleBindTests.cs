// <copyright file="Issue1629GenericCtorInferenceDoubleBindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1629: generic constructor type-argument inference pre-bound every
/// argument to drive inference, then bound the same arguments again for the
/// real call. Because <see cref="DiagnosticBag"/> is append-only, any
/// diagnostic inside an argument (e.g. an undefined variable) was reported
/// twice. The fix rolls back the pre-bind's diagnostics via
/// <see cref="DiagnosticBag.TruncateTo"/> so only the real bind's diagnostics
/// remain. These tests cover both the primary-constructor inference path
/// (<c>Box(x)</c>) and the explicit <c>init(...)</c> inference path
/// (<c>Box(x)</c> where the class declares an explicit constructor), plus a
/// nested-generic-construction case that would previously multiply
/// diagnostics further.
/// </summary>
public class Issue1629GenericCtorInferenceDoubleBindTests
{
    [Fact]
    public void PrimaryCtor_GenericInference_UndefinedArgument_ReportsDiagnosticExactlyOnce()
    {
        var source = """
            package p
            class Box[T](value T) { }
            func Use() {
                let b = Box(undefinedVar)
            }
            """;

        var diagnostics = Diagnose(source);

        Assert.Single(diagnostics);
    }

    [Fact]
    public void ExplicitInitCtor_GenericInference_UndefinedArgument_ReportsDiagnosticExactlyOnce()
    {
        var source = """
            package p
            class Box[T] {
                let value T
                init(v T) { value = v }
            }
            func Use() {
                let b = Box(undefinedVar)
            }
            """;

        var diagnostics = Diagnose(source);

        Assert.Single(diagnostics);
    }

    [Fact]
    public void PrimaryCtor_NestedGenericInference_UndefinedArgument_ReportsDiagnosticExactlyOnce()
    {
        // Nested generic construction: without the fix, each level re-binds its
        // own arguments twice, so the innermost undefined-variable diagnostic
        // would multiply with nesting depth.
        var source = """
            package p
            class Box[T](value T) { }
            func Use() {
                let b = Box(Box(Box(undefinedVar)))
            }
            """;

        var diagnostics = Diagnose(source);

        Assert.Single(diagnostics);
    }

    [Fact]
    public void PrimaryCtor_GenericInference_ValidArgument_StillCompilesCleanly()
    {
        var source = """
            package p
            class Box[T](value T) { }
            func Use() int32 {
                let b = Box(5)
                return b.value
            }
            """;

        var diagnostics = Diagnose(source);


        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ExplicitInitCtor_GenericInference_ValidArgument_StillCompilesCleanly()
    {
        var source = """
            package p
            class Box[T] {
                let value T
                init(v T) { value = v }
                func Get() T { return value }
            }
            func Use() int32 {
                let b = Box(5)
                return b.Get()
            }
            """;

        var diagnostics = Diagnose(source);

        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<Diagnostic> Diagnose(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }
}
