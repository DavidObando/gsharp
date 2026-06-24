// <copyright file="Issue1087GenericBaseCtorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1087: a derived class's base-initializer (<c>: base(...)</c>) must be
/// able to resolve an explicit <c>init(...)</c> constructor declared on a
/// GENERIC base class. A constructed (closed) generic base symbol does not carry
/// its own explicit-constructor table — those live on the open definition — so
/// resolution must look through to the definition and substitute the type
/// arguments into each candidate constructor's parameter signature. Before the
/// fix the constructed base fell back to its (empty) primary-constructor set and
/// reported a spurious GS0214.
/// </summary>
public class Issue1087GenericBaseCtorTests
{
    [Fact]
    public void BaseInitializer_GenericBaseExplicitCtor_CompilesCleanly()
    {
        // The minimal #1087 repro: explicit init on a generic base, resolved
        // through a closed `Base[int32]`.
        var source = """
            package p
            open class Base[T] {
                init(a int32) { }
            }
            class Deriv : Base[int32] {
                init() : base(1) { }
            }
            """;

        var scope = BindSources(source);

        Assert.Empty(scope.Diagnostics);
    }

    [Fact]
    public void BaseInitializer_NonGenericBaseExplicitCtor_StillCompilesCleanly()
    {
        // Control: the identical shape with a NON-generic base must keep working.
        var source = """
            package p
            open class Base {
                init(a int32) { }
            }
            class Deriv : Base {
                init() : base(1) { }
            }
            """;

        var scope = BindSources(source);

        Assert.Empty(scope.Diagnostics);
    }

    [Fact]
    public void BaseInitializer_GenericDerivedForwardsTypeArgument_CompilesCleanly()
    {
        // The derived type is itself generic and forwards its type argument to
        // the generic base (`Deriv[U] : Base[U]`).
        var source = """
            package p
            open class Base[T] {
                init(a int32) { }
            }
            class Deriv[U] : Base[U] {
                init() : base(1) { }
            }
            """;

        var scope = BindSources(source);

        Assert.Empty(scope.Diagnostics);
    }

    [Fact]
    public void BaseInitializer_GenericBaseCtorUsesTypeParameter_SubstitutesAndCompiles()
    {
        // The base ctor parameter is the type parameter itself: `init(a T)` on
        // `Base[T]` must surface as `init(a int32)` on `Base[int32]`, so the
        // int32 argument matches after substitution.
        var source = """
            package p
            open class Base[T] {
                init(a T) { }
            }
            class Deriv : Base[int32] {
                init() : base(7) { }
            }
            """;

        var scope = BindSources(source);

        Assert.Empty(scope.Diagnostics);
    }

    [Fact]
    public void BaseInitializer_IntermediateGenericBaseInChain_CompilesCleanly()
    {
        // An intermediate generic base class in the inheritance chain, plus a
        // base ctor whose parameter is the type parameter.
        var source = """
            package p
            open class A[T] {
                init(a T) { }
            }
            open class B[T] : A[T] {
                init(b T) : base(b) { }
            }
            class C : B[int32] {
                init() : base(3) { }
            }
            """;

        var scope = BindSources(source);

        Assert.Empty(scope.Diagnostics);
    }

    [Fact]
    public void BaseInitializer_GenericBaseWrongArgumentCount_ReportsGs0214()
    {
        // Negative case: a wrong argument count against a generic base must
        // still report GS0214 (no accessible base constructor).
        var source = """
            package p
            open class Base[T] {
                init(a int32) { }
            }
            class Deriv : Base[int32] {
                init() : base(1, 2) { }
            }
            """;

        var scope = BindSources(source);

        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0214");
    }

    private static BoundGlobalScope BindSources(params string[] sources)
    {
        var trees = ImmutableArray.CreateRange(
            sources.Select(s => SyntaxTree.Parse(SourceText.From(s))));
        return Binder.BindGlobalScope(previous: null, trees);
    }
}
