// <copyright file="Issue2300InterfaceAndTypeParameterNilCompareTests.cs" company="GSharp">
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
/// Issue #2300: <c>x == nil</c> / <c>x != nil</c> reported <c>GS0129</c> when
/// <c>x</c> was of an interface type or an unconstrained/class-constrained
/// type-parameter type, even though both shapes are managed references at
/// the CLR layer (an interface reference, or an open type parameter whose
/// substitution may be a reference type). C#/Kotlin both allow a reference
/// operand to be compared against <c>null</c> unconditionally.
///
/// The fix lives in two places:
///  * <see cref="GSharp.Core.CodeAnalysis.Binding.BoundBinaryOperator.IsNullCompare(GSharp.Core.CodeAnalysis.Symbols.TypeSymbol, GSharp.Core.CodeAnalysis.Symbols.TypeSymbol)"/>
///    (private — exercised indirectly here) now accepts a bare
///    <c>InterfaceSymbol</c> (including imported CLR interfaces) and a bare
///    <c>TypeParameterSymbol</c> whose constraint does not guarantee a
///    non-nullable value type (i.e. everything except a
///    <c>struct</c>-constrained type parameter).
///  * The emitter's <c>TryMatchTypeParameterNilCompare</c> /
///    <c>IsOpenTypeParameterOrNullable</c> (MethodBodyEmitter.Operators.cs)
///    now also matches a BARE open type parameter (not just its <c>T?</c>
///    wrapper), so the `box; ldnull; ceq` lowering used for `T? == nil`
///    since issue #831 covers the new bare-`T` shape too.
///
/// A <c>struct</c>-constrained type parameter is deliberately excluded: such
/// a `T` can never be nil, and its `T?` spelling erases to
/// <c>Nullable&lt;T&gt;</c> rather than a bare reference slot.
/// </summary>
public class Issue2300InterfaceAndTypeParameterNilCompareTests
{
    [Fact]
    public void Interface_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

interface IProfile {
    func Name() string;
}

func Guard(p IProfile) bool {
    return p == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Interface_Vs_Nil_Inequality_Binds()
    {
        const string source = @"
package P

interface IProfile {
    func Name() string;
}

func Guard(p IProfile) bool {
    return p != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Nil_Vs_Interface_Symmetric_Binds()
    {
        // The IsNullCompare arm is symmetric — `nil == p` must bind the
        // same as `p == nil`.
        const string source = @"
package P

interface IProfile {
    func Name() string;
}

func Guard(p IProfile) bool {
    return nil == p
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void ImportedClass_Vs_Nil_Binds()
    {
        const string source = @"
package P

import System.Text

func Guard(value StringBuilder) bool {
    return value == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void GenericInterface_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

interface Iter[T any] {
    func Next() T;
}

func Guard(it Iter[int32]) bool {
    return it == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void UnconstrainedTypeParameter_Vs_Nil_Equality_Binds()
    {
        // Verbatim shape from the issue body — `TPerson == nil` where
        // TPerson is a free (unconstrained) type parameter.
        const string source = @"
package P

func Guard[TPerson](value TPerson) bool {
    return value == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void UnconstrainedTypeParameter_Vs_Nil_Inequality_Binds()
    {
        const string source = @"
package P

func Guard[TPerson](value TPerson) bool {
    return value != nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Nil_Vs_UnconstrainedTypeParameter_Symmetric_Binds()
    {
        const string source = @"
package P

func Guard[T](value T) bool {
    return nil == value
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void ClassConstrainedTypeParameter_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

func Guard[T class](value T) bool {
    return value == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void InterfaceConstrainedTypeParameter_Vs_Nil_Equality_Binds()
    {
        const string source = @"
package P

interface IProfile {
    func Name() string;
}

func Guard[T IProfile](value T) bool {
    return value == nil
}
";
        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void StructConstrainedTypeParameter_Vs_Nil_StillDiagnoses()
    {
        // Guard-rail: a `struct`-constrained type parameter can never be
        // nil (its `T?` spelling erases to Nullable<T>), so bare `T == nil`
        // must continue to report GS0129 — the fix must not over-generalize
        // to value-typed type parameters.
        const string source = @"
package P

func Guard[T struct](value T) bool {
    return value == nil
}
";
        var errors = GetErrors(source);
        Assert.Contains(errors, e => e.Message.Contains("is not defined for types"));
    }

    [Fact]
    public void Interface_Vs_Nil_RuntimeEquality_FalseForNonNullInstance()
    {
        // Runtime check: a non-nil interface-typed argument must compare
        // unequal to nil (and equal-inequality must yield `true`).
        const string source = @"
interface IProfile {
    func Name() string;
}
class Person(N string) : IProfile {
    func Name() string { return N }
}
func IsNil(p IProfile) bool {
    return p == nil
}
func IsNotNil(p IProfile) bool {
    return p != nil
}
let person = Person(""Ann"")
(IsNil(person), IsNotNil(person))
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal((false, true), result.Value);
    }

    [Fact]
    public void TypeParameter_Vs_Nil_RuntimeEquality_TrueForDefaultReferenceValue()
    {
        // Runtime check: `default(T)` for a reference-type instantiation of
        // an unconstrained generic function is the CLR null reference, so
        // the nil-comparison must observe it as equal to nil.
        const string source = @"
func IsNil[T](value T) bool {
    return value == nil
}
func IsNotNil[T](value T) bool {
    return value != nil
}
(IsNil(default(string)), IsNotNil(default(string)), IsNil(""hi""), IsNotNil(""hi""))
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal((true, false, false, true), result.Value);
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

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
