// <copyright file="Issue6246NullConditionalStaticExtensionAssertionTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Runtime.Loader
import Xunit

/// Issue #6246: when `BuildNullConditionalStaticExtensionHelper` guards a
/// receiver with `if receiver != nil`, a fresh immutable `let` capture, a
/// statically non-null expression, or a stable local/parameter receiver is
/// already narrowed inside the guarded branch and must not emit a redundant
/// `receiver!!` (GS0536). Non-narrowable receivers (e.g. primary-constructor
/// fields or unspilled fallback expressions) keep `!!`.
open class Issue6246NullConditionalStaticExtensionAssertionTests {
    @Fact
    func PointerParameterStaticExtensionHelper_OmitsRedundantReceiverAssertionAndPreservesOrder() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public sealed class Host
    {
        public string Tag;
        public Host(string tag) { Tag = tag; }
    }

    public static unsafe class Extensions
    {
        public static string Trace = "";

        public static void Log(this Host host, int* ptr)
        {
            Trace += "L(" + host.Tag + "," + (ptr == null ? "nil" : (*ptr).ToString()) + ");";
        }

        public static int Probe(this Host host, int* ptr)
        {
            Trace += "P(" + host.Tag + "," + (ptr == null ? "nil" : (*ptr).ToString()) + ");";
            return host.Tag.Length + (ptr == null ? 0 : *ptr);
        }
    }

    public static unsafe class P
    {
        private static Host? Make(bool present)
        {
            Extensions.Trace += present ? "M1;" : "M0;";
            return present ? new Host("ok") : null;
        }

        private static int* Argument(int value)
        {
            Extensions.Trace += "A;";
            return (int*)value;
        }

