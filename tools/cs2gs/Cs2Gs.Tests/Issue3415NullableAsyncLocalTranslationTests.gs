// <copyright file="Issue3415NullableAsyncLocalTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

class Issue3415NullableAsyncLocalTranslationTests {
    @Fact
    func NullableAsyncLocal_TranslatesDirectStorageAndRunsWithExecutionContextIsolation() {
        let printed = Translate(Source)
        Assert.Contains("AsyncLocal[string?]", printed, StringComparison.Ordinal)
        Assert.Contains("state.Value = nil", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("?? \"\"", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe().Run()")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    shared {
        private const Source string = `#nullable enable
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
}`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                roundTrip!!.Success,
                string.Join(Environment.NewLine, roundTrip!!.Errors) + Environment.NewLine + printed
            )
            return printed
        }
    }
}
