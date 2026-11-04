// <copyright file="Adr0212ExtensionFeatureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// ADR-0212 question 12: member completion lists the extensions in scope for a value, and never for a type name.
open class Adr0212ExtensionFeatureTests {
    @Fact
    func Completion_OfAValue_OffersTheSourceExtensionsOfItsType() {
        let items = Complete("n.")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Shout" && i.Kind == CompletionItemKind.Method)
    }

    @Fact
    func Completion_OfAValue_OffersTheImportedExtensionsOfItsType() {
        let items = Complete("xs.")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Select" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "Shout")
    }

    @Fact
    func Completion_OfATypeName_OffersNoExtension() {
        let items = Complete("String.")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "IsNullOrEmpty")
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "Shout")
    }

    @Fact
    func Completion_OfAnEnumValue_OffersItsExtensionsAndTheTypeNameOffersItsConstants() {
        let value = CompleteEnum("c.")
        Assert.Contains(value, (i CompletionItem) -> i.Label == "Rank" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(value, (i CompletionItem) -> i.Label == "Red")
        let type = CompleteEnum("Color.")
        Assert.Contains(type, (i CompletionItem) -> i.Label == "Red")
        Assert.DoesNotContain(type, (i CompletionItem) -> i.Label == "Rank")
    }

    @Fact
    func Completion_OfAStaticHolderClass_StillOffersItsExtensionMethodsAsStaticCalls() {
        let items = Complete("Enumerable.")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Select" && i.Kind == CompletionItemKind.Method)
    }

    @Fact
    func Hover_OnASourceExtensionCall_CountsTheOverloadsForTheReceiver() {
        let content = SourceExtensionProjectContent()
        let singleHover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(SourceExtensionFileA, "Shout", 2)
        )
        Assert.NotNull(singleHover)
        Assert.Contains("Shout", singleHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("overload", singleHover!!.Contents.ToString(), StringComparison.Ordinal)
        let overloadedHover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(SourceExtensionFileA, "Scale", 3)
        )
        Assert.NotNull(overloadedHover)
        Assert.Contains("*(+ 1 overload)*", overloadedHover!!.Contents.ToString(), StringComparison.Ordinal)
        let genericSingleHover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(SourceExtensionFileA, "Repeat", 1)
        )
        Assert.NotNull(genericSingleHover)
        Assert.Contains("Repeat", genericSingleHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("overload", genericSingleHover!!.Contents.ToString(), StringComparison.Ordinal)
        let genericOverloadedHover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(SourceExtensionFileA, "Pick", 1)
        )
        Assert.NotNull(genericOverloadedHover)
        Assert.Contains("*(+ 1 overload)*", genericOverloadedHover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func SignatureHelp_OnASourceExtensionCall_ListsTheOverloadsInFileThenStartOrder() {
        let content = SourceExtensionProjectContent()
        let singleHelp = HelpIn(content, SourceExtensionFileA, "n.Shout(")
        Assert.NotNull(singleHelp)
        let singleSignature = Assert.Single(singleHelp!!.Signatures)
        Assert.Equal("func Shout() int32", singleSignature.Label)
        Assert.Empty(singleSignature.Parameters)
        let overloadedHelp = HelpIn(content, SourceExtensionFileA, "n.Scale(")
        Assert.NotNull(overloadedHelp)
        let scaleLabels = overloadedHelp!!.Signatures.Select((s SignatureInformation) -> s.Label).ToArray()
        Assert.Equal(
            []string{"func Scale(factor int32) int32", "func Scale(factor int32, bonus int32) int32"},
            scaleLabels
        )
        Assert.Equal(0, overloadedHelp!!.ActiveSignature)
        Assert.Equal(0, overloadedHelp!!.ActiveParameter)
        Assert.Equal(
            "factor int32",
            overloadedHelp!!
                .Signatures
                .ElementAt(overloadedHelp!!.ActiveSignature)
                .Parameters
                .ElementAt(overloadedHelp!!.ActiveParameter)
                .Label
        )
        let genericSingleHelp = HelpIn(content, SourceExtensionFileA, "n.Repeat(")
        Assert.NotNull(genericSingleHelp)
        let repeatSignature = Assert.Single(genericSingleHelp!!.Signatures)
        Assert.Equal("func Repeat[T](item T) sequence[T?]", repeatSignature.Label)
        Assert.Equal("item T", Assert.Single(repeatSignature.Parameters).Label)
        let genericOverloadedHelp = HelpIn(content, SourceExtensionFileA, "xs.Pick(")
        Assert.NotNull(genericOverloadedHelp)
        let pickLabels = genericOverloadedHelp!!.Signatures.Select((s SignatureInformation) -> s.Label).ToArray()
        Assert.Equal([]string{"func Pick[T](index int32) T", "func Pick[T](index int32, fallback T) T"}, pickLabels)
        Assert.Equal(0, genericOverloadedHelp!!.ActiveSignature)
        Assert.Equal(
            "index int32",
            genericOverloadedHelp!!
                .Signatures
                .ElementAt(genericOverloadedHelp!!.ActiveSignature)
                .Parameters
                .ElementAt(genericOverloadedHelp!!.ActiveParameter)
                .Label
        )
        let mixedStaticHelp = HelpIn(content, SourceExtensionFileA, "HostB.Scale(")
        Assert.NotNull(mixedStaticHelp)
        let mixedLabels = mixedStaticHelp!!.Signatures.Select((s SignatureInformation) -> s.Label).ToArray()
        Assert.Equal(
            []string{
                "static func Scale(only int32) int32",
                "static func Scale(value int32, factor int32, bonus int32) int32"
            },
            mixedLabels
        )
        Assert.Equal(0, mixedStaticHelp!!.ActiveSignature)
        Assert.Equal(
            "only int32",
            mixedStaticHelp!!
                .Signatures
                .ElementAt(mixedStaticHelp!!.ActiveSignature)
                .Parameters
                .ElementAt(mixedStaticHelp!!.ActiveParameter)
                .Label
        )
        let mixedStaticExtensionHelp = HelpIn(content, SourceExtensionFileA, "HostB.Scale(2, ")
        Assert.NotNull(mixedStaticExtensionHelp)
        Assert.Equal(1, mixedStaticExtensionHelp!!.ActiveSignature)
        Assert.Equal(1, mixedStaticExtensionHelp!!.ActiveParameter)
        Assert.Equal(
            "factor int32",
            mixedStaticExtensionHelp!!
                .Signatures
                .ElementAt(mixedStaticExtensionHelp!!.ActiveSignature)
                .Parameters
                .ElementAt(mixedStaticExtensionHelp!!.ActiveParameter)
                .Label
        )
    }

    @Fact
    func Hover_OnAnImportedExtensionCall_CountsOnlyTheOverloadsForTheReceiver() {
        let content = LanguageServerTestHelpers.Content(ImportedExtensionSource)
        let selectHover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(ImportedExtensionSource, "Select")
        )
        Assert.NotNull(selectHover)
        Assert.Contains("*(+ 1 overload)*", selectHover!!.Contents.ToString(), StringComparison.Ordinal)
        let toArrayHover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(ImportedExtensionSource, "ToArray")
        )
        Assert.NotNull(toArrayHover)
        Assert.Contains("ToArray", toArrayHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("overload", toArrayHover!!.Contents.ToString(), StringComparison.Ordinal)
        let asSpanHover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(ImportedExtensionSource, "AsSpan")
        )
        Assert.NotNull(asSpanHover)
        Assert.Contains("*(+ 4 overloads)*", asSpanHover!!.Contents.ToString(), StringComparison.Ordinal)
        let comparerHover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(ImportedExtensionSource, "GetStringComparer")
        )
        Assert.NotNull(comparerHover)
        Assert.Contains("GetStringComparer", comparerHover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("overload", comparerHover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func SignatureHelp_OnAnImportedExtensionCall_ListsOnlyTheOverloadsForTheReceiver() {
        let content = LanguageServerTestHelpers.Content(ImportedExtensionSource)
        let selectHelp = HelpIn(content, ImportedExtensionSource, "xs.Select(")
        Assert.NotNull(selectHelp)
        let selectLabels = selectHelp!!.Signatures.Select((s SignatureInformation) -> s.Label).ToArray()
        Assert.Equal(2, selectLabels.Length)
        Assert.All(
            selectLabels,
            (label string) -> Assert.DoesNotContain("source IEnumerable[TSource]", label, StringComparison.Ordinal)
        )
        Assert.Equal(0, selectHelp!!.ActiveSignature)
        Assert.Equal(
            "selector Func[TSource, TResult]",
            selectHelp!!
                .Signatures
                .ElementAt(selectHelp!!.ActiveSignature)
                .Parameters
                .ElementAt(selectHelp!!.ActiveParameter)
                .Label
        )
        let toListHelp = HelpIn(content, ImportedExtensionSource, "xs.ToList(")
        Assert.NotNull(toListHelp)
        let toListSignature = Assert.Single(toListHelp!!.Signatures)
        Assert.DoesNotContain("source", toListSignature.Label, StringComparison.Ordinal)
        Assert.Empty(toListSignature.Parameters)
        let toArrayHelp = HelpIn(content, ImportedExtensionSource, "xs.ToArray(")
        Assert.NotNull(toArrayHelp)
        let toArraySignature = Assert.Single(toArrayHelp!!.Signatures)
        Assert.DoesNotContain("source", toArraySignature.Label, StringComparison.Ordinal)
        Assert.Empty(toArraySignature.Parameters)
        let asSpanHelp = HelpIn(content, ImportedExtensionSource, "s.AsSpan(")
        Assert.NotNull(asSpanHelp)
        let asSpanLabels = asSpanHelp!!.Signatures.Select((s SignatureInformation) -> s.Label).ToArray()
        Assert.Equal(5, asSpanLabels.Length)
        Assert.All(
            asSpanLabels,
            (label string) -> Assert.DoesNotContain("text string", label, StringComparison.Ordinal)
        )
        Assert.Equal(
            "start int32",
            asSpanHelp!!
                .Signatures
                .ElementAt(asSpanHelp!!.ActiveSignature)
                .Parameters
                .ElementAt(asSpanHelp!!.ActiveParameter)
                .Label
        )
        let comparerHelp = HelpIn(content, ImportedExtensionSource, "cmp.GetStringComparer(")
        Assert.NotNull(comparerHelp)
        let comparerSignature = Assert.Single(comparerHelp!!.Signatures)
        Assert.DoesNotContain("compareInfo", comparerSignature.Label, StringComparison.Ordinal)
        Assert.Equal("options CompareOptions", Assert.Single(comparerSignature.Parameters).Label)
        const qualifiedStaticSource = "package Ext\nfunc Use(xs []int32) {\n    let arr = System.Linq.Enumerable.ToArray(xs)\n}\n"
        let qualifiedStaticContent = LanguageServerTestHelpers.Content(qualifiedStaticSource)
        let qualifiedStaticHelp = HelpIn(
            qualifiedStaticContent,
            qualifiedStaticSource,
            "System.Linq.Enumerable.ToArray("
        )
        Assert.NotNull(qualifiedStaticHelp)
        let qualifiedStaticSignature = Assert.Single(qualifiedStaticHelp!!.Signatures)
        Assert.Contains("source IEnumerable[int32]", qualifiedStaticSignature.Label, StringComparison.Ordinal)
        Assert.Equal("source IEnumerable[int32]", Assert.Single(qualifiedStaticSignature.Parameters).Label)
    }

    @Fact
    func ExtensionClassification_OnAProjectBackedReferenceSet_ReadsMetadataWithoutThrowing() {
        // A project's references load into a MetadataLoadContext, where MethodInfo.IsDefined is not supported.
        let tree = SyntaxTree.Parse(
            SourceText.From(
                "package Ext\nimport System\nimport System.Linq\n\nfunc Use(xs []int32) {\n    xs.Count() // PRef\n}\n",
                "ref.gs"
            )
        )
        let compilation = Compilation(CreateReferencePackResolver(), tree)
        let model = compilation.GetSemanticModel(tree)
        let position = tree.Text.ToString().IndexOf("// PRef", StringComparison.Ordinal)
        let access = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().First()
        let receiver = model.GetReceiverTypeInfo(access.LeftPart).Type!!
        let members = model.LookupMembers(position, receiver, "Count")
        Assert.NotEmpty(members)
        Assert.All(members, (m Symbol) -> Assert.True(BoundSemantics.IsReceiverExtension(m, receiver), m.Name))
        Assert.All(members, (m Symbol) -> Assert.False(MemberTokenResolver.IsStatic(m, receiver), m.Name))
        // Every member of an imported type, static ones included, classifies without throwing.
        let strings = model.LookupMembers(position, TypeSymbol.String)
        Assert.NotEmpty(strings)
        Assert.Contains(strings, (m Symbol) -> MemberTokenResolver.IsStatic(m, TypeSymbol.String))
    }

    shared {
        private func CreateReferencePackResolver() ReferenceResolver {
            let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            let dotnetRoot = Directory.GetParent(runtimeDir!!)!!.Parent!!.Parent!!.FullName
            let packRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            Assert.True(Directory.Exists(packRoot), "Ref pack root '${packRoot}' not found.")
            let refDir = Directory
                .EnumerateDirectories(packRoot)
                .Select((d string) -> Path.Combine(d, "ref", "net${Environment.Version.Major}.0"))
                .Where((d string) -> Directory.Exists(d))
                .OrderByDescending((d string) -> d, StringComparer.Ordinal)
                .First()
            return ReferenceResolver.WithReferences(Directory.GetFiles(refDir, "*.dll"))
        }

        private const EnumTemplate string = `package Ext

enum Color { Red, Green }

func (c Color) Rank() int32 {
    return 1
}

func Use(c Color) {
    @@
}
`

        private func CompleteEnum(anchor string) IReadOnlyList[CompletionItem] {
            let text = EnumTemplate.Replace("@@", anchor, StringComparison.Ordinal)
            let content = LanguageServerTestHelpers.Content(text)
            let at = LanguageServerTestHelpers.PositionOf(text, anchor)
            return CompletionComputer.ComputeCompletions(content, Position(at.Line, at.Character + anchor.Length))
        }

        private const Template string = `package Ext
import System
import System.Linq

func (value int32) Shout() int32 {
    return value
}

func Use(n int32, xs []int32) {
    @@
}
`

        private const SourceExtensionFileA string = `package Ext
import System.Collections.Generic

class HostA {}
class HostB {
    shared {
        func Scale(only int32) int32 {
            return only
        }
    }
}

func (value int32) Shout() int32 {
    return value
}

func (text string) Shout() string {
    return text
}

@ExtensionOwner(typeof(HostA))
func (value int32) Scale(factor int32) int32 {
    return value * factor
}

func (text string) Scale(factor int32) string {
    return text
}

func (value int32) Repeat[T](item T) sequence[T?] {
    yield item
}

@ExtensionOwner(typeof(HostA))
func (items IList[T]) Pick[T](index int32) T {
    return items[index]
}

func Use(n int32, xs []int32) {
    let a = n.Shout()
    let b = n.Scale(2)
    let c = n.Repeat("x")
    let d = xs.Pick(0)
    let e = HostB.Scale(2)
    let f = HostB.Scale(2, 3, 4)
}
`

        private const SourceExtensionFileB string = `package Ext
import System.Collections.Generic

@ExtensionOwner(typeof(HostB))
func (value int32) Scale(factor int32, bonus int32) int32 {
    return (value * factor) + bonus
}

@ExtensionOwner(typeof(HostB))
func (items IList[T]) Pick[T](index int32, fallback T) T {
    return fallback
}
`

        private const ImportedExtensionSource string = `package Ext
import System
import System.Globalization
import System.Linq

func Use(xs []int32, s string, cmp CompareInfo) {
    let mapped = xs.Select((x int32) -> x)
    let list = xs.ToList()
    let arr = xs.ToArray()
    let span = s.AsSpan(1)
    let comparer = cmp.GetStringComparer(CompareOptions.None)
}
`

        private func SourceExtensionProjectContent() DocumentContent {
            let project = ProjectState("/test/ext.gsproj")
            project.UpdateFile("/test/b.gs", SourceExtensionFileB)
            project.UpdateFile("/test/a.gs", SourceExtensionFileA)
            Assert.True(project.TryGetSyntaxTree("/test/a.gs", out var treeA))
            let lines = List[int32]()
            for var i = 0; i < SourceExtensionFileA.Length; i++ {
                if SourceExtensionFileA[i] == '\n' {
                    lines.Add(i)
                }
            }
            return DocumentContent(treeA, lines, project)
        }

        private func HelpIn(content DocumentContent, source string, callPrefix string) SignatureHelp? {
            let at = LanguageServerTestHelpers.PositionOf(source, callPrefix)
            return SignatureHelpComputer.ComputeSignatureHelp(
                content,
                Position(at.Line, at.Character + callPrefix.Length)
            )
        }

        private func Complete(anchor string) IReadOnlyList[CompletionItem] {
            let text = Template.Replace("@@", anchor, StringComparison.Ordinal)
            let content = LanguageServerTestHelpers.Content(text)
            let at = LanguageServerTestHelpers.PositionOf(text, anchor)
            return CompletionComputer.ComputeCompletions(content, Position(at.Line, at.Character + anchor.Length))
        }
    }
}
