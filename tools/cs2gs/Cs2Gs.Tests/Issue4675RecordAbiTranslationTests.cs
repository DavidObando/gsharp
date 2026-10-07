// <copyright file="Issue4675RecordAbiTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;
using GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4675: translated record API metadata must match Roslyn's C#
/// baseline for the same source.
/// </summary>
public sealed class Issue4675RecordAbiTranslationTests
{
    [Theory]
    [InlineData("record", "", " = Seed(Value)", 21)]
    [InlineData("record", "private", " = Seed(Value)", 21)]
    [InlineData("record struct", "", " = Seed(Value)", 21)]
    [InlineData("record struct", "private", " = Seed(Value)", 21)]
    [InlineData("record", "", "", 0)]
    [InlineData("record struct", "", "", 0)]
    [InlineData("record", "", " = Value", 10)]
    [InlineData("record struct", "", " = Value", 10)]
    [InlineData("record", "private", " = Value", 10)]
    [InlineData("record struct", "private", " = Value", 10)]
    public void ExplicitPositionalProperty_PreservesRuntimeAndAccessorMetadata(
        string kind, string accessorVisibility, string initializer, int expected)
    {
        var source = $$"""
            namespace PositionalProperty {
                public {{kind}} Item(int Value) {
                    public int Value { get; {{accessorVisibility}} init; }{{initializer}}{{(initializer.Length == 0 ? "" : ";")}}
                    private static int Calls;
                    private static int Seed(int value) { Calls++; return value + 1; }
                    public static int Run() => new Item(1).Value * 10 + Calls;
                }
            }
            """;
        VerifyExplicitPositionalProperty(source, "Value", expected);
    }

    [Theory]
    [InlineData("record", "package", "", false, 0)]
    [InlineData("record struct", "package", "", false, 0)]
    [InlineData("record", "package", " = package", false, 7)]
    [InlineData("record struct", "package", " = package", false, 7)]
    [InlineData("record", "Value", " = null", true, 0)]
    [InlineData("record struct", "Value", " = null", true, 0)]
    [InlineData("record", "package", " = null", true, 0)]
    [InlineData("record struct", "package", " = null", true, 0)]
    [InlineData("record", "Value", " = Value", true, 1)]
    [InlineData("record struct", "Value", " = Value", true, 1)]
    [InlineData("record", "Value", "", true, 0)]
    [InlineData("record struct", "Value", "", true, 0)]
    public void ExplicitPositionalProperty_EscapedAndNullableStorage_PreservesBaseline(
        string kind, string name, string initializer, bool nullable, int expected)
    {
        var source = $$"""
            #nullable enable
            namespace PositionalProperty {
                public {{kind}} Item({{(nullable ? "string?" : "int")}} {{name}}) {
                    public {{(nullable ? "string?" : "int")}} {{name}} { get; init; }{{initializer}}{{(initializer.Length == 0 ? "" : ";")}}
                    public static int Run() => {{(nullable ? "new Item(\"input\")." + name + " is null ? 0 : 1" : "new Item(7)." + name)}};
                }
            }
            """;
        VerifyExplicitPositionalProperty(source, name, expected);
    }

    private static void VerifyExplicitPositionalProperty(string source, string name, int expected)
        => VerifyExplicitPositionalProperty(new[] { ("Item.cs", source) }, name, expected);

    [Fact]
    public void NullableNormalizingPositionalGetter_MatchesRoslyn()
    {
        VerifyExplicitPositionalProperty("""
            #nullable enable
            namespace PositionalProperty {
                public record Item(string? Value) {
                    public string Value { get; } = Value ?? "";
                    public static int Run() => new Item((string?)null).Value.Length;
                }
            }
            """, "Value", 0);
    }

    [Fact]
    public void NullableNormalizingAbstractPositionalGetter_MatchesRoslyn()
    {
        VerifyExplicitPositionalProperty("""
            #nullable enable
            namespace PositionalProperty {
                public abstract record Item(string? Input) {
                    public abstract string Input { get; }
                    public static int Run() => new Leaf(null).Input.Length;
                }
                public sealed record Leaf(string? Value) : Item(Value) {
                    public override string Input { get; } = Value ?? "";
                }
            }
            """, "Input", 0);
    }

    [Theory]
    [InlineData(" = 42", 42)]
    [InlineData(" = Seed()", 7)]
    [InlineData("", 0)]
    public void NonPositionalGetterOnlyProperty_PreservesRoslynAbi(string initializer, int expected)
    {
        VerifyExplicitPositionalProperty($$"""
            namespace PositionalProperty {
                public record Item {
                    private static int Seed() => 7;
                    public int Value { get; }{{initializer}}{{(initializer.Length == 0 ? "" : ";")}}
                    public static int Run() => new Item().Value;
                }
            }
            """, "Value", expected);
    }

