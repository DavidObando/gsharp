// <copyright file="Issue4214NestedEnumArrayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.IO
import Xunit

open class Issue4214NestedEnumArrayTests {
    @Theory
    @InlineData("[]Kind{Kind.First}")
    @InlineData("[1]Kind{Kind.First}")
    func SymbolicArray_WidensToObjectWithoutChangingIdentity(array string) {
        let result = EmittedOracle.Evaluate((`enum Kind { First = 7 }
func Forward(value object) object -> value
let values = ` + "$array" + `
let boxed object? = values
let forwarded = Forward(values)
"${boxed!!.GetType().Name}:${System.Object.ReferenceEquals(boxed, forwarded)}"`))
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("Kind[]:True", result.Value)
    }

    @Fact
    func GenericArrayReturn_WidensToObjectWithoutChangingIdentity() {
        let result = EmittedOracle.Evaluate(`enum Kind { First = 7 }
func Forward[T any](values []T) object -> values
let values = []Kind{Kind.First}
let forwarded = Forward(values)
"${forwarded.GetType().Name}:${System.Object.ReferenceEquals(values, forwarded)}"`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("Kind[]:True", result.Value)
    }

    @Theory
    @InlineData("[]Kind{GetKind()}")
    @InlineData("[1]Kind{GetKind()}")
    @InlineData("[]string{GetText()}")
    func NestedAttributeArray_NonConstantElementRemainsRejected(array string) {
        let compilation = Compilation(SyntaxTree.Parse((`import System
enum Kind { First = 7 }
func GetKind() Kind -> Kind.First
func GetText() string -> "value"
class ValueAttribute : Attribute {
    init(value object) {}
}
@Value([]object{ ` + "$array" + ` })
class Tagged {}`))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0202")
    }
}
