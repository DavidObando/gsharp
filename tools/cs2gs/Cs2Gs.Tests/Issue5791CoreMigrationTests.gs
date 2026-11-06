// <copyright file="Issue5791CoreMigrationTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// The Core migration's post-GS0536-polish calls must bind without receiver assertions.
open class Issue5791CoreMigrationTests {
    @Theory
    @InlineData(true)
    @InlineData(false)
    func GuardedAnnotationTarget_PreservesDerivedMember(staticCaller bool) {
        let source = `
#nullable disable
namespace Demo
{
    public abstract class SyntaxNode { }
    public sealed class SyntaxToken : SyntaxNode
    {
        public string ValueText => "1";
    }
    public sealed class AnnotationTargetSyntax : SyntaxNode
    {
        public SyntaxToken KindIdentifier { get; }
        public AnnotationTargetSyntax(SyntaxToken kindIdentifier) { KindIdentifier = kindIdentifier; }
    }
    public sealed class AnnotationSyntax : SyntaxNode
    {
        public AnnotationTargetSyntax? Target { get; }
        public AnnotationSyntax(AnnotationTargetSyntax? target) { Target = target; }
    }
    public class Binder
    {
        public static bool HasAttributeTarget(AnnotationSyntax annotation, int target)
            => annotation.Target != null
                && TryParseTargetKind(annotation.Target.KindIdentifier.ValueText, out var parsedTarget)
                && parsedTarget == target;
        private static bool TryParseTargetKind(string value, out int target)
            => int.TryParse(value, out target);
    }
}`
        let printed = Translate(
            if staticCaller {
                source
            } else {
                source.Replace(
                    "public static bool HasAttributeTarget",
                    "public bool HasAttributeTarget",
                    StringComparison.Ordinal
                )
            }
        )
        TranslationTestValidation.AssertBinds(
            printed.Replace("annotation.Target!!.", "annotation.Target.", StringComparison.Ordinal)
        )
    }

    @Fact
    func ConditionalRecursiveTranslation_PreservesNonNullArgument() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Collections.Immutable;
namespace Demo
{
    public abstract class BoundExpression { }
    public sealed class Literal : BoundExpression { }
    public sealed class Result : BoundExpression
    {
        public Result(ImmutableArray<BoundExpression> items) { }
    }
    public sealed class Property : BoundExpression
    {
        public BoundExpression? Receiver { get; }
        public Property(BoundExpression? receiver) { Receiver = receiver; }
    }
    public sealed class Lowerer
    {
        public BoundExpression TranslateExpression(BoundExpression expression, Dictionary<int, object> parameterMap)
        {
            switch (expression)
            {
                case Property property: return BuildPropertyAccessExpression(property, parameterMap);
                default: return new Literal();
            }
        }
        private BoundExpression BuildPropertyAccessExpression(Property property, Dictionary<int, object> parameterMap)
            => new Result(ImmutableArray.Create<BoundExpression>(property.Receiver == null
                ? new Literal()
                : UpcastToExpression(this.TranslateExpression(property.Receiver, parameterMap))));
        private static BoundExpression UpcastToExpression(BoundExpression expression) => expression;
    }
}`)
        TranslationTestValidation.AssertBinds(
            printed.Replace("property.Receiver!!", "property.Receiver", StringComparison.Ordinal)
        )
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Core.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
