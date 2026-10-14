// <copyright file="Issue894ConstructorHoverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import Xunit

/// Issue #894: hovering over a local variable, a constructor parameter, or a
/// class member referenced inside an `init(...)` constructor body must
/// produce the same hover result as the equivalent reference inside a normal
/// method body.
open class Issue894ConstructorHoverTests {
    @Fact
    func ComputeHover_LocalVariableInsideConstructorBody() {
        const source = `package P
class Widget {
    var Area int32
    init(w int32, h int32) {
        var product = w * h
        Area = product
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "product", 1)
        )
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("(local variable) product int32", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ConstructorParameterInsideConstructorBody() {
        const source = `package P
class Widget {
    var Area int32
    init(w int32, h int32) {
        var product = w * h
        Area = product
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "w", 1))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("(parameter) w int32", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_ClassMemberInsideConstructorBody() {
        const source = `package P
class Widget {
    /// The computed area.
    var Area int32
    init(w int32, h int32) {
        var product = w * h
        Area = product
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Area", 1))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Area int32", value, StringComparison.Ordinal)
        Assert.Contains("The computed area.", value, StringComparison.Ordinal)
    }
}
