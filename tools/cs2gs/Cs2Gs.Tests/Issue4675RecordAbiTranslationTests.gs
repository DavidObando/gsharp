// <copyright file="Issue4675RecordAbiTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.IO
import System.Linq
import System.Reflection
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis
import System.Collections.Generic
import System.Text
import System.Text.Json

/// Issue #4675: translated record API metadata must match Roslyn's C#
/// baseline for the same source.
class Issue4675RecordAbiTranslationTests {
    @Theory
    @InlineData("record", "", " = Seed(Value)", int32(21))
    @InlineData("record", "private", " = Seed(Value)", int32(21))
    @InlineData("record struct", "", " = Seed(Value)", int32(21))
    @InlineData("record struct", "private", " = Seed(Value)", int32(21))
    @InlineData("record", "", "", int32(0))
    @InlineData("record struct", "", "", int32(0))
    @InlineData("record", "", " = Value", int32(10))
    @InlineData("record struct", "", " = Value", int32(10))
    @InlineData("record", "private", " = Value", int32(10))
    @InlineData("record struct", "private", " = Value", int32(10))
    func ExplicitPositionalProperty_PreservesRuntimeAndAccessorMetadata(
        kind string,
        accessorVisibility string,
        initializer string,
        expected int32
    ) {
        let source = (`namespace PositionalProperty {
    public ` + "$kind" + ` Item(int Value) {
        public int Value { get; ` + "$accessorVisibility" + ` init; }` + "$initializer" + "${(if initializer.Length == 0 { "" } else { ";" })}" + `
        private static int Calls;
        private static int Seed(int value) { Calls++; return value + 1; }
        public static int Run() => new Item(1).Value * 10 + Calls;
    }
}`)
        VerifyExplicitPositionalProperty(source, "Value", expected)
    }

    @Theory
    @InlineData("record", "package", "", false, int32(0))
    @InlineData("record struct", "package", "", false, int32(0))
    @InlineData("record", "package", " = package", false, int32(7))
    @InlineData("record struct", "package", " = package", false, int32(7))
    @InlineData("record", "Value", " = null", true, int32(0))
    @InlineData("record struct", "Value", " = null", true, int32(0))
    @InlineData("record", "package", " = null", true, int32(0))
    @InlineData("record struct", "package", " = null", true, int32(0))
    @InlineData("record", "Value", " = Value", true, int32(1))
    @InlineData("record struct", "Value", " = Value", true, int32(1))
    @InlineData("record", "Value", "", true, int32(0))
    @InlineData("record struct", "Value", "", true, int32(0))
    func ExplicitPositionalProperty_EscapedAndNullableStorage_PreservesBaseline(
        kind string,
        name string,
        initializer string,
        nullable bool,
        expected int32
    ) {
        let source = (`#nullable enable
namespace PositionalProperty {
    public ` + "$kind" + ` Item(` + "${(if nullable { "string?" } else { "int" })}" + ` ` + "$name" + `) {
        public ` + "${(if nullable { "string?" } else { "int" })}" + ` ` + "$name" + ` { get; init; }` + "$initializer" + "${(if initializer.Length == 0 { "" } else { ";" })}" + `
        public static int Run() => ` + "${(if nullable { "new Item(\"input\")." + name + " is null ? 0 : 1" } else { "new Item(7)." + name })}" + `;
    }
}`)
        VerifyExplicitPositionalProperty(source, name, expected)
    }

    @Fact
    func NullableNormalizingPositionalGetter_MatchesRoslyn() {
        VerifyExplicitPositionalProperty(`#nullable enable
namespace PositionalProperty {
    public record Item(string? Value) {
        public string Value { get; } = Value ?? "";
        public static int Run() => new Item((string?)null).Value.Length;
    }
}`, "Value", 0)
    }

    @Fact
    func NullableNormalizingAbstractPositionalGetter_MatchesRoslyn() {
        VerifyExplicitPositionalProperty(`#nullable enable
