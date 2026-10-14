// <copyright file="DefinitionHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import Xunit

open class DefinitionHandlerTests {
    @Fact
    func ComputeDefinition_FunctionUsageGoesToDeclaration() {
        const source = `func add(a int32, b int32) int32 { return a + b }
let result = add(1, 2)
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")
        // Position cursor on the "add" call in "add(1, 2)"
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri!!,
            content,
            LanguageServerTestHelpers.PositionOf(source, "add", 1)
        )
        Assert.NotNull(location)
        Assert.Equal(uri, location!!.Uri)
        // Should point to the function declaration identifier
        Assert.Equal(0, location!!.Range.Start.Line)
        Assert.Equal(5, location!!.Range.Start.Character)
    }

    @Fact
    func ComputeDefinition_VariableUsageGoesToDeclaration() {
        const source = `func F() int32 {
let x = 42
return x
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")
        // Position on the "x" in "return x"
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri!!,
            content,
            LanguageServerTestHelpers.PositionOf(source, "x", 1)
        )
        Assert.NotNull(location)
        Assert.Equal(uri, location!!.Uri)
    }

    @Fact
    func ComputeDefinition_StructNameGoesToDeclaration() {
        const source = `struct Point {
var X int32
var Y int32
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri!!,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Point")
        )
        Assert.NotNull(location)
        Assert.Equal(uri, location!!.Uri)
    }

    @Fact
    func ComputeDefinitions_PartialType_ReturnsAllPartLocations() {
        // ADR-0144: go-to-definition on a partial type returns every part's
        // location. Two `partial class Point` parts on lines 0 and 3.
        const source = `partial class Point {
    var x int32 = 0
}
partial class Point {
    func Get() int32 { return x }
}
let p = Point()
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")!!
        // Cursor on the `Point` type name in the `Point()` construction.
        let locations = DefinitionComputer.ComputeDefinitions(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Point", 2)
        )
        Assert.Equal(2, locations.Count)
        Assert.Contains(locations, (l Location) -> l.Range.Start.Line == 0)
        Assert.Contains(locations, (l Location) -> l.Range.Start.Line == 3)
        // The single-Location convenience overload returns the first part.
        let single Location? = DefinitionComputer.ComputeDefinition(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Point", 2)
        )
        Assert.NotNull(single)
        Assert.Equal(0, single!!.Range.Start.Line)
    }

    @Fact
    func ComputeDefinition_ReturnsNullForUnknownToken() {
        const source = "let x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")!!
        // Position on "42" — a literal, not a symbol
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "42")
        )
        Assert.Null(location)
    }

    @Fact
    func ComputeDefinition_PropertyUsageGoesToDeclaration() {
        // Implicit-this property usage (`Width` inside a method) must navigate to the
        // property declaration. Previously FindDeclarationToken had no PropertySymbol case.
        const source = `class Rect {
    prop Width int32
    func Double() int32 { return Width + Width }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri!!,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Width", 1)
        )
        Assert.NotNull(location)
        Assert.Equal(uri, location!!.Uri)
        // Declaration identifier "Width" is on line 1 (0-based).
        Assert.Equal(1, location!!.Range.Start.Line)
    }

    @Fact
    func ComputeDefinition_ExplicitPropertyAccessGoesToDeclaration() {
        // `this.Width` member access must navigate to the property declaration.
        const source = `class Rect {
    prop Width int32
    func Get() int32 { return this.Width }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")!!
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Width", 1)
        )
        Assert.NotNull(location)
        Assert.Equal(1, location!!.Range.Start.Line)
    }

    @Fact
    func ComputeDefinition_MethodUsageGoesToDeclaration() {
        const source = `class Calc {
    func Add(a int32, b int32) int32 { return a + b }
    func Run() int32 { return Add(1, 2) }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///def.gs")!!
        let location Location? = DefinitionComputer.ComputeDefinition(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Add", 1)
        )
        Assert.NotNull(location)
        Assert.Equal(1, location!!.Range.Start.Line)
    }
}
