// <copyright file="Issue1926ReceiverInterfaceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #1926: a receiver-clause (extension) function
/// declared over a constructed generic CLR/user interface (e.g.
/// <c>func (values IReadOnlyList[T]) …</c>) must accept a call-site receiver
/// whose static type is a concrete class implementing that interface (e.g.
/// <c>List[T]</c> implements <c>IReadOnlyList[T]</c>) instead of failing with
/// GS0155.
/// </summary>
/// <remarks>
/// Root cause: <c>Binder.SubstituteType</c> closes a generic receiver-clause's
/// declared type (e.g. <c>IReadOnlyList[T]</c>) over its inferred type
/// argument by calling <see cref="Type.MakeGenericType(Type[])"/> on the
/// interface's open generic definition with the substituted argument's raw
/// <see cref="TypeSymbol.ClrType"/>. Well-known primitive
/// <see cref="TypeSymbol"/>s (<see cref="TypeSymbol.Int32"/>, etc.) always
/// carry the host process's live <c>typeof(int)</c> — but when <c>gsc</c> is
/// driven with an explicit <c>/r:</c> reference set (as the cs2gs migration
/// pipeline and MSBuild task both do), the receiver-clause's own declared
/// type was resolved through an isolated
/// <see cref="System.Reflection.MetadataLoadContext"/>. Mixing a live and an
/// MLC-resolved <see cref="Type"/> in <c>MakeGenericType</c> throws
/// <see cref="ArgumentException"/>, which was silently swallowed and fell
/// back to an ERASED <c>IReadOnlyList&lt;object&gt;</c> receiver type — a type
/// that <c>List&lt;int&gt;</c> does NOT implicitly convert to, so the call
/// site failed GS0155 even though <c>List&lt;int&gt;</c> genuinely implements
/// <c>IReadOnlyList&lt;int&gt;</c>. The fix projects every substituted type
/// argument's CLR type into the SAME reflection context as the declared
/// receiver's open generic definition (mirroring the existing
/// <c>ReferenceResolver.MapClrTypeToReferences</c> pattern used throughout the
/// rest of the binder) before calling <c>MakeGenericType</c>.
/// </remarks>
public class Issue1926ReceiverInterfaceConversionTests
{
    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the BCL reference
    /// assemblies. Supplying explicit paths forces gsc into the
    /// <see cref="System.Reflection.MetadataLoadContext"/> resolution path —
    /// the same path the cs2gs migration pipeline and the MSBuild task drive
    /// gsc through — reproducing the cross-reflection-context scenario inside
    /// the unit-test process.
    /// </summary>
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

    private static BoundGlobalScope BindWithMlc(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), MetadataLoadContextResolver());
    }

    private static BoundGlobalScope BindDefault(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    [Fact]
    public void GenericExtension_OverClrInterfaceReceiver_AcceptsImplementingClass_UnderMetadataLoadContext()
    {
        // Grid G13's ExtensionMethodsGeneric.MiddleElement<T>(this IReadOnlyList<T>)
        // translated shape: a generic receiver-clause function whose receiver
        // is the constructed generic CLR interface `IReadOnlyList[T]`, called
        // on a `List[int32]` receiver.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (items IReadOnlyList[T]) MiddleElement[T]() T {
                return items[items.Count / 2]
            }

            var numbers = List[int32]{ 1, 2, 3, 4, 5, 6, 7 }
            numbers.MiddleElement()
            """;

        var globalScope = BindWithMlc(source);
        Assert.Empty(globalScope.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void GenericExtension_OverClrDictionaryInterfaceReceiver_AcceptsImplementingClass_UnderMetadataLoadContext()
    {
        // #1926 must generalize beyond List -> IReadOnlyList: any CLR class
        // implementing any constructed generic interface (here
        // Dictionary[K, V] -> IReadOnlyDictionary[K, V]).
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (entries IReadOnlyDictionary[K, V]) CountEntries[K, V]() int32 {
                return entries.Count
            }

            var scores = Dictionary[string, int32]{ "alice": 90, "bob": 85 }
            scores.CountEntries()
            """;

        var globalScope = BindWithMlc(source);
        Assert.Empty(globalScope.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void GenericExtension_OverClrInterfaceReceiver_AcceptsImplementingClass_ReferenceTypeArgument_UnderMetadataLoadContext()
    {
        // Generality check: the fix must not be narrowly special-cased to a
        // single element type. Exercises a reference-type (string) type
        // argument alongside the value-type (int32) case in the first test,
        // covering both MakeGenericType argument shapes.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (items IReadOnlyList[T]) MiddleElement[T]() T {
                return items[items.Count / 2]
            }

            var words = List[string]{ "alpha", "beta", "gamma" }
            words.MiddleElement()
            """;

        var globalScope = BindWithMlc(source);
        Assert.Empty(globalScope.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void GenericExtension_OverClrInterfaceReceiver_AcceptsImplementingClass_ControlCase_DefaultResolver()
    {
        // Control case: the same call site must already bind (and keep
        // binding) under the default (non-MLC) reflection context, so the fix
        // does not regress the common single-context compile path.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func (items IReadOnlyList[T]) MiddleElement[T]() T {
                return items[items.Count / 2]
            }

            var numbers = List[int32]{ 1, 2, 3, 4, 5, 6, 7 }
            numbers.MiddleElement()
            """;

        var globalScope = BindDefault(source);
        Assert.Empty(globalScope.Diagnostics.Where(d => d.IsError));
    }
}
