// <copyright file="Issue1420SpanExtensionIdentityTests.cs" company="GSharp">
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
/// Regression tests for issue #1420: a generic extension declared on a
/// <c>ref struct</c> receiver (<c>func (ints Span[T]) AllLE[...](...)</c>) must
/// bind against a <c>Span&lt;int&gt;</c> produced by a BCL signature
/// (<c>CollectionsMarshal.AsSpan(List[int32])</c>).
/// <para>
/// The BCL signature surfaces the element type as the metadata
/// <c>System.Int32</c> while the substituted extension receiver carries the G#
/// primitive alias <c>int32</c>. Substitution cannot rebuild the real closed
/// CLR <c>Span&lt;int&gt;</c> (the alias holds the runtime <c>System.Int32</c>
/// whereas <c>Span&lt;&gt;</c> came from a MetadataLoadContext, and mixing the
/// two throws), so the substituted receiver stays symbolic. Conversion identity
/// must normalize the two element representations onto the SAME
/// <see cref="TypeSymbol"/> so the receiver binds instead of failing GS0155.
/// </para>
/// </summary>
public class Issue1420SpanExtensionIdentityTests
{
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Runtime.InteropServices.CollectionsMarshal).Assembly.Location,
            typeof(System.IComparable<>).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            MetadataLoadContextResolver());
        var program = Binder.BindProgram(globalScope, MetadataLoadContextResolver());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    [Fact]
    public void SpanGenericExtension_BindsAgainstAsSpanResult()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic
            import System.Runtime.InteropServices

            func (ints Span[T]) AllLE[T IComparable[T] unmanaged](value T) bool -> true

            func F(list List[int32]) {
                let sp = CollectionsMarshal.AsSpan(list)
                let b = sp.AllLE(int32(5))
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void SpanWrongElement_StillReportsConversionError()
    {
        // The BCL Span<long> from AsSpan(List[int64]) must NOT unify with the
        // explicit Span[int32] parameter — the identity normalization is by
        // element type, not blanket acceptance of any Span instantiation.
        var source = """
            package App
            import System
            import System.Collections.Generic
            import System.Runtime.InteropServices

            func G(s Span[int32]) int32 -> 0

            func F(list List[int64]) {
                let sp = CollectionsMarshal.AsSpan(list)
                let r = G(sp)
            }
            """;

        Assert.NotEmpty(Bind(source));
    }
}
