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

        private func Complete(anchor string) IReadOnlyList[CompletionItem] {
            let text = Template.Replace("@@", anchor, StringComparison.Ordinal)
            let content = LanguageServerTestHelpers.Content(text)
            let at = LanguageServerTestHelpers.PositionOf(text, anchor)
            return CompletionComputer.ComputeCompletions(content, Position(at.Line, at.Character + anchor.Length))
        }
    }
}
