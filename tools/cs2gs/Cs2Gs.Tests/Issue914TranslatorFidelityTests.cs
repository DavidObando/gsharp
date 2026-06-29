// <copyright file="Issue914TranslatorFidelityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for the three defects in issue #914:
/// (1) a positive type-pattern variable (<c>x is T t</c>) that leaks past its
/// <c>if</c> is hoisted to a nullable local plus a positive nil-guard so later
/// uses bind to it;
/// (2) a reassigned value parameter is shadowed by a mutable local
/// (<c>var p = p</c>) because G# parameters are read-only;
/// (3) <c>x ?? throw E</c> is lowered to a nil-guard that throws when nil.
/// </summary>
public class Issue914TranslatorFidelityTests
{
    // ---- Task 1: positive pattern variable leaking past the if --------------

    [Fact]
    public void PositivePattern_UsedAfterIf_HoistsNullableLocalAndPositiveGuard()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class E { public ES ES_Descriptor => new ES(); }
    public class ES { public int X; }
    public class Box { public E? Esds => null; }
    public class C
    {
        public int F(Box b, E fresh)
        {
            if (b.Esds is E esds) { System.Console.WriteLine(esds.ES_Descriptor.X); }
            esds = fresh;
            return esds.ES_Descriptor.X;
        }
    }
}");

        // Hoisted as a mutable local (reassigned by `esds = fresh`).
        Assert.Contains("var esds E? = b.Esds as E", printed);
        Assert.Contains("if esds != nil", printed);
    }

    [Fact]
    public void PositivePattern_LocalScrutinee_UsedOnlyInsideThen_KeepsSmartCastNoHoist()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class E { public int X; }
    public class Box { public E? Esds => null; }
    public class C
    {
        public void F(Box b)
        {
            var local = b.Esds;
            if (local is E esds) { System.Console.WriteLine(esds.X); }
        }
    }
}");

        // A bare local scrutinee smart-casts in gsc, so no hoist: the existing
        // smart-cast `is` test is kept and `esds` rewrites to the local.
        Assert.Contains("local is E", printed);
        Assert.DoesNotContain("as E", printed);
    }

    [Fact]
    public void PositivePattern_PropertyScrutinee_UsedOnlyInsideThen_HoistsLocal()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class E { public int X; }
    public class Box { public E? Esds => null; }
    public class C
    {
        public void F(Box b)
        {
            if (b.Esds is E esds) { System.Console.WriteLine(esds.X); }
        }
    }
}");

        // A property-access scrutinee cannot be smart-cast by gsc, so even when the
        // binder is used only inside the then-block it must hoist into a local
        // (rewriting `esds` to `b.Esds` would yield `b.Esds.X` → GS0158).
        Assert.Contains("let esds E? = b.Esds as E", printed);
        Assert.Contains("if esds != nil", printed);
    }

    [Fact]
    public void PositivePattern_MethodCallScrutinee_UsedOnlyInsideThen_HoistsLocalOnce()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class E { public int X; }
    public class Box { public T? GetChild<T>() where T : class => null; }
    public class C
    {
        public void F(Box b)
        {
            if (b.GetChild<E>() is E child) { System.Console.WriteLine(child.X + child.X); }
        }
    }
}");

        // A method-call scrutinee must be evaluated once into a hoisted local; the
        // side-effecting call must not be re-emitted at each use of the binder.
        Assert.Contains("let child E? = b.GetChild[E]() as E", printed);
        Assert.Contains("if child != nil", printed);
        // The method call is emitted exactly once (in the hoist), not per binder use.
        string[] occurrences = printed.Split("GetChild[E]()");
        Assert.Equal(2, occurrences.Length);
    }

    [Fact]
    public void PositivePattern_JaggedArrayTarget_PropertyScrutinee_HoistsNullableJaggedArray()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Chunk { public byte[][] ExtraData => null; }
    public class C
    {
        public int F(Chunk chunk)
        {
            if (chunk.ExtraData is byte[][] ivs) { return ivs.Length; }
            return 0;
        }
    }
}");

        // Issue #1351: a nullable jagged-array local annotation (`[]?[]uint8`) now
        // round-trip-parses in gsc, so an array target with a non-smart-castable
        // (property-chain) scrutinee hoists the faithful nullable local + `!= nil`
        // guard instead of falling back to the smart-cast `is` test.
        Assert.Contains("let ivs []?[]uint8 = chunk.ExtraData as [][]uint8", printed);
        Assert.Contains("if ivs != nil", printed);
    }

    [Fact]
    public void PositivePattern_UsedAfterIf_NeverReassigned_HoistsAsLet()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class E { public int X; }
    public class Box { public E? Esds => null; }
    public class C
    {
        public int F(Box b)
        {
            if (b.Esds is E esds) { System.Console.WriteLine(esds.X); } else { return 0; }
            return esds.X;
        }
    }
}");

        Assert.Contains("let esds E? = b.Esds as E", printed);
        Assert.Contains("if esds != nil", printed);
    }

    // ---- Task 2: reassigned value parameter ---------------------------------

    [Fact]
    public void ReassignedParameter_ShadowedByMutableLocal()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public long F(long x) { x = x + 1; return x; }
    }
}");

        Assert.Contains("var x = x", printed);
    }

    [Fact]
    public void NonReassignedParameter_NotShadowed()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public long F(long x) { return x + 1; }
    }
}");

        Assert.DoesNotContain("var x = x", printed);
    }

    // ---- Task 3: `x ?? throw E` ---------------------------------------------

    [Fact]
    public void CoalesceThrow_InReturn_RendersNativeCoalesceThrow()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class E { }
    public class C
    {
        public E F(E? x) { return x ?? throw new System.InvalidOperationException(""nil""); }
    }
}");

        Assert.Contains("?? throw InvalidOperationException", printed);
        Assert.DoesNotContain("__coalesce", printed);
        Assert.DoesNotContain("if true {", printed);
    }

    [Fact]
    public void CoalesceThrow_InLocalDeclaration_RendersNativeCoalesceThrow()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class E { }
    public class C
    {
        public E F(E? x)
        {
            var r = x ?? throw new System.InvalidOperationException(""nil"");
            return r;
        }
    }
}");

        Assert.Contains("?? throw InvalidOperationException", printed);
        Assert.DoesNotContain("__coalesce", printed);
        Assert.DoesNotContain("if true {", printed);
    }

    [Fact]
    public void CoalesceThrow_InAssignment_RendersNativeCoalesceThrow()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class E { }
    public class C
    {
        public E Field;
        public void F(E? x)
        {
            Field = x ?? throw new System.InvalidOperationException(""nil"");
        }
    }
}");

        Assert.Contains("?? throw InvalidOperationException", printed);
        Assert.DoesNotContain("__coalesce", printed);
        Assert.DoesNotContain("if true {", printed);
    }

    [Fact]
    public void CoalesceThrow_ValueTypeNullable_RendersNativeCoalesceThrow()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int F(int? n) { return n ?? throw new System.InvalidOperationException(""nil""); }
    }
}");

        Assert.Contains("?? throw InvalidOperationException", printed);
        Assert.DoesNotContain("__coalesce", printed);
        Assert.DoesNotContain("if true {", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
