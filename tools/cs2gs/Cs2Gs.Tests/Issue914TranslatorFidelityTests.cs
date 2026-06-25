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
    public void PositivePattern_UsedOnlyInsideThen_KeepsSmartCastNoHoist()
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

        // No hoist: the existing smart-cast `is` test is kept.
        Assert.Contains("b.Esds is E", printed);
        Assert.DoesNotContain("as E", printed);
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
