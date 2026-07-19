// <copyright file="Issue2521ImportedInitializerTargetContractTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #2521: consumer-side taint may describe a
/// referenced target symbol as promoted even though its independently emitted
/// G# contract remains non-null. Initializer sinks must use that effective
/// emitted contract while preserving real same-compilation promotion.
/// </summary>
public sealed class Issue2521ImportedInitializerTargetContractTranslationTests
{
    private const string TargetSource = """
        #nullable disable
        using System.Collections;
        using System.Collections.Generic;

        namespace Imported;

        public interface ITarget
        {
            string Value { get; set; }
        }

        public class TargetBase
        {
            public string BaseValue;
        }

        public sealed class Target : TargetBase, ITarget
        {
            public Target() { }

            public Target(int id) { }

            public string Value { get; set; }

            public string InitValue { get; init; }
        }

        public sealed class GenericTarget<T>
            where T : class
        {
            public T Value { get; set; }
        }

        public sealed class ImportedBag : IEnumerable<string>
        {
            private readonly List<string> values = new();

            public void Add(string value) => values.Add(value);

            public IEnumerator<string> GetEnumerator() => values.GetEnumerator();

            IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        }

        public sealed class ImportedHolder
        {
            public ImportedHolder() { }

            public ImportedHolder(int id) { }

            public List<string> Values { get; } = new();
        }

        public sealed class ImportedMap : IEnumerable<KeyValuePair<string, string>>
        {
            private readonly Dictionary<string, string> values = new();

            public string this[string key]
            {
                get => values[key];
                set => values[key] = value;
            }

            public void Add(string key, string value) => values.Add(key, value);

            public IEnumerator<KeyValuePair<string, string>> GetEnumerator() => values.GetEnumerator();

            IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        }

        #nullable enable
        public sealed class NullableTarget
        {
            public string? Value { get; set; }
        }
        """;

    private const string ConsumerSource = """
        #nullable disable
        using Imported;

        namespace Consumer;

        public interface ISource
        {
            string Value { get; set; }
        }

        public sealed class Wrapper
        {
            public Target Nested { get; set; }
        }

        public sealed class LocalTarget
        {
            public string Value { get; set; }

            public bool HasValue => Value is not null;
        }

        public sealed class LocalGenericTarget<T>
            where T : class
        {
            public T Value { get; set; }

            public bool HasValue => Value is not null;
        }

        public sealed class LocalBag : System.Collections.Generic.IEnumerable<string>
        {
            public void Add(string value)
            {
                if (value is null)
                    return;
            }

            public System.Collections.Generic.IEnumerator<string> GetEnumerator() =>
                System.Linq.Enumerable.Empty<string>().GetEnumerator();

            System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
        }

        public sealed class LocalMap : System.Collections.Generic.IEnumerable<
            System.Collections.Generic.KeyValuePair<string, string>>
        {
            public string this[string key]
            {
                get => "";
                set { }
            }

            public bool IsMissing(string key) => this[key] is null;

            public System.Collections.Generic.IEnumerator<
                System.Collections.Generic.KeyValuePair<string, string>> GetEnumerator() =>
                System.Linq.Enumerable.Empty<
                    System.Collections.Generic.KeyValuePair<string, string>>().GetEnumerator();

            System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
        }

        public static class Repro
        {
            public static string StaticValue { get; set; }

            public static bool SourceMayBeNull(ISource source) => source.Value is null;

            public static bool StaticMayBeNull() => StaticValue is null;

            public static Target Property(ISource source) =>
                new Target
                {
                    Value = source.Value,
                    InitValue = source.Value,
                    BaseValue = source.Value,
                };

            public static Target StaticProperty() =>
                new Target { Value = StaticValue };

            public static Target ConstructorSuffix(ISource source) =>
                new Target(1) { Value = source.Value };

            public static Wrapper Nested(ISource source) =>
                new Wrapper { Nested = new Target { Value = source.Value } };

            public static T GenericConstraint<T>(ISource source)
                where T : class, ITarget, new() =>
                new T { Value = source.Value };

            public static GenericTarget<string> GenericMember(ISource source) =>
                new GenericTarget<string> { Value = source.Value };

            public static ImportedBag BareAdd(ISource source) =>
                new ImportedBag { source.Value };

            public static ImportedHolder NestedCollection(ISource source) =>
                new ImportedHolder { Values = { source.Value } };

            public static ImportedHolder SuffixNestedCollection(ISource source) =>
                new ImportedHolder(1) { Values = { source.Value } };

            public static ImportedMap KeyedAdd(ISource source) =>
                new ImportedMap { { "key", source.Value } };

            public static ImportedMap Indexed(ISource source) =>
                new ImportedMap { ["key"] = source.Value };

            public static Target Parameter(string value)
            {
                if (value is null)
                    value = "fallback";

                return new Target { Value = value };
            }

            public static Target Local(ISource source)
            {
                string value = source.Value;
                if (value is null)
                    value = "fallback";

                return new Target { Value = value };
            }

            public static LocalTarget SameCompilationTarget(ISource source) =>
                new LocalTarget { Value = source.Value };

            public static LocalGenericTarget<string> SameCompilationGenericTarget(ISource source) =>
                new LocalGenericTarget<string> { Value = source.Value };

            public static LocalBag SameCompilationAdd(ISource source) =>
                new LocalBag { source.Value };

            public static LocalMap SameCompilationIndexer(ISource source) =>
                new LocalMap { ["key"] = source.Value };

            public static NullableTarget ReferencedNullableTarget(ISource source) =>
                new NullableTarget { Value = source.Value };
        }
        """;

