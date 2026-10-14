// <copyright file="Issue3785ExplicitMemberInitializerBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Linq
import Xunit

class Issue3785ExplicitMemberInitializerBindingTests {
    @Fact
    func MembersOnly_DoesNotRequireAdd() {
        Assert.Empty(Bind("class Plain { var Value int32 }\nlet p = Plain(){ .Value: 1 }"))
    }

    @Theory
    @InlineData("class Plain { var Value int32 }", ".Missing: 1", "GS0158")
    @InlineData("class Plain { prop Value int32 { get; } }", ".Value: 1", "GS0127")
    @InlineData("class Plain { let Value int32 = 0 }", ".Value: 1", "GS0127")
    @InlineData("class Plain { private var Value int32 }", ".Value: 1", "GS0472")
    @InlineData("class Plain { var Value int32 }", ".Value: 1, .Value: 2", "GS0102")
    @InlineData("class Plain { var Value int32 }", ".Value: 1, 2", "GS0369")
    func ExplicitMemberErrors_DoNotFallBackToKeyedAdd(declaration string, elements string, diagnosticId string) {
        let diagnostics = Bind(declaration + "\nlet p = Plain(){ " + elements + " }")
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == diagnosticId)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9998")
        if diagnosticId != "GS0369" {
            Assert.DoesNotContain(
                diagnostics,
                (diagnostic Diagnostic) -> diagnostic.Id == "GS0369" || diagnostic.Id == "GS0159"
            )
        }
    }

    @Theory
    @InlineData("\"bad\"")
    @InlineData("...[]string{ \"bad\" }")
    func InvalidElementConversion_ReportsOrdinaryBindingErrors(element string) {
        let diagnostics = Bind(
            "import System.Collections.Generic\nlet p = List[int32](){ .Capacity: 4, " + element + " }"
        )
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0369" || diagnostic.Id == "GS9998"
        )
    }

    @Fact
    func AmbiguousAdd_MatchesOrdinaryOverloadResolution() {
        const declaration = `class Left {}
class Right {}
class Bag {
    var Tag int32
    func Add(value Left?) {}
    func Add(value Right?) {}
}`
        let ordinary = Bind(declaration + `
let b = Bag()
b.Add(nil)`)
        let initializer = Bind(declaration + "\nlet b = Bag(){ .Tag: 1, nil }")
        Assert.NotEmpty(ordinary)
        Assert.Equal(
            ordinary.Select((diagnostic Diagnostic) -> diagnostic.Id),
            initializer.Select((diagnostic Diagnostic) -> diagnostic.Id)
        )
    }

    @Fact
    func LegacyObjectInitializer_RemainsUnchanged() {
        Assert.Empty(Bind("class Plain { var Value int32 }\nlet p = Plain(){ Value = 1 }"))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(source)
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return if scope_.Diagnostics.Any() {
                scope_.Diagnostics
            } else {
                Binder.BindProgram(scope_).Diagnostics.ToImmutableArray()
            }
        }
    }
}
