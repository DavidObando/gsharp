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
/// (1) a positive type-pattern variable (<c>x is T t</c>) keeps its binder name:
/// a never-reassigned binder is emitted as a native G# pattern variable
/// (ADR-0166 / issue #3409), while a reassigned binder that leaks past its
/// <c>if</c> is hoisted to a nullable local plus a positive nil-guard;
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

        // Hoisted as a mutable local (reassigned by `esds = fresh`); a reassigned
        // binder cannot be a `let`-immutable G# pattern variable (ADR-0166).
        Assert.Contains("var esds E? = b.Esds as E", printed);
        Assert.Contains("if esds != nil", printed);
        Assert.DoesNotContain("is E esds", printed);
    }

    [Fact]
    public void PositivePattern_LocalScrutinee_PreservesBinderIdentity()
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

        // ADR-0166 / issue #3409: a never-reassigned binder is emitted verbatim as
        // a native pattern variable; no hoisted `as` local, no nil-guard.
        Assert.Contains("if local is E esds {", printed);
        Assert.Contains("Console.WriteLine(esds.X)", printed);
        Assert.DoesNotContain("as E", printed);
        Assert.DoesNotContain("!= nil", printed);
    }

    [Fact]
    public void PositivePattern_PropertyScrutinee_UsedOnlyInsideThen_UsesNativePatternVariable()
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

        // ADR-0166 / issue #3409: a property-access scrutinee cannot be smart-cast
        // by gsc, but the native pattern variable binds the matched value itself,
        // so the binder is kept verbatim (rewriting `esds` to `b.Esds` would yield
        // `b.Esds.X` → GS0158) and no hoisted local is needed.
        Assert.Contains("if b.Esds is E esds {", printed);
        Assert.Contains("Console.WriteLine(esds.X)", printed);
        Assert.DoesNotContain("b.Esds.X", printed);
        Assert.DoesNotContain("as E", printed);
        Assert.DoesNotContain("let esds", printed);
    }

    [Fact]
    public void PositivePattern_MethodCallScrutinee_UsedOnlyInsideThen_EvaluatesScrutineeOnce()
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

        // ADR-0166 / issue #3409: the side-effecting call is the scrutinee of a
        // native pattern variable, so it is evaluated once by the `is` test itself;
        // no hoisted local, and the call must not be re-emitted at each binder use.
        Assert.Contains("if b.GetChild[E]() is E child {", printed);
        Assert.Contains("child.X + child.X", printed);
        Assert.DoesNotContain("as E", printed);
        Assert.DoesNotContain("let child", printed);
        // The method call is emitted exactly once (in the `is` test), not per binder use.
        string[] occurrences = printed.Split("GetChild[E]()");
        Assert.Equal(2, occurrences.Length);
    }

    [Fact]
    public void PositivePattern_JaggedArrayTarget_PropertyScrutinee_UsesNativePatternVariable()
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

        // ADR-0166 / issue #3409: an array-typed target with a non-smart-castable
        // (property-chain) scrutinee is a native pattern variable of type
        // `[][]uint8`; the nullable jagged-array hoist (`let ivs []?[]uint8 = … as
        // [][]uint8` + `!= nil`, issue #1351) is no longer needed.
        Assert.Contains("if chunk.ExtraData is [][]uint8 ivs {", printed);
        Assert.Contains("return ivs.Length", printed);
        Assert.DoesNotContain("let ivs", printed);
        Assert.DoesNotContain("as [][]uint8", printed);
        Assert.DoesNotContain("!= nil", printed);
    }

    [Fact]
    public void PositivePattern_UsedAfterIf_NeverReassigned_LeaksNativePatternVariable()
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

        // ADR-0166 / issue #3409: the else-branch always exits, so G# scopes the
        // native pattern variable to the statements after the `if`; the binder is
        // emitted verbatim and read after the `if` without a hoisted `let`.
        Assert.Contains("if b.Esds is E esds {", printed);
        Assert.Contains("return esds.X", printed);
        Assert.DoesNotContain("as E", printed);
        Assert.DoesNotContain("let esds", printed);
        Assert.DoesNotContain("!= nil", printed);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