    [Fact]
    public void ImportedTargets_UseAlreadyEmittedContracts_ForAllInitializerSinks()
    {
        LoadedCSharpProject target = LoadProject(TargetSource, "Issue2521.Target");
        LoadedCSharpProject consumer = LoadProject(
            ConsumerSource,
            "Issue2521.Consumer",
            target.Compilation.ToMetadataReference());

        string printed = Translate(
            consumer,
            new[] { consumer.Compilation, target.Compilation });
        string compact = Compact(printed);

        Assert.Contains(
            "Target{Value: source.Value!!, InitValue: source.Value!!, BaseValue: source.Value!!}",
            compact);
        Assert.Contains("StaticValue!!", compact);
        Assert.Contains("Target(1){Value = source.Value!!}", compact);
        Assert.Contains("Nested: Target{Value: source.Value!!}", compact);
        Assert.Contains("T{Value: source.Value!!}", compact);
        Assert.Contains("GenericTarget[string]{Value: source.Value!!}", compact);
        Assert.Contains("ImportedBag(){ source.Value!! }", compact);
        Assert.Contains("ImportedHolder{Values: { source.Value!! }}", compact);
        Assert.Contains("ImportedHolder(1){Values = { source.Value!! }}", compact);
        Assert.Contains("\"key\": source.Value!!", compact);
        Assert.Contains("[\"key\"] = source.Value!!", compact);
        Assert.Contains("Target{Value: value!!}", compact);

        Assert.Contains("LocalTarget{Value: source.Value}", compact);
        Assert.DoesNotContain("LocalTarget{Value: source.Value!!}", compact);
        Assert.Contains("LocalGenericTarget[string]{Value: source.Value}", compact);
        Assert.DoesNotContain("LocalGenericTarget[string]{Value: source.Value!!}", compact);
        Assert.Contains("LocalBag(){ source.Value }", compact);
        Assert.DoesNotContain("LocalBag(){ source.Value!! }", compact);
        Assert.Contains("LocalMap(){ [\"key\"] = source.Value }", compact);
        Assert.DoesNotContain("LocalMap(){ [\"key\"] = source.Value!! }", compact);
        Assert.Contains("NullableTarget{Value: source.Value}", compact);
        Assert.DoesNotContain("NullableTarget{Value: source.Value!!}", compact);
    }

