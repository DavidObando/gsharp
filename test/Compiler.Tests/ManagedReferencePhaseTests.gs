// <copyright file="ManagedReferencePhaseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import Gsharp.Values
import System.Collections.Generic
import System.Linq
import Xunit

class ManagedReferencePhaseTests {
    @Fact
    func PersistentAddressesAreLoweredBeforeEmissionIncludingNestedBodiesAndInitializers() {
        const source = `package ManagedPhases
class Box { var Value int32 }
class Holder { var Reference managed[int32] = managed(Box{Value: 1}.Value) }
func Make() managed[int32] {
    var value = 1
    let nested = func () managed[int32] { return managed(value) }
    return nested()
}`
        using let references = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(ManagedRef[_]).Assembly.Location}
        )
        let compilation = Compilation(references, SyntaxTree.Parse(source)){IsLibrary = true}
        let bound = compilation.BoundProgram
        Assert.Empty(bound.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let before = NodeCounter()
        before.VisitProgram(bound)
        Assert.Equal(2, before.PersistentAddresses)
        Assert.Equal(0, before.FieldKeys)
        let boxed = CaptureBoxingRewriter.Lower(bound, references.MapClrTypeToReferences)
        let lowered = ManagedReferenceLowerer.Lower(boxed, references)
        let after = NodeCounter()
        after.VisitProgram(lowered)
        Assert.Equal(0, after.PersistentAddresses)
        Assert.True(after.FieldKeys >= 2)
        Assert.Contains(
            lowered.Structs,
            (type StructSymbol) -> type.Methods.Any((method FunctionSymbol) -> method.Name == "Borrow")
        )
    }

    @Fact
    func LocationBlockEarlyReturnPreservesBorrowAndPersistentIdentity() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ManagedLocationFlow
import System
func Select(early bool) managed[int32] {
    var value = 1
    let ref before = value
    let retained = managed({
        if early { return managed(value) }
        value
    })
    *retained = 3
    before += 4
    return retained
}
func Main() {
    Console.WriteLine(*Select(false))
    Console.WriteLine(*Select(true))
}`, "ManagedLocationFlow", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
1
`, fixture.Run(dll))
    }

    private class NodeCounter : BoundTreeWalker {
        internal prop PersistentAddresses int32 {
            get;
            private set;
        }

        internal prop FieldKeys int32 {
            get;
            private set;
        }

        internal func VisitProgram(program BoundProgram) {
            for body in program.Functions.Values {
                this.Visit(body)
            }
            for type in program.Structs {
                for initializer in(
                    if program.Initializers.ContainsKey((type, false)) {
                        Enumerable.Empty[BoundExpression]()
                    } else {
                        type.InstanceFieldInitializers.Values
                    }
                )
                    .Concat(
                    if program.Initializers.ContainsKey((type, true)) {
                        Enumerable.Empty[BoundExpression]()
                    } else {
                        type.StaticFieldInitializers.Values
                    }
                ) {
                    this.VisitExpression(initializer)
                }
            }
            for plan in program.Initializers.Values {
                this.Visit(plan.Prologue)
                for argument in plan.Arguments {
                    this.VisitExpression(argument)
                }
                this.Visit(plan.Body)
            }
        }

        override func VisitExpression(node BoundExpression) {
            this.PersistentAddresses += if node is BoundManagedReferenceExpression {
                1
            } else {
                0
            }
            this.FieldKeys += if node is BoundManagedFieldKeyExpression {
                1
            } else {
                0
            }
            if node is BoundFunctionLiteralExpression literal {
                this.Visit(literal.Body)
            }
            base.VisitExpression(node)
        }
    }
}
