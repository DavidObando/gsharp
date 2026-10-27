// <copyright file="NativeSliceFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import Xunit

class NativeSliceFormattingTests {
    @Fact
    func ClrSpanAliasesKeepModifiersAcrossNestedTypesAndReceivers() {
        const source = `func use(value readonly span[byte],nested List[readonly span[byte]],tuple (readonly span[int32],span[byte])){
let empty=readonly span[byte].Empty
let writable=span[byte](data)
let ordinary=$span[int32]{Value:1}
}`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let text = result.Text!!.ToString()
        Assert.Contains("readonly span[byte]", text)
        Assert.Contains("List[readonly span[byte]]", text)
        Assert.Contains("(readonly span[int32], span[byte])", text)
        Assert.Contains("readonly span[byte].Empty", text)
        Assert.Contains("$$span[int32]", text)
        Assert.Equal(text, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }

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
