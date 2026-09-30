// <copyright file="Issue1898AnonMethodTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1898: a C# anonymous method (<c>delegate (params) { … }</c>,
/// <c>AnonymousMethodExpressionSyntax</c>) had no canonical G# form and
/// reported the CS2GS-GAP "expression 'AnonymousMethodExpression' has no
/// canonical G# form yet" for every shape. An anonymous method is
/// semantically a block-bodied lambda (C# spec §12.19), so it is routed
/// through the same <c>TranslateLambda</c> lowering already used for
/// <c>ParenthesizedLambdaExpressionSyntax</c>/<c>SimpleLambdaExpressionSyntax</c>
/// — closures, spills, and mutability scoping all just work. The one
/// anonymous-method-specific wrinkle is the parameterless
/// <c>delegate { … }</c> form (distinct from <c>delegate () { … }</c>): C#
/// infers its parameter list from the target delegate type, so the
/// translator synthesizes G# parameters from the converted delegate type's
/// Invoke signature.
/// </summary>
public class Issue1898AnonMethodTranslationTests
{
    [Fact]
    public void SingleParameter_LowersToBlockBodiedFunctionLiteral()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("(x int32) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("return x + 1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_TargetingAction_InfersZeroParams()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public void Describe()
        {
            Action greet = delegate
            {
                Console.WriteLine(""hi"");
            };
            greet();
        }
    }
}
");

        Assert.Contains("() -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(\"hi\")", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_TargetingFuncWithParams_SynthesizesParamsFromDelegateSignature()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("return 7", rendered, StringComparison.Ordinal);
        Assert.Contains("(_ int32, _ int32) -> {", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__" + "anon", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_SynthesizedParamNeverShadowsCapturedOuterLocal()
    {
        // Bug: synthesizing the Action<string>.Invoke param with its DECLARED
        // name ("obj") would shadow the outer captured `obj` local — the body
        // can never reference the delegate's own param (it has no source name
        // in this form), so a fresh non-source name is required.
        string rendered = Render(@"
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
            a(""ignored"");
        }
    }
}
");

        Assert.Contains("(_ string) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(obj)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__" + "anon", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_DiscardParamsCannotShadowSourceGeneratedOrReservedNames()
    {
        string retiredName = "__" + "anon0";
        string rendered = Render(@"
using System;

namespace Corpus.Issue1898
{
    public delegate void Sink(string obj, int RETIRED_NAME, bool init);

    public class Holder
    {
        public void Describe()
        {
            string obj = ""captured"";
            int RETIRED_NAME = 42;
            bool init = true;
            Sink sink = delegate
            {
                Console.WriteLine(obj + "":"" + RETIRED_NAME + "":"" + init);
            };
            sink(""ignored"", 0, false);
        }
    }
}
".Replace("RETIRED_NAME", retiredName, StringComparison.Ordinal));

        Assert.Contains("(_ string, _ int32, _ bool) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__" + "anon1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_PreservesRefInAndVariadicInvokeParameters()
    {
        string rendered = Render(@"
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
");

        // C# permits an omitted anonymous-method parameter list for ref, in,
        // and params-array delegate slots. `out` is not a valid counterpart:
        // the anonymous body cannot name the slot and therefore cannot perform
        // the definite assignment required for an out parameter.
        Assert.Contains("(ref _ int32) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("(in _ int32) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("(_ ...int32) -> {", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__" + "anon", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_WithoutTargetStillReportsTheExistingFallback()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", "class Holder { void M() { var d = delegate { }; } }") });
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);

        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("cannot infer its parameter list", StringComparison.Ordinal));
    }

    [Fact]
    public async Task G09FunctionsConsole_MigratesGreen_EndToEnd()
    {
        string compiler = FindCompiler();
        Assert.True(
            compiler != null,
            "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string corpus = TestFixtureSource.Resolve("tools", "cs2gs", "corpus");
        string outRoot = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "g09-anonymous-method-e2e",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outRoot);
        try
        {
            var pipeline = new MigrationPipeline(
                new PipelineOptions { GscPath = compiler, OutputRoot = outRoot });
            CorpusApp g09 = CorpusDiscovery.FindById(corpus, "corpus/G09-Functions-Console");

            Assert.NotNull(g09);
            RunResult result = await pipeline.RunAsync(new[] { g09 });
            AppResult app = Assert.Single(result.Apps);
            Assert.True(
                app.Succeeded,
                "corpus/G09-Functions-Console must migrate green end-to-end (issue #4297). Failure category: " +
                    (app.FailureCategory ?? "<none>") + "; artifacts: " + string.Join(", ", app.Artifacts));
            Assert.Empty(app.Artifacts);
            Assert.Collection(
                app.Stages,
                stage => Assert.Equal("translate", stage.Stage),
                stage => Assert.Equal("compile", stage.Stage),
                stage => Assert.Equal("ilverify", stage.Stage),
                stage => Assert.Equal("test-parity", stage.Stage));
            Assert.All(app.Stages, stage => Assert.Equal("passed", stage.Status));
        }
        finally
        {
            DeleteDirectory(outRoot);
        }
    }

    [Fact]
    public void TwoParameters_LowersToBlockBodiedFunctionLiteral()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("(a int32, b int32) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("return a + b", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void CapturesOuterLocal_ClosureWorksViaSharedLambdaPath()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("x + offset", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    "Compiler",
                    "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static void DeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch (IOException)
        {
            // Best effort: test-host file handles can remain open briefly on Windows.
        }
        catch (UnauthorizedAccessException)
        {
            // Best effort, as above.
        }
    }
}
