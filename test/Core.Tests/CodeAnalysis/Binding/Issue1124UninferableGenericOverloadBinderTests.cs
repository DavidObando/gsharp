// <copyright file="Issue1124UninferableGenericOverloadBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1124: when a method group contains a generic overload whose type
/// parameter cannot be inferred from the arguments (it appears only in the
/// return type / a constraint) alongside a non-generic overload with a matching
/// parameter list, a call WITHOUT explicit type arguments was reported as
/// ambiguous (GS0266). C# excludes the generic candidate from the applicable
/// set because type inference fails for it, leaving the non-generic overload as
/// the unique best match. The binder now drops a generic candidate whose type
/// parameters are not all inferable (when no explicit type arguments are
/// supplied) before the ambiguity determination, and symmetrically excludes a
/// non-generic candidate when explicit type arguments ARE supplied (they can
/// only apply to a generic method).
/// </summary>
public class Issue1124UninferableGenericOverloadBinderTests
{
    private const string FactoryPreamble = """
        package t
        interface IBox {}
        class Box : IBox {}
        class Factory {
            shared {
                func Make[T Box](file int32, parent IBox?) T { return default(T) }
                func Make(file int32, parent IBox?) IBox { return Box() }
            }
        }
        """;

    // Acceptance criterion 1: the repro compiles with NO diagnostics — the
    // uninferable generic Make[T] is excluded and the non-generic Make resolves.
    [Fact]
    public void StaticCall_NoExplicitTypeArgs_ResolvesNonGeneric_NoDiagnostics()
    {
        var source = FactoryPreamble + """

            class C {
                func G(b IBox) {
                    let child = Factory.Make(5, b)
                }
            }
            """;
        Assert.Empty(Bind(source));
    }

    // Acceptance criterion 1 (distinguishing): the resolved overload returns
    // IBox (the non-generic), proven by it satisfying an IBox-typed return.
    [Fact]
    public void StaticCall_NoExplicitTypeArgs_ResultIsNonGenericIBox()
    {
        var source = FactoryPreamble + """

            class C {
                func G(b IBox) IBox { return Factory.Make(5, b) }
            }
            """;
        Assert.Empty(Bind(source));
    }

    // Acceptance criterion 1 (negative distinguishing): the non-generic result
    // is IBox, NOT Box, so flowing it into a Box-typed return is a conversion
    // error (GS0155) — and crucially NOT the old GS0266 ambiguity.
    [Fact]
    public void StaticCall_NoExplicitTypeArgs_ResultNotBox_ReportsConversionNotAmbiguity()
    {
        var source = FactoryPreamble + """

            class C {
                func G(b IBox) Box { return Factory.Make(5, b) }
            }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0155");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0266");
    }

    // Acceptance criterion 2: with explicit [Box], the generic overload is
    // selected (its return type T=Box satisfies the Box-typed return).
    [Fact]
    public void StaticCall_ExplicitTypeArg_ResolvesGeneric_NoDiagnostics()
    {
        var source = FactoryPreamble + """

            class C {
                func G(b IBox) Box { return Factory.Make[Box](5, b) }
            }
            """;
        Assert.Empty(Bind(source));
    }

    // Acceptance criterion 3: a generic overload whose type parameter IS
    // inferable from the arguments is still selectable without explicit type
    // args, even alongside a non-generic sibling of different arity.
    [Fact]
    public void StaticCall_InferableGeneric_StillSelectable_NoDiagnostics()
    {
        const string source = """
            package t
            class Factory {
                shared {
                    func Id[T](x T) T { return x }
                    func Id(a int32, b int32) int32 { return a }
                }
            }
            class C { func G() int32 { return Factory.Id(7) } }
            """;
        Assert.Empty(Bind(source));
    }

    // Acceptance criterion 4: a lone generic overload with an uninferable type
    // parameter and no non-generic sibling still reports the dedicated
    // type-argument-inference-failure diagnostic (GS0151), NOT a misleading
    // "no applicable overload" or ambiguity.
    [Fact]
    public void StaticCall_LoneUninferableGeneric_ReportsInferenceFailure()
    {
        const string source = """
            package t
            interface IBox {}
            class Box : IBox {}
            class Factory {
                shared {
                    func Make[T Box](file int32, parent IBox?) T { return default(T) }
                }
            }
            class C {
                func G(b IBox) {
                    let child = Factory.Make(5, b)
                }
            }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0151");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0266");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0144");
    }

    // Centralized-fix coverage: the same rule applies to TOP-LEVEL function
    // overload groups, not only static class methods.
    [Fact]
    public void TopLevelFunctions_ExcludeUninferableGeneric_NoExplicitTypeArgs()
    {
        const string source = """
            package t
            interface IBox {}
            class Box : IBox {}
            func Make[T Box](file int32, parent IBox?) T { return default(T) }
            func Make(file int32, parent IBox?) IBox { return Box() }
            func G(b IBox) IBox { return Make(5, b) }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void TopLevelFunctions_ExplicitTypeArg_ResolvesGeneric()
    {
        const string source = """
            package t
            interface IBox {}
            class Box : IBox {}
            func Make[T Box](file int32, parent IBox?) T { return default(T) }
            func Make(file int32, parent IBox?) IBox { return Box() }
            func H(b IBox) Box { return Make[Box](5, b) }
            """;
        Assert.Empty(Bind(source));
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        // Include method-body diagnostics (overload resolution, conversions,
        // type-argument inference) which are produced by BindProgram, not only
        // the declaration-level diagnostics on the global scope.
        var resolver = ReferenceResolver.Default();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        return globalScope.Diagnostics.AddRange(program.Diagnostics).ToList();
    }
}