    [Fact]
    public void PrebuiltMetadataTarget_ConsumerTaintStillCannotPromoteItsContract()
    {
        MetadataReference targetReference = CompileReference(TargetSource, "Issue2521.PrebuiltTarget");
        LoadedCSharpProject consumer = LoadProject(
            ConsumerSource,
            "Issue2521.PrebuiltConsumer",
            targetReference);

        string compact = Compact(Translate(consumer, new[] { consumer.Compilation }));

        Assert.Contains(
            "Target{Value: source.Value!!, InitValue: source.Value!!, BaseValue: source.Value!!}",
            compact);
        Assert.Contains("T{Value: source.Value!!}", compact);
        Assert.Contains("ImportedBag(){ source.Value!! }", compact);
        Assert.Contains("[\"key\"] = source.Value!!", compact);
    }

    [Fact]
    public async Task ReferencedTargetTranslation_IsDeterministicAcrossParallelConsumers()
    {
        LoadedCSharpProject target = LoadProject(TargetSource, "Issue2521.ParallelTarget");
        LoadedCSharpProject consumer = LoadProject(
            ConsumerSource,
            "Issue2521.ParallelConsumer",
            target.Compilation.ToMetadataReference());
        var siblings = new[] { consumer.Compilation, target.Compilation };

        string sequential = Translate(consumer, siblings);
        string[] parallel = await Task.WhenAll(
            Enumerable.Range(0, 8)
                .Select(_ => Task.Run(() => Translate(consumer, siblings))));

        Assert.All(parallel, result => Assert.Equal(sequential, result));
        Assert.Contains("Target{Value: source.Value!!", Compact(sequential));
    }

    [Fact]
    public void NullableEnabledConsumer_PreservesAnnotationDrivenSemantics()
    {
        const string EnabledConsumer = """
            #nullable enable
            using Imported;

            namespace EnabledConsumer;

            public interface ISource
            {
                string? Value { get; }
            }

            public static class Repro
            {
                public static Target Create(ISource source) =>
                    new Target { Value = source.Value! };

                public static NullableTarget CreateNullable(ISource source) =>
                    new NullableTarget { Value = source.Value };
            }
            """;

        LoadedCSharpProject target = LoadProject(TargetSource, "Issue2521.EnabledTarget");
        LoadedCSharpProject consumer = LoadProject(
            EnabledConsumer,
            "Issue2521.EnabledConsumer",
            target.Compilation.ToMetadataReference(),
            NullableContextOptions.Enable);

        string compact = Compact(Translate(
            consumer,
            new[] { consumer.Compilation, target.Compilation }));

        Assert.Contains("Target{Value: source.Value!!}", compact);
        Assert.Contains("NullableTarget{Value: source.Value}", compact);
    }

    private static LoadedCSharpProject LoadProject(
        string source,
        string assemblyName,
        MetadataReference extraReference = null,
        NullableContextOptions nullableContext = NullableContextOptions.Disable)
    {
        IReadOnlyList<MetadataReference> references = extraReference is null
            ? CSharpProjectLoader.RuntimeReferences()
            : CSharpProjectLoader.RuntimeReferences().Append(extraReference).ToList();
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(nullableContext)
                .WithAllowUnsafe(true));
        Diagnostic[] errors = compilation.GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToArray();
        Assert.Empty(errors);
        var document = new LoadedDocument(
            tree.FilePath,
            tree,
            compilation.GetSemanticModel(tree));
        return new LoadedCSharpProject(
            compilation,
            new[] { document },
            Array.Empty<Diagnostic>());
    }

    private static MetadataReference CompileReference(string source, string assemblyName)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest));
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable));
        using var stream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        stream.Position = 0;
        return MetadataReference.CreateFromStream(stream);
    }

    private static string Translate(
        LoadedCSharpProject project,
        IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static string Compact(string printed) =>
        string.Join(
            " ",
            printed.Split(
                new[] { ' ', '\t', '\r', '\n' },
                StringSplitOptions.RemoveEmptyEntries));
}
