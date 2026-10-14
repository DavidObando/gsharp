// <copyright file="NativeSliceFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import Xunit

class NativeSliceFormattingTests {
    @Fact
    func OrdinaryNameEscapesAreNotRemoved() {
        const source = `let a=$slice[int32]{Value:1}
var b $array[int32]
let $readonly=3
`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("$$slice[int32]", result.Text!!.ToString())
        Assert.Contains("$$array[int32]", result.Text!!.ToString())
        Assert.Contains("$$readonly", result.Text!!.ToString())
    }

    @Fact
    func NativeTypesAndLiteralsKeepModifierAndNullableBinding() {
        const source = `func use(xs readonly slice[string?]?,ys List[readonly slice[int32]],z (readonly slice[int32])?){
let a=readonly slice[int32]{1,2}
let b=slice[int32]{3,4}
let c=array[int32]{5,6}
}`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let text = result.Text!!.ToString()
        Assert.Contains("readonly slice[string?]?", text)
        Assert.Contains("List[readonly slice[int32]]", text)
        Assert.Contains("readonly slice[int32]{1, 2}", text)
        Assert.Contains("slice[int32]{3, 4}", text)
        Assert.Contains("array[int32]{5, 6}", text)
        Assert.Equal(text, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }
}
