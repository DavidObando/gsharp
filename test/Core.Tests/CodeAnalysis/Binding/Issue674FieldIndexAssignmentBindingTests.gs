// <copyright file="Issue674FieldIndexAssignmentBindingTests.cs" company="GSharp">
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

/// Issue #674: verifies that the binder produces a valid bound tree when an
/// indexer assignment targets a field on the enclosing class (i.e., the bare
/// identifier resolves to an `ImplicitFieldVariableSymbol`). Before the
/// fix, this path would create a `BoundIndexAssignmentExpression` (or
/// `BoundClrIndexAssignmentExpression`) with the raw implicit-field
/// variable as target, causing a GS9998 ICE at emit time. The binder must
/// now wrap it in a synthesized temp initialized from a proper
/// `BoundFieldAccessExpression`.
open class Issue674FieldIndexAssignmentBindingTests {
    @Fact
    func ListField_IndexWrite_BindsWithoutDiagnostics() {
        let source = `package P
import System.Collections.Generic

class Bag {
    var items List[int32] = List[int32]()

    func Swap(i int32, j int32) {
        var a = items[i]
        var b = items[j]
        items[i] = b
        items[j] = a
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DictionaryField_IndexWrite_BindsWithoutDiagnostics() {
        let source = `package P
import System.Collections.Generic

class Cache {
    var data Dictionary[string, int32] = Dictionary[string, int32]()

    func Set(key string, value int32) {
        data[key] = value
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func SliceField_IndexWrite_BindsWithoutDiagnostics() {
        let source = `package P

class Container {
    var arr []int32 = []int32{0, 0, 0}

    func Set(i int32, v int32) {
        arr[i] = v
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func FieldIndexWrite_InsideInit_BindsWithoutDiagnostics() {
        let source = `package P
import System.Collections.Generic

class Holder {
    var items List[int32] = List[int32]()

    init() {
        items.Add(0)
        items[0] = 42
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func CompoundFieldIndexWrite_BindsWithoutDiagnostics() {
        let source = `package P
import System.Collections.Generic

class Counter {
    var counts List[int32] = List[int32]()

    init() {
        counts.Add(0)
    }

    func Increment(i int32, amount int32) {
        counts[i] += amount
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func MultipleFieldIndexWrites_SameMethod_BindsWithoutDiagnostics() {
        let source = `package P
import System.Collections.Generic

class Multi {
    var names List[string] = List[string]()
    var scores List[int32] = List[int32]()

    func Update(i int32, name string, score int32) {
        names[i] = name
        scores[i] = score
    }
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
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
