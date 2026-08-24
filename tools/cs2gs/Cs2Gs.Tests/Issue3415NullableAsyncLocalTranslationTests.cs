// <copyright file="Issue3415NullableAsyncLocalTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue3415NullableAsyncLocalTranslationTests
{
    private const string Source = """
        #nullable enable
        using System.Threading;
        using System.Threading.Tasks;

        namespace Demo;

        public sealed class Probe
        {
            private readonly AsyncLocal<string?> state = new AsyncLocal<string?>();

            public int Run()
            {
                state.Value = null;
                ExecutionContext? nullContext = ExecutionContext.Capture();
                if (nullContext == null)
                {
                    return -1;
                }

                state.Value = "outer";
                ExecutionContext? outerContext = ExecutionContext.Capture();
                if (outerContext == null)
                {
                    return -2;
                }

                state.Value = "root";
                int score = 0;
                ExecutionContext.Run(outerContext, _ =>
                {
                    if (state.Value == "outer")
                    {
                        score++;
                    }

                    state.Value = "inner-parent";
                    ExecutionContext.Run(nullContext, _ =>
                    {
                        if (state.Value == null)
                        {
                            score++;
                        }

                        state.Value = "inner-child";
                    }, null);

                    if (state.Value == "inner-parent")
                    {
                        score++;
                    }
                }, null);

                if (state.Value == "root")
                {
                    score++;
                }

                var barrier = new Barrier(2);
                state.Value = "left";
                Task<bool> left = Task.Run(() =>
                {
                    bool inherited = state.Value == "left";
                    state.Value = null;
                    barrier.SignalAndWait();
                    return inherited && state.Value == null;
                });

                state.Value = "right";
                Task<bool> right = Task.Run(() =>
                {
                    bool inherited = state.Value == "right";
                    state.Value = "right-child";
                    barrier.SignalAndWait();
                    return inherited && state.Value == "right-child";
                });

                if (left.Result)
                {
                    score++;
                }

                if (right.Result)
                {
                    score++;
                }

                if (state.Value == "right")
                {
                    score++;
                }

                return score;
            }
        }
        """;

    [Fact]
    public void NullableAsyncLocal_TranslatesDirectStorageAndRunsWithExecutionContextIsolation()
    {
        string printed = Translate(Source);

        Assert.Contains("AsyncLocal[string?]", printed, StringComparison.Ordinal);
        Assert.Contains("state.Value = nil", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("?? \"\"", printed, StringComparison.Ordinal);

        var result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit =
            new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            string.Join(Environment.NewLine, roundTrip.Errors) +
                Environment.NewLine +
                printed);
        return printed;
    }
}
