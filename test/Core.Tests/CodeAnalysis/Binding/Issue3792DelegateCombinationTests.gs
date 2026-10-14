// <copyright file="Issue3792DelegateCombinationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #3792: delegate combination outside event subscription sites.
open class Issue3792DelegateCombinationTests {
    @Theory
    @InlineData("Action")
    @InlineData("(() -> void)")
    @InlineData("Handler")
    func DelegateBinaryAndCompoundOperators_Bind(delegateType string) {
        let declaration = if delegateType == "Handler" {
            "delegate Handler();\n"
        } else {
            string.Empty
        }
        let source = (`package P
import System

` + "$declaration" + `
func Tick() {}

class Box {
    var Field ` + "$delegateType" + `? = nil
    prop Property ` + "$delegateType" + `? { get; set; }

    func Update(value ` + "$delegateType" + `) {
        Field += value
        Property += value
        Field -= value
        Property -= value
    }
}

func Run() {
    let value ` + "$delegateType" + ` = Tick
    let sum = value + value
    let removed = sum - value
    let leftNil = nil + value
    let rightNil = value + nil
    var local ` + "$delegateType" + `? = nil
    local += value
    local += nil
    local -= nil
    local -= value
    let box = Box()
    box.Update(value)
}`)
        Assert.Empty(Bind(source))
    }

    @Fact
    func DelegateOperators_DoNotBroadenToDelegateBaseOrDifferentNamedTypes() {
        const source = `package P
import System

delegate First();
delegate Second();

func Run(
    a Delegate,
    b Delegate,
    first First,
    second Second,
    objects Action[object],
    strings Action[string]) {
    let badBase = a + b
    let badNamed = first - second
    let badVariant = objects + strings
}`
        let diagnostics = Bind(source)
        Assert.Equal(3, diagnostics.Count((d Diagnostic) -> d.Id == "GS0129"))
    }

    @Fact
    func DelegateOperators_TargetTypeSourceAndClrMethodGroups() {
        const source = `package P
import System

func Print(value string) {}
func Print(value int32) {}

func Run() {
    let seed Action[string] = (value string) -> {}
    let source = seed + Print
    let clr = seed + Console.WriteLine
    var callbacks Action[string]? = seed
    callbacks += Print
    callbacks += Console.WriteLine
    callbacks -= Print
    callbacks -= Console.WriteLine
}`
        Assert.Empty(Bind(source))
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
