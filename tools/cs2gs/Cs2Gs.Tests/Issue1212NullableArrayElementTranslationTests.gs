// <copyright file="Issue1212NullableArrayElementTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1212 — cs2gs must distinguish the two array nullability spellings:
/// a C# array of nullable ELEMENTS (`T?[]`) renders as `[]T?` (a
/// non-nullable slice whose element type is `T?`), while a C# nullable
/// ARRAY reference (`T[]?`) renders as `[]?T` (the whole slice may be
/// nil). Both must round-trip through gsc.
open class Issue1212NullableArrayElementTranslationTests {
    @Fact
    func NullableReferenceElementArray_RendersElementNullable() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        public void F(object?[] items) { }
    }
}`)
        Assert.Contains("F(items []object?)", printed)
    }

    @Fact
    func NullableValueElementArray_RendersElementNullable() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        public void F(int?[] items) { }
    }
}`)
        Assert.Contains("F(items []int32?)", printed)
    }

    @Fact
    func NullableReferenceArray_RendersArrayNullable() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        public void F(object[]? items) { }
    }
}`)
        Assert.Contains("F(items []?object)", printed)
    }

    @Fact
    func NullableArrayOfNullableElements_RendersBothMarkers() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        public void F(object?[]? items) { }
    }
}`)
        Assert.Contains("F(items []?object?)", printed)
    }

    @Fact
    func NullableReferenceElementArrayCreation_RendersElementNullable() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        public object?[] F(int count) => new object?[count];
    }
}`)
        Assert.True(printed.Split("object?", StringSplitOptions.None).Length >= 3, printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
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
