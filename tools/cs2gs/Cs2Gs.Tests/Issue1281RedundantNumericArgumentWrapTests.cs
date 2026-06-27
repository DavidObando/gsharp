// <copyright file="Issue1281RedundantNumericArgumentWrapTests.cs" company="GSharp">
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
/// Issue #1281: gsc now applies, at a concrete numeric parameter, the same
/// implicit lossless widening (ADR-0044) and constant-expression narrowing
/// (C# §10.2.11) that C# performs at the call site. The translator must
/// therefore stop emitting the redundant explicit <c>T(x)</c> conversion that
/// gsc accepts on its own, while still keeping it where gsc cannot reproduce the
/// conversion: a generic (type-parameter) target, or a non-literal constant that
/// gsc does not fold (e.g. a <c>const</c> field).
/// </summary>
public class Issue1281RedundantNumericArgumentWrapTests
{
    /// <summary>
    /// A widening conversion of a non-constant operand to a concrete numeric
    /// parameter (<c>ushort</c> → <c>int</c>) is dropped: gsc widens the operand
    /// implicitly at the call site, so the explicit <c>int32(u)</c> is redundant.
    /// </summary>
    [Fact]
    public void Argument_WideningNonConstantToConcreteParameter_SkipsExplicitConversion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void M(int x) { }

        public void Caller(ushort u)
        {
            M(u);
        }
    }
}");
        Assert.Contains("M(u)", printed);
        Assert.DoesNotContain("int32(u)", printed);
    }

    /// <summary>
    /// A constant-expression cross-sign conversion of an integer LITERAL to a
    /// concrete unsigned parameter (<c>5</c> → <c>uint</c>) is dropped: gsc folds
    /// the literal and accepts it because the value is in range, so the explicit
    /// <c>uint32(5)</c> is redundant.
    /// </summary>
    [Fact]
    public void Argument_ConstantLiteralCrossSignToConcreteParameter_SkipsExplicitConversion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void M(uint x) { }

        public void Caller()
        {
            M(5);
        }
    }
}");
        Assert.Contains("M(5)", printed);
        Assert.DoesNotContain("uint32(", printed);
    }

    /// <summary>
    /// A widening conversion of an integer LITERAL to a concrete wider parameter
    /// (<c>5</c> → <c>long</c>) is dropped: gsc widens the literal implicitly.
    /// </summary>
    [Fact]
    public void Argument_WideningLiteralToConcreteParameter_SkipsExplicitConversion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void M(long x) { }

        public void Caller()
        {
            M(5);
        }
    }
}");
        Assert.Contains("M(5)", printed);
        Assert.DoesNotContain("int64(", printed);
    }

    /// <summary>
    /// A constant-expression cross-sign conversion of a <c>const</c> FIELD (not a
    /// bare literal) to a concrete unsigned parameter keeps its explicit
    /// <c>uint32(Five)</c>: gsc only folds literals and unary +/- over literals at
    /// the call site (ADR-0129), so a const-field reference is not value-known to
    /// gsc and the conversion must remain explicit.
    /// </summary>
    [Fact]
    public void Argument_ConstantFieldCrossSignToConcreteParameter_KeepsExplicitConversion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private const int Five = 5;

        public void M(uint x) { }

        public void Caller()
        {
            M(Five);
        }
    }
}");
        Assert.Contains("uint32(C.Five)", printed);
    }

    /// <summary>
    /// A widening conversion to a GENERIC (type-parameter) parameter keeps its
    /// explicit conversion: gsc's CLR generic inference does not unify a
    /// widening-only numeric argument (GS0159), so the operand must already carry
    /// the converted type.
    /// </summary>
    [Fact]
    public void Argument_WideningToGenericParameter_KeepsExplicitConversion()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public void M(int x)
        {
            ArgumentOutOfRangeException.ThrowIfGreaterThan(x, ushort.MaxValue);
        }
    }
}");
        Assert.Contains("int32(UInt16.MaxValue)", printed);
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
