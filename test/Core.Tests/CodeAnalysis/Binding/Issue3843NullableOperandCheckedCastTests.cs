// <copyright file="Issue3843NullableOperandCheckedCastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3843: <c>cast[T](expr)</c> over a REFERENCE-NULLABLE operand.
/// <para>
/// ADR-0167 already promised C#'s exact explicit-cast behaviour — nil in →
/// nil out, an incompatible non-nil value → <see cref="InvalidCastException"/>,
/// static result non-nullable <c>T</c> — and delivered it for the identity
/// (<c>T? → T</c>), downcast (<c>Base? → Derived</c>) and cross-cast
/// directions. The UPCAST direction (<c>Derived? → Base</c>,
/// <c>Impl? → IFace</c>) had no checked-conversion classification at all and
/// reported GS0155, which is why cs2gs carried a workaround lowering such
/// casts to <c>expr as T</c> — a rendering that yields <c>T?</c> and, worse,
/// silently returns nil where C# throws. These tests EXECUTE, because the
/// throw-versus-nil half of the defect is invisible to binding and to
/// ILVerify.
/// </para>
/// </summary>
public sealed class Issue3843NullableOperandCheckedCastTests
{
    [Fact]
    public void BinderClassifiesNullableSourceUpcastAsExplicit()
    {
        var baseType = TypeSymbol.FromClrType(typeof(Exception));
        var derivedType = TypeSymbol.FromClrType(typeof(ArgumentException));
        var interfaceType = TypeSymbol.FromClrType(typeof(ICloneable));
        var stringType = TypeSymbol.String;

        // The gap closed by #3843: a nullable source widening to a
        // NON-nullable base / implemented interface.
        Assert.True(Conversion.Classify(
            NullableTypeSymbol.Get(derivedType), baseType).IsExplicit);
        Assert.True(Conversion.Classify(
            NullableTypeSymbol.Get(stringType), interfaceType).IsExplicit);

        // The downcast direction, which already worked, keeps working.
        // (The IDENTITY direction `T? -> T` is deliberately NOT a
        // classified conversion — dropping an annotation without changing
        // the runtime type is the binder's null-forgiveness question, not a
        // conversion — and reaches `cast[T]` through the conversion binder
        // instead. Its runtime behaviour is covered by the executing test
        // below.)
        Assert.True(Conversion.Classify(
            NullableTypeSymbol.Get(baseType), derivedType).IsExplicit);

        // The new arm does NOT open an implicit nullability-dropping path:
        // a nullable-to-nullable widening stays implicit, and an unrelated
        // pair still has no conversion at all.
        Assert.True(Conversion.Classify(
            NullableTypeSymbol.Get(derivedType),
            NullableTypeSymbol.Get(baseType)).IsImplicit);
        Assert.False(Conversion.Classify(
            NullableTypeSymbol.Get(stringType),
            TypeSymbol.FromClrType(typeof(Uri))).Exists);
    }

    [Fact]
    public void CheckedCastOfNullableOperandPreservesNilAndThrowsOnWrongType()
    {
        var result = EmittedOracle.Evaluate("""
            import System

            open class Base3843 { var Tag string = "b" }
            class Derived3843 : Base3843 { var Extra int32 = 7 }
            class Other3843 : Base3843 {}

            // 1. DOWNCAST over a nil operand: nil in, nil out, no throw.
            let missing Base3843? = nil
            Console.WriteLine(cast[Derived3843](missing) == nil)

            // 2. DOWNCAST over an incompatible NON-nil operand: still throws,
            //    exactly as C# `(Derived)x` does. The `as` rendering this
            //    replaces returned nil here.
            let wrong Base3843? = Other3843()
            try {
                cast[Derived3843](wrong)
                Console.WriteLine("no-throw")
            } catch (e InvalidCastException) {
                Console.WriteLine(e.GetType().Name)
            }

            // 3. UPCAST over a nil operand — the direction that used to be
            //    GS0155. Nil survives the widening.
            let absent Derived3843? = nil
            Console.WriteLine(cast[Base3843](absent) == nil)

            // 4. UPCAST over a non-nil operand still yields the value.
            let present Derived3843? = Derived3843()
            Console.WriteLine(cast[Base3843](present).Tag)

            // 5. The static result is NON-nullable `T`, so a member access
            //    needs no `!!` — this line would not bind otherwise.
            let hit Base3843? = Derived3843()
            Console.WriteLine(cast[Derived3843](hit).Extra)

            // 6. IDENTITY direction — `T? -> T` drops the annotation and
            //    still carries nil through, as C# `(Derived)maybeDerived` does.
            let sameType Derived3843? = nil
            Console.WriteLine(cast[Derived3843](sameType) == nil)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "True",
                "InvalidCastException",
                "True",
                "b",
                "7",
                "True") + Environment.NewLine,
            result.Output);
        Assert.Equal(string.Empty, result.ErrorOutput);
        Assert.Equal(0, result.ExitCode);
    }

    [Fact]
    public void ValueTypeAndNullableValueTargetsAreUnchangedByTheReferenceArm()
    {
        // The #3843 arm is gated on a reference-like source AND target, so the
        // value-type paths keep C#'s (different) rules: `(int)nullObject`
        // throws NullReferenceException, `(int?)nullObject` does not.
        var result = EmittedOracle.Evaluate("""
            import System

            let boxed object? = nil

            try {
                cast[int32](boxed)
                Console.WriteLine("no-throw")
            } catch (e NullReferenceException) {
                Console.WriteLine(e.GetType().Name)
            }

            Console.WriteLine(cast[int32?](boxed) == nil)

            let wrongBox object? = "text"
            try {
                cast[int32](wrongBox)
                Console.WriteLine("no-throw")
            } catch (e InvalidCastException) {
                Console.WriteLine(e.GetType().Name)
            }
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "NullReferenceException",
                "True",
                "InvalidCastException") + Environment.NewLine,
            result.Output);
        Assert.Equal(0, result.ExitCode);
    }

    [Fact]
    public void CheckedCastComposesWithCoalesceOverANullableOperand()
    {
        // The shape that originally motivated the `as` workaround (#3567):
        // C# `(SyntaxNode)node.Body ?? node.ExpressionBody`. It composes with
        // `??` directly now, with no safe cast in between.
        var result = EmittedOracle.Evaluate("""
            import System

            open class Node3843 { var Tag string = "n" }
            class Block3843 : Node3843 {}
            class Arrow3843 : Node3843 { var Tag2 string = "a" }

            func body() Block3843? -> nil
            func arrow() Arrow3843? -> Arrow3843()

            let picked = cast[Node3843](body()) ?? arrow()
            Console.WriteLine(picked!!.Tag)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("n" + Environment.NewLine, result.Output);
        Assert.Equal(0, result.ExitCode);
    }
}
