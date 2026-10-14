// <copyright file="Issue1898AnonMethodTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Threading.Tasks
import Xunit

/// Issue #1898: a C# anonymous method (`delegate (params) { … }`,
/// `AnonymousMethodExpressionSyntax`) had no canonical G# form and
/// reported the CS2GS-GAP "expression 'AnonymousMethodExpression' has no
/// canonical G# form yet" for every shape. An anonymous method is
/// semantically a block-bodied lambda (C# spec §12.19), so it is routed
/// through the same `TranslateLambda` lowering already used for
/// `ParenthesizedLambdaExpressionSyntax`/`SimpleLambdaExpressionSyntax`
/// — closures, spills, and mutability scoping all just work. The one
/// anonymous-method-specific wrinkle is the parameterless
/// `delegate { … }` form (distinct from `delegate () { … }`): C#
/// infers its parameter list from the target delegate type, so the
/// translator synthesizes G# parameters from the converted delegate type's
/// Invoke signature.
open class Issue1898AnonMethodTranslationTests {
    @Fact
    func SingleParameter_LowersToBlockBodiedFunctionLiteral() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public int Describe()
        {
            Func<int, int> inc = delegate (int x)
            {
                return x + 1;
            };
            return inc(41);
        }
    }
}
`)
        Assert.Contains("(x int32) -> {", rendered, StringComparison.Ordinal)
        Assert.Contains("return x + 1", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParameterlessDelegateBlock_TargetingAction_InfersZeroParams() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public void Describe()
        {
            Action greet = delegate
            {
                Console.WriteLine("hi");
            };
            greet();
        }
    }
}
`)
        Assert.Contains("() -> {", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(\"hi\")", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParameterlessDelegateBlock_TargetingFuncWithParams_SynthesizesParamsFromDelegateSignature() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public int Describe()
        {
            // The block ignores both incoming args entirely; the parameter
            // list still must be inferred from Func<int, int, int>.
            Func<int, int, int> ignoreArgs = delegate
            {
                return 7;
            };
            return ignoreArgs(1, 2);
        }
    }
}
`)
        Assert.Contains("return 7", rendered, StringComparison.Ordinal)
        Assert.Contains("(_ int32, _ int32) -> {", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__" + "anon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParameterlessDelegateBlock_SynthesizedParamNeverShadowsCapturedOuterLocal() {
        // Bug: synthesizing the Action<string>.Invoke param with its DECLARED
        // name ("obj") would shadow the outer captured `obj` local — the body
        // can never reference the delegate's own param (it has no source name
        // in this form), so a fresh non-source name is required.
        let rendered = Render(`
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public void Describe()
        {
            int obj = 42;
            Action<string> a = delegate
            {
                Console.WriteLine(obj);
            };
            a("ignored");
        }
    }
}
`)
        Assert.Contains("(_ string) -> {", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(obj)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__" + "anon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParameterlessDelegateBlock_DiscardParamsCannotShadowSourceGeneratedOrReservedNames() {
        let retiredName = "__" + "anon0"
        let rendered = Render(`
using System;

namespace Corpus.Issue1898
{
    public delegate void Sink(string obj, int RETIRED_NAME, bool init);

    public class Holder
    {
        public void Describe()
        {
            string obj = "captured";
            int RETIRED_NAME = 42;
            bool init = true;
            Sink sink = delegate
            {
                Console.WriteLine(obj + ":" + RETIRED_NAME + ":" + init);
            };
            sink("ignored", 0, false);
        }
    }
}
`.Replace("RETIRED_NAME", retiredName, StringComparison.Ordinal))
        Assert.Contains("(_ string, _ int32, _ bool) -> {", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__" + "anon1", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParameterlessDelegateBlock_PreservesRefInAndVariadicInvokeParameters() {
        let rendered = Render(`
namespace Corpus.Issue1898
{
    public delegate int RefSink(ref int value);
    public delegate int InSink(in int value);
    public delegate int VariadicSink(params int[] values);

    public class Holder
    {
        public int Describe()
        {
            int captured = 7;
            RefSink byRef = delegate { return captured; };
            InSink readOnly = delegate { return captured + 1; };
            VariadicSink variadic = delegate { return captured + 2; };
            int value = 1;
            return byRef(ref value) + readOnly(in value) + variadic(1, 2, 3);
        }
    }
}
`)
        // C# permits an omitted anonymous-method parameter list for ref, in,
        // and params-array delegate slots. `out` is not a valid counterpart:
        // the anonymous body cannot name the slot and therefore cannot perform
        // the definite assignment required for an out parameter.
        Assert.Contains("(ref _ int32) -> {", rendered, StringComparison.Ordinal)
        Assert.Contains("(in _ int32) -> {", rendered, StringComparison.Ordinal)
        Assert.Contains("(_ ...int32) -> {", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__" + "anon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParameterlessDelegateBlock_WithoutTargetStillReportsTheExistingFallback() {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Source.cs", "class Holder { void M() { var d = delegate { }; } }")}
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("cannot infer its parameter list", StringComparison.Ordinal)
        )
    }

    @Fact
    async func G09FunctionsConsole_MigratesGreen_EndToEnd() {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let corpus string? = TestFixtureSource.Resolve("tools", "cs2gs", "corpus")
        let outRoot = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "g09-anonymous-method-e2e",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(outRoot)
        try {
            let pipeline = MigrationPipeline(PipelineOptions{GscPath: compiler, OutputRoot: outRoot})
            let g09 = CorpusDiscovery.FindById(corpus, "corpus/G09-Functions-Console")!!
            Assert.NotNull(g09)
            let result = await pipeline.RunAsync([]CorpusApp{g09})
            let app = Assert.Single(result.Apps)
            Assert.True(
                app.Succeeded,
                "corpus/G09-Functions-Console must migrate green end-to-end (issue #4297). Failure category: " +
                    (app.FailureCategory ?? "<none>") +
                    "; artifacts: " +
                    string.Join(", ", app.Artifacts)
            )
            Assert.Empty(app.Artifacts)
            Assert.Collection(
                app.Stages,
                (stage StageResult) -> Assert.Equal("translate", stage.Stage),
                (stage StageResult) -> Assert.Equal("compile", stage.Stage),
                (stage StageResult) -> Assert.Equal("ilverify", stage.Stage),
                (stage StageResult) -> Assert.Equal("test-parity", stage.Stage)
            )
            Assert.All(app.Stages, (stage StageResult) -> Assert.Equal("passed", stage.Status))
        } finally {
            DeleteDirectory(outRoot)
        }
    }

    @Fact
    func TwoParameters_LowersToBlockBodiedFunctionLiteral() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public int Describe()
        {
            Func<int, int, int> add = delegate (int a, int b)
            {
                return a + b;
            };
            return add(3, 4);
        }
    }
}
`)
        Assert.Contains("(a int32, b int32) -> {", rendered, StringComparison.Ordinal)
        Assert.Contains("return a + b", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func CapturesOuterLocal_ClosureWorksViaSharedLambdaPath() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public int Describe()
        {
            int offset = 10;
            Func<int, int> addOffset = delegate (int x)
            {
                return x + offset;
            };
            return addOffset(5);
        }
    }
}
`)
        Assert.Contains("x + offset", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }

        private func DeleteDirectory(path string) {
            try {
                Directory.Delete(path, recursive: true)
            } catch (IOException) {
                // Best effort: test-host file handles can remain open briefly on Windows.

            } catch (UnauthorizedAccessException) {
                // Best effort, as above.

            }
        }
    }
}
