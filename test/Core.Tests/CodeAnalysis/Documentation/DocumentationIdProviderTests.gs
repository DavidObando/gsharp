// <copyright file="DocumentationIdProviderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Documentation

import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Documentation
import Xunit
import GSharp.Core.Tests
import System.IO
import System.Xml.Linq

/// ADR-0057 §5: golden tests pinning (cref:DocumentationIdProvider) to Roslyn's
/// exact DocID format. The expected strings are taken verbatim from the .NET reference
/// pack's own `.xml` documentation files — i.e. they are Roslyn's own output — so
/// these assertions verify byte-for-byte parity for both the ingestion and emission
/// code paths that share this provider.
open class DocumentationIdProviderTests {
    @Fact
    func Type_Simple() {
        Assert.Equal("T:System.String", DocumentationIdProvider.GetDocumentationId(typeof(string)))
    }

    @Fact
    func Type_OpenGeneric_UsesArityBacktick() {
        Assert.Equal("T:System.Collections.Generic.List`1", DocumentationIdProvider.GetDocumentationId(typeof(List[_])))
        Assert.Equal("T:System.Action`2", DocumentationIdProvider.GetDocumentationId(typeof(Action[_, _])))
    }

    @Fact
    func Type_ConstructedGeneric_NormalizesToDefinition() {
        Assert.Equal(
            "T:System.Collections.Generic.List`1",
            DocumentationIdProvider.GetDocumentationId(typeof(List[int32]))
        )
    }

    @Fact
    func Type_NestedGeneric_UsesDotAndPerLevelArity() {
        Assert.Equal(
            "T:System.Collections.Generic.Dictionary`2.Enumerator",
            DocumentationIdProvider.GetDocumentationId(typeof(Dictionary[_, _].Enumerator))
        )
    }

    @Fact
    func Field_OnType() {
        Assert.Equal(
            "F:System.Int32.MaxValue",
            DocumentationIdProvider.GetDocumentationId(typeof(int32).GetField("MaxValue")!!)
        )
    }

    @Fact
    func Property_OnType() {
        Assert.Equal(
            "P:System.String.Length",
            DocumentationIdProvider.GetDocumentationId(typeof(string).GetProperty("Length")!!)
        )
    }

    @Fact
    func Method_SingleParameter() {
        let method MethodInfo? = typeof(string).GetMethod("Substring", []Type{typeof(int32)})
        Assert.Equal("M:System.String.Substring(System.Int32)", DocumentationIdProvider.GetDocumentationId(method!!))
    }

    @Fact
    func Method_NoParameters_OmitsParens() {
        let method MethodInfo? = typeof(object).GetMethod("ToString", Type.EmptyTypes)
        Assert.Equal("M:System.Object.ToString", DocumentationIdProvider.GetDocumentationId(method!!))
    }

    @Fact
    func Method_ByRefParameter_AppendsAt() {
        let method MethodInfo? = typeof(AppContext).GetMethod("TryGetSwitch")
        Assert.Equal(
            "M:System.AppContext.TryGetSwitch(System.String,System.Boolean@)",
            DocumentationIdProvider.GetDocumentationId(method!!)
        )
    }

    @Fact
    func Method_ConstructedGenericParameter_UsesBraces() {
        let method MethodInfo? = typeof(AggregateException).GetMethod("Handle")
        Assert.Equal(
            "M:System.AggregateException.Handle(System.Func{System.Exception,System.Boolean})",
            DocumentationIdProvider.GetDocumentationId(method!!)
        )
    }

    @Fact
    func Method_GenericWithMethodTypeParameters() {
        let method = typeof(Array).GetMethods().First(
            (m MethodInfo) -> m.Name == "Resize" && m.IsGenericMethodDefinition
        )
        Assert.Equal(
            "M:System.Array.Resize``1(``0[]@,System.Int32)",
            DocumentationIdProvider.GetDocumentationId(method)
        )
    }

    @Fact
    func Method_OnGenericType_UsesClassTypeParameterReference() {
        let method MethodInfo? = typeof(List[_]).GetMethod("Add")
        Assert.Equal(
            "M:System.Collections.Generic.List`1.Add(`0)",
            DocumentationIdProvider.GetDocumentationId(method!!)
        )
    }

    @Fact
    func Constructor_InstanceUsesCtor() {
        let ctor ConstructorInfo? = typeof(AggregateException).GetConstructor([]Type{typeof([]Exception)})
        Assert.Equal(
            "M:System.AggregateException.#ctor(System.Exception[])",
            DocumentationIdProvider.GetDocumentationId(ctor!!)
        )
    }

