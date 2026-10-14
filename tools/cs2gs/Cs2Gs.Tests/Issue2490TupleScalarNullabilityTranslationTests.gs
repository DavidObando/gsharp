// <copyright file="Issue2490TupleScalarNullabilityTranslationTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

open class Issue2490TupleScalarNullabilityTranslationTests {
    @Fact
    func DirectNamedTupleElement_PromotesWrapperAndCoreParameters() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

public static class Repro
{
    public static int Run(bool ok)
    {
        var result = Gather(ok);
        if (ok)
            Count(new List<string>());

        return Count(items: result.Items);
    }

    private static (List<string> Items, int Value) Gather(bool ok)
    {
        if (!ok)
            return default;

        return (new List<string>(), 0);
    }

    private static int Count(List<string> items) => CountCore(items);

    private static List<string> Read(bool ok)
    {
        return Gather(ok).Items;
    }

    private static int CountCore(List<string> items)
    {
        if (items is null)
            return 0;

        return items.Count;
    }
}`)
        Assert.Contains("func Gather(ok bool) (Items List[string]?, Value int32)", printed)
        Assert.Contains("func Count(items List[string]?) int32", printed)
        Assert.Contains("func CountCore(items List[string]?) int32", printed)
        Assert.Contains("func Read(ok bool) List[string]?", printed)
    }

    @Fact
    func NestedTupleLocalsConditionalsConstructorsAndIndexers_PreserveLeafPrecision() {
        let printed = TranslateOblivious(`
public sealed class Box
{
    public Box(string value)
    {
    }

    public Box((string Maybe, int Keep) payload)
        : this(payload.Maybe)
    {
    }
}

public sealed class Lookup
{
    public string this[string key] => "value";
}

public static class Repro
{
    public static string Run(bool missing, Lookup lookup)
    {
        var result = Gather(missing);
        var direct = result.Names.Maybe;
        var (keep, deconstructed) = result.Names;
        string assigned = "initial";
        assigned = missing ? result.Names.Maybe : direct;
        var box = new Box((result.Names.Maybe, result.Count));
        var indexed = lookup[result.Names.Maybe];
        return Echo(missing ? deconstructed : direct);
    }

    private static ((string Keep, string Maybe) Names, int Count) Gather(bool missing)
    {
        if (missing)
            return (("keep", null), 1);

        return (("keep", "value"), 2);
    }

    private static string Echo(string value) => value;
}`)
        Assert.Contains("func Gather(missing bool) (Names (Keep string, Maybe string?), Count int32)", printed)
        Assert.Contains("var assigned string? =", printed)
        Assert.Contains("init(value string?)", printed)
        Assert.Contains("prop this[key string?] string", printed)
        Assert.Contains("func Echo(value string?) string?", printed)
        Assert.DoesNotContain("Keep string?", printed)
    }

    @Fact
    func ScalarFieldsAndProperties_ReceiveTupleElementEvidence() {
        let printed = TranslateOblivious(`
public static class Repro
{
    private static (string Maybe, string Keep) Source
    {
        get
        {
            return (null, "keep");
        }
    }

    public static string Field = Source.Maybe;

    public static string Property { get; set; } = Source.Maybe;

    public static void Reset()
    {
        Field = Source.Maybe;
        Property = Source.Maybe;
    }
}`)
        Assert.Contains("prop Source (Maybe string?, Keep string)", printed)
        Assert.Contains("var Field string?", printed)
        Assert.Contains("var _property string?", printed)
        Assert.Contains("prop Property string?", printed)
        Assert.DoesNotContain("Keep string?)", printed)
    }

    @Fact
    func DelegateGenericLocalFunctionAndAsyncForwarding_PropagateTupleEvidence() {
        let printed = TranslateOblivious(`
using System.Threading.Tasks;

public delegate int Counter(string value);

public static class Repro
{
    public static int Invoke(Counter counter, bool missing)
    {
        var result = Gather(missing);
        return counter(result.Item);
    }

    public static async Task<string> RunAsync(bool missing)
    {
        var result = await GatherAsync(missing);
        return Forward(result.Item);
    }

    private static T Forward<T>(T value) where T : class
    {
        T Core(T item) => item;
        return Core(value);
    }

    private static (string Item, int Keep) Gather(bool missing)
    {
        if (missing)
            return (null, 1);

        return ("value", 2);
    }

