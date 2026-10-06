// <copyright file="Issue4796SourceDataClassWithEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4796SourceDataClassWithEmitTests
{
    private readonly ITestOutputHelper output;

    public Issue4796SourceDataClassWithEmitTests(ITestOutputHelper output) => this.output = output;

    [Theory]
    [InlineData("plain", false, false)]
    [InlineData("plain", true, true)]
    [InlineData("generic", false, false)]
    [InlineData("generic", true, true)]
    [InlineData("nested", false, false)]
    [InlineData("nested", true, true)]
    [InlineData("derived", false, false)]
    [InlineData("derived", true, true)]
    public void AuthoredOverloads_CopyPreservesStorageProvenanceAndLexicalEffects(string shape, bool property, bool overrides)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue4796-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var generic = shape is "generic" or "nested";
            var valueType = generic ? "T" : "int";
            var declaration = shape == "generic" ? "Row<T>" : "Row";
            var owner = shape switch
            {
                "generic" => "Row<int>",
                "nested" => "Outer<int>.Row",
                _ => "Row",
            };
            var record = $$"""
                public record {{declaration}}
                {
                    private readonly object owner;
                    private readonly int initialized = Effects.Initialize();
                    public string Field { get; }
                    public bool Property { get; }
                    public {{valueType}} Value { get; init; }
                    public bool IsDeclarationInitializer { get; init; }
                    public Row(string field, {{valueType}} value, object owner)
                    {
                        Field = field; Value = value; this.owner = owner; Effects.Construct();
                    }
                    public Row(bool property, {{valueType}} value)
                    {
                        Property = property; Value = value; owner = new object(); Effects.Construct();
                    }
                    public object Owner() => owner;
                    public int Initialized() => initialized;
                }
                """;
            if (shape == "nested")
            {
                record = "public class Outer<T> { " + record + """
                    public static Row Create(string field, T value, object owner) =>
                        new Row(field, value, owner) { IsDeclarationInitializer = true };
                    public static Row Create(bool property, T value) =>
                        new Row(property, value) { IsDeclarationInitializer = true };
                    }
                    """;
            }
            else if (shape == "derived")
            {
                record = """
                    public record Parent
                    {
                        private readonly object inherited = new object();
                        public bool IsDeclarationInitializer { get; init; }
                        public object Inherited() => inherited;
                    }
                    """ + record.Replace("public record Row", "public record Row : Parent", StringComparison.Ordinal)
                        .Replace("public bool IsDeclarationInitializer { get; init; }", string.Empty, StringComparison.Ordinal);
            }

            var arguments = property ? "true, 7" : "\"field\", 7, new object()";
            var creation = shape == "nested"
                ? $"Outer<int>.Create({arguments})"
                : $"new {owner}({arguments}) {{ IsDeclarationInitializer = true }}";
            var source = $$"""
                using System;
                using System.Collections.Immutable;
                namespace SourceClone4796;
                public static class Effects
                {
                    public static string Trace = "";
                    public static int Initializations;
                    public static int Constructors;
                    public static int Initialize() { Trace += "I"; return ++Initializations; }
                    public static void Construct() { Trace += "C"; Constructors++; }
                    public static T Receiver<T>(T value) { Trace += "R"; return value; }
                    public static bool Flag() { Trace += "F"; return false; }
                    public static int Next() { Trace += "V"; return 9; }
                }
                {{record}}
                public static class Driver
                {
                    public static {{owner}} Copy({{owner}} original)
                    {
                        var builder = ImmutableArray.CreateBuilder<{{owner}}>();
                        builder.Add(Effects.Receiver(original) with {
                            {{(overrides ? "IsDeclarationInitializer = Effects.Flag(), Value = Effects.Next()" : "")}}
                        });
                        return builder[0];
                    }
                    public static string Run()
                    {
                        Effects.Trace = ""; Effects.Initializations = Effects.Constructors = 0;
                        var original = {{creation}};
                        var updated = Copy(original);
                        return $"{original.Value}/{updated.Value}/{original.IsDeclarationInitializer}/{updated.IsDeclarationInitializer}/{original.Field == updated.Field}/{original.Property == updated.Property}/{Object.ReferenceEquals(original.Owner(), updated.Owner())}/{original.Initialized() == updated.Initialized()}/{Object.ReferenceEquals(original, updated)}/{Effects.Initializations}/{Effects.Constructors}/{Effects.Trace}";
                    }
                }
                """;
            var references = RuntimeReferences();
            var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Preview), "Fixture.cs", System.Text.Encoding.UTF8);
            var native = CSharpCompilation.Create(
                "NativeSourceClone4796",
                new[] { tree },
                references.Select(path => MetadataReference.CreateFromFile(path)),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, deterministic: true));
            var nativePath = Path.Combine(directory, "NativeSourceClone4796.dll");
            using (var imageStream = File.Create(nativePath))
            using (var pdbStream = File.Create(Path.ChangeExtension(nativePath, ".pdb")))
            {
                var emitted = native.Emit(imageStream, pdbStream,
                    options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            }
            IlVerifier.Verify(nativePath);
            var model = native.GetSemanticModel(tree);
            var translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(
                new LoadedDocument("Fixture.cs", tree, model),
                new TranslationContext(native, model, "Fixture.cs")));
            var sourcePath = Path.Combine(directory, "Fixture.gs");
            var image = Path.Combine(directory, "SourceClone4796.dll");
            File.WriteAllText(sourcePath, translated);
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            try
            {
                Console.SetOut(stdout);
                Console.SetError(stderr);
                var exit = Program.Main(new[] { "/target:library", "/assemblyname:SourceClone4796", "/out:" + image, "/targetframework:net10.0" }
                    .Concat(references.Select(path => "/reference:" + path)).Append(sourcePath).ToArray());
                Assert.True(exit == 0, stdout.ToString() + stderr);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            IlVerifier.Verify(image);
            var assemblies = EmittedFixture.LoadTogether(nativePath, image);
            var expected = overrides
                ? "7/9/True/False/True/True/True/True/False/1/1/ICRFV"
                : "7/7/True/True/True/True/True/True/False/1/1/ICR";
            var nativeResult = Run(assemblies[0]);
            var result = Run(assemblies[1]);
            this.output.WriteLine("Explicit Roslyn/native: " + nativeResult);
            this.output.WriteLine("Actual cs2gs/gsc/CLR: " + result);
            Assert.Equal(expected, nativeResult);
            Assert.Equal(expected, result);
            var copy = assemblies[1].GetType("SourceClone4796.Driver", throwOnError: true).GetMethod("Copy");
            var clone = copy.ReturnType.GetMethod("<Clone>$", BindingFlags.Instance | BindingFlags.Public);
            Assert.Equal(copy.ReturnType, clone.ReturnType);
            Assert.Empty(clone.GetParameters());
            var fields = copy.ReturnType.GetFields(BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.True(fields.Single(field => field.Name == "owner").IsInitOnly);
            Assert.True(fields.Single(field => field.Name == "initialized").IsInitOnly);
            if (shape == "derived")
            {
                var row = copy.ReturnType;
                var original = row.GetConstructor(new[] { typeof(string), typeof(int), typeof(object) })
                    .Invoke(new object[] { "field", 7, new object() });
                var baseClone = row.BaseType.GetMethod("<Clone>$").Invoke(original, null);
                Assert.Equal(row, baseClone.GetType());
                Assert.NotSame(original, baseClone);
                Assert.Same(row.GetMethod("Inherited").Invoke(original, null), row.GetMethod("Inherited").Invoke(baseClone, null));
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string Run(Assembly assembly) =>
        (string)assembly.GetType("SourceClone4796.Driver", throwOnError: true).GetMethod("Run").Invoke(null, null);

    private static string[] RuntimeReferences() =>
        Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll");
}