    @Fact
    func Method_ConversionOperator_AppendsReturnType() {
        let op = typeof(DateTimeOffset).GetMethods().First(
            (m MethodInfo) -> m.Name == "op_Implicit" && m.GetParameters()[0].ParameterType == typeof(DateTime)
        )
        Assert.Equal(
            "M:System.DateTimeOffset.op_Implicit(System.DateTime)~System.DateTimeOffset",
            DocumentationIdProvider.GetDocumentationId(op)
        )
    }

    @Fact
    func Method_MultidimensionalArrayParameter() {
        let method MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Documentation.DocIdSamples"
        )
            .GetMethod("TakesGrid")
        Assert.Equal(
            "M:GSharp.Core.Tests.CodeAnalysis.Documentation.DocIdSamples.TakesGrid(System.Int32[0:,0:])",
            DocumentationIdProvider.GetDocumentationId(method!!)
        )
    }

    @Fact
    func Method_NullableValueTypeParameter_UsesNullableBraces() {
        let method MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Documentation.DocIdSamples"
        )
            .GetMethod("TakesNullable")
        Assert.Equal(
            "M:GSharp.Core.Tests.CodeAnalysis.Documentation.DocIdSamples.TakesNullable(System.Nullable{System.Int32})",
            DocumentationIdProvider.GetDocumentationId(method!!)
        )
    }

    @Fact
    func Method_ExplicitGenericInterfaceImplementation_ManglesInterfaceTypeArguments() {
        // Dictionary<TKey,TValue> explicitly implements ICollection<KeyValuePair<TKey,TValue>>.Add.
        // Roslyn mangles the interface portion of the name with '#'/'{'/'}'/'@' and references
        // the interface's type arguments by their declaring-type parameter names (TKey, TValue),
        // while the parameter signature still uses positional `0/`1. Verbatim from System.Collections.xml.
        let method = typeof(Dictionary[_, _]).GetMethods(BindingFlags.NonPublic | BindingFlags.Instance).First(
            (m MethodInfo) -> m.Name.Contains("ICollection") && m.Name.EndsWith(".Add", StringComparison.Ordinal)
        )
        Assert.Equal(
            "M:System.Collections.Generic.Dictionary`2.System#Collections#Generic#ICollection{System#Collections#Generic#KeyValuePair{TKey@TValue}}#Add(System.Collections.Generic.KeyValuePair{`0,`1})",
            DocumentationIdProvider.GetDocumentationId(method)
        )
    }

    /// Corpus check: every computed DocID for a curated, stable slice of the BCL public
    /// surface must appear in the reference pack's own `.xml`, confirming parity
    /// with Roslyn across a broad, real member set rather than only curated cases.
    @Fact
    func Corpus_ComputedIdsAppearInReferenceXml() {
        let members = LoadReferenceMemberNames("System.Runtime.xml")
        if members.Count == 0 {
            return // Reference pack not present in this environment; skip silently.

        }
        var probed = 0
        var missed = 0
        for type in[]Type{typeof(string), typeof(Math), typeof(Version)} {
            for method in type.GetMethods(
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
            ) {
                if method.IsSpecialName || method.IsGenericMethod || method.Name.Contains('.') {
                    continue
                }
                let id = DocumentationIdProvider.GetDocumentationId(method)
                // The running runtime surface can be newer than the reference pack xml,
                // so an individual member may legitimately be absent. A *format*
                // regression, however, would make essentially everything miss — hence we
                // require a strong majority to match rather than every member.
                if members.Contains(id) {
                    probed++
                } else {
                    missed++
                }
            }
        }
        Assert.True(probed > 20, "Expected to verify many members, only matched $probed.")
        Assert.True(
            probed > missed * 4,
            "Too many DocID mismatches ($missed missed vs $probed matched) — likely a format regression."
        )
    }

    shared {
        private func LoadReferenceMemberNames(fileName string) HashSet[string] {
            let packRoot = "/usr/local/share/dotnet/packs/Microsoft.NETCore.App.Ref"
            let result = HashSet[string](StringComparer.Ordinal)
            if !Directory.Exists(packRoot) {
                return result
            }
            let xml string? = Directory
                .EnumerateFiles(packRoot, fileName, SearchOption.AllDirectories)
                .OrderByDescending((p string) -> p)
                .FirstOrDefault()
            if xml == nil {
                return result
            }
            let doc = XDocument.Load(xml)
            for member in doc.Descendants("member") {
                let name string? = member.Attribute(XName?("name")!!)?.Value
                if name != nil {
                    result.Add(name)
                }
            }
            return result
        }
    }
}