    private static async Task<(string Item, int Keep)> GatherAsync(bool missing)
    {
        await Task.Yield();
        return Gather(missing);
    }
}`)
        Assert.Contains("delegate Counter(value string?) int32;", printed)
        Assert.Contains("func Forward[T class](value T?) T?", printed)
        Assert.Contains("let Core = func (item T?) T?", printed)
        Assert.Contains("async func RunAsync(missing bool) string?", printed)
        Assert.Contains("async func GatherAsync(missing bool) (Item string?, Keep int32)", printed)
    }

    @Fact
    func InterfaceAndOverrideParameterContracts_StayInLockstep() {
        let printed = TranslateOblivious(`
public interface ISink
{
    void Put(string value);
}

public abstract class SinkBase
{
    public abstract void Put(string value);
}

public sealed class Sink : SinkBase, ISink
{
    public override void Put(string value) => PutCore(value);

    private static void PutCore(string value)
    {
    }
}

public static class Repro
{
    public static void Run(ISink sink, bool missing)
    {
        var result = Gather(missing);
        sink.Put(result.Item);
    }

    private static (string Item, int Keep) Gather(bool missing)
    {
        if (missing)
            return (null, 1);

        return ("value", 2);
    }
}`)
        Assert.Contains("func Put(value string?);", printed)
        Assert.Contains("open func Put(value string?);", printed)
        Assert.Contains("override func Put(value string?)", printed)
        Assert.Contains("func PutCore(value string?)", printed)
    }

    @Fact
    func CrossProjectTupleElement_PromotesConsumerScalarParameter() {
        const sourceB = `
namespace LibB
{
    public static class Provider
    {
        public static (string Item, int Keep) Gather(bool missing)
        {
            if (missing)
                return (null, 1);

            return ("value", 2);
        }
    }
}`
        const sourceA = `
using LibB;

namespace LibA
{
    public static class Consumer
    {
        public static int Run(bool missing) => Count(Provider.Gather(missing).Item);

        private static int Count(string value) => value is null ? 0 : value.Length;
    }
}`
        let projectB = LoadOblivious(sourceB, "LibB")
        let projectA = LoadOblivious(sourceA, "LibA", []MetadataReference{projectB.Compilation.ToMetadataReference()})
        let siblings = []CSharpCompilation{projectA.Compilation, projectB.Compilation}
        let printedB = TranslateProject(projectB, siblings)
        let printedA = TranslateProject(
            projectA,
            siblings,
            "Consumer fixture omits the sibling Provider declaration from its emitted G# binding input."
        )
        Assert.Contains("func Gather(missing bool) (Item string?, Keep int32)", printedB)
        Assert.Contains("func Count(value string?) int32", printedA)
    }

    @Fact
    func NullableEnabledCompilation_PreservesAnnotatedAndNonNullParameters() {
        let printed = TranslateEnabled(`
#nullable enable

public static class Repro
{
    public static void Run(bool missing)
    {
        var result = Gather(missing);
        Accept(result.Maybe);
        Keep(result.Required);
    }

    private static (string Required, string? Maybe) Gather(bool missing)
    {
        if (missing)
            return ("required", null);

        return ("required", "value");
    }

    private static void Accept(string? value)
    {
    }

    private static void Keep(string value)
    {
    }
}`)
        Assert.Contains("func Gather(missing bool) (Required string, Maybe string?)", printed)
        Assert.Contains("func Accept(value string?)", printed)
        Assert.Contains("func Keep(value string)", printed)
        Assert.DoesNotContain("func Keep(value string?)", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = LoadOblivious(source, "Snippet")
            return TranslateProject(project, []CSharpCompilation{project.Compilation})
        }

        private func TranslateEnabled(source string) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            let document = LoadedDocument("Snippet.cs", tree, compilation.GetSemanticModel(tree))
            let project = LoadedCSharpProject(compilation, []LoadedDocument{document}, Array.Empty[Diagnostic]())
            return TranslateProject(project, []CSharpCompilation{compilation})
        }

        private func LoadOblivious(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){(assemblyName + ".cs", source)},
                references,
                assemblyName
            )
            Assert.True(
                project.BoundWithoutErrors,
                "$assemblyName should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return project
        }

        private func TranslateProject(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation],
            roundTripOnlyReason string? = nil
        ) string {
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations
            )
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
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
