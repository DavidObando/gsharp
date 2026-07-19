// <copyright file="Issue2469TupleElementNullabilityTranslationTests.cs" company="GSharp">
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

public class Issue2469TupleElementNullabilityTranslationTests
{
    [Fact]
    public void Oblivious_NamedTupleLiteral_PromotesEachNullElement()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

public static class Parser
{
    public static (string Action, string Method, Dictionary<string, string> Inputs) Parse(string text)
    {
        if (string.IsNullOrEmpty(text))
            return (null, null, null);

        return (""/login"", ""POST"", new Dictionary<string, string>());
    }

    public static void Inspect(string text)
    {
        var parsed = Parse(text);
        var method = parsed.Method;
    }
}");

        Assert.Contains(
            "func Parse(text string) (string?, string?, Dictionary[string, string]?)",
            printed);
        Assert.Contains("let method string? = parsed.Item2", printed);
        Assert.DoesNotContain("nil!!", printed);
    }

    [Fact]
    public void Oblivious_NestedConditionalSwitchAndForwardedTuple_PromoteOnlyAffectedLeaves()
    {
        string printed = TranslateOblivious(@"
public static class Parser
{
    public static ((string Left, string Right) Names, int Count, string Keep, int? Maybe) Pick(bool flag, int value)
    {
        (string Left, string Right) names =
            flag ? (null, ""right"") : value switch
            {
                0 => (""left"", null),
                _ => (""left"", ""right"")
            };

        var result = (Names: names, Count: 1, Keep: ""fixed"", Maybe: (int?)null);
        return result;
    }
}");

        Assert.Contains(
            "func Pick(flag bool, value int32) ((string?, string?), int32, string, int32?)",
            printed);
    }

    [Fact]
    public void Oblivious_AsyncInterfaceAndOverrideContracts_StayInLockstep()
    {
        string printed = TranslateOblivious(@"
using System.Threading.Tasks;

public interface IParser
{
    Task<(string Action, string Method)> ParseAsync();
}

public abstract class ParserBase
{
    public abstract (string Action, string Method) Parse();
}

public sealed class Parser : ParserBase, IParser
{
    public override (string Action, string Method) Parse()
    {
        return (null, ""GET"");
    }

    public async Task<(string Action, string Method)> ParseAsync()
    {
        return (null, ""POST"");
    }
}");

        Assert.Contains("func ParseAsync() Task[(string?, string)];", printed);
        Assert.Contains("async func ParseAsync() (string?, string)", printed);
        Assert.Contains("open func Parse() (string?, string);", printed);
        Assert.Contains("override func Parse() (string?, string)", printed);
    }

    [Fact]
    public void Oblivious_GenericAndDeconstructionFlow_PreserveValueElements()
    {
        string printed = TranslateOblivious(@"
public static class Parser
{
    public static (T Value, int Count, int? Maybe) Generic<T>() where T : class
    {
        return (null, 0, null);
    }

    public static (string First, string Second) Get()
    {
        return (null, ""second"");
    }

    public static string Forward()
    {
        var (first, second) = Get();
        return first;
    }
}");

        Assert.Contains("func Generic[T class]() (T?, int32, int32?)", printed);
        Assert.Contains("func Get() (string?, string)", printed);
        Assert.Contains("func Forward() string?", printed);
    }

    [Fact]
    public void EnabledCompilation_PreservesDeclaredTupleAnnotations()
    {
        string printed = TranslateEnabled(@"
#nullable enable

public static class Parser
{
    public static (string Required, string? Optional, int Count, int? Maybe) Parse()
    {
        return (""required"", null, 0, null);
    }
}");

        Assert.Contains("func Parse() (string, string?, int32, int32?)", printed);
        Assert.DoesNotContain("(string?, string?, int32, int32?)", printed);
    }

    [Fact]
    public void CrossProject_ForwardedTuple_UsesSiblingElementEvidence()
    {
        const string sourceB = @"
namespace LibB
{
    public static class Parser
    {
        public static (string Action, string Method) Parse()
        {
            return (null, ""POST"");
        }
    }
}";
        const string sourceA = @"
using LibB;

namespace LibA
{
    public static class Forwarder
    {
        public static (string Action, string Method) Parse()
        {
            return Parser.Parse();
        }
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

        Assert.Contains("func Parse() (string?, string)", printedB);
        Assert.Contains("func Parse() (string?, string)", printedA);
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
