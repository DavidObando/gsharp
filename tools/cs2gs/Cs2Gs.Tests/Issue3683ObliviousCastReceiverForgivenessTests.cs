// <copyright file="Issue3683ObliviousCastReceiverForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3683, as re-based by issue #3843: a C# reference cast whose operand
/// is nullable on the G# side used to lower to the safe cast <c>expr as T</c>,
/// whose <c>T?</c> result then needed a <c>!!</c> on every dereference. The
/// cast now stays <c>cast[T](expr)</c>, whose result is non-nullable <c>T</c>
/// exactly as the C# cast's type is <c>T</c>, so no safe cast and no
/// null-forgiveness appear at all. Runtime faithfulness is unchanged and now
/// exact: <c>cast[T](nil)</c> yields nil (ADR-0167), and the dereference that
/// follows raises the same NullReferenceException C# raises — while a
/// wrong-type non-nil operand throws InvalidCastException, which the old
/// <c>as</c> rendering silently swallowed into nil.
/// </summary>
public class Issue3683ObliviousCastReceiverForgivenessTests
{
    private const string AnnotatedDeclarations = @"
#nullable enable
namespace Demo
{
    public class BoundExpression { }

    public class BoundVariableExpression : BoundExpression
    {
        public object? Variable { get; set; }
    }

    public class BoundFieldAccessExpression : BoundExpression
    {
        public BoundExpression? Receiver { get; set; }
    }
}";

    [Fact]
    public void ObliviousReadOfAnnotatedReference_CastReceiver_StaysCheckedConversionCall()
    {
        string printed = TranslateObliviousConsumer(@"
namespace Demo
{
    public class Holder
    {
        public object Read(BoundFieldAccessExpression faExpr)
        {
            return ((BoundVariableExpression)faExpr.Receiver).Variable;
        }
    }
}");

        Assert.Contains("cast[BoundVariableExpression](faExpr.Receiver).Variable", printed);
        Assert.DoesNotContain("as BoundVariableExpression", printed);
    }

    [Fact]
    public void ObliviousReadOfAnnotatedReference_CastReceiverInLoop_StaysCheckedConversionCall()
    {
        string printed = TranslateObliviousConsumer(@"
namespace Demo
{
    public class Holder
    {
        public void Read(BoundFieldAccessExpression[] items)
        {
            for (int i = 0; i < items.Length; i++)
            {
                var value = ((BoundVariableExpression)items[i].Receiver).Variable;
            }
        }
    }
}");

        Assert.Contains("cast[BoundVariableExpression](items[i].Receiver).Variable", printed);
        Assert.DoesNotContain("as BoundVariableExpression", printed);
    }

    [Fact]
    public void ObliviousReadOfNonNullableReference_Cast_StaysUnforgiven()
    {
        string printed = TranslateObliviousConsumer(@"
namespace Demo
{
    public class Holder
    {
        public object Read(BoundVariableExpression variableExpr)
        {
            return ((BoundVariableExpression)(BoundExpression)variableExpr).Variable;
        }
    }
}");

        // A provably non-null operand keeps the checked-reference-cast form, so
        // no safe cast and no assertion are introduced.
        Assert.DoesNotContain("as BoundVariableExpression", printed);
    }

    private static string TranslateObliviousConsumer(string obliviousSource)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Annotated.cs", AnnotatedDeclarations), ("Oblivious.cs", obliviousSource) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument document = project.Documents[1];
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
