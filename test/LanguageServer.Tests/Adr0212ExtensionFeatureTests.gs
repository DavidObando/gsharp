// <copyright file="Adr0212ExtensionFeatureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
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

    shared {
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
