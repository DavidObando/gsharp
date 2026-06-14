// <copyright file="Issue813TupleSequenceReturnBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #813 / ADR-0084 §L5: value-tuple element types
/// (<c>(T1, T2, ...)</c>) on iterator return shapes such as
/// <c>sequence[(int32, T)]</c> or <c>IEnumerable[(T, T)]</c> must
/// bind cleanly. Pre-fix the parser rejected <c>yield (a, b)</c>
/// at statement start (the <c>(</c> after <c>yield</c> was always
/// routed to expression-statement parsing as a call) and the
/// binder's substitution pipeline did not descend into tuple
/// element types, so dogfooded ports of
/// <see cref="System.Linq"/>-style helpers
/// (<c>SequenceExtensions.Indexed</c> / <c>Pairwise</c>) were
/// blocked.
/// </summary>
public class Issue813TupleSequenceReturnBindingTests
{
    [Fact]
    public void IndexedShape_SequenceOfIntAndT_Binds()
    {
        // The exact `Indexed` shape from the issue narrative.
        const string source = @"
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Foo[T any]() sequence[(int32, T)] {
            yield (0, default(T))
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void PairwiseShape_SequenceOfTAndT_Binds()
    {
        // `Pairwise` returns a tuple whose element types both
        // mention the outer T. Verifies the encoder honours the
        // SM-remap for every TP occurrence inside the tuple.
        const string source = @"
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Pairwise[T any]() sequence[(T, T)] {
            yield (default(T), default(T))
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ThreeElementTuple_SequenceOfIntTU_Binds()
    {
        // 3-arity tuple to confirm the substitution helper walks
        // every element type, not just the first two.
        const string source = @"
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Triples[T any, U any]() sequence[(int32, T, U)] {
            yield (0, default(T), default(U))
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void NestedTuple_SequenceOfIntAndTU_Binds()
    {
        // A nested tuple `(int32, (T, U))` exercises the tuple
        // recursion in `Binder.SubstituteType` and the encoder's
        // recursive descent into `TupleTypeSymbol.ElementTypes`.
        const string source = @"
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Nested[T any, U any]() sequence[(int32, (T, U))] {
            yield (0, (default(T), default(U)))
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void IEnumerableReturn_TupleElement_Binds()
    {
        // Mirror of the sequence-return shape against the
        // explicit `IEnumerable[(int32, T)]` spelling — both must
        // bind and dispatch through the same iterator rewriter.
        const string source = @"
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T any]() IEnumerable[(int32, T)] {
            yield (0, default(T))
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void IndexedYield_ExpressionType_IsTupleOfIntAndT()
    {
        // Drill into the bound body to confirm the yielded
        // expression is typed as `(int32, T)` — i.e. the binder's
        // `SubstituteType` propagated the type-parameter argument
        // into the tuple slot rather than erasing it.
        const string source = @"
package P
import System.Collections.Generic

class Sequences {
    shared {
        func Foo[T any]() sequence[(int32, T)] {
            yield (0, default(T))
        }
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = compilation.BoundProgram;
        Assert.False(program.Diagnostics.Any(d => d.IsError),
            string.Join("; ", program.Diagnostics.Select(d => d.Message)));

        var sequencesStruct = program.Structs.Single(s => s.Name == "Sequences");
        var fooMethod = sequencesStruct.StaticMethods.Single(m => m.Name == "Foo");
        var body = program.Functions[fooMethod];

        var yields = CollectYieldExpressions(body);
        Assert.Single(yields);
        var yielded = yields[0];
        var tuple = Assert.IsType<TupleTypeSymbol>(yielded.Type);
        Assert.Equal(2, tuple.Arity);
        Assert.Same(TypeSymbol.Int32, tuple.ElementTypes[0]);
        Assert.IsType<TypeParameterSymbol>(tuple.ElementTypes[1]);
        Assert.Equal("T", tuple.ElementTypes[1].Name);
    }

    private static List<GSharp.Core.CodeAnalysis.Binding.BoundExpression>
        CollectYieldExpressions(GSharp.Core.CodeAnalysis.Binding.BoundStatement body)
    {
        var collector = new YieldExpressionCollector();
        collector.Visit(body);
        return collector.Expressions;
    }

    private sealed class YieldExpressionCollector : GSharp.Core.CodeAnalysis.Binding.BoundTreeWalker
    {
        public List<GSharp.Core.CodeAnalysis.Binding.BoundExpression> Expressions { get; } =
            new List<GSharp.Core.CodeAnalysis.Binding.BoundExpression>();

        protected override void VisitYieldStatement(
            GSharp.Core.CodeAnalysis.Binding.BoundYieldStatement node)
        {
            if (node.Expression is not null)
            {
                Expressions.Add(node.Expression);
            }

            base.VisitYieldStatement(node);
        }
    }

    private static ImmutableArrayOfDiagnostic GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var parseDiagnostics = tree.Diagnostics;
        var bindDiagnostics = compilation.GlobalScope.Diagnostics;
        var programDiagnostics = compilation.BoundProgram.Diagnostics;
        var all = parseDiagnostics
            .Concat(bindDiagnostics)
            .Concat(programDiagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
        return new ImmutableArrayOfDiagnostic(all);
    }

    /// <summary>
    /// Thin wrapper used so the test cases can call <c>Assert.Empty</c>
    /// against a <see cref="ImmutableArray{T}"/> without exposing the
    /// GSharp diagnostic surface to xUnit's enumerable inference.
    /// </summary>
    private readonly struct ImmutableArrayOfDiagnostic : IReadOnlyCollection<Diagnostic>
    {
        private readonly ImmutableArray<Diagnostic> diagnostics;

        public ImmutableArrayOfDiagnostic(ImmutableArray<Diagnostic> diagnostics)
        {
            this.diagnostics = diagnostics;
        }

        public int Count => this.diagnostics.Length;

        public IEnumerator<Diagnostic> GetEnumerator()
        {
            foreach (var d in this.diagnostics)
            {
                yield return d;
            }
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() =>
            this.GetEnumerator();
    }
}
