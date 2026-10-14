// <copyright file="TestDiscoveryComputerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.Linq
import Xunit

open class TestDiscoveryComputerTests {
    @Fact
    func ComputeTests_DiscoversTopLevelTestFunction() {
        const source = `@Test
func RunsThing() {
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content)
        let item = Assert.Single(tests)
        Assert.Equal("RunsThing", item.Label)
        Assert.Equal("RunsThing", item.Filter)
        Assert.Equal("file:///t.gs", item.Uri)
        Assert.Null(item.Children)
    }

    @Fact
    func ComputeTests_DiscoversClassMethodsWithQualifiedFilter() {
        const source = `class MyTests {
  @Fact
  func PassesA() {
  }

  @Fact
  func PassesB() {
  }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content)
        let group = Assert.Single(tests)
        Assert.Equal("MyTests", group.Label)
        Assert.Null(group.Filter)
        Assert.NotNull(group.Children)
        Assert.Equal(2, group.Children!!.Length)
        Assert.Equal(
            []string{"MyTests.PassesA", "MyTests.PassesB"},
            group.Children!!.Select((c TestDiscoveryItem) -> c.Filter!!).ToArray()
        )
    }

    @Fact
    func ComputeTests_QualifiesClassLabelWithNamespace() {
        const source = `package Foo.Bar

class MyTests {
  @Fact
  func PassesA() {
  }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content)
        let group = Assert.Single(tests)
        Assert.Equal("Foo.Bar.MyTests", group.Label)
        // The run filter token remains the unqualified Class.Method (dotnet test's
        // FullyQualifiedName~ is a substring match, so it still resolves correctly).
        let method = Assert.Single(group.Children!!)
        Assert.Equal("MyTests.PassesA", method.Filter)
    }

    @Fact
    func ComputeTests_IgnoresFunctionsWithoutTestAttribute() {
        const source = `func plainHelper() {
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content)
        Assert.Empty(tests)
    }

    @Fact
    func ComputeTests_RecognizesAttributeSuffix() {
        const source = `@FactAttribute
func Suffixed() {
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let tests = TestDiscoveryComputer.ComputeTests("file:///t.gs", content)
        Assert.Single(tests)
    }
}
