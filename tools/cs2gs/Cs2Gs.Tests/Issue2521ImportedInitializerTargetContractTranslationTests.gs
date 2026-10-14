// <copyright file="Issue2521ImportedInitializerTargetContractTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Regression coverage for issue #2521: consumer-side taint may describe a
/// referenced target symbol as promoted even though its independently emitted
/// G# contract remains non-null. Initializer sinks must use that effective
/// emitted contract while preserving real same-compilation promotion.
class Issue2521ImportedInitializerTargetContractTranslationTests {
    @Fact
    func ImportedTargets_UseAlreadyEmittedContracts_ForAllInitializerSinks() {
        let target = LoadProject(TargetSource, "Issue2521.Target")
        let consumer = LoadProject(ConsumerSource, "Issue2521.Consumer", target.Compilation.ToMetadataReference())
        let printed = Translate(consumer, []CSharpCompilation{consumer.Compilation, target.Compilation})
        let compact = Compact(printed)
        Assert.Contains("Target{Value: source.Value!!, InitValue: source.Value!!, BaseValue: source.Value!!}", compact)
        Assert.Contains("StaticValue!!", compact)
        Assert.Contains("Target(1){Value = source.Value!!}", compact)
        Assert.Contains("Nested: Target{Value: source.Value!!}", compact)
        Assert.Contains("T{Value: source.Value!!}", compact)
        Assert.Contains("GenericTarget[string]{Value: source.Value!!}", compact)
        Assert.Contains("ImportedBag(){ source.Value!! }", compact)
        Assert.Contains("ImportedHolder{Values: { source.Value!! }}", compact)
        Assert.Contains("ImportedHolder(1){Values = { source.Value!! }}", compact)
        Assert.Contains("\"key\": source.Value!!", compact)
        Assert.Contains("[\"key\"] = source.Value!!", compact)
        Assert.Contains("Target{Value: value!!}", compact)
        Assert.Contains("LocalTarget{Value: source.Value}", compact)
        Assert.DoesNotContain("LocalTarget{Value: source.Value!!}", compact)
        Assert.Contains("LocalGenericTarget[string]{Value: source.Value}", compact)
        Assert.DoesNotContain("LocalGenericTarget[string]{Value: source.Value!!}", compact)
        Assert.Contains("LocalBag(){ source.Value }", compact)
        Assert.DoesNotContain("LocalBag(){ source.Value!! }", compact)
        Assert.Contains("LocalMap(){ [\"key\"] = source.Value }", compact)
        Assert.DoesNotContain("LocalMap(){ [\"key\"] = source.Value!! }", compact)
        Assert.Contains("NullableTarget{Value: source.Value}", compact)
        Assert.DoesNotContain("NullableTarget{Value: source.Value!!}", compact)
    }

    @Fact
    func PrebuiltMetadataTarget_ConsumerTaintStillCannotPromoteItsContract() {
        let targetReference = CompileReference(TargetSource, "Issue2521.PrebuiltTarget")
        let consumer = LoadProject(ConsumerSource, "Issue2521.PrebuiltConsumer", targetReference)
        let compact = Compact(Translate(consumer, []CSharpCompilation{consumer.Compilation}))
        // Issue #3865: the contract still cannot be PROMOTED by consumer taint —
        // that is what this test pins and it still holds. What changed is the
        // bridge: `Issue2521.PrebuiltTarget` is compiled `#nullable disable`, so
        // every one of these sinks is an imported OBLIVIOUS reference type, and
        // gsc's import rule (`ClrNullability.IsPositionNonNull`: non-null iff the
        // byte is 1) maps oblivious and absent metadata alike to `T?`. The
        // already-emitted contract these sinks bind to is therefore `string?`,
        // which accepts the nullable value with no assertion. `!!` is a RUNTIME
        // null check in G#, so emitting one here made a legal null assignment
        // throw; `Issue3865ImportedObliviousArgumentAssertionTests` compiles and
        // RUNS the initializer/indexer shapes to prove it.
        //
        // `GenericTarget<T>.Value` declares the TYPE PARAMETER `T`, which
        // carries no obliviousness signal, so it keeps its assertion — the
        // control for the exclusion. Note this test's source-referenced sibling
        // (`ImportedTargets_UseAlreadyEmittedContracts_ForAllInitializerSinks`)
        // deliberately still asserts everywhere: a project cs2gs is itself
        // migrating has no frozen contract to read.
        Assert.Contains("Target{Value: source.Value, InitValue: source.Value, BaseValue: source.Value}", compact)
        Assert.Contains("GenericTarget[string]{Value: source.Value!!}", compact)
        Assert.Contains("ImportedBag(){ source.Value }", compact)
        Assert.Contains("[\"key\"] = source.Value", compact)
        Assert.DoesNotContain("Target{Value: source.Value!!", compact)
    }

    @Fact
    async func ReferencedTargetTranslation_IsDeterministicAcrossParallelConsumers() {
        let target = LoadProject(TargetSource, "Issue2521.ParallelTarget")
        let consumer = LoadProject(
            ConsumerSource,
            "Issue2521.ParallelConsumer",
            target.Compilation.ToMetadataReference()
        )
        let siblings = []CSharpCompilation{consumer.Compilation, target.Compilation}
        let sequential = Translate(consumer, siblings)
        let parallel = await Task.WhenAll(
            Enumerable.Range(0, 8).Select((_ int32) -> Task.Run(() -> Translate(consumer, siblings)))
        )
        Assert.All(parallel, (result string) -> Assert.Equal(sequential, result))
        Assert.Contains("Target{Value: source.Value!!", Compact(sequential))
    }

    @Fact
    func NullableEnabledConsumer_PreservesAnnotationDrivenSemantics() {
        const EnabledConsumer = `#nullable enable
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
}`
        let target = LoadProject(TargetSource, "Issue2521.EnabledTarget")
        let consumer = LoadProject(
            EnabledConsumer,
            "Issue2521.EnabledConsumer",
            target.Compilation.ToMetadataReference(),
            NullableContextOptions.Enable
        )
        let compact = Compact(Translate(consumer, []CSharpCompilation{consumer.Compilation, target.Compilation}))
        Assert.Contains("Target{Value: source.Value!!}", compact)
        Assert.Contains("NullableTarget{Value: source.Value}", compact)
    }

    shared {
        private const TargetSource string = `#nullable disable
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
}`

        private const ConsumerSource string = `#nullable disable
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
}`

        private func LoadProject(
            source string,
            assemblyName string,
            extraReference MetadataReference? = nil,
            nullableContext NullableContextOptions = NullableContextOptions.Disable
        ) LoadedCSharpProject {
            let references = if extraReference == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Append(extraReference).ToList()
                )
            }
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    nullableContext
                )
                    .WithAllowUnsafe(true)
            )
            let errors = compilation
                .GetDiagnostics()
                .Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
                .ToArray()
            Assert.Empty(errors)
            let document = LoadedDocument(tree.FilePath, tree, compilation.GetSemanticModel(tree))
            return LoadedCSharpProject(compilation, []LoadedDocument{document}, Array.Empty[Diagnostic]())
        }

        private func CompileReference(source string, assemblyName string) MetadataReference {
            let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
            )
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            stream.Position = 0
            return MetadataReference.CreateFromStream(stream)
        }

        private func Translate(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations
            )
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
