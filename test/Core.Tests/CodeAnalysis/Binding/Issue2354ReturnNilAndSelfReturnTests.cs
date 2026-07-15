// <copyright file="Issue2354ReturnNilAndSelfReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2345 follow-up (deferred finding #2): a plain G# `class` could not
/// `return nil` for its own non-nullable type (`GS0155: Cannot convert type
/// 'nil' to '&lt;Class&gt;'`), and a method declared inside a GENERIC class
/// could not `return this` for its own generic self-type (`GS0155: Cannot
/// convert type '&lt;Class&gt;' to '&lt;Class&gt;'` — an identical-looking
/// source/target that hid a genuine type-identity mismatch).
///
/// Root causes and fixes:
///  * `return nil`: <c>Conversion.Classify</c>'s "Phase 3.C.2" rule rejected
///    `nil -&gt;` any non-<see cref="GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol"/>
///    target unconditionally — including reference-capable targets (a
///    `class`, an interface, a reference-constrained type parameter, or
///    `object`) that are ALWAYS nullable at the CLR level regardless of an
///    explicit `?` spelling. The rule is now scoped to genuine value types
///    via a new, deliberately NARROW predicate,
///    `Conversion.IsNilAssignableWithoutNullableWrapper` (a `class`, an
///    interface, or a reference-constrained type parameter — NOT the wider
///    `Conversion.IsReferenceLikeTarget`, which also matches general
///    CLR-backed reference types like `string`/`object`/function types that
///    deliberately keep requiring an explicit `T?` per issues #2159/#715),
///    so ONLY a real struct/value-kind target (or one of those excluded
///    CLR-backed types) still requires an explicit `T?` wrapper.
///  * `return this` (generic self-type): a generic class's own `this`
///    parameter is bound with the OPEN generic definition as its type
///    (`TypeArguments` empty), while a self-referential member-signature
///    type written explicitly in source (e.g. `func Self() Box[T]` inside
///    `class Box[T]`) binds through `StructSymbol.Construct`, producing a
///    DIFFERENT (but structurally identical) `StructSymbol` instance.
///    `Conversion.Classify` now recognizes this "self-instantiation" identity
///    (`AreSameConstructedStructIdentity`) — same `Definition`, and every
///    type-argument slot (defaulting an open definition's empty
///    `TypeArguments` to its own `TypeParameters`) pairwise identical —
///    and the emitter's `IsReferenceCompatible` mirrors the same check so
///    emission recognizes it as a no-op reference load.
/// </summary>
public class Issue2354ReturnNilAndSelfReturnTests
{
    [Fact]
    public void GenericClass_ReturnThis_OwnGenericSelfType_Binds()
    {
        const string source = """
            package p
            class Box[T] {
                func Self() Box[T] {
                    return this
                }
            }
            """;

        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void NonGenericClass_ReturnThis_StillBinds()
    {
        // Control: the non-generic case was never broken; guard against a
        // regression while generalizing the generic case.
        const string source = """
            package p
            class Box {
                func Self() Box {
                    return this
                }
            }
            """;

        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void GenericClass_ReturnNil_OwnGenericType_Binds()
    {
        const string source = """
            package p
            class Box[T] {
                func Nothing() Box[T] {
                    return nil
                }
            }
            """;

        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void NonGenericClass_ReturnNil_Binds()
    {
        const string source = """
            package p
            class Box {
                func Nothing() Box {
                    return nil
                }
            }
            """;

        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void Interface_ReturnNil_Binds()
    {
        const string source = """
            package p
            interface Greeter {
                func Greet() string;
            }
            class Box {
                func AsGreeter() Greeter {
                    return nil
                }
            }
            """;

        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void ObjectReturnType_ReturnNil_StillReportsGS0155()
    {
        // Negative control: `object` is reached only via
        // `IsReferenceLikeTarget`'s general CLR-backed fallback, not the
        // narrower `IsNilAssignableWithoutNullableWrapper` predicate used for
        // the nil-conversion rule, so it must keep requiring an explicit
        // `object?` — this mirrors how `string`/function-typed slots keep
        // rejecting a bare `nil` (issues #2159 / #715) and proves the fix
        // did not over-broaden past genuine G#-declared reference types.
        const string source = """
            package p
            class Box {
                func AsObject() object {
                    return nil
                }
            }
            """;

        Assert.Contains(GetErrors(source), d => d.Id == "GS0155");
    }

    [Fact]
    public void NestedNullableSelfType_ReturnThis_Binds()
    {
        // A generic self-return wrapped in a further `?` (Box[T]?) exercises
        // the reference-upcast-to-nullable path recursing into the same
        // self-instantiation identity check.
        const string source = """
            package p
            class Box[T] {
                func Wrapped() Box[T]? {
                    return this
                }
            }
            """;

        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void PlainClass_EqualsNil_Binds()
    {
        // Generalizes issue #2300 (interface / type-parameter `== nil`) to a
        // plain non-nullable `class` operand — the same CLR reference-typed
        // rationale applies.
        const string source = """
            package p
            class Box {
            }
            func Guard(b Box) bool {
                return b == nil
            }
            """;

        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void PlainClass_NotEqualsNil_Binds()
    {
        const string source = """
            package p
            class Box {
            }
            func Guard(b Box) bool {
                return b != nil
            }
            """;

        Assert.Empty(GetErrors(source));
    }

    [Fact]
    public void GenericClass_ReturnThis_DifferentGenericClass_StillReportsGS0155()
    {
        // Negative control: a method declared inside `Bag[T]` that claims to
        // return `Box[T]` and does `return this` must still fail — the two
        // classes are genuinely different `Definition`s, so
        // AreSameConstructedStructIdentity must reject this pair.
        const string source = """
            package p
            class Box[T] {
            }
            class Bag[T] {
                func F() Box[T] {
                    return this
                }
            }
            """;

        Assert.Contains(GetErrors(source), d => d.Id == "GS0155");
    }

    [Fact]
    public void GenericClass_ReturnThis_DifferentClosedTypeArgument_StillReportsGS0155()
    {
        // Negative control: `this` inside `Box[T]` is the OPEN self-type; a
        // return type explicitly closed over a DIFFERENT type argument
        // (`Box[int32]`) must still fail, proving the fix does not
        // over-broadly accept any two constructed shapes of the same
        // definition.
        const string source = """
            package p
            class Box[T] {
                func F() Box[int32] {
                    return this
                }
            }
            """;

        Assert.Contains(GetErrors(source), d => d.Id == "GS0155");
    }

    [Fact]
    public void UnrelatedClasses_ReturnMismatch_StillReportsGS0155()
    {
        // Negative control: a genuinely incompatible return must still fail
        // — the reference-like `nil ->` and self-instantiation-identity
        // rules must not weaken ordinary type-mismatch diagnostics.
        const string source = """
            package p
            class A {
            }
            class B {
            }
            class C {
                func F() A {
                    return B()
                }
            }
            """;

        Assert.Contains(GetErrors(source), d => d.Id == "GS0155");
    }

    [Fact]
    public void Struct_ReturnNil_StillReportsGS0155()
    {
        // Negative control: a genuine value-type (struct) return type must
        // still require an explicit `T?` wrapper to accept `nil` — the
        // reference-like relaxation must not apply to structs.
        const string source = """
            package p
            struct Point {
                var X int32
            }
            class Box {
                func Get() Point {
                    return nil
                }
            }
            """;

        Assert.Contains(GetErrors(source), d => d.Id == "GS0155");
    }

    [Fact]
    public void Struct_EqualsNil_StillReportsGS0129()
    {
        // Negative control: a struct-typed (non-nullable value type) operand
        // must still reject `== nil` / `!= nil` — only reference-capable
        // types gained this allowance.
        const string source = """
            package p
            struct Point {
                var X int32
            }
            func Guard(p Point) bool {
                return p == nil
            }
            """;

        Assert.Contains(GetErrors(source), d => d.Id == "GS0129");
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
