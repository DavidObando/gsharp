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
/// Issue #3683: a C# reference cast whose operand is nullable on the G# side
/// lowers to the null-preserving safe cast <c>expr as T</c> (issue #3501),
/// whose result is <c>T?</c>. When the operand's nullability comes from an
/// ANNOTATED declaration read by an OBLIVIOUS file — the shape all of
/// <c>test/Core.Tests</c> has, since the NRT migration was production-only —
/// Roslyn reports nothing maybe-null at the dereference, so none of the
/// ordinary forgiveness predicates fire and the emitted
/// <c>((x as T)).Member</c> was rejected by gsc with GS0158. The receiver now
/// carries its <c>!!</c>, which is faithful: C# raises a
/// NullReferenceException at exactly this dereference.
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
    public void ObliviousReadOfAnnotatedReference_CastReceiver_KeepsNullForgiveness()
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

        Assert.Contains("((faExpr.Receiver as BoundVariableExpression))!!.Variable", printed);
    }

    [Fact]
    public void ObliviousReadOfAnnotatedReference_CastReceiverInLoop_KeepsNullForgiveness()
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

        Assert.Contains("as BoundVariableExpression))!!.Variable", printed);
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
        Assert.DoesNotContain("as BoundVariableExpression))!!", printed);
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