namespace PositionalProperty {
    public abstract record Item(string? Input) {
        public abstract string Input { get; }
        public static int Run() => new Leaf(null).Input.Length;
    }
    public sealed record Leaf(string? Value) : Item(Value) {
        public override string Input { get; } = Value ?? "";
    }
}`, "Input", 0)
    }

    @Theory
    @InlineData(" = 42", int32(42))
    @InlineData(" = Seed()", int32(7))
    @InlineData("", int32(0))
    func NonPositionalGetterOnlyProperty_PreservesRoslynAbi(initializer string, expected int32) {
        VerifyExplicitPositionalProperty((`namespace PositionalProperty {
    public record Item {
        private static int Seed() => 7;
        public int Value { get; }` + "$initializer" + "${(if initializer.Length == 0 { "" } else { ";" })}" + `
        public static int Run() => new Item().Value;
    }
}`), "Value", expected)
    }

    @Fact
    func MutableStructFieldPrintMembers_MatchesRoslynReceiverSemantics() {
        const source = `namespace PrintMembersMutation {
    public struct Counter {
        public int Count;
        public override string ToString() => (++Count).ToString();
    }
    public record Item {
        public Counter Value;
        public static string Run() {
            var item = new Item();
            var first = new System.Text.StringBuilder();
            var second = new System.Text.StringBuilder();
            item.PrintMembers(first);
            item.PrintMembers(second);
            return first.ToString() + "|" + second.ToString() + "|" + item.Value.Count;
        }
    }
    public record GenericItem<T> where T : struct {
        public T Value;
        public static string Run() {
            var item = new GenericItem<Counter>();
            var first = new System.Text.StringBuilder();
            var second = new System.Text.StringBuilder();
            item.PrintMembers(first);
            item.PrintMembers(second);
            return first.ToString() + "|" + second.ToString() + "|" + item.Value.Count;
        }
    }
    public static class Probe {
        public static string Run() => Item.Run() + ";" + GenericItem<Counter>.Run();
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Item.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let baselineImage = MemoryStream()
        Assert.True(project.Compilation.WithAssemblyName("PrintMembersMutationBaseline").Emit(baselineImage).Success)
        let baseline = Assembly.Load(baselineImage.ToArray())
        let expected object? = baseline.GetType("PrintMembersMutation.Probe", throwOnError: true)!!.GetMethod(
            "Run"
        )!!.Invoke(nil, nil)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        using let translatedImage = MemoryStream()
        let compilation = GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(translated))){IsLibrary = true}
        let emit = compilation.Emit(
            translatedImage,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "PrintMembersMutationTranslated"
        )
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        let actual object? = Assembly.Load(translatedImage.ToArray()).GetType(
            "PrintMembersMutation.Probe",
            throwOnError: true
        )!!.GetMethod("Run")!!.Invoke(nil, nil)
        Assert.Equal(expected, actual)
        Assert.Equal("Value = 1|Value = 2|2;Value = 1|Value = 2|2", actual)
    }

    @Fact
    func HiddenBaseFieldPrintMembers_MatchesRoslynMemberSelection() {
        const source = `namespace PrintMembersHiding {
    public record Base {
        public int Value = 1;
    }
    public record Derived : Base {
        public new int Value => 2;
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Item.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let baselineImage = MemoryStream()
        Assert.True(project.Compilation.WithAssemblyName("PrintMembersHidingBaseline").Emit(baselineImage).Success)
        let baseline = Assembly.Load(baselineImage.ToArray())
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        using let translatedImage = MemoryStream()
        let compilation = GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(translated))){IsLibrary = true}
        let emit = compilation.Emit(
            translatedImage,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "PrintMembersHidingTranslated"
        )
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        let migrated = Assembly.Load(translatedImage.ToArray())
        let Render = func (assembly Assembly) string {
            let type Type? = assembly.GetType("PrintMembersHiding.Derived", throwOnError: true)
            let instance object? = Activator.CreateInstance(type!!)
            let builder = StringBuilder()
            type!!.GetMethod("PrintMembers", BindingFlags.Instance | BindingFlags.NonPublic)!!.Invoke(
                instance,
                []object{builder}
            )
            return builder.ToString()
        }
        let expected = Render(baseline)
        let actual = Render(migrated)
        Assert.Equal(expected, actual)
        Assert.Equal("Value = 1, Value = 2", actual)
    }

    @Fact
    func ExplicitAbstractPrintMembers_IsNotSynthesizedTwice() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Item.cs", `public abstract record Item {
    protected abstract bool PrintMembers(System.Text.StringBuilder builder);
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Equal(1, translated.Split("func PrintMembers(", StringSplitOptions.None).Length - 1)
        Assert.True(TranslationTestValidation.AssertBinds(translated)!!.Success, translated)
    }

    @Theory
    @InlineData("record", "Value", "", false, false, false, int32(0))
    @InlineData("record struct", "Value", "", false, false, false, int32(0))
    @InlineData("record", "package", "", false, false, false, int32(0))
    @InlineData("record struct", "package", "", false, false, false, int32(0))
    @InlineData("record", "Value", " = Value", false, false, false, int32(7))
    @InlineData("record struct", "Value", " = Value", false, false, false, int32(7))
    @InlineData("record", "Value", "", false, true, true, int32(0))
    @InlineData("record struct", "Value", "", false, true, true, int32(0))
    @InlineData("record", "package", "", false, true, true, int32(0))
    @InlineData("record struct", "package", "", false, true, true, int32(0))
    @InlineData("record", "Value", "", false, true, false, int32(0))
    @InlineData("record struct", "Value", "", false, true, false, int32(0))
    @InlineData("record", "Value", " = null", true, true, true, int32(0))
    @InlineData("record struct", "Value", " = null", true, true, true, int32(0))
    @InlineData("record", "Value", " = Value", false, true, true, int32(7))
    @InlineData("record struct", "Value", " = Value", false, true, true, int32(7))
    func ExplicitPositionalProperty_PartialAndGetOnlyStorage_PreservesBaseline(
        kind string,
        name string,
        initializer string,
        nullable bool,
        split bool,
        hasSetter bool,
        expected int32
    ) {
        let source = (`#nullable enable
namespace PositionalProperty {
    public ` + "${(if split { "partial " } else { "" })}" + "$kind" + ` Item` + "${(if split { "" } else { "(" + (if nullable { "string?" } else { "int" }) + " " + name + ")" })}" + ` {
        public ` + "${(if nullable { "string?" } else { "int" })}" + ` ` + "$name" + ` { get; ` + "${(if hasSetter { "init;" } else { "" })}" + ` }` + "$initializer" + "${(if initializer.Length == 0 { "" } else { ";" })}" + `
        public static int Run() => ` + "${(if nullable { "new Item(\"input\")." + name + " is null ? 0 : 1" } else { "new Item(7)." + name })}" + `;
    }
}`)
        let sources = if split {
            [](string, string){("Header.cs", (`#nullable enable
