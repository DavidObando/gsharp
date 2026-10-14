// <copyright file="Issue1072FieldInitNullableTests.cs" company="GSharp">
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

/// Translator-fidelity tests for the issue #1072 field/property INITIALIZER form:
/// when a field or property whose declared type is a non-nullable reference type is
/// initialized from an expression that yields a nullable value (a `?.`
/// conditional access, a `?? nullableFallback` coalesce, or a member declared
/// `T?`), the emitted G# declared type must be widened to `T?`; otherwise
/// gsc rejects the initializer with `GS0156: Cannot convert type 'T?' to 'T'`.
/// The negative tests pin the precision guard: a provably non-null initializer keeps
/// its non-nullable `T` type.
open class Issue1072FieldInitNullableTests {
    @Fact
    func StaticGetOnlyProperty_ConditionalAccessInitializer_RendersNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public static string Name { get; } = Get()?.ToString();
        private static object Get() => null;
    }
}`)
        Assert.Contains("let _name string? =", printed)
        Assert.Contains("prop Name string?", printed)
    }

    @Fact
    func StaticGetOnlyProperty_NonNullInitializer_KeepsNonNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public static string Name { get; } = "hello";
    }
}`)
        Assert.Contains("let _name string =", printed)
        Assert.Contains("prop Name string", printed)
        Assert.DoesNotContain("let _name string? =", printed)
    }

    @Fact
    func StaticGetOnlyProperty_CoalesceWithNonNullFallback_KeepsNonNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public static string Name { get; } = Get()?.ToString() ?? "fallback";
        private static object Get() => null;
    }
}`)
        Assert.Contains("let _name string =", printed)
        Assert.Contains("prop Name string", printed)
        Assert.DoesNotContain("let _name string? =", printed)
    }

    @Fact
    func StaticGetOnlyProperty_CoalesceWithNullableFallback_RendersNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public static string Name { get; } = Get()?.ToString() ?? Maybe();
        private static object Get() => null;
        private static string? Maybe() => null;
    }
}`)
        Assert.Contains("let _name string? =", printed)
        Assert.Contains("prop Name string?", printed)
    }

    @Fact
    func InstanceField_ConditionalAccessInitializer_RendersNullableType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private readonly string s = Get()?.ToString();
        private static object Get() => null;
    }
}`)
        Assert.Contains("let s string? =", printed)
    }

    @Fact
    func StaticField_NullableMemberInitializer_RendersNullableType() {
        // `AssemblyName.Name` is declared `string?` in BCL metadata, so the
        // initializer is nullable even though the consuming nullable context is off.
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public static string Title { get; } =
            System.Reflection.Assembly.GetEntryAssembly().GetName().Name;
    }
}`)
        Assert.Contains("let _title string? =", printed)
        Assert.Contains("prop Title string?", printed)
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
