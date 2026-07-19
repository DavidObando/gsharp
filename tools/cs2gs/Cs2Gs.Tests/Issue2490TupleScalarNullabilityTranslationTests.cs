// <copyright file="Issue2490TupleScalarNullabilityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue2490TupleScalarNullabilityTranslationTests
{
    [Fact]
    public void DirectNamedTupleElement_PromotesWrapperAndCoreParameters()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("func Gather(ok bool) (List[string]?, int32)", printed);
        Assert.Contains("func Count(items List[string]?) int32", printed);
        Assert.Contains("func CountCore(items List[string]?) int32", printed);
        Assert.Contains("func Read(ok bool) List[string]?", printed);
    }

    [Fact]
    public void NestedTupleLocalsConditionalsConstructorsAndIndexers_PreserveLeafPrecision()
    {
        string printed = TranslateOblivious(@"
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
    public string this[string key] => ""value"";
}

public static class Repro
{
    public static string Run(bool missing, Lookup lookup)
    {
        var result = Gather(missing);
        var direct = result.Names.Maybe;
        var (keep, deconstructed) = result.Names;
        string assigned = ""initial"";
        assigned = missing ? result.Names.Maybe : direct;
        var box = new Box((result.Names.Maybe, result.Count));
        var indexed = lookup[result.Names.Maybe];
        return Echo(missing ? deconstructed : direct);
    }

    private static ((string Keep, string Maybe) Names, int Count) Gather(bool missing)
    {
        if (missing)
            return ((""keep"", null), 1);

        return ((""keep"", ""value""), 2);
    }

    private static string Echo(string value) => value;
}");

        Assert.Contains("func Gather(missing bool) ((string, string?), int32)", printed);
        Assert.Contains("var assigned string? =", printed);
        Assert.Contains("init(value string?)", printed);
        Assert.Contains("prop this[key string?] string", printed);
        Assert.Contains("func Echo(value string?) string?", printed);
        Assert.DoesNotContain("((string?, string?), int32)", printed);
    }

    [Fact]
    public void ScalarFieldsAndProperties_ReceiveTupleElementEvidence()
    {
        string printed = TranslateOblivious(@"
public static class Repro
{
    private static (string Maybe, string Keep) Source
    {
        get
        {
            return (null, ""keep"");
        }
    }

    public static string Field = Source.Maybe;

    public static string Property { get; set; } = Source.Maybe;

    public static void Reset()
    {
        Field = Source.Maybe;
        Property = Source.Maybe;
    }
}");

        Assert.Contains("prop Source (string?, string)", printed);
        Assert.Contains("var Field string?", printed);
        Assert.Contains("var Property string?", printed);
        Assert.DoesNotContain("prop Source (string?, string?)", printed);
    }

    [Fact]
    public void DelegateGenericLocalFunctionAndAsyncForwarding_PropagateTupleEvidence()
    {
        string printed = TranslateOblivious(@"
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

        return (""value"", 2);
    }

    private static async Task<(string Item, int Keep)> GatherAsync(bool missing)
    {
        await Task.Yield();
        return Gather(missing);
    }
}");

        Assert.Contains("type Counter = delegate func(value string?) int32", printed);
        Assert.Contains("func Forward[T class](value T?) T?", printed);
        Assert.Contains("let Core = func (item T?) T?", printed);
        Assert.Contains("async func RunAsync(missing bool) string?", printed);
        Assert.Contains("async func GatherAsync(missing bool) (string?, int32)", printed);
    }

    [Fact]
    public void InterfaceAndOverrideParameterContracts_StayInLockstep()
    {
        string printed = TranslateOblivious(@"
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

        return (""value"", 2);
    }
}");

        Assert.Contains("func Put(value string?);", printed);
        Assert.Contains("open func Put(value string?);", printed);
        Assert.Contains("override func Put(value string?)", printed);
        Assert.Contains("func PutCore(value string?)", printed);
    }

    [Fact]
    public void CrossProjectTupleElement_PromotesConsumerScalarParameter()
    {
        const string sourceB = @"
namespace LibB
{
    public static class Provider
    {
        public static (string Item, int Keep) Gather(bool missing)
        {
            if (missing)
                return (null, 1);

            return (""value"", 2);
        }
    }
}";
        const string sourceA = @"
using LibB;

namespace LibA
{
    public static class Consumer
    {
        public static int Run(bool missing) => Count(Provider.Gather(missing).Item);

        private static int Count(string value) => value is null ? 0 : value.Length;
    }
}";

        LoadedCSharpProject projectB = LoadOblivious(sourceB, "LibB");
        LoadedCSharpProject projectA = LoadOblivious(
            sourceA,
            "LibA",
            new MetadataReference[] { projectB.Compilation.ToMetadataReference() });
        var siblings = new[] { projectA.Compilation, projectB.Compilation };

        string printedB = TranslateProject(projectB, siblings);
        string printedA = TranslateProject(projectA, siblings);

        Assert.Contains("func Gather(missing bool) (string?, int32)", printedB);
        Assert.Contains("func Count(value string?) int32", printedA);
    }

    [Fact]
    public void NullableEnabledCompilation_PreservesAnnotatedAndNonNullParameters()
    {
        string printed = TranslateEnabled(@"
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
            return (""required"", null);

        return (""required"", ""value"");
    }

    private static void Accept(string? value)
    {
    }

    private static void Keep(string value)
    {
    }
}");

        Assert.Contains("func Gather(missing bool) (string, string?)", printed);
        Assert.Contains("func Accept(value string?)", printed);
        Assert.Contains("func Keep(value string)", printed);
        Assert.DoesNotContain("func Keep(value string?)", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = LoadOblivious(source, "Snippet");
        return TranslateProject(project, new[] { project.Compilation });
    }

    private static string TranslateEnabled(string source)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "Snippet.cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            "Snippet",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        var document = new LoadedDocument("Snippet.cs", tree, compilation.GetSemanticModel(tree));
        var project = new LoadedCSharpProject(compilation, new[] { document }, Array.Empty<Diagnostic>());
        return TranslateProject(project, new[] { compilation });
    }

    private static LoadedCSharpProject LoadOblivious(
        string source,
        string assemblyName,
        IReadOnlyList<MetadataReference> extraReferences = null)
    {
        IReadOnlyList<MetadataReference> references = extraReferences is null
            ? CSharpProjectLoader.RuntimeReferences()
            : CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { (assemblyName + ".cs", source) },
            references,
            assemblyName);
        Assert.True(
            project.BoundWithoutErrors,
            $"{assemblyName} should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);
        return project;
    }

    private static string TranslateProject(
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
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