    [Fact]
    public void MutableStructFieldPrintMembers_MatchesRoslynReceiverSemantics()
    {
        const string source = """
            namespace PrintMembersMutation {
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
            }
            """;
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Item.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        using var baselineImage = new MemoryStream();
        Assert.True(project.Compilation.WithAssemblyName("PrintMembersMutationBaseline").Emit(baselineImage).Success);
        var baseline = Assembly.Load(baselineImage.ToArray());
        var expected = baseline.GetType("PrintMembersMutation.Probe", throwOnError: true)
            .GetMethod("Run").Invoke(null, null);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        using var translatedImage = new MemoryStream();
        var compilation = new GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(translated)))
        {
            IsLibrary = true,
        };
        var emit = compilation.Emit(
            translatedImage,
            pdbStream: null,
            refStream: null,
            assemblyName: "PrintMembersMutationTranslated");
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        var actual = Assembly.Load(translatedImage.ToArray())
            .GetType("PrintMembersMutation.Probe", throwOnError: true)
            .GetMethod("Run").Invoke(null, null);
        Assert.Equal(expected, actual);
        Assert.Equal("Value = 1|Value = 2|2;Value = 1|Value = 2|2", actual);
    }

    [Fact]
    public void HiddenBaseFieldPrintMembers_MatchesRoslynMemberSelection()
    {
        const string source = """
            namespace PrintMembersHiding {
                public record Base {
                    public int Value = 1;
                }
                public record Derived : Base {
                    public new int Value => 2;
                }
            }
            """;
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Item.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        using var baselineImage = new MemoryStream();
        Assert.True(project.Compilation.WithAssemblyName("PrintMembersHidingBaseline").Emit(baselineImage).Success);
        var baseline = Assembly.Load(baselineImage.ToArray());

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        using var translatedImage = new MemoryStream();
        var compilation = new GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(translated)))
        {
            IsLibrary = true,
        };
        var emit = compilation.Emit(
            translatedImage,
            pdbStream: null,
            refStream: null,
            assemblyName: "PrintMembersHidingTranslated");
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        var migrated = Assembly.Load(translatedImage.ToArray());
        static string Render(Assembly assembly)
        {
            var type = assembly.GetType("PrintMembersHiding.Derived", throwOnError: true);
            var instance = Activator.CreateInstance(type);
            var builder = new System.Text.StringBuilder();
            type.GetMethod("PrintMembers", BindingFlags.Instance | BindingFlags.NonPublic)
                .Invoke(instance, new object[] { builder });
            return builder.ToString();
        }

        var expected = Render(baseline);
        var actual = Render(migrated);
        Assert.Equal(expected, actual);
        Assert.Equal("Value = 1, Value = 2", actual);
    }

    [Fact]
    public void ExplicitAbstractPrintMembers_IsNotSynthesizedTwice()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Item.cs", """
                public abstract record Item {
                    protected abstract bool PrintMembers(System.Text.StringBuilder builder);
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Equal(1, translated.Split("func PrintMembers(", StringSplitOptions.None).Length - 1);
        Assert.True(TranslationTestValidation.AssertBinds(translated).Success, translated);
    }

    [Theory]
    [InlineData("record", "Value", "", false, false, false, 0)]
    [InlineData("record struct", "Value", "", false, false, false, 0)]
    [InlineData("record", "package", "", false, false, false, 0)]
    [InlineData("record struct", "package", "", false, false, false, 0)]
    [InlineData("record", "Value", " = Value", false, false, false, 7)]
    [InlineData("record struct", "Value", " = Value", false, false, false, 7)]
    [InlineData("record", "Value", "", false, true, true, 0)]
    [InlineData("record struct", "Value", "", false, true, true, 0)]
    [InlineData("record", "package", "", false, true, true, 0)]
    [InlineData("record struct", "package", "", false, true, true, 0)]
    [InlineData("record", "Value", "", false, true, false, 0)]
    [InlineData("record struct", "Value", "", false, true, false, 0)]
    [InlineData("record", "Value", " = null", true, true, true, 0)]
    [InlineData("record struct", "Value", " = null", true, true, true, 0)]
    [InlineData("record", "Value", " = Value", false, true, true, 7)]
    [InlineData("record struct", "Value", " = Value", false, true, true, 7)]
    public void ExplicitPositionalProperty_PartialAndGetOnlyStorage_PreservesBaseline(
        string kind, string name, string initializer, bool nullable, bool split, bool hasSetter, int expected)
    {
        var source = $$"""
            #nullable enable
            namespace PositionalProperty {
                public {{(split ? "partial " : "")}}{{kind}} Item{{(split ? "" : "(" + (nullable ? "string?" : "int") + " " + name + ")")}} {
                    public {{(nullable ? "string?" : "int")}} {{name}} { get; {{(hasSetter ? "init;" : "")}} }{{initializer}}{{(initializer.Length == 0 ? "" : ";")}}
                    public static int Run() => {{(nullable ? "new Item(\"input\")." + name + " is null ? 0 : 1" : "new Item(7)." + name)}};
                }
            }
            """;
        var sources = split
            ? new[]
            {
                ("Header.cs", $$"""
                    #nullable enable
                    namespace PositionalProperty {
                        public partial {{kind}} Item({{(nullable ? "string?" : "int")}} {{name}});
                    }
                    """),
                ("Item.cs", source),
            }
            : new[] { ("Item.cs", source) };
        VerifyExplicitPositionalProperty(sources, name, expected);
    }

    private static void VerifyExplicitPositionalProperty((string Name, string Source)[] sources, string name, int expected)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        string root = Path.Combine(AppContext.BaseDirectory, "record-property-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string baselinePath = Path.Combine(root, "Baseline.dll");
            using (var output = File.Create(baselinePath))
            {
                Assert.True(project.Compilation.WithAssemblyName("Baseline" + Guid.NewGuid().ToString("N")).Emit(output).Success);
            }

            Assembly baseline = Assembly.LoadFile(baselinePath);
            Type original = baseline.GetType("PositionalProperty.Item", throwOnError: true);
            Assert.Equal(expected, original.GetMethod("Run").Invoke(null, null));
            Assert.Equal(sources.Length, project.Documents.Count);
            var sourcePaths = project.Documents.Select((document, index) =>
            {
                var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
                string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
                string sourcePath = Path.Combine(root, "Translated" + index + ".gs");
                File.WriteAllText(sourcePath, translated + (index == 0 ? "\nfunc Main() { System.Console.WriteLine(Item.Run()) }\n" : ""));
                return sourcePath;
            }).ToArray();
            string dll = Path.Combine(root, "Translated.dll");
            string compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"));
            Assert.True(File.Exists(compiler), compiler);
            var compile = ProcessRunner.Run("dotnet", new[]
            {
                compiler, "/target:exe", "/targetframework:net10.0",
                "/reference:" + baselinePath, "/out:" + dll,
            }.Concat(sourcePaths).ToArray());
            Assert.True(compile.ExitCode == 0, compile.Output);
            Assert.True(File.Exists(dll), compile.Output);
            string repo = GsharpTestProjectRunner.FindRepoRoot();
            Assert.NotNull(repo);
            string runtime = Path.GetDirectoryName(typeof(object).Assembly.Location);
            var verifierArguments = new[] { "tool", "run", "ilverify", "--", dll, "-s", "System.Private.CoreLib", "-r", baselinePath }
                .Concat(Directory.EnumerateFiles(runtime, "*.dll").SelectMany(path => new[] { "-r", path })).ToArray();
            var verified = ProcessRunner.Run("dotnet", verifierArguments, repo);
            Assert.True(verified.ExitCode == 0, verified.Output);
            File.WriteAllText(Path.ChangeExtension(dll, ".runtimeconfig.json"), System.Text.Json.JsonSerializer.Serialize(new
            {
                runtimeOptions = new
                {
                    tfm = "net10.0",
                    framework = new { name = "Microsoft.NETCore.App", version = Environment.Version.ToString() },
                },
            }));
            var run = ProcessRunner.Run("dotnet", new[] { dll });
            Assert.Equal(0, run.ExitCode);
            Assert.Equal(expected + "\n", run.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal));
            Type migrated = Assembly.LoadFile(dll).GetType("PositionalProperty.Item", throwOnError: true);
            MethodInfo originalSetter = original.GetProperty(name).SetMethod;
            MethodInfo migratedSetter = migrated.GetProperty(name).SetMethod;
            if (originalSetter == null)
            {
                Assert.Null(migratedSetter);
            }
            else
            {
                Assert.NotNull(migratedSetter);
                Assert.Equal(originalSetter.IsPrivate, migratedSetter.IsPrivate);
                Assert.Equal(originalSetter.IsPublic, migratedSetter.IsPublic);
                Assert.Equal(
                    originalSetter.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName),
                    migratedSetter.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName));
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private const string Source = @"
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
        public string BodyHash { get; } = ""hash"";
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
            builder.Append(""custom"");
            return true;
        }
    }

    public record DerivedCustomPrintMembers(int Other) : CustomPrintMembers(1);

    public record OverloadedPrintMembers(int Value)
    {
        public bool PrintMembers(int ignored) => false;
    }
}";

    [Fact]
    public void TranslatedRecordAbi_MatchesCSharpCompilerSurface()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Issue4675.cs", Source) });
        Assert.True(
            project.BoundWithoutErrors,
            "C# baseline should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        INamedTypeSymbol baselineClass = project.Compilation.GetTypeByMetadataName("Corpus.Issue4675.RecordClass");
        IMethodSymbol baselinePrintMembers = Assert.Single(
            baselineClass.GetMembers("PrintMembers").OfType<IMethodSymbol>());
        Assert.Equal(Accessibility.Protected, baselinePrintMembers.DeclaredAccessibility);
        Assert.True(baselinePrintMembers.IsVirtual || baselinePrintMembers.IsOverride);
        Assert.Equal("System.Text.StringBuilder", baselinePrintMembers.Parameters[0].Type.ToDisplayString());
        Assert.Contains(
            baselineClass.AllInterfaces,
            iface => iface.OriginalDefinition.ToDisplayString() == "System.IEquatable<T>");

        IPropertySymbol baselineProperty = Assert.Single(
            baselineClass.GetMembers("BodyHash").OfType<IPropertySymbol>());
        Assert.Null(baselineProperty.SetMethod);

        INamedTypeSymbol baselineStruct = project.Compilation.GetTypeByMetadataName("Corpus.Issue4675.RecordStruct");
        Assert.Contains(
            baselineStruct.AllInterfaces,
            iface => iface.OriginalDefinition.ToDisplayString() == "System.IEquatable<T>");

        INamedTypeSymbol baselineOverloaded = project.Compilation.GetTypeByMetadataName("Corpus.Issue4675.OverloadedPrintMembers");
        Assert.Contains(
            baselineOverloaded.GetMembers("PrintMembers").OfType<IMethodSymbol>(),
            method => method.IsImplicitlyDeclared
                && method.Parameters.Length == 1
                && method.Parameters[0].Type.ToDisplayString() == "System.Text.StringBuilder");

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string translated = GSharpPrinter.Print(unit);
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(translated);
        Assert.True(
            roundTrip.Success,
            "Translated record should bind:\n" + string.Join(Environment.NewLine, roundTrip.Errors) + "\n" + translated);

        TypeDeclaration translatedClass = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "RecordClass");
        MethodDeclaration translatedPrintMembers = Assert.Single(
            translatedClass.Members.OfType<MethodDeclaration>(),
            method => method.Name == "PrintMembers");
        Assert.Equal(Visibility.Protected, translatedPrintMembers.Visibility);
        Assert.True(translatedPrintMembers.IsOpen);
        Assert.Contains("BodyHash", translated);
        Assert.DoesNotContain("BodyHash string { get; init; }", translated, StringComparison.Ordinal);

        TypeDeclaration translatedStruct = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "RecordStruct");
        Assert.Contains(
            translatedStruct.Interfaces,
            iface => iface is NamedTypeReference named && named.Name.Contains("IEquatable", StringComparison.Ordinal));
        TypeDeclaration translatedOverloaded = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "OverloadedPrintMembers");
        Assert.Equal(
            2,
            translatedOverloaded.Members.OfType<MethodDeclaration>().Count(method => method.Name == "PrintMembers"));

        using var csharpImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(csharpImage).Success, "C# baseline should emit.");
        using var gsharpImage = new MemoryStream();
        var gsharpCompilation = new GSharpCompilation(
            GSharpSyntaxTree.Parse(SourceText.From(translated)))
        {
            IsLibrary = true,
        };
        var gsharpEmit = gsharpCompilation.Emit(
            gsharpImage,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue4675Translated");
        Assert.True(gsharpEmit.Success, string.Join(Environment.NewLine, gsharpEmit.Diagnostics));

        Assembly csharpAssembly = Assembly.Load(csharpImage.ToArray());
        Assembly gsharpAssembly = Assembly.Load(gsharpImage.ToArray());
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedRecord");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordStruct");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedDerivedRecord");
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase", isProtected: true);
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", isProtected: true);
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedRecord", isProtected: false);
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedDerivedRecord", isProtected: false);
        Assert.True(gsharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true).IsSealed);
        AssertGetOnlyProperty(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", "BodyHash");
        AssertInitProperty(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", "Value");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.OverloadedPrintMembers");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RefOverloadedPrintMembers");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.CustomPrintMembers");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericRecord`1");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericDerivedRecord`1");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericRecordStruct`1");
        foreach (string typeName in new[]
        {
            "Corpus.Issue4675.RecordBase",
            "Corpus.Issue4675.RecordClass",
            "Corpus.Issue4675.DerivedCustomPrintMembers",
            "Corpus.Issue4675.SealedDerivedRecord",
        })
        {
            AssertPrintMembersOutput(csharpAssembly, gsharpAssembly, typeName);
        }

        object baselineDerived = Activator.CreateInstance(
            csharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true), new object[] { 42 });
        object translatedDerived = Activator.CreateInstance(
            gsharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true), new object[] { 42 });
        object baselineRender = csharpAssembly.GetType("Corpus.Issue4675.RecordBase", throwOnError: true)
            .GetMethod("Render").Invoke(baselineDerived, null);
        object translatedRender = gsharpAssembly.GetType("Corpus.Issue4675.RecordBase", throwOnError: true)
            .GetMethod("Render").Invoke(translatedDerived, null);
        Assert.Equal(baselineRender, translatedRender);
        Type baselineBase = csharpAssembly.GetType("Corpus.Issue4675.RecordBase", throwOnError: true);
        Type translatedBase = gsharpAssembly.GetType("Corpus.Issue4675.RecordBase", throwOnError: true);
        Type baselineRecordClass = csharpAssembly.GetType("Corpus.Issue4675.RecordClass", throwOnError: true);
        Type translatedClassType = gsharpAssembly.GetType("Corpus.Issue4675.RecordClass", throwOnError: true);
        MethodInfo baselineEquals = typeof(IEquatable<>).MakeGenericType(baselineBase).GetMethod("Equals");
        MethodInfo translatedEquals = typeof(IEquatable<>).MakeGenericType(translatedBase).GetMethod("Equals");
        foreach (int value in new[] { 42, 43 })
        {
            object expected = baselineEquals.Invoke(
                Activator.CreateInstance(baselineRecordClass, new object[] { 42 }),
                new[] { Activator.CreateInstance(baselineRecordClass, new object[] { value }) });
            Assert.Equal(value == 42, expected);
            object actual = translatedEquals.Invoke(
                Activator.CreateInstance(translatedClassType, new object[] { 42 }),
                new[] { Activator.CreateInstance(translatedClassType, new object[] { value }) });
            Assert.Equal(expected, actual);
        }

        Type baselineGenericBase = csharpAssembly.GetType("Corpus.Issue4675.GenericBase`1", throwOnError: true).MakeGenericType(typeof(int));
        Type translatedGenericBase = gsharpAssembly.GetType("Corpus.Issue4675.GenericBase`1", throwOnError: true).MakeGenericType(typeof(int));
        Type baselineChild = csharpAssembly.GetType("Corpus.Issue4675.GenericChild", throwOnError: true);
        Type translatedChild = gsharpAssembly.GetType("Corpus.Issue4675.GenericChild", throwOnError: true);
        object expectedLeft = Activator.CreateInstance(baselineChild, new object[] { 42 });
        object expectedRight = Activator.CreateInstance(baselineChild, new object[] { 42 });
        object actualLeft = Activator.CreateInstance(translatedChild, new object[] { 42 });
        object actualRight = Activator.CreateInstance(translatedChild, new object[] { 42 });
        baselineGenericBase.GetProperty("BaseValue").SetValue(expectedRight, 2);
        translatedGenericBase.GetProperty("BaseValue").SetValue(actualRight, 2);
        object expectedEquality = typeof(IEquatable<>).MakeGenericType(baselineGenericBase).GetMethod("Equals")
            .Invoke(expectedLeft, new[] { expectedRight });
        Assert.Equal(false, expectedEquality);
        object actualEquality = typeof(IEquatable<>).MakeGenericType(translatedGenericBase).GetMethod("Equals")
            .Invoke(actualLeft, new[] { actualRight });
        Assert.Equal(expectedEquality, actualEquality);
    }

    [Fact]
    public void SynthesizedRecordAndSealedOverrideMetadata_MatchesRoslyn()
    {
        const string source = """
            namespace Corpus.Issue4828;
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
            }
            """;
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Issue4828.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        TranslationTestValidation.AssertBinds(translated);

        using var csharpImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(csharpImage).Success);
        using var gsharpImage = new MemoryStream();
        var compilation = new GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(translated)))
        {
            IsLibrary = true,
        };
        Assert.True(compilation.Emit(gsharpImage, null, null, "Issue4828Translated").Success);
        Assembly baseline = Assembly.Load(csharpImage.ToArray());
        Assembly migrated = Assembly.Load(gsharpImage.ToArray());

        Type baselineBase = baseline.GetType("Corpus.Issue4828.Base", throwOnError: true);
        Type migratedBase = migrated.GetType("Corpus.Issue4828.Base", throwOnError: true);
        Assert.Equal(
            "original",
            Assert.Single(baselineBase.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic),
                ctor => ctor.GetParameters() is [{ ParameterType: var type }] && type == baselineBase)
                .GetParameters()[0].Name);
        Assert.Equal(
            "original",
            Assert.Single(migratedBase.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic),
                ctor => ctor.GetParameters() is [{ ParameterType: var type }] && type == migratedBase)
                .GetParameters()[0].Name);

        Type baselineLeaf = baseline.GetType("Corpus.Issue4828.Leaf", throwOnError: true);
        Type migratedLeaf = migrated.GetType("Corpus.Issue4828.Leaf", throwOnError: true);
        Assert.Equal(
            baselineLeaf.GetConstructors().Select(ConstructorContract).OrderBy(value => value, StringComparer.Ordinal),
            migratedLeaf.GetConstructors().Select(ConstructorContract).OrderBy(value => value, StringComparer.Ordinal));
        foreach (string name in new[] { "op_Equality", "op_Inequality" })
        {
            Assert.Equal(
                baselineLeaf.GetMethod(name).GetParameters().Select(parameter => parameter.Name),
                migratedLeaf.GetMethod(name).GetParameters().Select(parameter => parameter.Name));
        }

        foreach (string name in new[] { "Equals", "GetHashCode", "ToString" })
        {
            MethodInfo expected = baselineLeaf.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                .Single(method => method.Name == name && (name != "Equals" || method.GetParameters().Length == 1
                    && method.GetParameters()[0].ParameterType == typeof(object)));
            MethodInfo actual = migratedLeaf.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                .Single(method => method.Name == name && (name != "Equals" || method.GetParameters().Length == 1
                    && method.GetParameters()[0].ParameterType == typeof(object)));
            Assert.Equal(expected.IsFinal, actual.IsFinal);
        }

        Assert.Equal(
            baseline.GetType("Corpus.Issue4828.Body", throwOnError: true).GetMethod("Deconstruct"),
            migrated.GetType("Corpus.Issue4828.Body", throwOnError: true).GetMethod("Deconstruct"));
        Assert.Equal(
            baseline.GetType("Corpus.Issue4828.Child", throwOnError: true).GetMethod("Render").IsFinal,
            migrated.GetType("Corpus.Issue4828.Child", throwOnError: true).GetMethod("Render").IsFinal);
    }

    [Theory]
    [InlineData("P")]
    [InlineData("this.P")]
    public void InitializedGetOnlyRecordProperty_ConstructorWritesTargetBackingField(string target)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Record.cs", """
                public record Item(int N) {
                    public int P { get; } = 1;
                    public Item() : this(0) { TARGET = 2; }
                    public static int Run() => new Item().P;
                }
                """.Replace("TARGET", target, StringComparison.Ordinal)),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        var result = EmittedOracle.Evaluate(translated + "\nItem.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void CharArrayRecordPrinting_MatchesCSharpBaseline()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("ArrayRecord.cs", """
                public record Item(char[] Value) {
                    public static string Run() {
                        var builder = new System.Text.StringBuilder();
                        new Item(new[] { 'a', 'b' }).PrintMembers(builder);
                        return builder.ToString();
                    }
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        using var baselineImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(baselineImage).Success);
        Assembly baseline = Assembly.Load(baselineImage.ToArray());
        object expected = baseline.GetType("Item", throwOnError: true).GetMethod("Run").Invoke(null, null);
        Assert.Equal("Value = System.Char[]", expected);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        var result = EmittedOracle.Evaluate(translated + "\nItem.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void DelegateRecordPrinting_MatchesCSharpBaseline()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("CallbackRecord.cs", """
                namespace Corpus.Issue4675 {
                public interface IKey { }
                public record Item(System.Func<IKey, bool> Callback) {
                    public System.Func<int, bool>? Optional => null;
                    public static string Run() {
                        var builder = new System.Text.StringBuilder();
                        new Item(x => true).PrintMembers(builder);
                        return builder.ToString();
                    }
                    }
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        using var baselineImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(baselineImage).Success);
        object expected = Assembly.Load(baselineImage.ToArray()).GetType("Corpus.Issue4675.Item", throwOnError: true)
            .GetMethod("Run").Invoke(null, null);
        Assert.NotNull(expected);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        var result = EmittedOracle.Evaluate(translated + "\nCorpus.Issue4675.Item.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void RefLikeRecordPrinting_MatchesCSharpBaseline()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("SpanRecord.cs", """
                public record Item(int N) {
                    public System.ReadOnlySpan<int> Values => new[] { N };
                    public static string Run() {
                        var builder = new System.Text.StringBuilder();
                        new Item(1).PrintMembers(builder);
                        return builder.ToString();
                    }
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        using var baselineImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(baselineImage).Success);
        object expected = Assembly.Load(baselineImage.ToArray()).GetType("Item", throwOnError: true)
            .GetMethod("Run").Invoke(null, null);
        Assert.NotNull(expected);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        var result = EmittedOracle.Evaluate(translated + "\nItem.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void PartialRecordPrintMembers_IsEmittedOnce()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("First.cs", "namespace Corpus; public partial record Item(int Value);"),
            ("Second.cs", "namespace Corpus; public partial record Item { public int Extra => 7; }"),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        string[] translated = project.Documents.Select(document =>
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        }).ToArray();
        Assert.Equal(1, translated.Sum(text => text.Split("func PrintMembers(", StringSplitOptions.None).Length - 1));
        TranslationTestValidation.AssertBinds(translated);
    }

    [Theory]
    [InlineData("public virtual", "CS8875")]
    [InlineData("private", "CS8875")]
    [InlineData("protected", "CS8872")]
    public void InvalidRecordPrintMembersShape_IsRejectedByCSharp(string modifiers, string diagnosticId)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Invalid.cs", $"public record Item {{ {modifiers} bool PrintMembers(System.Text.StringBuilder builder) => false; }}"),
        });
        Assert.False(project.BoundWithoutErrors);
        Assert.Contains(project.ErrorDiagnostics, diagnostic => diagnostic.Id == diagnosticId);
    }

    [Fact]
    public void TranslatedCoreRecordAbi_MatchesCSharpSourceApi()
    {
        string repoRoot = TestFixtureSource.Root;
        string[] paths =
        {
            "src/Core/CodeAnalysis/OptionalValue.cs",
            "src/Core/CodeAnalysis/SymbolInfo.cs",
            "src/Core/CodeAnalysis/TypeInfo.cs",
            "src/Core/CodeAnalysis/Binding/BoundBodyCacheKey.cs",
            "src/Core/CodeAnalysis/Documentation/DocInline.cs",
            "src/Core/CodeAnalysis/Documentation/DocumentationComment.cs",
        };
        var sources = paths
            .Select(path => (Path: path, Source: File.ReadAllText(Path.Combine(repoRoot, path))))
            .ToArray();
        var references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(typeof(GSharpCompilation).Assembly.Location))
            .ToArray();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            sources.Select(source => (source.Path, source.Source)).ToArray(),
            references,
            assemblyName: "Issue4675CoreCSharpBaseline");
        Assert.True(
            project.BoundWithoutErrors,
            "Core C# baseline sources should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        string[] translatedSources = project.Documents
            .Select(document =>
            {
                var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
                return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            })
            .ToArray();
        TranslationTestValidation.AssertBinds(translatedSources);

        using var csharpImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(csharpImage).Success, "Core C# baseline should emit.");
        using var gsharpImage = new MemoryStream();
        var gsharpCompilation = new GSharpCompilation(
            translatedSources.Select(source => GSharpSyntaxTree.Parse(SourceText.From(source))).ToArray())
        {
            IsLibrary = true,
        };
        var gsharpEmit = gsharpCompilation.Emit(
            gsharpImage,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue4675TranslatedCoreRecords");
        Assert.True(
            gsharpEmit.Success,
            string.Join(
                Environment.NewLine,
                gsharpEmit.Diagnostics.Select(diagnostic => $"{diagnostic.Id} {diagnostic.Location}: {diagnostic.Message}")));

        Assembly csharpAssembly = Assembly.Load(csharpImage.ToArray());
        Assembly gsharpAssembly = Assembly.Load(gsharpImage.ToArray());
        foreach (string typeName in new[]
        {
            "GSharp.Core.CodeAnalysis.OptionalValue",
            "GSharp.Core.CodeAnalysis.SymbolInfo",
            "GSharp.Core.CodeAnalysis.TypeInfo",
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
        })
        {
            AssertRecordInterface(csharpAssembly, gsharpAssembly, typeName);
        }

        AssertRecordInterface(csharpAssembly, gsharpAssembly, "GSharp.Core.CodeAnalysis.Documentation.DocInline");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "GSharp.Core.CodeAnalysis.Documentation.DocInline");
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "GSharp.Core.CodeAnalysis.Documentation.DocInline", isProtected: true);
        AssertCopyConstructor(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Documentation.DocInline+UnknownXmlElement",
            isProtected: false);
        AssertGetOnlyProperty(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            "BodyHash");
        AssertGetOnlyProperty(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            "StableMemberId");

        Type baselineKeyType = csharpAssembly.GetType(
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            throwOnError: true);
        Type translatedKeyType = gsharpAssembly.GetType(
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            throwOnError: true);
        ConstructorInfo baselineKeyConstructor = Assert.Single(
            baselineKeyType.GetConstructors(),
            constructor => constructor.GetParameters().Length == 2);
        ConstructorInfo translatedKeyConstructor = Assert.Single(
            translatedKeyType.GetConstructors(),
            constructor => constructor.GetParameters().Length == 2);
        object baselineKey = baselineKeyConstructor.Invoke(new object[] { null, null });
        object translatedKey = translatedKeyConstructor.Invoke(new object[] { null, null });
        foreach (string propertyName in new[] { "StableMemberId", "BodyHash" })
        {
            Assert.True(
                Equals(
                    baselineKeyType.GetProperty(propertyName).GetValue(baselineKey),
                    translatedKeyType.GetProperty(propertyName).GetValue(translatedKey)),
                propertyName + " initializer mismatch.");
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CoreRecordAbi_RejectsUnavailableConfiguredSource(bool rootExists)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "issue4675-source-" + Guid.NewGuid().ToString("N"));
        string previous = Environment.GetEnvironmentVariable("CS2GS_TEST_SOURCE_ROOT");
        if (rootExists)
        {
            Directory.CreateDirectory(Path.Combine(root, "src", "Core", "CodeAnalysis"));
        }

        try
        {
            Environment.SetEnvironmentVariable("CS2GS_TEST_SOURCE_ROOT", root);
            if (rootExists)
            {
                FileNotFoundException error = Assert.Throws<FileNotFoundException>(
                    () => this.TranslatedCoreRecordAbi_MatchesCSharpSourceApi());
                Assert.Contains(root, error.FileName, StringComparison.Ordinal);
            }
            else
            {
                DirectoryNotFoundException error = Assert.Throws<DirectoryNotFoundException>(
                    () => this.TranslatedCoreRecordAbi_MatchesCSharpSourceApi());
                Assert.Contains(root, error.Message, StringComparison.Ordinal);
            }
        }
        finally
        {
            Environment.SetEnvironmentVariable("CS2GS_TEST_SOURCE_ROOT", previous);
            if (rootExists)
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    private static void AssertRecordInterface(Assembly baseline, Assembly translated, string typeName)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        if (baselineType.IsGenericTypeDefinition)
        {
            baselineType = baselineType.MakeGenericType(typeof(int));
            translatedType = translatedType.MakeGenericType(typeof(int));
        }

        Assert.Contains(typeof(IEquatable<>).MakeGenericType(baselineType), baselineType.GetInterfaces());
        Assert.Contains(typeof(IEquatable<>).MakeGenericType(translatedType), translatedType.GetInterfaces());

        MethodInfo baselineEquals = baselineType.GetMethod("Equals", new[] { baselineType });
        MethodInfo translatedEquals = translatedType.GetMethod("Equals", new[] { translatedType });
        Assert.NotNull(baselineEquals);
        Assert.NotNull(translatedEquals);
        Assert.Equal(baselineEquals.Attributes & MethodAttributes.MemberAccessMask, translatedEquals.Attributes & MethodAttributes.MemberAccessMask);
        Assert.Equal(baselineEquals.IsVirtual, translatedEquals.IsVirtual);
        Assert.Equal(baselineEquals.IsFinal, translatedEquals.IsFinal);
        if (!baseline.GetType(typeName, throwOnError: true).IsGenericTypeDefinition)
        {
            return;
        }

        ConstructorInfo constructor = Assert.Single(
            translatedType.GetConstructors(),
            candidate => candidate.GetParameters() is [{ ParameterType: var parameterType }] && parameterType == typeof(int));
        object left = constructor.Invoke(new object[] { 42 });
        object equal = constructor.Invoke(new object[] { 42 });
        object different = constructor.Invoke(new object[] { 43 });
        MethodInfo interfaceEquals = typeof(IEquatable<>).MakeGenericType(translatedType).GetMethod("Equals");
        Assert.Equal(true, interfaceEquals.Invoke(left, new[] { equal }));
        Assert.Equal(false, interfaceEquals.Invoke(left, new[] { different }));
    }

    private static string ConstructorContract(ConstructorInfo constructor) =>
        string.Join(
            "|",
            constructor.Attributes,
            string.Join(
                ";",
                constructor.GetParameters().Select(parameter =>
                    $"{parameter.Name}:{parameter.ParameterType.FullName}:{parameter.Attributes}")));

    private static void AssertPrintMembers(Assembly baseline, Assembly translated, string typeName)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        MethodInfo baselineMethod = baselineType.GetMethod(
            "PrintMembers",
            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        MethodInfo translatedMethod = translatedType.GetMethod(
            "PrintMembers",
            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);

        Assert.NotNull(baselineMethod);
        Assert.NotNull(translatedMethod);
        Assert.Equal(baselineMethod.Attributes & MethodAttributes.MemberAccessMask, translatedMethod.Attributes & MethodAttributes.MemberAccessMask);
        Assert.Equal(baselineMethod.IsVirtual, translatedMethod.IsVirtual);
        Assert.Equal(baselineMethod.IsFinal, translatedMethod.IsFinal);
        Assert.Equal(baselineMethod.ReturnType, translatedMethod.ReturnType);
        Assert.Equal(
            baselineMethod.GetParameters().Select(parameter => parameter.ParameterType),
            translatedMethod.GetParameters().Select(parameter => parameter.ParameterType));
    }

    private static void AssertCopyConstructor(Assembly baseline, Assembly translated, string typeName, bool isProtected)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        ConstructorInfo baselineCopy = Assert.Single(
            baselineType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
            ctor => ctor.GetParameters() is [{ ParameterType: var parameterType }] && parameterType == baselineType);
        ConstructorInfo translatedCopy = Assert.Single(
            translatedType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
            ctor => ctor.GetParameters() is [{ ParameterType: var parameterType }] && parameterType == translatedType);

        Assert.Equal(isProtected, baselineCopy.IsFamily);
        Assert.Equal(isProtected, translatedCopy.IsFamily);
        Assert.Equal(baselineCopy.IsPrivate, translatedCopy.IsPrivate);
    }

    private static void AssertPrintMembersOutput(Assembly baseline, Assembly translated, string typeName)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        var baselineBuilder = new System.Text.StringBuilder();
        var translatedBuilder = new System.Text.StringBuilder();
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        object baselineResult = baselineType.GetMethod("PrintMembers", flags).Invoke(
            Activator.CreateInstance(baselineType, new object[] { 42 }),
            new object[] { baselineBuilder });
        object translatedResult = translatedType.GetMethod("PrintMembers", flags).Invoke(
            Activator.CreateInstance(translatedType, new object[] { 42 }),
            new object[] { translatedBuilder });
        Assert.Equal(baselineResult, translatedResult);
        Assert.Equal(baselineBuilder.ToString(), translatedBuilder.ToString());
    }

    private static void AssertGetOnlyProperty(Assembly baseline, Assembly translated, string typeName, string propertyName, string message = null)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        PropertyInfo baselineProperty = baselineType.GetProperty(propertyName);
        PropertyInfo translatedProperty = translatedType.GetProperty(propertyName);

        Assert.NotNull(baselineProperty);
        Assert.NotNull(translatedProperty);
        Assert.Null(baselineProperty.SetMethod);
        Assert.True(translatedProperty.SetMethod is null, message);
        Assert.Equal(baselineProperty.PropertyType, translatedProperty.PropertyType);
    }

    private static void AssertInitProperty(Assembly baseline, Assembly translated, string typeName, string propertyName)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        MethodInfo baselineSetter = baselineType.GetProperty(propertyName).SetMethod;
        MethodInfo translatedSetter = translatedType.GetProperty(propertyName).SetMethod;

        Assert.NotNull(baselineSetter);
        Assert.NotNull(translatedSetter);
        Assert.Equal(
            baselineSetter.ReturnParameter.GetRequiredCustomModifiers(),
            translatedSetter.ReturnParameter.GetRequiredCustomModifiers());
    }
}
