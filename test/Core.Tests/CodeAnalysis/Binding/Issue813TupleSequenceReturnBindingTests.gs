// <copyright file="Issue813TupleSequenceReturnBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #813 / ADR-0084 §L5: value-tuple element types
/// (`(T1, T2, ...)`) on iterator return shapes such as
/// `sequence[(int32, T)]` or `IEnumerable[(T, T)]` must
/// bind cleanly. Pre-fix the parser rejected `yield (a, b)`
/// at statement start (the `(` after `yield` was always
/// routed to expression-statement parsing as a call) and the
/// binder's substitution pipeline did not descend into tuple
/// element types, so dogfooded ports of
/// (cref:System.Linq)-style helpers
/// (`SequenceExtensions.Indexed` / `Pairwise`) were
/// blocked.
open class Issue813TupleSequenceReturnBindingTests {
    @Fact
    func IndexedShape_SequenceOfIntAndT_Binds() {
        // The exact `Indexed` shape from the issue narrative.
        const source = `
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Foo[T any]() sequence[(int32, T)] {
            yield (0, default(T))
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func PairwiseShape_SequenceOfTAndT_Binds() {
        // `Pairwise` returns a tuple whose element types both
        // mention the outer T. Verifies the encoder honours the
        // SM-remap for every TP occurrence inside the tuple.
        const source = `
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Pairwise[T any]() sequence[(T, T)] {
            yield (default(T), default(T))
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ThreeElementTuple_SequenceOfIntTU_Binds() {
        // 3-arity tuple to confirm the substitution helper walks
        // every element type, not just the first two.
        const source = `
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Triples[T any, U any]() sequence[(int32, T, U)] {
            yield (0, default(T), default(U))
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func NestedTuple_SequenceOfIntAndTU_Binds() {
        // A nested tuple `(int32, (T, U))` exercises the tuple
        // recursion in `Binder.SubstituteType` and the encoder's
        // recursive descent into `TupleTypeSymbol.ElementTypes`.
        const source = `
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Nested[T any, U any]() sequence[(int32, (T, U))] {
            yield (0, (default(T), default(U)))
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func IEnumerableReturn_TupleElement_Binds() {
        // Mirror of the sequence-return shape against the
        // explicit `IEnumerable[(int32, T)]` spelling — both must
        // bind and dispatch through the same iterator rewriter.
        const source = `
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T any]() IEnumerable[(int32, T)] {
            yield (0, default(T))
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func IndexedYield_ExpressionType_IsTupleOfIntAndT() {
        // Drill into the bound body to confirm the yielded
        // expression is typed as `(int32, T)` — i.e. the binder's
        // `SubstituteType` propagated the type-parameter argument
        // into the tuple slot rather than erasing it.
        const source = `
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Foo[T any]() sequence[(int32, T)] {
            yield (0, default(T))
        }
    }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let program = compilation.BoundProgram
        Assert.False(
            program.Diagnostics.Any((d Diagnostic) -> d.IsError),
            string.Join("; ", program.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        let sequencesStruct = program.Structs.Single((s StructSymbol) -> s.Name == "Sequences")
        let fooMethod = sequencesStruct.StaticMethods.Single((m FunctionSymbol) -> m.Name == "Foo")
        let body = program.Functions[fooMethod]
        let yields = CollectYieldExpressions(body)
        Assert.Single(yields)
        let yielded = yields[0]
        let tuple = Assert.IsType[TupleTypeSymbol](yielded.Type)
        Assert.Equal(2, tuple.Arity)
        Assert.Same(TypeSymbol.Int32, tuple.ElementTypes[0])
        Assert.IsType[TypeParameterSymbol](tuple.ElementTypes[1])
        Assert.Equal("T", tuple.ElementTypes[1].Name)
    }

    private class YieldExpressionCollector : BoundTreeWalker {
        init() {
            Expressions = List[BoundExpression]()
        }

        prop Expressions List[BoundExpression] {
            get;
        }

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            if node.Expression != nil {
                Expressions.Add(node.Expression)
            }
            base.VisitYieldStatement(node)
        }
    }

    /// Thin wrapper used so the test cases can call `Assert.Empty`
    /// against a (cref:ImmutableArray{T}) without exposing the
    /// GSharp diagnostic surface to xUnit's enumerable inference.
    private struct ImmutableArrayOfDiagnostic : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for d in this.diagnostics {
                yield d
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator -> this.GetEnumerator()
    }

    shared {
        private func CollectYieldExpressions(body BoundStatement) List[BoundExpression] {
            let collector = Issue813TupleSequenceReturnBindingTests.YieldExpressionCollector()
            collector.Visit(body)
            return collector.Expressions
        }

        private func GetDiagnostics(source string) Issue813TupleSequenceReturnBindingTests.ImmutableArrayOfDiagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            let all = parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
            return Issue813TupleSequenceReturnBindingTests.ImmutableArrayOfDiagnostic(all)
        }
    }
}
