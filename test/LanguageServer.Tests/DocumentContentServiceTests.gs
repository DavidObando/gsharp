// <copyright file="DocumentContentServiceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.Reflection
import Xunit

open class DocumentContentServiceTests {
    @Fact
    func AddOrUpdate_Then_TryGet_ReturnsContent() {
        let service = DocumentContentService()
        let content = MakeContent("package P\n")
        service.AddOrUpdate("file:///a.gs", content)
        Assert.True(service.TryGet("file:///a.gs", out var got))
        Assert.Same(content, got)
        Assert.Same(content.SyntaxTree, got.SyntaxTree)
    }

    @Fact
    func TryGet_Missing_ReturnsFalse() {
        let service = DocumentContentService()
        Assert.False(service.TryGet("file:///missing.gs", out var content))
        Assert.Null(content)
    }

    @Fact
    func TryGet_Contract_NarrowsOnlyOnSuccess() {
        let method = typeof(DocumentContentService).GetMethod("TryGet")
        AssertNotNullOnlyOnSuccess(method)
    }

    @Fact
    func LspTryGet_Contract_NarrowsOnlyOnSuccess() {
        let method = typeof(LspServer).GetMethod(
            "TryGet",
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: nil,
            []Type{typeof(TextDocumentIdentifier), typeof(DocumentContent).MakeByRefType()},
            modifiers: nil
        )
        AssertNotNullOnlyOnSuccess(method)
    }

    @Fact
    func AddOrUpdate_Overwrites_Existing() {
        let service = DocumentContentService()
        let c1 = MakeContent("package A\n")
        let c2 = MakeContent("package B\n")
        service.AddOrUpdate("file:///a.gs", c1)
        service.AddOrUpdate("file:///a.gs", c2)
        Assert.True(service.TryGet("file:///a.gs", out var got))
        Assert.Same(c2, got)
    }

    @Fact
    func TryRemove_RemovesEntry() {
        let service = DocumentContentService()
        service.AddOrUpdate("file:///a.gs", MakeContent("package P\n"))
        Assert.True(service.TryRemove("file:///a.gs"))
        Assert.False(service.TryGet("file:///a.gs", out _))
    }

    shared {
        private func MakeContent(text string) DocumentContent {
            let tree = SyntaxTree.Parse(text)
            return DocumentContent(tree, List[int32]())
        }

        private func AssertNotNullOnlyOnSuccess(method MethodInfo?) {
            Assert.NotNull(method)
            let parameter = method!!.GetParameters()[1]
            let contract = Assert.Single(parameter.GetCustomAttributes[NotNullWhenAttribute]())
            Assert.True(contract.ReturnValue)
            Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(parameter).WriteState)
        }
    }
}
