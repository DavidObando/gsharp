// <copyright file="PromotionConsolidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.Linq
import Xunit

open class PromotionConsolidationTests {
    @Fact
    func ObliviousClassConstrainedValuePromotesSymmetricallyAcrossSinks() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder<T> where T : class
    {
        public T Item;
    }

    public class C<T> where T : class
    {
        public T Field;
        public T Property { get; set; }

        public void Accept(T item) { }

        public void Assign(T value)
        {
            if (value == null) { return; }
            Field = value;
            Property = value;
            T local = value;
            Accept(value);
        }

        public T Return(T value)
        {
            if (value == null) { return default(T); }
            return value;
        }

        public (T, T) Pair(T value)
        {
            if (value == null) { return (default(T), default(T)); }
            return (value, value);
        }

        public Holder<T> ObjectInit(T value)
        {
            if (value == null) { return new Holder<T>(); }
            return new Holder<T> { Item = value };
        }

        public T SwitchArm(T value, bool pick)
        {
            if (value == null) { return default(T); }
            return pick switch
            {
                true => value,
                _ => default(T),
            };
        }
    }
}`)
        Assert.Contains("Item T?", printed)
        Assert.Contains("Field T?", printed)
        Assert.Contains("Property T?", printed)
        Assert.Contains("Assign(value T?)", printed)
        Assert.Contains("local T?", printed)
        Assert.Contains("Accept(item T?)", printed)
        Assert.Contains("Return(value T?) T?", printed)
        Assert.Contains("Pair(value T?) (T?, T?)", printed)
        Assert.Contains("ObjectInit(value T?) Holder[T]", printed)
        Assert.Contains("SwitchArm(value T?, pick bool) T?", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
