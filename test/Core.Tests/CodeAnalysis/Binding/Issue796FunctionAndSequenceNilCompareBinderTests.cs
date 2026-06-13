// <copyright file="Issue796FunctionAndSequenceNilCompareBinderTests.cs" company="GSharp">
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
/// Issue #796 / ADR-0084 §L5 follow-up. The binder rejected
/// <c>== nil</c> / <c>!= nil</c> for function-typed and sequence-typed
/// values with <c>GS0129</c> even though both shapes are managed
/// references at the CLR layer (delegate / IEnumerable&lt;T&gt;).
///
/// Extensions stdlib helpers (<c>OrCompute</c>, <c>Windowed</c>, etc.)
/// need to guard against nil delegate / sequence arguments at the head
/// of the method body — the C# escape hatch under
/// <c>src/Sdk/Gsharp.Extensions/</c> already does exactly this. With
/// the binder fix in place a G# source-port can do the same.
///
/// The fix lives in <see cref="BoundBinaryOperator.IsNullCompare"/>:
/// the predicate now accepts <see cref="FunctionTypeSymbol"/>,
/// <see cref="DelegateTypeSymbol"/>, <see cref="SequenceTypeSymbol"/>,
/// and <see cref="AsyncSequenceTypeSymbol"/> on the non-null side.
/// No new <c>BoundNodeKind</c> was introduced.
/// </summary>
public class Issue796FunctionAndSequenceNilCompareBinderTests
{
    [Fact]
    public void Repro_OrCompute_FunctionParameter_Compared_To_Nil_Binds()
    {
        // Verbatim shape from the issue body — the `factory == nil`
        // guard previously reported `GS0129: Binary operator '==' is
        // not defined for types '(T) -> T' and 'nil'`.
        const string source = @"
package P
import System

func (self T?) OrCompute[T class](factory () -> T) T {
    if factory == nil {
        throw ArgumentNullException(""factory"")
    }
    return self ?: factory()
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Repro_Windowed_SequenceReceiver_Compared_To_Nil_Binds()
    {
        // Second repro from the issue body — `self == nil` on a
        // `sequence[T]` receiver previously reported
        // `GS0129: Binary operator '==' is not defined for types 'sequence[T]' and 'nil'`.
        const string source = @"
package P
import System

func (self sequence[T]) Windowed[T](size int32) sequence[T] {
    if self == nil {
        throw ArgumentNullException(""source"")
    }
    return self
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void GenericArrowFunction_Vs_Nil_Equality_Binds()
    {
        // `(T) -> R` over a free type parameter — the binder must
        // route through the FunctionTypeSymbol arm independent of any
        // concrete element type.
        const string source = @"
package P

func Guard[T, R](f (T) -> R) bool {
    return f == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void NoArgArrowFunction_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

func Guard(f () -> int32) bool {
    return f == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void NoArgArrowFunction_Vs_Nil_Inequality_Binds()
    {
        const string source = @"
package P

func IsBound(f () -> int32) bool {
    return f != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void GenericSequence_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

func IsEmpty[T](xs sequence[T]) bool {
    return xs == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Int32Sequence_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

func IsEmpty(xs sequence[int32]) bool {
    return xs == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Int32Sequence_Vs_Nil_Inequality_Binds()
    {
        const string source = @"
package P

func HasAny(xs sequence[int32]) bool {
    return xs != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Nil_Vs_FunctionParameter_Symmetric_Binds()
    {
        // The IsNullCompare arm is symmetric — `nil == f` must bind
        // the same as `f == nil`.
        const string source = @"
package P

func Guard(f () -> int32) bool {
    return nil == f
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void NamedDelegateType_Vs_Nil_Equality_Binds()
    {
        // ADR-0059 named delegate values are reference-typed (sealed
        // class deriving MulticastDelegate); the binder must treat
        // them the same as the structural FunctionTypeSymbol shape.
        const string source = @"
package P

type Reducer = delegate func(a int32, b int32) int32

func Guard(f Reducer) bool {
    return f == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void NamedDelegateType_Vs_Nil_Inequality_Binds()
    {
        const string source = @"
package P

type Reducer = delegate func(a int32, b int32) int32

func IsBound(f Reducer) bool {
    return f != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void LegacyFuncForm_Vs_Nil_Equality_Binds()
    {
        // The legacy `func(T) U` spelling (predates the arrow form)
        // binds to the same FunctionTypeSymbol shape. The fix must
        // cover both spellings.
        const string source = @"
package P

func Guard(f func(int32) int32) bool {
    return f == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void LegacyFuncForm_Vs_Nil_Inequality_Binds()
    {
        const string source = @"
package P

func IsBound(f func(int32) int32) bool {
    return f != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void AsyncSequence_Vs_Nil_Equality_Binds()
    {
        // `sequence[T]` inside an `async func` aliases
        // IAsyncEnumerable<T> per ADR-0041. The fix extends to the
        // AsyncSequenceTypeSymbol shape as well.
        const string source = @"
package P

async func Drain(xs sequence[int32]) bool {
    return xs == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void LocalFunctionVariable_Vs_Nil_Equality_Binds()
    {
        // Local typed as `() -> int32` — the receiver isn't a
        // parameter but the same binder path applies.
        const string source = @"
package P

func Run() bool {
    var f () -> int32 = default(() -> int32)
    return f == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    private static ImmutableArray<Diagnostic> GetErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        var parseDiagnostics = tree.Diagnostics;
        var bindDiagnostics = compilation.GlobalScope.Diagnostics;
        var programDiagnostics = compilation.BoundProgram.Diagnostics;
        return parseDiagnostics
            .Concat(bindDiagnostics)
            .Concat(programDiagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
    }
}
