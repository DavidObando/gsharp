// <copyright file="Adr0212MemberFeatureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0212 slice S4: the features that moved onto `SemanticModel.LookupMembers` and
/// `GetMemberGroup`: member completion, signature help and the hover overload count.
open class Adr0212MemberFeatureTests {
    @Fact
    func SignatureHelp_ListsEveryOverloadOfAnImportedMethod() {
        let call = "Console.WriteLine("
        let content = LanguageServerTestHelpers.Content(Source)
        let position = LanguageServerTestHelpers.PositionOf(Source, call)
        let help = SignatureHelpComputer.ComputeSignatureHelp(
            content,
            Position(position.Line, position.Character + call.Length)
        )
        Assert.NotNull(help)
        Assert.True(help!!.Signatures.Count() > 5, "one signature for each overload")
        Assert.All(
            help!!.Signatures,
            (s SignatureInformation) -> Assert.Contains("WriteLine", s.Label, StringComparison.Ordinal)
        )
    }

    @Fact
    func SignatureHelp_LabelsEveryImportedOverloadDifferently() {
        let call = "Console.WriteLine("
        let content = LanguageServerTestHelpers.Content(Source)
        let position = LanguageServerTestHelpers.PositionOf(Source, call)
        let help = SignatureHelpComputer.ComputeSignatureHelp(
            content,
            Position(position.Line, position.Character + call.Length)
        )
        let labels = help!!.Signatures.Select((s SignatureInformation) -> s.Label).ToList()
        Assert.Equal(labels.Count, labels.Distinct().Count())
        for signature in help!!.Signatures {
            Assert.All(
                signature.Parameters,
                (p ParameterInformation) -> Assert.Contains(p.Label, signature.Label, StringComparison.Ordinal)
            )
        }
        // The overload that the call resolved to is the active one: WriteLine(string).
        Assert.Contains("string", labels[help!!.ActiveSignature], StringComparison.Ordinal)
    }

    @Fact
    func SignatureHelp_ListsEveryOverloadOfASourceFunction() {
        let call = "Pick("
        let content = LanguageServerTestHelpers.Content(Source)
        let position = LanguageServerTestHelpers.PositionOf(Source, call, 2)
        let help = SignatureHelpComputer.ComputeSignatureHelp(
            content,
            Position(position.Line, position.Character + call.Length)
        )
        Assert.NotNull(help)
        Assert.Equal(2, help!!.Signatures.Count())
    }

    @Fact
    func Completion_OffersNoPrivateMemberOfAnotherType() {
        let items = Complete("// outside")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Shown")
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "Hidden")
    }

    @Fact
    func Completion_OfAnImportedType_OffersItsStaticMembers() {
        let items = Complete("// console")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "WriteLine" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "get_Out")
    }

    @Fact
    func Completion_OfATupleValue_OffersItsElementsButNotOfItsTypeName() {
        let value = Complete("// pairValue")
        Assert.Contains(value, (i CompletionItem) -> i.Label == "left")
        Assert.DoesNotContain(Complete("// pairType"), (i CompletionItem) -> i.Label == "left")
    }

    @Fact
    func Hover_OnAnInitializerName_DescribesTheNearestDeclaringType() {
        let source = "open class Base {\n    prop Value string {\n        get {\n            return \"\"\n        }\n    }\n}\nclass Derived : Base {\n    var Value int32\n}\nfunc Build() Derived {\n    return Derived() { Value = 1 }\n}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Value", 2))
        Assert.NotNull(hover)
        Assert.Contains("int32", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Hover_OnAnImportedCall_CountsTheOverloadsOfItsGroup() {
        let content = LanguageServerTestHelpers.Content(Source)
        let hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(Source, "WriteLine", 0))
        Assert.NotNull(hover)
        Assert.Contains("overloads", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    shared {
        private const Source string = `package Members
import System

func Pick(a int32) int32 { return a }
func Pick(a string) int32 { return 0 }

class Box {
    var Shown int32
    private var Hidden int32
}

type Pair = (left int32, right int32)

func Use(b Box, pair (left int32, right int32)) {
    Console.WriteLine("x")
    let n = Pick(1)
    let m = b.
}
`

        private func Complete(marker string) IReadOnlyList[CompletionItem] {
            let source = if marker == "// console" {
                Source.Replace("    let m = b.\n", "    Console.\n", StringComparison.Ordinal)
            } else if marker == "// pairValue" {
                Source.Replace("    let m = b.\n", "    pair.\n", StringComparison.Ordinal)
            } else if marker == "// pairType" {
                Source.Replace("    let m = b.\n", "    Pair.\n", StringComparison.Ordinal)
            } else {
                Source
            }
            let text = if marker == "// outside" {
                source
            } else {
                source
            }
            let content = LanguageServerTestHelpers.Content(text)
            let anchor = if marker == "// console" {
                "Console.\n"
            } else if marker == "// pairValue" {
                "pair.\n"
            } else if marker == "// pairType" {
                "Pair.\n"
            } else {
                "let m = b."
            }
            let at = LanguageServerTestHelpers.PositionOf(text, anchor)
            return CompletionComputer.ComputeCompletions(
                content,
                Position(at.Line, at.Character + anchor.TrimEnd('\n').Length)
            )
        }
    }
}
