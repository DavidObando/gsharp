// <copyright file="Issue3683ObliviousCastReceiverForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Xunit

/// Issue #3683, as re-based by issue #3843: a C# reference cast whose operand
/// is nullable on the G# side used to lower to the safe cast `expr as T`,
/// whose `T?` result then needed a `!!` on every dereference. The
/// cast now stays `cast[T](expr)`, whose result is non-nullable `T`
/// exactly as the C# cast's type is `T`, so no safe cast and no
/// null-forgiveness appear at all. Runtime faithfulness is unchanged and now
/// exact: `cast[T](nil)` yields nil (ADR-0167), and the dereference that
/// follows raises the same NullReferenceException C# raises — while a
/// wrong-type non-nil operand throws InvalidCastException, which the old
/// `as` rendering silently swallowed into nil.
open class Issue3683ObliviousCastReceiverForgivenessTests {
    @Fact
    func ObliviousReadOfAnnotatedReference_CastReceiver_StaysCheckedConversionCall() {
        let printed = TranslateObliviousConsumer(`
namespace Demo
{
    public class Holder
    {
        public object Read(BoundFieldAccessExpression faExpr)
        {
            return ((BoundVariableExpression)faExpr.Receiver).Variable;
        }
    }
}`)
        Assert.Contains("(cast[BoundVariableExpression](faExpr.Receiver)).Variable", printed)
        Assert.DoesNotContain("as BoundVariableExpression", printed)
    }

    @Fact
    func ObliviousReadOfAnnotatedReference_CastReceiverInLoop_StaysCheckedConversionCall() {
        let printed = TranslateObliviousConsumer(`
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
}`)
        Assert.Contains("(cast[BoundVariableExpression](items[i].Receiver)).Variable", printed)
        Assert.DoesNotContain("as BoundVariableExpression", printed)
    }

    @Fact
    func ObliviousReadOfNonNullableReference_Cast_StaysUnforgiven() {
        let printed = TranslateObliviousConsumer(`
namespace Demo
{
    public class Holder
    {
        public object Read(BoundVariableExpression variableExpr)
        {
            return ((BoundVariableExpression)(BoundExpression)variableExpr).Variable;
        }
    }
}`)
        // A provably non-null operand keeps the checked-reference-cast form, so
        // no safe cast and no assertion are introduced.
        Assert.DoesNotContain("as BoundVariableExpression", printed)
    }

    shared {
        private const AnnotatedDeclarations string = `
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
}`

        private func TranslateObliviousConsumer(obliviousSource string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Annotated.cs", AnnotatedDeclarations), ("Oblivious.cs", obliviousSource)}
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics)
            )
            let document = project.Documents[1]
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
