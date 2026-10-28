// <copyright file="Adr0212InheritedFeatureTests.cs" company="GSharp">
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
import System.IO
import System.Linq
import Xunit

/// Issue #5441: member completion offers the members that the call binder binds on a class with an imported base,
/// on an imported interface, on a class with a default interface method, and on a collection of a source type.
open class Adr0212InheritedFeatureTests {
    @Fact
    func Completion_OfAClassWithAnImportedBase_OffersTheBaseMembers() {
        let items = Complete("b.")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Mark")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "SetLength" && i.Kind == CompletionItemKind.Method)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Position" && i.Kind == CompletionItemKind.Property)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "Null")
    }

    @Fact
    func Completion_OfAnImportedInterface_OffersTheMembersOfItsBaseInterfaces() {
        let items = Complete("list.")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Count" && i.Kind == CompletionItemKind.Property)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Add")
    }

    @Fact
    func Completion_OfAClassWithADefaultInterfaceMethod_OffersIt() {
        Assert.Contains(Complete("sq."), (i CompletionItem) -> i.Label == "Area")
    }

    @Fact
    func Completion_OfACollectionOfASourceType_OffersTheBuiltInMembers() {
        Assert.Contains(Complete("items."), (i CompletionItem) -> i.Label == "Length")
        Assert.Contains(Complete("lookup."), (i CompletionItem) -> i.Label == "ContainsKey")
    }

    @Fact
    func LookupMembers_OnAProjectBackedReferenceSet_ReadsMetadataWithoutThrowing() {
        // A project's references load into a MetadataLoadContext: every row reads its members there.
        let body = "let a1 = b.Position\n    let a2 = list.Count\n    let a3 = sq.ToString()\n    let a4 = items.Length\n    let a5 = lookup.Count"
        let tree = SyntaxTree.Parse(SourceText.From(Text(body), "ref.gs"))
        let compilation = Compilation(CreateReferencePackResolver(), tree)
        let model = compilation.GetSemanticModel(tree)
        var compared = 0
        for access in tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]() {
            let receiver = model.GetReceiverTypeInfo(access.LeftPart).Type!!
            let name = access.RightPart.GetFirstToken().ValueText
            let members = model.LookupMembers(access.Span.Start, receiver, name)
            Assert.NotEmpty(members)
            // Classifying every member, static or not, must not throw either.
            Assert.Equal(
                members.Length,
                members.Select((m Symbol) -> MemberTokenResolver.IsStatic(m, receiver)).ToList().Count
            )
            compared++
        }
        Assert.Equal(5, compared)
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

        private const Template string = `package Inh
import System
import System.IO
import System.Collections.Generic

class Buffer : MemoryStream {
    func Mark() int32 { return 1 }
}

interface IShape {
    func Area() int32 { return 1 }
}

class Square : IShape { }

class Item { var X int32 = 0 }

func Use(
    b Buffer,
    list IList[string],
    sq Square,
    items []Item,
    lookup map[string, Item]
) {
    @@
}
`

        private func Text(statement string) string {
            return Template.Replace("@@", statement, StringComparison.Ordinal)
        }

        private func Complete(anchor string) IReadOnlyList[CompletionItem] {
            let text = Text(anchor)
            let content = LanguageServerTestHelpers.Content(text)
            let at = LanguageServerTestHelpers.PositionOf(text, anchor)
            return CompletionComputer.ComputeCompletions(content, Position(at.Line, at.Character + anchor.Length))
        }
    }
}
