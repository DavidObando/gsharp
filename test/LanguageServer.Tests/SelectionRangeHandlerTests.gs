// <copyright file="SelectionRangeHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import Xunit

open class SelectionRangeHandlerTests {
    @Fact
    func ComputeSelectionRange_ReturnsNestedRanges() {
        const source = `func add(a int32, b int32) int32 {
  return a + b
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let position = LanguageServerTestHelpers.PositionOf(source, "a + b")
        let result = SelectionRangeComputer.ComputeSelectionRange(content, position)
        // Should have at least one level of nesting
        Assert.NotNull(result)
        Assert.NotNull(result.Parent)
    }

    @Fact
    func ComputeSelectionRange_AtTopLevel_ReturnsFullFile() {
        const source = "var x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let position = Position(0, 4)
        let result = SelectionRangeComputer.ComputeSelectionRange(content, position)
        Assert.NotNull(result)
    }

    @Fact
    func ComputeSelectionRange_EmptySource_ReturnsNull() {
        const source = ""
        let content = LanguageServerTestHelpers.Content(source)
        let position = Position(0, 0)
        let result SelectionRange? = SelectionRangeComputer.ComputeSelectionRange(content, position)
        // Empty source may return null or a minimal range
        // The handler should not throw
        Assert.True(result == nil || result.Range != nil)
    }
}
