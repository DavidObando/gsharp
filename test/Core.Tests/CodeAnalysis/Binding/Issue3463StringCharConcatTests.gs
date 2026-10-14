// <copyright file="Issue3463StringCharConcatTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #3463: native string and char concatenation.
open class Issue3463StringCharConcatTests {
    @Fact
    func StringCharForms_BindWithoutDiagnostics() {
        const source = `func F(ns string?, ch char) {
    var s = "text"
    var a = s + ch
    var b = ch + s
    var c = ns + ch
    var d = ch + ns
    s += ch
}`
        Assert.Empty(Bind(source))
    }

    @Theory
    @InlineData("\"left\" + '!'", "left!")
    @InlineData("'!' + \"right\"", "!right")
    @InlineData("var s string? = nil\ns + 'x'", "x")
    @InlineData("\"a\" + 'b' + 'c'", "abc")
    func StringCharExpressions_EmitAndRun(source string, expected string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func DirectorySeparatorChar_CompoundAssignment_EmitsAndRuns() {
        let result = EmittedOracle.Evaluate(`import System.IO

var normalizedDirectory = "root"
normalizedDirectory += Path.DirectorySeparatorChar
normalizedDirectory`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("root" + Path.DirectorySeparatorChar, result.Value)
    }

    @Fact
    func ConstantStringAndCharConcat_FoldsAndEmits() {
        let result = EmittedOracle.Evaluate(`class Values {
    const Separator char = 'b'
    const Text string = "a" + Separator
}

Values.Text`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ab", result.Value)
    }

    @Fact
    func PropertyCompoundAssignment_EvaluatesReceiverOnce() {
        let result = EmittedOracle.Evaluate(`class Box {
    var value string = "a"
    prop Text string { get { return value } set { this.value = value } }
}

func GetBox() Box {
    calls += 1
    return box
}

var calls = 0
let box = Box()
GetBox().Text += 'x'
"${box.Text}:$calls"`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ax:1", result.Value)
    }

    @Fact
    func IndexerCompoundAssignment_EvaluatesReceiverAndIndexOnce() {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

func GetValues() Dictionary[int32, string] {
    receiverCalls += 1
    return values
}

func GetIndex() int32 {
    indexCalls += 1
    return 0
}

var receiverCalls = 0
var indexCalls = 0
let values = Dictionary[int32, string]()
values[0] = "a"
GetValues()[GetIndex()] += 'x'
"${values[0]}:$receiverCalls:$indexCalls"`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ax:1:1", result.Value)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            return Binder.BindProgram(globalScope).Diagnostics.ToImmutableArray()
        }
    }
}
