// <copyright file="Issue4816SelfMigrationNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

class Issue4816SelfMigrationNullabilityTests {
    @Theory
    @InlineData(NullableContextOptions(0))
    func NullableLocals_PreserveMaybeNullRuntimeValues(nullableContext NullableContextOptions) {
        let tree = CSharpSyntaxTree.ParseText(`using System;
using System.IO;

#nullable disable
public static class Fixture
{
    private static string ReadMaybeNull() => null;
    private static void Accept(string value) { }

    public static void Run()
    {
        string evidence = Environment.GetEnvironmentVariable("GSHARP_EVIDENCE");
        if (!string.IsNullOrEmpty(evidence))
        {
            _ = Path.Combine(evidence, "result");
        }

        string current = "/";
        string parent = Path.GetDirectoryName(current);
        if (string.IsNullOrEmpty(parent))
        {
            _ = parent;
        }
        _ = Path.GetFullPath(Path.GetDirectoryName(current));

        string promoted = ReadMaybeNull();
        if (string.IsNullOrEmpty(promoted))
        {
            _ = promoted;
        }

        string asserted = ReadMaybeNull()!;
        Accept(asserted);
    }
}`, path: "Fixture.cs")
        let compilation = CSharpCompilation.Create(
            "Issue4816.NullableLocals",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(nullableContext)
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument(tree.FilePath, tree, model)
        let context = TranslationContext(compilation, model, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains(
            "let evidence string? = Environment.GetEnvironmentVariable(\"GSHARP_EVIDENCE\")",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("let parent string? = Path.GetDirectoryName(current)", rendered, StringComparison.Ordinal)
        Assert.Contains("let promoted string? = ReadMaybeNull()", rendered, StringComparison.Ordinal)
        Assert.Contains("Path.GetFullPath(Path.GetDirectoryName(current)!!)", rendered, StringComparison.Ordinal)
        Assert.Contains("let asserted string? = ReadMaybeNull()!!", rendered, StringComparison.Ordinal)
        Assert.Contains("Accept(asserted!!)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ObliviousReads_KeepTheirNonNullUseSitesWhenSelfMigrated() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Fixture.cs", `#nullable disable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

public static class Fixture
{
    private static string Accept(string value) => value;
    private static Node Merge(Node left, Node right) => left;
    private static Node MergeParents(Node left, Node right) =>
        left.Parent != null && right.Parent != null
            ? Merge(left.Parent, right.Parent)
            : left.Parent;
    private static string[] Values() =>
        new[] { typeof(string) }.Select(type => type.FullName).ToArray();

    public static void Run(string[] values, MethodInfo[][] methods, bool include)
    {
        _ = Accept(values[0]);
        var projected = Values();
        _ = Accept(projected[0]);
        _ = Accept(projected.Single());
        _ = Accept(Enumerable.Single(projected));
        _ = Accept(projected.ToString());
        _ = Accept(projected.Aggregate("seed", (acc, _) => acc));
        string[] explicitProjected = Values();
        _ = Accept(explicitProjected[0]);
        _ = methods[0].Select(method => method.Name).ToArray();
        _ = typeof(string).GetProperty("Length").GetValue("x").ToString();
        _ = Convert.ToString(1);
        _ = new { Name = "fixed" };
        _ = new { Name = typeof(string).FullName };
        _ = new { Values = Values() };
        _ = new { Cast = (object)"fixed" as string };
        _ = new { Cast = (string)null };
        string maybe = null;
        var nullableShape = new { Value = maybe };
        var nonNullableShape = new { Value = "fixed" };
        nullableShape = nonNullableShape;
        string path = typeof(string).FullName;
        _ = new { Path = path };
        _ = new { Emitted = include ? new { Path = "fixed" } : null };
        string evidence = Environment.GetEnvironmentVariable("GSHARP_EVIDENCE");
        if (!string.IsNullOrEmpty(evidence))
        {
            _ = Path.Combine(evidence, "result");
        }
        string current = "/";
        string parent = Path.GetDirectoryName(current);
        if (string.IsNullOrEmpty(parent))
        {
            _ = parent;
        }
    }

    private sealed class Node
    {
        public Node Parent { get; }
    }
}

public class Outer<T>
{
    public class Inner
    {
        private readonly T value;
        public Inner(T value) => this.value = value;
        public T Get() => value;
        public T[] GetValues() => new[] { value };
    }
}

#nullable enable
public static class AnnotatedFixture
{
    public static object Nullable(string? value, string?[] values) =>
        new { Name = value, Values = values };
    public static object NonNull(string value, string[] values) =>
        new { Name = value, Values = values };
    public static object DefaultValue(bool include) =>
        new { Count = include ? default : 1 };
    public static int MergedContractRead(string? maybe)
    {
        var nullableShape = new { Value = maybe };
        var nonNullableShape = new { Value = "fixed" };
        nullableShape = nonNullableShape;
        return nonNullableShape.Value.Length;
    }
    public static bool MergedContractNullObservation(string? maybe)
    {
        var nonNullableShape = new { Value = "fixed" };
        var nullableShape = new { Value = maybe };
        nonNullableShape = nullableShape;
        return nonNullableShape.Value == null;
    }
    public static object MergedDelegateContract(
        Func<string?> nullableFactory,
        Func<string> nonNullableFactory)
    {
        var nullableShape = new { Factory = nullableFactory };
        var nonNullableShape = new { Factory = nonNullableFactory };
        nullableShape = nonNullableShape;
        return nullableShape;
    }
    public static int MergedContainingContract(
        Outer<string>.Inner nonNullable,
        Outer<string?>.Inner nullable)
    {
        var nonNullableShape = new { Value = nonNullable };
        var nullableShape = new { Value = nullable };
        nonNullableShape = nullableShape;
        return nonNullableShape.Value.GetValues()[0].Length;
    }
    public static int MergedArrayElementRead(
        string[] nonNullable,
        string?[] nullable)
    {
        var nonNullableShape = new { Values = nonNullable };
        var nullableShape = new { Values = nullable };
        nonNullableShape = nullableShape;
        return nonNullableShape.Values[0].Length;
    }
    public static int MergedGenericElementRead(
        List<string> nonNullable,
        List<string?> nullable)
    {
        var nonNullableShape = new { Values = nonNullable };
        var nullableShape = new { Values = nullable };
        nonNullableShape = nullableShape;
        return nonNullableShape.Values[0].Length;
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.DoesNotContain("(nil as string)!!", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Convert!!", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("projected.ToString()!!", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("projected.Aggregate(\"seed\", (acc, _) -> acc)!!", rendered, StringComparison.Ordinal)
        Assert.Contains(
            "let evidence string? = Environment.GetEnvironmentVariable(\"GSHARP_EVIDENCE\")",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("let parent string? = Path.GetDirectoryName(current)", rendered, StringComparison.Ordinal)
        Assert.Equal(
            "private func Merge(left Node, right Node) Node -> left",
            rendered.Split('\n').Single((line string) -> line.Contains("func Merge(", StringComparison.Ordinal)).Trim()
        )
        Assert.DoesNotContain("Merge(left Node?, right Node?)", rendered, StringComparison.Ordinal)
        Assert.Contains("nonNullableShape.Value!!.Length", rendered, StringComparison.Ordinal)
        Assert.Contains("nonNullableShape.Value == nil", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("nonNullableShape.Value!! == nil", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ProjectedArrayReturn_UsesTheCallingDocumentLocation() {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Producer.cs", "#nullable disable\n" + String(' ', 500) + `using System;
using System.Linq;
public static class Producer
{
    public static string[] Values() =>
        new[] { typeof(string) }.Select(type => type.FullName).ToArray();
}`), ("Consumer.cs", `#nullable disable
public static class Consumer
{
    public static int Read() => Producer.Values()[0].Length;
}`)}
        )
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        let producer = project.Documents.Single(
            (candidate LoadedDocument) -> candidate.FilePath.EndsWith("Producer.cs", StringComparison.Ordinal)
        )
        let producerContext = TranslationContext(project.Compilation, producer.SemanticModel, producer.FilePath)
        let producerRendered = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(producer, producerContext)
        )
        let document = project.Documents.Single(
            (candidate LoadedDocument) -> candidate.FilePath.EndsWith("Consumer.cs", StringComparison.Ordinal)
        )
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("Producer.Values()[0]!!.Length", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(producerRendered, rendered)
    }

    @Fact
    func NullableRecordEnvelope_DoesNotWidenStoredMembers() {
        let library = CSharpCompilation.Create("Issue4816.Options", []SyntaxTree{CSharpSyntaxTree.ParseText(`#nullable disable
public sealed class Options
{
    public string SourceRoot { get; set; }
    public string OutputRoot { get; set; }
}`)}, CSharpProjectLoader.RuntimeReferences(), CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
        using let image = MemoryStream()
        let emit = library.Emit(image)
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics))
        let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromImage(image.ToArray()))
            .ToList()
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Fixture.cs", `#nullable disable
public readonly record struct Arguments(Options Options, string Path);

public static class Fixture
{
    private static Arguments? Parse()
    {
        var options = new Options();
        _ = options == null;
        return new(options, null);
    }

    public static void Run()
    {
        Arguments? parsed = Parse();
        if (parsed == null)
        {
            return;
        }

        var (options, _) = parsed.Value;
        options.SourceRoot = "source";
    }
}`)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            []CSharpCompilation{project.Compilation, library},
            []CSharpCompilation{project.Compilation, library}
        )
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("Options Options", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Options Options?", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ImportedGenericSubstitution_PreservesNullableValueContract() {
        let library = CSharpCompilation.Create("Issue4816.Imported", []SyntaxTree{CSharpSyntaxTree.ParseText(`#nullable enable
namespace Issue4816Imported
{
    public sealed class Box<T>
    {
        public T Value { get; }
        public Box(T value) => Value = value;
    }
    public static class Factory
    {
        public static Box<string?> Create() => new(null);
        public static string? NullableField;
        public static string? NullableProperty { get; }
        public static string NonNullField = "field";
        public static string NonNullProperty { get; } = "property";
        public static int Accept(string value) => value.Length;
    }
}`)}, CSharpProjectLoader.RuntimeReferences(), CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-4816-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let libraryPath = Path.Combine(root, "Issue4816.Imported.dll")
            let emit = library.Emit(libraryPath)
            Assert.True(emit.Success, string.Join("\n", emit.Diagnostics))
            let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
                .RuntimeReferences()
                .Append(MetadataReference.CreateFromFile(libraryPath))
                .ToList()
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Consumer.cs", `#nullable disable
using Issue4816Imported;
public static class Consumer
{
    public static int Read() => Factory.Create().Value.Length;
    public static int ReadField() => Factory.Accept(Factory.NullableField);
    public static int ReadProperty() => Factory.Accept(Factory.NullableProperty);
    public static int ReadNonNullField() => Factory.Accept(Factory.NonNullField);
    public static int ReadNonNullProperty() => Factory.Accept(Factory.NonNullProperty);
}`)}, references)
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.Contains("Factory.Create().Value!!.Length", rendered, StringComparison.Ordinal)
            Assert.Contains("Factory.Accept(Factory.NullableField!!)", rendered, StringComparison.Ordinal)
            Assert.Contains("Factory.Accept(Factory.NullableProperty!!)", rendered, StringComparison.Ordinal)
            Assert.Contains("Factory.Accept(Factory.NonNullField)", rendered, StringComparison.Ordinal)
            Assert.Contains("Factory.Accept(Factory.NonNullProperty)", rendered, StringComparison.Ordinal)
            Assert.DoesNotContain("Factory.NonNullField!!", rendered, StringComparison.Ordinal)
            Assert.DoesNotContain("Factory.NonNullProperty!!", rendered, StringComparison.Ordinal)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            TranslationTestValidation.AssertBinds(resolver, rendered)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }
}
