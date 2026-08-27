// <copyright file="Issue3566OfTypeMlcSequenceTests.cs" company="GSharp">
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
/// Issue #3566: <c>xs.OfType[U]()</c> / <c>xs.Cast[U]()</c> on a
/// <c>sequence[T]</c> receiver whose element type resolves through a
/// <see cref="System.Reflection.MetadataLoadContext"/> reported GS0159.
/// The extensions' self-parameter is the NON-generic
/// <c>System.Collections.IEnumerable</c>, and <c>sequence[T]</c>'s CLR type
/// is the runtime <c>IEnumerable&lt;&gt;</c> closed over the MLC element — a
/// hybrid constructed type whose interface set the cross-context by-name
/// walk cannot read. The conversion classifier now answers semantically:
/// an <c>IEnumerable&lt;T&gt;</c> shape implements non-generic
/// <c>IEnumerable</c> by definition.
/// </summary>
public class Issue3566OfTypeMlcSequenceTests
{
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
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
    public void OfType_OnSequenceOfMlcElement_Binds()
    {
        var source = """
            package Repro
            import System
            import System.Linq

            func CountVersions(xs sequence[Version]) int32 {
                return xs.OfType[Version]().Count()
            }
            """;

        var diagnostics = BindWithMlc(source);

        Assert.DoesNotContain(
            diagnostics,
            d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void Cast_OnSequenceOfMlcElement_Binds()
    {
        var source = """
            package Repro
            import System
            import System.Linq

            func AsObjects(xs sequence[Version]) sequence[object] {
                return xs.Cast[object]()
            }
            """;

        var diagnostics = BindWithMlc(source);

        Assert.DoesNotContain(
            diagnostics,
            d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void SequenceConvertsToNonGenericIEnumerable()
    {
        // IEnumerable<T> implements the non-generic IEnumerable by
        // definition — the direct upcast the new classifier arm answers.
        // (The arm itself gates on the IEnumerable`1 shape so async
        // sequences never enter it; their conversion behavior is governed
        // by pre-existing rules.)
        var source = """
            package Repro
            import System
            import System.Collections

            func Sync(xs sequence[Version]) IEnumerable {
                return xs
            }
            """;

        Assert.DoesNotContain(
            BindWithMlc(source),
            d => d.Severity == DiagnosticSeverity.Error);
    }
}