        public static string Run()
        {
            Make(false)?.Log(Argument(1));
            Make(true)?.Log(default(int*));
            int? absent = Make(false)?.Probe(Argument(2));
            int x = 5;
            int? present = Make(true)?.Probe(&x);
            return (absent == null) + "|" + present + "|" + Extensions.Trace;
        }
    }
}
`, "True|7|M0;M1;L(ok,nil);M0;M1;P(ok,5);", allowUnsafeIl: true)
        Assert.DoesNotContain("receiver!!", printed, StringComparison.Ordinal)
        Assert.Contains("Extensions.Log(receiver, Argument(1))", printed, StringComparison.Ordinal)
        Assert.Contains("Extensions.Log(receiver_2, default(*int32))", printed, StringComparison.Ordinal)
    }

    @Fact
    func ReferenceAndNullableValueStaticExtensionHelpers_OmitRedundantReceiverAssertions() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public sealed class Host
    {
        public string Name;
        public Host(string name) { Name = name; }
    }

    public readonly struct ValBox
    {
        public int Number { get; }
        public ValBox(int number) { Number = number; }
    }

    public sealed class Config
    {
        public Host Item = new Host("cfg");
    }

    public static class FirstExtensions
    {
        public static string Trace = "";

        public static void Log(this Host host, int value)
        {
            Trace += host.Name + ":" + value + ";";
        }

        public static int Score(this ValBox box, int delta)
        {
            Trace += "V:" + (box.Number + delta) + ";";
            return box.Number + delta;
        }
    }

    public static class P
    {
        private static Host? MakeHost(bool present) => present ? new Host("h") : null;
        private static ValBox? MakeVal(bool present) => present ? new ValBox(10) : null;
        private static Config? MakeConfig(bool present) => present ? new Config() : null;

        private static string RunLocal(Host? localHost, ValBox? localVal)
        {
            localHost?.Log(3);
            int? a = localVal?.Score(4);
            return a?.ToString() ?? "nil";
        }

        public static string Run()
        {
            MakeHost(false)?.Log(1);
            MakeHost(true)?.Log(2);
            MakeConfig(false)?.Item.Log(5);
            MakeConfig(true)?.Item.Log(6);
            int? v0 = MakeVal(false)?.Score(1);
            int? v1 = MakeVal(true)?.Score(2);
            string r0 = RunLocal(null, null);
            string r1 = RunLocal(new Host("p"), new ValBox(20));
            return (v0 == null) + "|" + v1 + "|" + r0 + "|" + r1 + "|" + FirstExtensions.Trace;
        }
    }
}
`, "True|12|nil|24|h:2;cfg:6;V:12;p:3;V:24;", extraSource: `
namespace Demo.Other
{
    public static class SecondExtensions
    {
        public static void Log(this Demo.Host host, int value) { }
        public static int Score(this Demo.ValBox box, int delta) => 0;
    }
}
`)
        Assert.DoesNotContain("receiver!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("localHost!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("localVal!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func PrimaryConstructorFieldReceiverAndDirectNullableField_KeepRequiredAssertions_NegativeControls() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public sealed class Host
    {
        public string Name;
        public Host(string name) { Name = name; }
    }

    public static class FirstExtensions
    {
        public static string Trace = "";

        public static void Log(this Host host, int value)
        {
            Trace += host.Name + ":" + value + ";";
        }
    }

    public sealed class Holder(Host? host)
    {
        public void Trigger() => host?.Log(7);
    }

    public static class P
    {
        private static Host? directField = new Host("df");

        public static string Run()
        {
            new Holder(null).Trigger();
            new Holder(new Host("pc")).Trigger();
            directField!.Log(9);
            return FirstExtensions.Trace;
        }
    }
}
`, "pc:7;df:9;", extraSource: `
namespace Demo.Other
{
    public static class SecondExtensions
    {
        public static void Log(this Demo.Host host, int value) { }
    }
}
`)
        Assert.Contains("host!!", printed, StringComparison.Ordinal)
        Assert.Contains("directField!!", printed, StringComparison.Ordinal)
    }

    shared {
        private func AssertRunsLikeCSharp(
            source string,
            expectedOutput string,
            allowUnsafeIl bool = false,
            extraSource string? = nil
        ) string {
            let sources = List[(FileName string, Source string)]{("Snippet.cs", source)}
            if extraSource != nil {
                sources.Add(("Other.cs", extraSource))
            }
            let project = CSharpProjectLoader.LoadInMemory(sources)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            using let peStream = MemoryStream()
            let emitted = project.Compilation.Emit(peStream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let loadContext = AssemblyLoadContext("Issue6246", isCollectible: true)
            var expected string
            try {
                peStream.Position = 0
                expected = cast[string](
                    loadContext.LoadFromStream(peStream).GetType("Demo.P", throwOnError: true)!!.GetMethod(
                        "Run"
                    )!!.Invoke(nil, nil)
                )
            } finally {
                loadContext.Unload()
            }
            Assert.Equal(expectedOutput, expected)

            let translator = CSharpToGSharpTranslator()
            let printedList = List[string]()
            for document in project.Documents {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = translator.TranslateDocument(document, context)
                Assert.DoesNotContain(
                    context.Diagnostics,
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                )
                printedList.Add(GSharpPrinter.Print(unit))
            }
            let printed = printedList[0]
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printedList.ToArray())
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must bind cleanly. Errors:\n" + string.Join("\n", roundTrip!!.Errors) +
                    "\n\nPrinted:\n" +
                    string.Join("\n---\n", printedList)
            )
            CompileVerifyAndRun(printedList, "System.Console.WriteLine(Demo.P.Run())", expected, allowUnsafeIl)
            return printed
        }

        private func CompileVerifyAndRun(
            printedSources IReadOnlyList[string],
            callExpression string,
            expectedOutput string,
            allowUnsafeIl bool
        ) {
            let compiler string? = LocalFunctionHoistTranslationTests.FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-6246-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let args = List[string]{compiler!!, "/target:exe"}
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                args.Add("/out:$dllPath")
                for var i = 0; i < printedSources.Count; i++ {
                    let gsPath = Path.Combine(workDir, "Snippet_$i.gs")
                    File.WriteAllText(gsPath, printedSources[i])
                    args.Add(gsPath)
                }
                let mainPath = Path.Combine(workDir, "Main.gs")
                File.WriteAllText(mainPath, callExpression + Environment.NewLine)
                args.Add(mainPath)
                let compile = ProcessRunner.Run("dotnet", args.ToArray(), timeout: TimeSpan.FromSeconds(60))
                let combinedPrinted = string.Join("\n---\n", printedSources)
                Assert.False(compile.TimedOut, "gsc timed out:\n" + compile.Output)
                Assert.True(
                    compile.ExitCode == 0 && !compile.Output.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet. Output:\n" +
                        compile.Output +
                        "\n\nTranslated G#:\n" +
                        combinedPrinted
                )
                Assert.True(
                    !compile.Output.Contains("GS0536", StringComparison.Ordinal),
                    "gsc must not report redundant assertions. Output:\n" +
                        compile.Output +
                        "\n\nTranslated G#:\n" +
                        combinedPrinted
                )

                let repoRoot = GsharpTestProjectRunner.FindRepoRootAbove(AppContext.BaseDirectory) ??
                    GsharpTestProjectRunner.FindRepoRoot()
                if repoRoot != nil {
                    let runner = IlVerifyRunner(repoRoot)
                    let verify = runner.Verify(dllPath)
                    if !allowUnsafeIl &&
                        verify.Status != IlVerifyStatus.Skipped &&
                        verify.Status != IlVerifyStatus.Unavailable {
                        Assert.True(
                            verify.Status == IlVerifyStatus.Passed,
                            "ILVerify must pass. Output:\n" + verify.Output + "\n\nTranslated G#:\n" + combinedPrinted
                        )
                    } else if allowUnsafeIl && verify.Status == IlVerifyStatus.Failed {
                        let unexpected = verify
                            .Errors
                            .Where(
                            (e IlVerifyError) -> !(e.Code is "UnmanagedPointer" or "StackUnexpected" or "StackByRef")
                        )
                            .ToList()
                        Assert.True(
                            unexpected.Count == 0,
                            "Unexpected ILVerify errors beyond known unsafe-pointer codes:\n" + string.Join(
                                "\n",
                                unexpected.Select((e IlVerifyError) -> e.RawLine)
                            )
                        )
                    }
                }

                let run = ProcessRunner.Run("dotnet", []string{dllPath}, timeout: TimeSpan.FromSeconds(60))
                Assert.False(run.TimedOut, "Translated program timed out:\n" + run.Output)
                Assert.True(run.ExitCode == 0, "Translated program must exit 0. Output:\n" + run.Output)
                Assert.Equal(expectedOutput + Environment.NewLine, run.Stdout)
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
