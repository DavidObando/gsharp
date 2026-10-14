// <copyright file="Issue2469TupleElementNullabilityTranslationTests.cs" company="GSharp">
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

open class Issue2469TupleElementNullabilityTranslationTests {
    @Fact
    func Oblivious_NamedTupleLiteral_PromotesEachNullElement() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

public static class Parser
{
    public static (string Action, string Method, Dictionary<string, string> Inputs) Parse(string text)
    {
        if (string.IsNullOrEmpty(text))
            return (null, null, null);

        return ("/login", "POST", new Dictionary<string, string>());
    }

    public static void Inspect(string text)
    {
        var parsed = Parse(text);
        var method = parsed.Method;
    }
}`)
        Assert.Contains(
            "func Parse(text string) (Action string?, Method string?, Inputs Dictionary[string, string]?)",
            printed
        )
        Assert.Contains("let method string? = parsed.Method", printed)
        Assert.DoesNotContain("nil!!", printed)
    }

    @Fact
    func Oblivious_NestedConditionalSwitchAndForwardedTuple_PromoteOnlyAffectedLeaves() {
        let printed = TranslateOblivious(`
public static class Parser
{
    public static ((string Left, string Right) Names, int Count, string Keep, int? Maybe) Pick(bool flag, int value)
    {
        (string Left, string Right) names =
            flag ? (null, "right") : value switch
            {
                0 => ("left", null),
                _ => ("left", "right")
            };

        var result = (Names: names, Count: 1, Keep: "fixed", Maybe: (int?)null);
        return result;
    }
}`)
        Assert.Contains(
            "func Pick(flag bool, value int32) (Names (Left string?, Right string?), Count int32, Keep string, Maybe int32?)",
            printed
        )
    }

    @Fact
    func Oblivious_AsyncInterfaceAndOverrideContracts_StayInLockstep() {
        let printed = TranslateOblivious(`
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
        return (null, "GET");
    }

    public async Task<(string Action, string Method)> ParseAsync()
    {
        return (null, "POST");
    }
}`)
        Assert.Contains("func ParseAsync() Task[(Action string?, Method string)];", printed)
        Assert.Contains("async func ParseAsync() (Action string?, Method string)", printed)
        Assert.Contains("open func Parse() (Action string?, Method string);", printed)
        Assert.Contains("override func Parse() (Action string?, Method string)", printed)
    }

    @Fact
    func Oblivious_GenericAndDeconstructionFlow_PreserveValueElements() {
        let printed = TranslateOblivious(`
public static class Parser
{
    public static (T Value, int Count, int? Maybe) Generic<T>() where T : class
    {
        return (null, 0, null);
    }

    public static (string First, string Second) Get()
    {
        return (null, "second");
    }

    public static string Forward()
    {
        var (first, second) = Get();
        return first;
    }
}`)
        Assert.Contains("func Generic[T class]() (Value T?, Count int32, Maybe int32?)", printed)
        Assert.Contains("func Get() (First string?, Second string)", printed)
        Assert.Contains("func Forward() string?", printed)
    }

    @Fact
    func EnabledCompilation_PreservesDeclaredTupleAnnotations() {
        let printed = TranslateEnabled(`
#nullable enable

public static class Parser
{
    public static (string Required, string? Optional, int Count, int? Maybe) Parse()
    {
        return ("required", null, 0, null);
    }
}`)
        Assert.Contains("func Parse() (Required string, Optional string?, Count int32, Maybe int32?)", printed)
        Assert.DoesNotContain("Required string?", printed)
    }

    @Fact
    func CrossProject_ForwardedTuple_UsesSiblingElementEvidence() {
        const sourceB = `
namespace LibB
{
    public static class Parser
    {
        public static (string Action, string Method) Parse()
        {
            return (null, "POST");
        }
    }
}`
        const sourceA = `
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
}`
        let projectB = LoadOblivious(sourceB, "LibB")
        let projectA = LoadOblivious(sourceA, "LibA", []MetadataReference{projectB.Compilation.ToMetadataReference()})
        let siblings = []CSharpCompilation{projectA.Compilation, projectB.Compilation}
        let printedB = TranslateProject(projectB, siblings)
        let printedA = TranslateProject(
            projectA,
            siblings,
            "Consumer fixture omits the sibling Parser declaration from its emitted G# binding input."
        )
        Assert.Contains("func Parse() (Action string?, Method string)", printedB)
        Assert.Contains("func Parse() (Action string?, Method string)", printedA)
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