namespace PositionalProperty {
    public partial ` + "$kind" + ` Item(` + "${(if nullable { "string?" } else { "int" })}" + ` ` + "$name" + `);
}`)), ("Item.cs", source)}
        } else {
            cast[[](string, string)]([](string, source string){("Item.cs", source)})
        }
        VerifyExplicitPositionalProperty(sources, name, expected)
    }

    @Fact
    func TranslatedRecordAbi_MatchesCSharpCompilerSurface() {
        let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Issue4675.cs", Source)})
        Assert.True(
            project.BoundWithoutErrors,
            "C# baseline should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let baselineClass INamedTypeSymbol? = project.Compilation.GetTypeByMetadataName("Corpus.Issue4675.RecordClass")
        let baselinePrintMembers = Assert.Single(baselineClass!!.GetMembers("PrintMembers").OfType[IMethodSymbol]())
        Assert.Equal(Accessibility.Protected, baselinePrintMembers.DeclaredAccessibility)
        Assert.True(baselinePrintMembers.IsVirtual || baselinePrintMembers.IsOverride)
        Assert.Equal("System.Text.StringBuilder", baselinePrintMembers.Parameters[0].Type.ToDisplayString())
        Assert.Contains(
            baselineClass!!.AllInterfaces,
            (iface INamedTypeSymbol) -> iface.OriginalDefinition.ToDisplayString() == "System.IEquatable<T>"
        )
        let baselineProperty = Assert.Single(baselineClass!!.GetMembers("BodyHash").OfType[IPropertySymbol]())
        Assert.Null(baselineProperty.SetMethod)
        let baselineStruct INamedTypeSymbol? = project.Compilation.GetTypeByMetadataName(
            "Corpus.Issue4675.RecordStruct"
        )
        Assert.Contains(
            baselineStruct!!.AllInterfaces,
            (iface INamedTypeSymbol) -> iface.OriginalDefinition.ToDisplayString() == "System.IEquatable<T>"
        )
        let baselineOverloaded INamedTypeSymbol? = project.Compilation.GetTypeByMetadataName(
            "Corpus.Issue4675.OverloadedPrintMembers"
        )
        Assert.Contains(
            baselineOverloaded!!.GetMembers("PrintMembers").OfType[IMethodSymbol](),
            (method IMethodSymbol) -> method.IsImplicitlyDeclared &&
                method
                .Parameters
                .Length == 1 &&
                method
                .Parameters[0]
                .Type
                .ToDisplayString() == "System.Text.StringBuilder"
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let translated = GSharpPrinter.Print(unit)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(translated)
        Assert.True(
            roundTrip!!.Success,
            "Translated record should bind:\n" + string.Join(Environment.NewLine, roundTrip!!.Errors) +
                "\n" +
                translated
        )
        let translatedClass = unit
            .Members
            .OfType[TypeDeclaration]()
            .Single((t TypeDeclaration) -> t.Name == "RecordClass")
        // ADR-0199: gsc synthesizes the record PrintMembers; the translation
        // must not carry a generated copy (the Roslyn-shaped slot is checked
        // below through the emitted metadata).
        Assert.DoesNotContain(
            translatedClass.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "PrintMembers"
        )
        Assert.Contains("BodyHash", translated)
        Assert.DoesNotContain("BodyHash string { get; init; }", translated, StringComparison.Ordinal)
        let translatedStruct = unit
            .Members
            .OfType[TypeDeclaration]()
            .Single((t TypeDeclaration) -> t.Name == "RecordStruct")
        Assert.Contains(
            translatedStruct.Interfaces,
            (iface GTypeReference) -> iface is NamedTypeReference named && named.Name.Contains(
                "IEquatable",
                StringComparison.Ordinal
            )
        )
        let translatedOverloaded = unit
            .Members
            .OfType[TypeDeclaration]()
            .Single((t TypeDeclaration) -> t.Name == "OverloadedPrintMembers")
        let translatedOverload = Assert.Single(
            translatedOverloaded.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "PrintMembers"
        )
        Assert.Single(translatedOverload.Parameters)
        Assert.Equal("ignored", translatedOverload.Parameters[0].Name)
        using let csharpImage = MemoryStream()
        Assert.True(project.Compilation.Emit(csharpImage).Success, "C# baseline should emit.")
        using let gsharpImage = MemoryStream()
        let gsharpCompilation = GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(translated))){IsLibrary = true}
        let gsharpEmit = gsharpCompilation.Emit(
            gsharpImage,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue4675Translated"
        )
        Assert.True(gsharpEmit.Success, string.Join(Environment.NewLine, gsharpEmit.Diagnostics))
        let csharpAssembly = Assembly.Load(csharpImage.ToArray())
        let gsharpAssembly = Assembly.Load(gsharpImage.ToArray())
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase")
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass")
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedRecord")
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordStruct")
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase")
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass")
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedDerivedRecord")
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase", isProtected: true)
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", isProtected: true)
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedRecord", isProtected: false)
        AssertCopyConstructor(
            csharpAssembly,
            gsharpAssembly,
            "Corpus.Issue4675.SealedDerivedRecord",
            isProtected: false
        )
        Assert.True(gsharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true)!!.IsSealed)
        AssertGetOnlyProperty(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", "BodyHash")
        AssertInitProperty(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", "Value")
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.OverloadedPrintMembers")
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RefOverloadedPrintMembers")
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.CustomPrintMembers")
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericRecord`1")
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericDerivedRecord`1")
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericRecordStruct`1")
        for typeName in[]string{
            "Corpus.Issue4675.RecordBase",
            "Corpus.Issue4675.RecordClass",
            "Corpus.Issue4675.DerivedCustomPrintMembers",
            "Corpus.Issue4675.SealedDerivedRecord"
        } {
            AssertPrintMembersOutput(csharpAssembly, gsharpAssembly, typeName)
        }
        let baselineDerived object? = Activator.CreateInstance(
            csharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true)!!,
            []object{42}
        )
        let translatedDerived object? = Activator.CreateInstance(
            gsharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true)!!,
            []object{42}
        )
        let baselineRender object? = csharpAssembly.GetType(
            "Corpus.Issue4675.RecordBase",
            throwOnError: true
        )!!.GetMethod("Render")!!.Invoke(baselineDerived, nil)
        let translatedRender object? = gsharpAssembly.GetType(
            "Corpus.Issue4675.RecordBase",
            throwOnError: true
        )!!.GetMethod("Render")!!.Invoke(translatedDerived, nil)
        Assert.Equal(baselineRender, translatedRender)
        let baselineBase Type? = csharpAssembly.GetType("Corpus.Issue4675.RecordBase", throwOnError: true)
        let translatedBase Type? = gsharpAssembly.GetType("Corpus.Issue4675.RecordBase", throwOnError: true)
        let baselineRecordClass Type? = csharpAssembly.GetType("Corpus.Issue4675.RecordClass", throwOnError: true)
        let translatedClassType Type? = gsharpAssembly.GetType("Corpus.Issue4675.RecordClass", throwOnError: true)
        let baselineEquals MethodInfo? = typeof(IEquatable[_]).MakeGenericType(baselineBase!!).GetMethod("Equals")
        let translatedEquals MethodInfo? = typeof(IEquatable[_]).MakeGenericType(translatedBase!!).GetMethod("Equals")
        for value in[]int32{42, 43} {
            let expected object? = baselineEquals!!.Invoke(
                Activator.CreateInstance(baselineRecordClass!!, []object{42}),
                []object{Activator.CreateInstance(baselineRecordClass!!, []object{value})}
            )
            Assert.Equal(value == 42, expected)
            let actual object? = translatedEquals!!.Invoke(
                Activator.CreateInstance(translatedClassType!!, []object{42}),
                []object{Activator.CreateInstance(translatedClassType!!, []object{value})}
            )
            Assert.Equal(expected, actual)
        }
        let baselineGenericBase = csharpAssembly.GetType(
            "Corpus.Issue4675.GenericBase`1",
            throwOnError: true
        )!!.MakeGenericType(typeof(int32))
        let translatedGenericBase = gsharpAssembly.GetType(
            "Corpus.Issue4675.GenericBase`1",
            throwOnError: true
        )!!.MakeGenericType(typeof(int32))
        let baselineChild Type? = csharpAssembly.GetType("Corpus.Issue4675.GenericChild", throwOnError: true)
        let translatedChild Type? = gsharpAssembly.GetType("Corpus.Issue4675.GenericChild", throwOnError: true)
        let expectedLeft object? = Activator.CreateInstance(baselineChild!!, []object{42})
        let expectedRight object? = Activator.CreateInstance(baselineChild!!, []object{42})
        let actualLeft object? = Activator.CreateInstance(translatedChild!!, []object{42})
        let actualRight object? = Activator.CreateInstance(translatedChild!!, []object{42})
        baselineGenericBase.GetProperty("BaseValue")!!.SetValue(expectedRight, 2)
        translatedGenericBase.GetProperty("BaseValue")!!.SetValue(actualRight, 2)
        let expectedEquality object? = typeof(IEquatable[_]).MakeGenericType(baselineGenericBase).GetMethod(
            "Equals"
        )!!.Invoke(expectedLeft, []object{expectedRight})
        Assert.Equal(false, expectedEquality)
        let actualEquality object? = typeof(IEquatable[_]).MakeGenericType(translatedGenericBase).GetMethod(
            "Equals"
        )!!.Invoke(actualLeft, []object{actualRight})
        Assert.Equal(expectedEquality, actualEquality)
    }

    @Fact
    func SynthesizedRecordAndSealedOverrideMetadata_MatchesRoslyn() {
        const source = `namespace Corpus.Issue4828;
public abstract record Base(int Value);
public sealed record Leaf(int Value) : Base(Value);
public sealed record Body
{
    public int Value { get; }
    public Body(int value) { Value = value; }
}
public abstract class Parent
{
    public virtual string Render() => "base";
}
public sealed class Child : Parent
{
    public override string Render() => "child";
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Issue4828.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        TranslationTestValidation.AssertBinds(translated)
        using let csharpImage = MemoryStream()
        Assert.True(project.Compilation.Emit(csharpImage).Success)
        using let gsharpImage = MemoryStream()
        let compilation = GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(translated))){IsLibrary = true}
        Assert.True(compilation.Emit(gsharpImage, nil, nil, "Issue4828Translated").Success)
        let baseline = Assembly.Load(csharpImage.ToArray())
        let migrated = Assembly.Load(gsharpImage.ToArray())
        let baselineBase Type? = baseline.GetType("Corpus.Issue4828.Base", throwOnError: true)
        let migratedBase Type? = migrated.GetType("Corpus.Issue4828.Base", throwOnError: true)
        Assert.Equal(
            baselineBase!!
                .GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .Select(ConstructorContract)
                .OrderBy((value string) -> value, StringComparer.Ordinal),
            migratedBase!!
                .GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .Select(ConstructorContract)
                .OrderBy((value string) -> value, StringComparer.Ordinal)
        )
        Assert.Equal(
            "original",
            Assert
                .Single(
                baselineBase!!.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic),
                (ctor ConstructorInfo) -> ctor.GetParameters() is [{ParameterType: var type}] && type == baselineBase
            )
                .GetParameters()[0]
                .Name
        )
        Assert.Equal(
            "original",
            Assert
                .Single(
                migratedBase!!.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic),
                (ctor ConstructorInfo) -> ctor.GetParameters() is [{ParameterType: var type}] && type == migratedBase
            )
                .GetParameters()[0]
                .Name
        )
        let baselineLeaf Type? = baseline.GetType("Corpus.Issue4828.Leaf", throwOnError: true)
        let migratedLeaf Type? = migrated.GetType("Corpus.Issue4828.Leaf", throwOnError: true)
        Assert.Equal(
            baselineLeaf!!
                .GetConstructors()
                .Select(ConstructorContract)
                .OrderBy((value string) -> value, StringComparer.Ordinal),
            migratedLeaf!!
                .GetConstructors()
                .Select(ConstructorContract)
                .OrderBy((value string) -> value, StringComparer.Ordinal)
        )
        for name in[]string{"op_Equality", "op_Inequality"} {
            Assert.Equal(
                baselineLeaf!!.GetMethod(name)!!.GetParameters().Select((parameter ParameterInfo) -> parameter.Name),
                migratedLeaf!!.GetMethod(name)!!.GetParameters().Select((parameter ParameterInfo) -> parameter.Name)
            )
        }
        for name in[]string{"Equals", "GetHashCode", "ToString"} {
            let expected = baselineLeaf!!.GetMethods(
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
            )
                .Single(
                (method MethodInfo) -> method.Name == name &&
                    (
                    name != "Equals" || method.GetParameters()
                        .Length == 1 &&
                        method
                        .GetParameters()[0]
                        .ParameterType == typeof(object)
                )
            )
            let actual = migratedLeaf!!.GetMethods(
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
            )
                .Single(
                (method MethodInfo) -> method.Name == name &&
                    (
                    name != "Equals" || method.GetParameters()
                        .Length == 1 &&
                        method
                        .GetParameters()[0]
                        .ParameterType == typeof(object)
                )
            )
            Assert.Equal(expected.IsFinal, actual.IsFinal)
        }
        // ADR-0199 item 4: a body-only record keeps G#'s own Deconstruct once the
        // provenance marker is gone; C# synthesizes none. This is the one ABI
        // difference, listed in the Core public-API allowance.
        Assert.Null(baseline.GetType("Corpus.Issue4828.Body", throwOnError: true)!!.GetMethod("Deconstruct"))
        Assert.NotNull(migrated.GetType("Corpus.Issue4828.Body", throwOnError: true)!!.GetMethod("Deconstruct"))
        Assert.Equal(
            baseline.GetType("Corpus.Issue4828.Child", throwOnError: true)!!.GetMethod("Render")!!.IsFinal,
            migrated.GetType("Corpus.Issue4828.Child", throwOnError: true)!!.GetMethod("Render")!!.IsFinal
        )
    }

    @Fact
    func AuthoredCSharpRecordAttribute_IsPreserved() {
        const source = `namespace Corpus.Issue4828;
public sealed class CSharpRecordAttribute : System.Attribute { }
[CSharpRecord]
public record Item(int Value);`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Issue4828.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("@CSharpRecord", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("Cs2GsRecordProvenance", translated, StringComparison.Ordinal)
        using let image = MemoryStream()
        let compilation = GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(translated))){IsLibrary = true}
        let emit = compilation.Emit(image, nil, nil, "Issue4828AuthoredAttribute")
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        let item Type? = Assembly.Load(image.ToArray()).GetType("Corpus.Issue4828.Item", throwOnError: true)
        Assert.Contains(
            item!!.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "Corpus.Issue4828.CSharpRecordAttribute"
        )
    }

    @Theory
    @InlineData("P")
    @InlineData("this.P")
    func InitializedGetOnlyRecordProperty_ConstructorWritesTargetBackingField(target string) {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Record.cs", `public record Item(int N) {
    public int P { get; } = 1;
    public Item() : this(0) { TARGET = 2; }
    public static int Run() => new Item().P;
}`.Replace("TARGET", target, StringComparison.Ordinal))})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let result = EmittedOracle.Evaluate(translated + "\nItem.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func CharArrayRecordPrinting_MatchesCSharpBaseline() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("ArrayRecord.cs", `public record Item(char[] Value) {
    public static string Run() {
        var builder = new System.Text.StringBuilder();
        new Item(new[] { 'a', 'b' }).PrintMembers(builder);
        return builder.ToString();
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let baselineImage = MemoryStream()
        Assert.True(project.Compilation.Emit(baselineImage).Success)
        let baseline = Assembly.Load(baselineImage.ToArray())
        let expected object? = baseline.GetType("Item", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)
        Assert.Equal("Value = System.Char[]", expected)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let result = EmittedOracle.Evaluate(translated + "\nItem.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func DelegateRecordPrinting_MatchesCSharpBaseline() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("CallbackRecord.cs", `namespace Corpus.Issue4675 {
public interface IKey { }
public record Item(System.Func<IKey, bool> Callback) {
    public System.Func<int, bool>? Optional => null;
    public static string Run() {
        var builder = new System.Text.StringBuilder();
        new Item(x => true).PrintMembers(builder);
        return builder.ToString();
    }
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let baselineImage = MemoryStream()
        Assert.True(project.Compilation.Emit(baselineImage).Success)
        let expected object? = Assembly.Load(baselineImage.ToArray()).GetType(
            "Corpus.Issue4675.Item",
            throwOnError: true
        )!!.GetMethod("Run")!!.Invoke(nil, nil)
        Assert.NotNull(expected)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let result = EmittedOracle.Evaluate(translated + "\nCorpus.Issue4675.Item.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func RefLikeRecordPrinting_MatchesCSharpBaseline() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("SpanRecord.cs", `public record Item(int N) {
    public System.ReadOnlySpan<int> Values => new[] { N };
    public static string Run() {
        var builder = new System.Text.StringBuilder();
        new Item(1).PrintMembers(builder);
        return builder.ToString();
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let baselineImage = MemoryStream()
        Assert.True(project.Compilation.Emit(baselineImage).Success)
        let expected object? = Assembly.Load(baselineImage.ToArray()).GetType("Item", throwOnError: true)!!.GetMethod(
            "Run"
        )!!.Invoke(nil, nil)
        Assert.NotNull(expected)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let result = EmittedOracle.Evaluate(translated + "\nItem.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func PartialRecordPrintMembers_IsNotTranslated() {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                ("First.cs", "namespace Corpus; public partial record Item(int Value);"),
                ("Second.cs", "namespace Corpus; public partial record Item { public int Extra => 7; }")
            }
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let translated = project
            .Documents
            .Select(
            (document LoadedDocument) -> {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            }
        )
            .ToArray()
        Assert.Equal(
            0,
            translated.Sum((text string) -> text.Split("func PrintMembers(", StringSplitOptions.None).Length - 1)
        )
        TranslationTestValidation.AssertBinds(translated)
    }

    @Theory
    @InlineData("public virtual", "CS8875")
    @InlineData("private", "CS8875")
    @InlineData("protected", "CS8872")
    func InvalidRecordPrintMembersShape_IsRejectedByCSharp(modifiers string, diagnosticId string) {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (
                    "Invalid.cs",
                    "public record Item { $modifiers bool PrintMembers(System.Text.StringBuilder builder) => false; }"
                )
            }
        )
        Assert.False(project.BoundWithoutErrors)
        Assert.Contains(
            project.ErrorDiagnostics,
            (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Id == diagnosticId
        )
    }

    @Fact
    func TranslatedCoreRecordAbi_MatchesCSharpSourceApi() {
        let repoRoot = TestFixtureSource.Root
        let paths[]string = []string{
            "src/Core/CodeAnalysis/OptionalValue.cs",
            "src/Core/CodeAnalysis/SymbolInfo.cs",
            "src/Core/CodeAnalysis/TypeInfo.cs",
            "src/Core/CodeAnalysis/Binding/BoundBodyCacheKey.cs",
            "src/Core/CodeAnalysis/Documentation/DocInline.cs",
            "src/Core/CodeAnalysis/Documentation/DocumentationComment.cs"
        }
        let sources = paths.Select(
            (path string) -> (Path: path, Source: File.ReadAllText(Path.Combine(repoRoot, path)))
        )
            .ToArray()
        let references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(typeof(GSharpCompilation).Assembly.Location))
            .ToArray()
        let project = CSharpProjectLoader.LoadInMemory(
            sources.Select((source(Path string, Source string)) -> (source.Item1, source.Item2)).ToArray(),
            references,
            assemblyName: "Issue4675CoreCSharpBaseline"
        )
        Assert.True(
            project.BoundWithoutErrors,
            "Core C# baseline sources should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let translatedSources = project
            .Documents
            .Select(
            (document LoadedDocument) -> {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            }
        )
            .ToArray()
        TranslationTestValidation.AssertBinds(translatedSources)
        using let csharpImage = MemoryStream()
        Assert.True(project.Compilation.Emit(csharpImage).Success, "Core C# baseline should emit.")
        using let gsharpImage = MemoryStream()
        let gsharpCompilation = GSharpCompilation(
            translatedSources.Select((source string) -> GSharpSyntaxTree.Parse(SourceText.From(source))).ToArray()
        ){IsLibrary = true}
        let gsharpEmit = gsharpCompilation.Emit(
            gsharpImage,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue4675TranslatedCoreRecords"
        )
        Assert.True(
            gsharpEmit.Success,
            string.Join(
                Environment.NewLine,
                gsharpEmit.Diagnostics.Select(
                    (
                        diagnostic GSharp.Core.CodeAnalysis.Diagnostic
                    ) -> "${diagnostic.Id} ${diagnostic.Location}: ${diagnostic.Message}"
                )
            )
        )
        let csharpAssembly = Assembly.Load(csharpImage.ToArray())
        let gsharpAssembly = Assembly.Load(gsharpImage.ToArray())
        for typeName in[]string{
            "GSharp.Core.CodeAnalysis.OptionalValue",
            "GSharp.Core.CodeAnalysis.SymbolInfo",
            "GSharp.Core.CodeAnalysis.TypeInfo",
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey"
        } {
            AssertRecordInterface(csharpAssembly, gsharpAssembly, typeName)
        }
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "GSharp.Core.CodeAnalysis.Documentation.DocInline")
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "GSharp.Core.CodeAnalysis.Documentation.DocInline")
        AssertCopyConstructor(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Documentation.DocInline",
            isProtected: true
        )
        AssertCopyConstructor(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Documentation.DocInline+UnknownXmlElement",
            isProtected: false
        )
        AssertGetOnlyProperty(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            "BodyHash"
        )
        AssertGetOnlyProperty(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            "StableMemberId"
        )
        let baselineKeyType Type? = csharpAssembly.GetType(
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            throwOnError: true
        )
        let translatedKeyType Type? = gsharpAssembly.GetType(
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            throwOnError: true
        )
        let baselineKeyConstructor = Assert.Single(
            baselineKeyType!!.GetConstructors(),
            (constructor ConstructorInfo) -> constructor.GetParameters().Length == 2
        )
        let translatedKeyConstructor = Assert.Single(
            translatedKeyType!!.GetConstructors(),
            (constructor ConstructorInfo) -> constructor.GetParameters().Length == 2
        )
        let baselineKey = baselineKeyConstructor.Invoke([]object? {nil, nil})
        let translatedKey = translatedKeyConstructor.Invoke([]object? {nil, nil})
        for propertyName in[]string{"StableMemberId", "BodyHash"} {
            Assert.True(
                object.Equals(
                    baselineKeyType!!.GetProperty(propertyName)!!.GetValue(baselineKey),
                    translatedKeyType!!.GetProperty(propertyName)!!.GetValue(translatedKey)
                ),
                propertyName + " initializer mismatch."
            )
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CoreRecordAbi_RejectsUnavailableConfiguredSource(rootExists bool) {
        let root = Path.Combine(AppContext.BaseDirectory, "issue4675-source-" + Guid.NewGuid().ToString("N"))
        let previous string? = Environment.GetEnvironmentVariable("CS2GS_TEST_SOURCE_ROOT")
        if rootExists {
            Directory.CreateDirectory(Path.Combine(root, "src", "Core", "CodeAnalysis"))
        }
        try {
            Environment.SetEnvironmentVariable("CS2GS_TEST_SOURCE_ROOT", root)
            if rootExists {
                let error = Assert.Throws[FileNotFoundException](
                    () -> this.TranslatedCoreRecordAbi_MatchesCSharpSourceApi()
                )
                Assert.Contains(root, error.FileName, StringComparison.Ordinal)
            } else {
                let error = Assert.Throws[DirectoryNotFoundException](
                    () -> this.TranslatedCoreRecordAbi_MatchesCSharpSourceApi()
                )
                Assert.Contains(root, error.Message, StringComparison.Ordinal)
            }
        } finally {
            Environment.SetEnvironmentVariable("CS2GS_TEST_SOURCE_ROOT", previous)
            if rootExists {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    shared {
        private func VerifyExplicitPositionalProperty(
            source string,
            name string,
            expected int32
        ) -> VerifyExplicitPositionalProperty([](string, source string){("Item.cs", source)}, name, expected)

        private func VerifyExplicitPositionalProperty(
            sources[](Name string, Source string),
            name string,
            expected int32
        ) {
            let project = CSharpProjectLoader.LoadInMemory(sources)
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let root = Path.Combine(AppContext.BaseDirectory, "record-property-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            try {
                let baselinePath = Path.Combine(root, "Baseline.dll")
                {
                    using let output = File.Create(baselinePath)
                    Assert.True(
                        project
                            .Compilation
                            .WithAssemblyName("Baseline" + Guid.NewGuid().ToString("N"))
                            .Emit(output)
                            .Success
                    )
                }
                let baseline = Assembly.LoadFile(baselinePath)
                let original Type? = baseline.GetType("PositionalProperty.Item", throwOnError: true)
                Assert.Equal(expected, original!!.GetMethod("Run")!!.Invoke(nil, nil))
                Assert.Equal(sources.Length, project.Documents.Count)
                let sourcePaths = project
                    .Documents
                    .Select(
                    (document LoadedDocument, index int32) -> {
                        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                        let translated = GSharpPrinter.Print(
                            CSharpToGSharpTranslator().TranslateDocument(document, context)
                        )
                        let sourcePath = Path.Combine(root, "Translated" + index.ToString() + ".gs")
                        File.WriteAllText(
                            sourcePath,
                            translated +
                                (
                                if index == 0 {
                                    `
func Main() { System.Console.WriteLine(Item.Run()) }
`
                                } else {
                                    ""
                                }
                            )
                        )
                        return sourcePath
                    }
                )
                    .ToArray()
                let dll = Path.Combine(root, "Translated.dll")
                let compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
                Assert.True(File.Exists(compiler), compiler)
                let compile = ProcessRunner.Run(
                    "dotnet",
                    []string{
                        compiler,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + baselinePath,
                        "/out:" + dll
                    }
                        .Concat(sourcePaths).ToArray()
                )
                Assert.True(compile.ExitCode == 0, compile.Output)
                Assert.True(File.Exists(dll), compile.Output)
                let repo = GsharpTestProjectRunner.FindRepoRoot()!!
                Assert.NotNull(repo)
                let runtime string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                let verifierArguments = []string{
                    "tool",
                    "run",
                    "ilverify",
                    "--",
                    dll,
                    "-s",
                    "System.Private.CoreLib",
                    "-r",
                    baselinePath
                }
                    .Concat(
                    Directory.EnumerateFiles(runtime!!, "*.dll").SelectMany(
                        func (path string) IEnumerable[string] {
                            return []string{"-r", path}
                        }
                    )
                )
                    .ToArray()
                let verified = ProcessRunner.Run("dotnet", verifierArguments, repo)
                Assert.True(verified.ExitCode == 0, verified.Output)
                File.WriteAllText(
                    Path.ChangeExtension(dll, ".runtimeconfig.json"),
                    JsonSerializer.Serialize(
                        AnonymousType1_A67B097F50EFCF6E(
                            AnonymousType2_50E665486F88DBC4(
                                "net10.0",
                                AnonymousType2_F068C7BBDCE9746D("Microsoft.NETCore.App", Environment.Version.ToString())
                            )
                        )
                    )
                )
                let run = ProcessRunner.Run("dotnet", []string{dll})
                Assert.Equal(0, run.ExitCode)
                Assert.Equal(expected.ToString() + "\n", run.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal))
                let migrated Type? = Assembly.LoadFile(dll).GetType("PositionalProperty.Item", throwOnError: true)
                let originalSetter MethodInfo? = original!!.GetProperty(name)!!.SetMethod
                let migratedSetter MethodInfo? = migrated!!.GetProperty(name)!!.SetMethod
                if originalSetter == nil {
                    Assert.Null(migratedSetter)
                } else {
                    Assert.NotNull(migratedSetter)
                    Assert.Equal(originalSetter.IsPrivate, migratedSetter!!.IsPrivate)
                    Assert.Equal(originalSetter.IsPublic, migratedSetter!!.IsPublic)
                    Assert.Equal(
                        originalSetter
                            .ReturnParameter
                            .GetRequiredCustomModifiers()
                            .Select((type Type) -> type.FullName),
                        migratedSetter!!
                            .ReturnParameter
                            .GetRequiredCustomModifiers()
                            .Select((type Type) -> type.FullName)
                    )
                }
            } finally {
                Directory.Delete(root, recursive: true)
            }
        }

        private const Source string = `
namespace Corpus.Issue4675
{
    public record RecordBase(int BaseValue)
    {
        public string Render()
        {
            var builder = new System.Text.StringBuilder();
            PrintMembers(builder);
            return builder.ToString();
        }
    }

    public record RecordClass(int Value) : RecordBase(1)
    {
        public string BodyHash { get; } = "hash";
    }

    public sealed record SealedRecord(int Value);

    public sealed record SealedDerivedRecord(int Other) : RecordBase(1);

    public readonly record struct RecordStruct(int Value);

    public record GenericRecord<T>(T Value);

    public record GenericDerivedRecord<T>(T Value) : RecordBase(1);

    public record GenericBase<T>(T BaseValue);

    public record GenericChild(int Own) : GenericBase<int>(1);

    public readonly record struct GenericRecordStruct<T>(T Value);

    public record RefOverloadedPrintMembers(int Value)
    {
        public bool PrintMembers(ref System.Text.StringBuilder builder) => false;
    }

    public record CustomPrintMembers(int Value)
    {
        protected virtual bool PrintMembers(System.Text.StringBuilder builder)
        {
            builder.Append("custom");
            return true;
        }
    }

    public record DerivedCustomPrintMembers(int Other) : CustomPrintMembers(1);

    public record OverloadedPrintMembers(int Value)
    {
        public bool PrintMembers(int ignored) => false;
    }
}`

        private func AssertRecordInterface(baseline Assembly, translated Assembly, typeName string) {
            var baselineType Type? = baseline.GetType(typeName, throwOnError: true)
            var translatedType Type? = translated.GetType(typeName, throwOnError: true)
            if baselineType!!.IsGenericTypeDefinition {
                baselineType = baselineType!!.MakeGenericType(typeof(int32))
                translatedType = translatedType!!.MakeGenericType(typeof(int32))
            }
            Assert.Contains(typeof(IEquatable[_]).MakeGenericType(baselineType!!), baselineType!!.GetInterfaces())
            Assert.Contains(typeof(IEquatable[_]).MakeGenericType(translatedType!!), translatedType!!.GetInterfaces())
            let baselineEquals MethodInfo? = baselineType!!.GetMethod("Equals", []Type{baselineType!!})
            let translatedEquals MethodInfo? = translatedType!!.GetMethod("Equals", []Type{translatedType!!})
            Assert.NotNull(baselineEquals)
            Assert.NotNull(translatedEquals)
            Assert.Equal(
                baselineEquals!!.Attributes & MethodAttributes.MemberAccessMask,
                translatedEquals!!.Attributes & MethodAttributes.MemberAccessMask
            )
            Assert.Equal(baselineEquals!!.IsVirtual, translatedEquals!!.IsVirtual)
            Assert.Equal(baselineEquals!!.IsFinal, translatedEquals!!.IsFinal)
            if !baseline.GetType(typeName, throwOnError: true)!!.IsGenericTypeDefinition {
                return
            }
            let constructor = Assert.Single(
                translatedType!!.GetConstructors(),
                (candidate ConstructorInfo) -> candidate.GetParameters() is [{ParameterType: var parameterType}] &&
                    parameterType == typeof(int32)
            )
            let left = constructor.Invoke([]object{42})
            let equal = constructor.Invoke([]object{42})
            let different = constructor.Invoke([]object{43})
            let interfaceEquals MethodInfo? = typeof(IEquatable[_]).MakeGenericType(translatedType!!).GetMethod(
                "Equals"
            )
            Assert.Equal(true, interfaceEquals!!.Invoke(left, []object{equal}))
            Assert.Equal(false, interfaceEquals!!.Invoke(left, []object{different}))
        }

        private func ConstructorContract(constructor ConstructorInfo) string -> string.Join(
            "|",
            constructor.Attributes,
            string.Join(
                ";",
                constructor.GetParameters().Select(
                    (
                        parameter ParameterInfo
                    ) -> "${parameter.Name}:${parameter.ParameterType.FullName}:${parameter.Attributes}"
                )
            )
        )

        private func AssertPrintMembers(baseline Assembly, translated Assembly, typeName string) {
            let baselineType Type? = baseline.GetType(typeName, throwOnError: true)
            let translatedType Type? = translated.GetType(typeName, throwOnError: true)
            let baselineMethod MethodInfo? = baselineType!!.GetMethod(
                "PrintMembers",
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            )
            let translatedMethod MethodInfo? = translatedType!!.GetMethod(
                "PrintMembers",
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            )
            Assert.NotNull(baselineMethod)
            Assert.NotNull(translatedMethod)
            Assert.Equal(
                baselineMethod!!.Attributes & MethodAttributes.MemberAccessMask,
                translatedMethod!!.Attributes & MethodAttributes.MemberAccessMask
            )
            Assert.Equal(baselineMethod!!.IsVirtual, translatedMethod!!.IsVirtual)
            Assert.Equal(baselineMethod!!.IsFinal, translatedMethod!!.IsFinal)
            Assert.Equal(baselineMethod!!.ReturnType, translatedMethod!!.ReturnType)
            Assert.Equal(
                baselineMethod!!.GetParameters().Select((parameter ParameterInfo) -> parameter.ParameterType),
                translatedMethod!!.GetParameters().Select((parameter ParameterInfo) -> parameter.ParameterType)
            )
        }

        private func AssertCopyConstructor(baseline Assembly, translated Assembly, typeName string, isProtected bool) {
            let baselineType Type? = baseline.GetType(typeName, throwOnError: true)
            let translatedType Type? = translated.GetType(typeName, throwOnError: true)
            let baselineCopy = Assert.Single(
                baselineType!!.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                (ctor ConstructorInfo) -> ctor.GetParameters() is [{ParameterType: var parameterType}] &&
                    parameterType == baselineType
            )
            let translatedCopy = Assert.Single(
                translatedType!!.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                (ctor ConstructorInfo) -> ctor.GetParameters() is [{ParameterType: var parameterType}] &&
                    parameterType == translatedType
            )
            Assert.Equal(isProtected, baselineCopy.IsFamily)
            Assert.Equal(isProtected, translatedCopy.IsFamily)
            Assert.Equal(baselineCopy.IsPrivate, translatedCopy.IsPrivate)
        }

        private func AssertPrintMembersOutput(baseline Assembly, translated Assembly, typeName string) {
            let baselineType Type? = baseline.GetType(typeName, throwOnError: true)
            let translatedType Type? = translated.GetType(typeName, throwOnError: true)
            let baselineBuilder = StringBuilder()
            let translatedBuilder = StringBuilder()
            const flags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            let baselineResult object? = baselineType!!.GetMethod("PrintMembers", flags)!!.Invoke(
                Activator.CreateInstance(baselineType!!, []object{42}),
                []object{baselineBuilder}
            )
            let translatedResult object? = translatedType!!.GetMethod("PrintMembers", flags)!!.Invoke(
                Activator.CreateInstance(translatedType!!, []object{42}),
                []object{translatedBuilder}
            )
            Assert.Equal(baselineResult, translatedResult)
            Assert.Equal(baselineBuilder.ToString(), translatedBuilder.ToString())
        }

        private func AssertGetOnlyProperty(
            baseline Assembly,
            translated Assembly,
            typeName string,
            propertyName string,
            message string? = nil
        ) {
            let baselineType Type? = baseline.GetType(typeName, throwOnError: true)
            let translatedType Type? = translated.GetType(typeName, throwOnError: true)
            let baselineProperty PropertyInfo? = baselineType!!.GetProperty(propertyName)
            let translatedProperty PropertyInfo? = translatedType!!.GetProperty(propertyName)
            Assert.NotNull(baselineProperty)
            Assert.NotNull(translatedProperty)
            Assert.Null(baselineProperty!!.SetMethod)
            Assert.True(translatedProperty!!.SetMethod == nil, message)
            Assert.Equal(baselineProperty!!.PropertyType, translatedProperty!!.PropertyType)
        }

        private func AssertInitProperty(baseline Assembly, translated Assembly, typeName string, propertyName string) {
            let baselineType Type? = baseline.GetType(typeName, throwOnError: true)
            let translatedType Type? = translated.GetType(typeName, throwOnError: true)
            let baselineSetter MethodInfo? = baselineType!!.GetProperty(propertyName)!!.SetMethod
            let translatedSetter MethodInfo? = translatedType!!.GetProperty(propertyName)!!.SetMethod
            Assert.NotNull(baselineSetter)
            Assert.NotNull(translatedSetter)
            Assert.Equal(
                baselineSetter!!.ReturnParameter.GetRequiredCustomModifiers(),
                translatedSetter!!.ReturnParameter.GetRequiredCustomModifiers()
            )
        }
    }
}

internal data class AnonymousType2_F068C7BBDCE9746D(name string, version string) { }

internal data class AnonymousType2_50E665486F88DBC4(tfm string, framework AnonymousType2_F068C7BBDCE9746D) { }

internal data class AnonymousType1_A67B097F50EFCF6E(runtimeOptions AnonymousType2_50E665486F88DBC4) { }
