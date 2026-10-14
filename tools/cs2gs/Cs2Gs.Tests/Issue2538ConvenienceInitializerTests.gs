// <copyright file="Issue2538ConvenienceInitializerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #2538: C# this-constructor initializers lower canonically.
class Issue2538ConvenienceInitializerTests {
    @Fact
    func Translator_OverloadedThisInitializers_KeepDelegationCanonicalAndFirst() {
        let (unit, printed) = Translate()
        let routed = Assert.Single(unit.Members.OfType[TypeDeclaration]())
        let singleArgument = routed
            .Members
            .OfType[ConstructorDeclaration]()
            .Single((c ConstructorDeclaration) -> c.Parameters.Count == 1)
        Assert.NotNull(singleArgument.DelegatingArguments)
        Assert.Equal(2, singleArgument.DelegatingArguments!!.Count)
        Assert.DoesNotContain(
            singleArgument.Body.Statements,
            (s GStatement) -> (
                s is ExpressionStatement and
                    {Expression: InvocationExpression and {Target: IdentifierExpression and {Name: "init"}}}
            )
        )
        let delegation = printed.IndexOf("init(Trace(seed), Trace(seed + 1))", StringComparison.Ordinal)
        let parameterShadow = printed.IndexOf("var seed = seed", StringComparison.Ordinal)
        Assert.True(delegation >= 0 && parameterShadow > delegation, printed)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            roundTrip!!.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + printed
        )
    }

    @Fact
    func Compiler_OverloadedThisInitializers_AcceptsCanonicalDelegation() {
        let (_, printed) = Translate()
        let (exit, output, _) = Compile(printed)
        Assert.True(
            exit == 0 && !output.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must accept translated overloaded constructors. Output:\n" + output + `

Translated G#:
` + printed
        )
    }

    @Fact
    func Runtime_OverloadedThisInitializers_PreserveArgumentAndBodyOrder() {
        let (_, printed) = Translate()
        let (compileExit, compileOutput, assembly) = Compile(printed)
        Assert.True(compileExit == 0, compileOutput)
        let (runExit, stdout) = RunDotnet("\"$assembly\"")
        Assert.True(runExit == 0, stdout)
        Assert.Equal("231026" + Environment.NewLine, stdout)
    }

    shared {
        private const Source string = `using System;

namespace Issue2538;

public sealed class Routed
{
    private int value;

    public Routed(int left, int right)
    {
        value = (left * 10) + right;
    }

    public Routed(int seed)
        : this(Trace(seed), Trace(seed + 1))
    {
        seed++;
        value += seed;
    }

    public Routed()
        : this(2)
    {
        value += 1000;
    }

    private static int Trace(int value)
    {
        Console.Write(value);
        return value;
    }

    public int Value() => value;
}`

        private func Translate()(Unit CompilationUnit, Printed string) {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Repro.cs", Source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            return (unit, GSharpPrinter.Print(unit))
        }

        private func Compile(printed string)(Exit int32, Output string, Assembly string) {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2538-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let source = Path.Combine(workDir, "Repro.gs")
            let assembly = Path.Combine(workDir, "Repro.dll")
            File.WriteAllText(
                source,
                printed + Environment.NewLine + "Console.WriteLine(Routed().Value().ToString())" + Environment.NewLine
            )
            let (exit, output) = RunDotnet("\"$compiler\" /target:exe /out:\"$assembly\" \"$source\"")
            return (exit, output, assembly)
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
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
    }
}
