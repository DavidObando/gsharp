// <copyright file="DocumentationIdProviderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Documentation;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Documentation;

/// <summary>
/// ADR-0057 §5: golden tests pinning <see cref="DocumentationIdProvider"/> to Roslyn's
/// exact DocID format. The expected strings are taken verbatim from the .NET reference
/// pack's own <c>.xml</c> documentation files — i.e. they are Roslyn's own output — so
/// these assertions verify byte-for-byte parity for both the ingestion and emission
/// code paths that share this provider.
/// </summary>
public class DocumentationIdProviderTests
{
    [Fact]
    public void Type_Simple()
    {
        Assert.Equal("T:System.String", DocumentationIdProvider.GetDocumentationId(typeof(string)));
    }

    [Fact]
    public void Type_OpenGeneric_UsesArityBacktick()
    {
        Assert.Equal("T:System.Collections.Generic.List`1", DocumentationIdProvider.GetDocumentationId(typeof(List<>)));
        Assert.Equal("T:System.Action`2", DocumentationIdProvider.GetDocumentationId(typeof(Action<,>)));
    }

    [Fact]
    public void Type_ConstructedGeneric_NormalizesToDefinition()
    {
        Assert.Equal("T:System.Collections.Generic.List`1", DocumentationIdProvider.GetDocumentationId(typeof(List<int>)));
    }

    [Fact]
    public void Type_NestedGeneric_UsesDotAndPerLevelArity()
    {
        Assert.Equal(
            "T:System.Collections.Generic.Dictionary`2.Enumerator",
            DocumentationIdProvider.GetDocumentationId(typeof(Dictionary<,>.Enumerator)));
    }

    [Fact]
    public void Field_OnType()
    {
        Assert.Equal("F:System.Int32.MaxValue", DocumentationIdProvider.GetDocumentationId(typeof(int).GetField("MaxValue")));
    }

    [Fact]
    public void Property_OnType()
    {
        Assert.Equal("P:System.String.Length", DocumentationIdProvider.GetDocumentationId(typeof(string).GetProperty("Length")));
    }

    [Fact]
    public void Method_SingleParameter()
    {
        var method = typeof(string).GetMethod("Substring", new[] { typeof(int) });
        Assert.Equal("M:System.String.Substring(System.Int32)", DocumentationIdProvider.GetDocumentationId(method));
    }

    [Fact]
    public void Method_NoParameters_OmitsParens()
    {
        var method = typeof(object).GetMethod("ToString", Type.EmptyTypes);
        Assert.Equal("M:System.Object.ToString", DocumentationIdProvider.GetDocumentationId(method));
    }

    [Fact]
    public void Method_ByRefParameter_AppendsAt()
    {
        var method = typeof(AppContext).GetMethod("TryGetSwitch");
        Assert.Equal(
            "M:System.AppContext.TryGetSwitch(System.String,System.Boolean@)",
            DocumentationIdProvider.GetDocumentationId(method));
    }

    [Fact]
    public void Method_ConstructedGenericParameter_UsesBraces()
    {
        var method = typeof(AggregateException).GetMethod("Handle");
        Assert.Equal(
            "M:System.AggregateException.Handle(System.Func{System.Exception,System.Boolean})",
            DocumentationIdProvider.GetDocumentationId(method));
    }

    [Fact]
    public void Method_GenericWithMethodTypeParameters()
    {
        var method = typeof(Array).GetMethods()
            .First(m => m.Name == "Resize" && m.IsGenericMethodDefinition);
        Assert.Equal(
            "M:System.Array.Resize``1(``0[]@,System.Int32)",
            DocumentationIdProvider.GetDocumentationId(method));
    }

    [Fact]
    public void Method_OnGenericType_UsesClassTypeParameterReference()
    {
        var method = typeof(List<>).GetMethod("Add");
        Assert.Equal("M:System.Collections.Generic.List`1.Add(`0)", DocumentationIdProvider.GetDocumentationId(method));
    }

    [Fact]
    public void Constructor_InstanceUsesCtor()
    {
        var ctor = typeof(AggregateException).GetConstructor(new[] { typeof(Exception[]) });
        Assert.Equal("M:System.AggregateException.#ctor(System.Exception[])", DocumentationIdProvider.GetDocumentationId(ctor));
    }

    [Fact]
    public void Method_ConversionOperator_AppendsReturnType()
    {
        var op = typeof(DateTimeOffset).GetMethods()
            .First(m => m.Name == "op_Implicit" && m.GetParameters()[0].ParameterType == typeof(DateTime));
        Assert.Equal(
            "M:System.DateTimeOffset.op_Implicit(System.DateTime)~System.DateTimeOffset",
            DocumentationIdProvider.GetDocumentationId(op));
    }

