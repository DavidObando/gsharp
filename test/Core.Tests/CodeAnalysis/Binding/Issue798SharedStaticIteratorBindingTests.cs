// <copyright file="Issue798SharedStaticIteratorBindingTests.cs" company="GSharp">
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
/// Issue #798 / ADR-0084 §L5: <c>yield</c> inside a generic iterator
/// method — including a shared-static method on a class — must bind
/// the yielded expression against the symbolic element type
/// (<c>T</c>), not the type-erased <c>object</c> form of the return
/// type's <see cref="System.Type"/>.
///
/// Pre-fix the binder's iterator-element-type extraction
/// (<c>StatementBinder.GetIteratorElementType</c>) only inspected
/// <c>function.Type.ClrType</c>. For a method whose return type is
/// <c>IEnumerable[T]</c> with an in-scope generic <c>T</c>, ClrType
/// is the erased <c>IEnumerable&lt;object&gt;</c>, so the element type
/// resolved to <c>object</c> and <c>yield v</c> (where <c>v</c> is
/// typed <c>T</c>) failed with <c>GS0155: Cannot convert type 'T' to
/// 'object'</c>. The fix honors the symbolic
/// <see cref="ImportedTypeSymbol.TypeArguments"/> (#313) so the
/// element type round-trips as <c>T</c>.
///
/// Coverage spans the four iterator return-type spellings —
/// <c>IEnumerable[T]</c>, <c>sequence[T]</c>,
/// <c>IAsyncEnumerable[T]</c> (with <c>async</c>), and
/// <c>async sequence[T]</c> — across top-level <c>func</c>, instance
/// methods, and shared-static methods. <c>yield break</c> inside a
/// shared-static iterator is also covered.
/// </summary>
public class Issue798SharedStaticIteratorBindingTests
{
    [Fact]
    public void Repro_From_Issue_GenericSharedStatic_IEnumerableT_Binds()
    {
        // Exact repro from issue #798. Pre-fix this surfaced as
        // "Cannot convert type 'T' to 'object'" inside the binder
        // (and as GS9998 "Unexpected statement: YieldStatement"
        // through the gsc interpreter path because the CFG builder
        // also did not recognize BoundYieldStatement).
        const string source = @"
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Empty[T any]() IEnumerable[T] {
            for v in []T{} {
                yield v
            }
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericSharedStatic_IEnumerableT_With_YieldT_Binds()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Of[T any](v T) IEnumerable[T] {
            yield v
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericSharedStatic_SequenceT_With_YieldT_Binds()
    {
        // `sequence[T]` is the G# alias for `IEnumerable[T]` and is
        // already a SequenceTypeSymbol with a non-erased element type,
        // so this path bound pre-fix too — captured here as a
        // regression guard.
        const string source = @"
package P
import System

class Sequences {
    shared {
        func Of[T any](v T) sequence[T] {
            yield v
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericSharedStatic_IAsyncEnumerableT_With_Async_YieldT_Binds()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        async func Of[T any](v T) IAsyncEnumerable[T] {
            yield v
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericSharedStatic_AsyncSequenceT_With_YieldT_Binds()
    {
        // ADR-0041: inside an `async func`, the `sequence[T]` return
        // type clause resolves to `IAsyncEnumerable[T]`. For an in-scope
        // generic T this is an AsyncSequenceTypeSymbol whose ClrType is
        // null, which pre-fix made the binder's iterator-return-type
        // predicates miss it ("yield not allowed outside iterator").
        const string source = @"
package P
import System

class Sequences {
    shared {
        async func Of[T any](v T) sequence[T] {
            yield v
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void NonGenericSharedStatic_IEnumerableInt32_Binds()
    {
        // Regression guard: the non-generic case worked pre-fix. Keep
        // it covered alongside the generic cases so future refactors
        // don't break the closed shape while focusing on the open one.
        const string source = @"
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Take3() IEnumerable[int32] {
            yield 1
            yield 2
            yield 3
        }
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericTopLevel_IEnumerableT_With_YieldT_Binds()
    {
        // The same bug surfaced on top-level generic iterators too.
        // The issue narrative diagnosed it as shared-static only, but
        // the root cause is in StatementBinder.GetIteratorElementType
        // which has no shared/instance/top-level distinction.
        const string source = @"
package P
import System
import System.Collections.Generic

func Of[T any](v T) IEnumerable[T] {
    yield v
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericInstanceMethod_IEnumerableT_With_YieldT_Binds()
    {
        const string source = @"
package P
import System
import System.Collections.Generic

class Box {
    func Of[T any](v T) IEnumerable[T] {
        yield v
    }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void GenericSharedStatic_Yielded_Element_Has_TypeParameter_Symbol()
    {
        // Drill into the bound body: the BoundYieldStatement's
        // expression must carry the symbolic T as its type, not the
        // ObjectSymbol that the pre-fix element-type extraction
        // produced.
        const string source = @"
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Of[T any](v T) IEnumerable[T] {
            yield v
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
        var ofMethod = sequencesStruct.StaticMethods.Single(m => m.Name == "Of");
        var body = program.Functions[ofMethod];

        var yields = CollectYieldExpressions(body);
        Assert.Single(yields);
        var yielded = yields[0];
        Assert.NotNull(yielded.Type);
        Assert.IsType<TypeParameterSymbol>(yielded.Type);
        Assert.Equal("T", yielded.Type.Name);
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
