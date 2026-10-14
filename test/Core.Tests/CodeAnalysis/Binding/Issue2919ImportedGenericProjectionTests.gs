// <copyright file="Issue2919ImportedGenericProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2919: all three imported-generic type-clause paths preserve the same
/// symbolic arguments while retaining their established CLR erasures.
open class Issue2919ImportedGenericProjectionTests {
    @Fact
    func ImportedGenericProjection_PreservesCallerSpecificErasureAndSymbolicTypes() {
        let scope_ = BindSource(`package Issue2919Projection
import System
import System.Collections.Generic

class Src {}
enum Mode { First, Second }

func Probe(
    unqualified Action[Src],
    qualified System.Action[Src],
    nested List[Src].Enumerator,
    unqualifiedEnum List[Mode],
    qualifiedEnum System.Collections.Generic.List[Mode],
    nestedEnum List[Mode].Enumerator,
    unqualifiedNullableEnum List[Mode?],
    qualifiedNullableEnum System.Collections.Generic.List[Mode?],
    nestedNullableEnum List[Mode?].Enumerator) {}`)
        Assert.Empty(scope_.Diagnostics)
        let parameters = scope_.Functions.Single((function FunctionSymbol) -> function.Name == "Probe").Parameters
        AssertProjection(parameters[0].Type, "System.Action`1", "System.Object", "Src")
        AssertProjection(parameters[1].Type, "System.Action`1", "System.Object", "Src")
        AssertProjection(parameters[2].Type, "System.Collections.Generic.List`1+Enumerator", "System.Object", "Src")
        AssertProjection(parameters[3].Type, "System.Collections.Generic.List`1", "System.Int32", "Mode")
        AssertProjection(parameters[4].Type, "System.Collections.Generic.List`1", "System.Object", "Mode")
        AssertProjection(parameters[5].Type, "System.Collections.Generic.List`1+Enumerator", "System.Object", "Mode")
        AssertNullableEnumProjection(parameters[6].Type, "System.Collections.Generic.List`1")
        AssertNullableEnumProjection(parameters[7].Type, "System.Collections.Generic.List`1")
        AssertNullableEnumProjection(parameters[8].Type, "System.Collections.Generic.List`1+Enumerator")
    }

    @Fact
    func NullableSourceEnum_GenericArguments_EmitAndRun() {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

enum Mode { First, Second }

let unqualified = List[Mode?]()
let qualified = System.Collections.Generic.List[Mode?]()
unqualified.Add(Mode.Second)
qualified.Add(Mode.First)
unqualified[0] == Mode.Second && qualified[0] == Mode.First`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    shared {
        private func AssertProjection(
            type TypeSymbol,
            expectedOpenDefinition string,
            expectedClrArgument string,
            expectedSymbolicArgument string
        ) {
            let imported = Assert.IsType[ImportedTypeSymbol](type)
            Assert.NotNull(imported.OpenDefinition)
            Assert.Equal(expectedOpenDefinition, imported.OpenDefinition!!.FullName)
            Assert.Equal(expectedClrArgument, Assert.Single(imported.ClrType!!.GetGenericArguments()).FullName)
            Assert.Equal(expectedSymbolicArgument, Assert.Single(imported.TypeArguments).Name)
        }

        private func AssertNullableEnumProjection(type TypeSymbol, expectedOpenDefinition string) {
            let imported = Assert.IsType[ImportedTypeSymbol](type)
            Assert.NotNull(imported.OpenDefinition)
            Assert.Equal(expectedOpenDefinition, imported.OpenDefinition!!.FullName)
            Assert.Equal(typeof(object).FullName, Assert.Single(imported.ClrType!!.GetGenericArguments()).FullName)
            let symbolicArgument = Assert.IsType[NullableTypeSymbol](Assert.Single(imported.TypeArguments))
            Assert.Equal("Mode", symbolicArgument.UnderlyingType.Name)
        }

        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