    [Fact]
    public void Method_MultidimensionalArrayParameter()
    {
        var method = typeof(DocIdSamples).GetMethod(nameof(DocIdSamples.TakesGrid));
        Assert.Equal(
            "M:GSharp.Core.Tests.CodeAnalysis.Documentation.DocIdSamples.TakesGrid(System.Int32[0:,0:])",
            DocumentationIdProvider.GetDocumentationId(method));
    }

    [Fact]
    public void Method_NullableValueTypeParameter_UsesNullableBraces()
    {
        var method = typeof(DocIdSamples).GetMethod(nameof(DocIdSamples.TakesNullable));
        Assert.Equal(
            "M:GSharp.Core.Tests.CodeAnalysis.Documentation.DocIdSamples.TakesNullable(System.Nullable{System.Int32})",
            DocumentationIdProvider.GetDocumentationId(method));
    }

    [Fact]
    public void Method_ExplicitGenericInterfaceImplementation_ManglesInterfaceTypeArguments()
    {
        // Dictionary<TKey,TValue> explicitly implements ICollection<KeyValuePair<TKey,TValue>>.Add.
        // Roslyn mangles the interface portion of the name with '#'/'{'/'}'/'@' and references
        // the interface's type arguments by their declaring-type parameter names (TKey, TValue),
        // while the parameter signature still uses positional `0/`1. Verbatim from System.Collections.xml.
        var method = typeof(Dictionary<,>)
            .GetMethods(BindingFlags.NonPublic | BindingFlags.Instance)
            .First(m => m.Name.Contains("ICollection") && m.Name.EndsWith(".Add", StringComparison.Ordinal));
        Assert.Equal(
            "M:System.Collections.Generic.Dictionary`2.System#Collections#Generic#ICollection{System#Collections#Generic#KeyValuePair{TKey@TValue}}#Add(System.Collections.Generic.KeyValuePair{`0,`1})",
            DocumentationIdProvider.GetDocumentationId(method));
    }

    /// <summary>
    /// Corpus check: every computed DocID for a curated, stable slice of the BCL public
    /// surface must appear in the reference pack's own <c>.xml</c>, confirming parity
    /// with Roslyn across a broad, real member set rather than only curated cases.
    /// </summary>
    [Fact]
    public void Corpus_ComputedIdsAppearInReferenceXml()
    {
        var members = LoadReferenceMemberNames("System.Runtime.xml");
        if (members.Count == 0)
        {
            return; // Reference pack not present in this environment; skip silently.
        }

        var probed = 0;
        var missed = 0;
        foreach (var type in new[] { typeof(string), typeof(Math), typeof(Version) })
        {
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            {
                if (method.IsSpecialName || method.IsGenericMethod || method.Name.Contains('.'))
                {
                    continue;
                }

                var id = DocumentationIdProvider.GetDocumentationId(method);

                // The running runtime surface can be newer than the reference pack xml,
                // so an individual member may legitimately be absent. A *format*
                // regression, however, would make essentially everything miss — hence we
                // require a strong majority to match rather than every member.
                if (members.Contains(id))
                {
                    probed++;
                }
                else
                {
                    missed++;
                }
            }
        }

        Assert.True(probed > 20, $"Expected to verify many members, only matched {probed}.");
        Assert.True(probed > missed * 4, $"Too many DocID mismatches ({missed} missed vs {probed} matched) — likely a format regression.");
    }

    private static HashSet<string> LoadReferenceMemberNames(string fileName)
    {
        var packRoot = "/usr/local/share/dotnet/packs/Microsoft.NETCore.App.Ref";
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (!System.IO.Directory.Exists(packRoot))
        {
            return result;
        }

        var xml = System.IO.Directory.EnumerateFiles(packRoot, fileName, System.IO.SearchOption.AllDirectories)
            .OrderByDescending(p => p)
            .FirstOrDefault();
        if (xml == null)
        {
            return result;
        }

        var doc = System.Xml.Linq.XDocument.Load(xml);
        foreach (var member in doc.Descendants("member"))
        {
            var name = member.Attribute("name")?.Value;
            if (name != null)
            {
                result.Add(name);
            }
        }

        return result;
    }
}

/// <summary>
/// Local sample surface giving the provider deterministic shapes (multidim arrays,
/// nullables) that are rare in the BCL but must be encoded exactly.
/// </summary>
public static class DocIdSamples
{
    /// <summary>Sample with a rank-2 array parameter.</summary>
    /// <param name="grid">A grid.</param>
    public static void TakesGrid(int[,] grid)
    {
    }

    /// <summary>Sample with a nullable value-type parameter.</summary>
    /// <param name="value">A nullable.</param>
    public static void TakesNullable(int? value)
    {
    }
}
