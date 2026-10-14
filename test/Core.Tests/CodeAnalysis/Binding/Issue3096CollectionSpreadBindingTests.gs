// <copyright file="Issue3096CollectionSpreadBindingTests.cs" company="GSharp">
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

/// Binder coverage for native array/collection spread lowering.
class Issue3096CollectionSpreadBindingTests {
    @Fact
    func ArraySpread_AppliesElementConversions() {
        let diagnostics = Bind(
            "let source = []int32{ 2, 3 }\nlet values []int64 = []int64{ int64(1), ...source, int64(4) }"
        )
        Assert.Empty(diagnostics)
    }

    @Fact
    func Spread_UserDefinedImplicitConversion_BindsBeforeAdd() {
        let program = BindProgram(`import System.Collections.Generic

class Celsius {
    prop Degrees float64 { get; init; }

    init(degrees float64) {
        Degrees = degrees
    }
}

func operator implicit(value Celsius) float64 {
    return value.Degrees
}

let source = []Celsius{
    Celsius(2.5),
    Celsius(3.5),
}
let array = []float64{ 1.0, ...source, 9.0 }
let list = List[float64](){ ...source }`)
        Assert.Empty(program.Diagnostics)
        let conversions = UserDefinedConversionCollector()
        conversions.Visit(program.Statement)
        Assert.Equal(2, conversions.Count)
    }

    @Fact
    func CollectionSpread_UsesTargetAddContract() {
        let diagnostics = Bind(`import System.Collections.Generic

let first = []int32{ 1, 2 }
let second = []int32{}
let values = HashSet[int32](){ 0, ...first, ...second, 3 }`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SpreadSource_MustBeEnumerable() {
        let diagnostics = Bind("let values = []int32{ ...42 }")
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0116")
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9998")
    }

    @Fact
    func DictionarySpread_UsesKeyValuePairAddContract() {
        let diagnostics = Bind(`import System.Collections.Generic

let pairs = List[KeyValuePair[string, int32]]()
let values = Dictionary[string, int32](){ ...pairs }`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func SpreadTarget_WithOnlyMultiArgumentAdd_IsRejected() {
        let diagnostics = Bind(`class PairBag {
    func Add(key string, value int32) {
    }
}

let pairs = [](string, int32){ ("key", 1) }
let values = PairBag(){ ...pairs }`)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0369")
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9998")
    }

    @Fact
    func StaticAndInstanceFieldInitializers_Bind() {
        let diagnostics = Bind(`class Holder {
    let Instance []int32 = []int32{ 0, ...[]int32{}, 1 }

    shared {
        let Source []string = []string{ "a", "b" }
        let Values []string = []string{ "head", ...Source, "tail" }
    }
}`)
        Assert.Empty(diagnostics)
    }

    private class UserDefinedConversionCollector : BoundTreeWalker {
        prop Count int32 {
            get;
            private set;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundFunctionLiteralExpression literal {
                VisitStatement(literal.Body)
                return
            }
            base.VisitExpression(node)
        }

        protected override func VisitCallExpression(node BoundCallExpression) {
            if node.Function.Name == "op_Implicit" {
                Count++
            }
            base.VisitCallExpression(node)
        }
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

        private func BindProgram(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return Binder.BindProgram(globalScope)
        }
    }
}
