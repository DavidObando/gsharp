// <copyright file="Issue2114RangeSliceMlcTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #2114: binding a range-slice expression
/// <c>expr[a..b]</c> against a sliceable BCL type (e.g. <c>Span</c> /
/// <c>ReadOnlySpan</c>) must not crash when the receiver type is resolved
/// through a <see cref="System.Reflection.MetadataLoadContext"/> (the
/// <c>/reference:</c> resolver path used by the BuildTask and cs2gs migrate).
/// <para>
/// The slice-shape probe in <c>ExpressionBinder.TryFindSliceShape</c> previously
/// called <c>clrType.GetMethod("Slice", …, new[] { typeof(int), typeof(int) }, …)</c>.
/// When <c>clrType</c> is an MLC <c>RoType</c>, comparing its candidate parameter
/// types against the host's runtime <c>typeof(int)</c> made
/// <c>DefaultBinder.SelectMethod</c> throw
/// <c>ArgumentException: Type must be a type provided by the MetadataLoadContext</c>,
/// surfaced as a <c>GS9998</c> ICE. The probe now enumerates candidates and
/// compares parameter types with <c>IsSameAs</c>, which works across reflection
/// contexts.
/// </para>
/// </summary>
public class Issue2114RangeSliceMlcTests
{
    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at BCL reference
    /// assemblies. Supplying explicit paths forces gsc into the
    /// <see cref="System.Reflection.MetadataLoadContext"/> resolution path,
    /// reproducing the BuildTask / migrate scenario inside the test process.
    /// </summary>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.ReadOnlySpan<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Linq.Enumerable).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArray<Diagnostic> BindWithMlc(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            MetadataLoadContextResolver());
        return globalScope.Diagnostics;
    }

    [Fact]
    public void RangeSlice_OnReadOnlySpan_UnderMlc_DoesNotCrash()
    {
        var source = """
            package Repro
            import System

            func TakeTail(s ReadOnlySpan[int64]) ReadOnlySpan[int64] {
                return s[2..]
            }
            """;

        // Pre-fix this threw ArgumentException from the binder (GS9998 ICE).
        var diagnostics = BindWithMlc(source);

        Assert.DoesNotContain(
            diagnostics,
            d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void RangeSlice_OnSpan_WithBounds_UnderMlc_DoesNotCrash()
    {
        var source = """
            package Repro
            import System

            func Middle(s Span[uint8]) Span[uint8] {
                return s[1..3]
            }
            """;

        var diagnostics = BindWithMlc(source);

        Assert.DoesNotContain(
            diagnostics,
            d => d.Severity == DiagnosticSeverity.Error);
    }
}
