// <copyright file="SyntaxTreeInvariantTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Reflection
import Xunit

open class SyntaxTreeInvariantTests {
    @Fact
    func Root_BeforeParseResult_FailsLoudly() {
        let constructor ConstructorInfo? = typeof(SyntaxTree).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: nil,
            []Type{typeof(SourceText)},
            modifiers: nil
        )
        Assert.NotNull(constructor)
        let tree = Assert.IsType[SyntaxTree](constructor!!.Invoke([]object? {SourceText.From(string.Empty)}))
        Assert.Throws[InvalidOperationException](
            func () object? {
                return tree.Root
            }
        )
    }
}
