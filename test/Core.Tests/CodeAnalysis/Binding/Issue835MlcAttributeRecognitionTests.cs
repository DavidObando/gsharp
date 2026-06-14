// <copyright file="Issue835MlcAttributeRecognitionTests.cs" company="GSharp">
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
/// Regression tests for issue #835: when the BuildTask drives gsc, well-known
/// attribute types (Obsolete, DllImport, StructLayout, …) flow through a
/// <see cref="System.Reflection.MetadataLoadContext"/>. The MLC's
/// <see cref="System.Type"/> instances are <em>not</em> reference-equal to the
/// host process's <c>typeof()</c> literals, so any recogniser that used
/// <c>clrType == typeof(X)</c> would silently report <c>false</c> and silently
/// drop the attribute on the BuildTask path. The recognisers must compare by
/// <see cref="System.Type.FullName"/> instead (via
/// <see cref="ClrTypeUtilities.IsSameAs"/>).
/// </summary>
public class Issue835MlcAttributeRecognitionTests
{
    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the BCL reference
    /// assemblies. Supplying explicit paths forces gsc into the
    /// <see cref="System.Reflection.MetadataLoadContext"/> resolution path,
    /// reproducing the BuildTask scenario inside the unit-test process.
    /// </summary>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Runtime.InteropServices.DllImportAttribute).Assembly.Location,
            typeof(System.Runtime.InteropServices.StructLayoutAttribute).Assembly.Location,
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

    [Fact]
    public void Obsolete_From_Mlc_Is_Recognised()
    {
        var source = """
            package P
            import System

            @Obsolete("use Bar instead")
            func Helper() {
            }
            """;

        var globalScope = BindWithMlc(source);
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");
        var attr = Assert.Single(helper.Attributes);

        // ClrType must come from the MLC (different reflection context than
        // typeof(System.ObsoleteAttribute) in the test host).
        Assert.NotNull(attr.AttributeType?.ClrType);
        Assert.NotSame(typeof(System.ObsoleteAttribute), attr.AttributeType.ClrType);
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.ClrType.FullName);

        // The whole point of #835: the recogniser must return true regardless
        // of which reflection context produced the Type instance.
        Assert.True(KnownAttributes.IsObsolete(attr));
        Assert.True(KnownAttributes.TryGetObsolete(helper.Attributes, out var message, out var isError));
        Assert.Equal("use Bar instead", message);
        Assert.False(isError);
    }

    [Fact]
    public void DllImport_From_Mlc_Is_Recognised()
    {
        var source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("kernel32.dll")
            func GetTickCount() uint32;
            """;

        var globalScope = BindWithMlc(source);
        var fn = globalScope.Functions.Single(f => f.Name == "GetTickCount");
        var attr = Assert.Single(fn.Attributes);

        Assert.NotNull(attr.AttributeType?.ClrType);
        Assert.NotSame(typeof(System.Runtime.InteropServices.DllImportAttribute), attr.AttributeType.ClrType);
        Assert.Equal(
            "System.Runtime.InteropServices.DllImportAttribute",
            attr.AttributeType.ClrType.FullName);

        // Recogniser must fire on the MLC-loaded type.
        Assert.True(KnownAttributes.IsDllImport(attr));
        Assert.NotNull(KnownAttributes.FindDllImport(fn.Attributes));
    }

    [Fact]
    public void StructLayout_From_Mlc_Is_Recognised()
    {
        var source = """
            package P
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct Point {
                var X int32
                var Y int32
            }
            """;

        var globalScope = BindWithMlc(source);
        var point = globalScope.Structs.Single(s => s.Name == "Point");
        var attr = Assert.Single(point.Attributes);

        Assert.NotNull(attr.AttributeType?.ClrType);
        Assert.NotSame(typeof(System.Runtime.InteropServices.StructLayoutAttribute), attr.AttributeType.ClrType);
        Assert.Equal(
            "System.Runtime.InteropServices.StructLayoutAttribute",
            attr.AttributeType.ClrType.FullName);

        // Recogniser must fire on the MLC-loaded type. If it did not, the
        // emitter would write StructLayout as a plain CustomAttribute row
        // instead of encoding it into the TypeDef's pseudo-custom flags.
        Assert.True(KnownAttributes.IsStructLayout(attr));
        Assert.NotNull(KnownAttributes.FindStructLayout(point.Attributes));
    }

    [Fact]
    public void Sanity_Identity_Compare_Against_Mlc_Type_Is_False()
    {
        // Demonstrates *why* #835 matters: a raw `clrType == typeof(X)` check
        // against an MLC-loaded type is always false even when the FullNames
        // match. The KnownAttributes recognisers must therefore key off
        // FullName (via ClrTypeUtilities.IsSameAs) rather than identity.
        var source = """
            package P
            import System

            @Obsolete
            func Helper() {
            }
            """;

        var globalScope = BindWithMlc(source);
        var helper = globalScope.Functions.Single(f => f.Name == "Helper");
        var attr = Assert.Single(helper.Attributes);

        var clr = attr.AttributeType.ClrType;
        Assert.NotNull(clr);

        // Identity compare to the host typeof(...) — *must* be false because
        // the MLC produces a distinct Type instance.
        Assert.False(clr == typeof(System.ObsoleteAttribute));

        // FullName-based compare — must be true. This is what
        // ClrTypeUtilities.IsSameAs implements.
        Assert.True(ClrTypeUtilities.IsSameAs(clr, typeof(System.ObsoleteAttribute)));
    }
}
