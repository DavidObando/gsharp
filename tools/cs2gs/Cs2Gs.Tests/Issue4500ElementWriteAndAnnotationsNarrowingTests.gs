// <copyright file="Issue4500ElementWriteAndAnnotationsNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4500, two cs2gs gaps from main nightly 36236554862.
///
/// 1. An element WRITE of a maybe-nil value (`names[i] = member?.Name`)
/// into a `new T[n]` array kept a non-null element type and bridged the
/// write with `!!`, which threw where C# stores the null. That is what failed
/// the migrated `Cs2Gs.Tests` (`TryGetPositionalMembers`). The element
/// now widens to `T?`, as #4482 does for out/ref elements.
///
/// 2. In a `<Nullable>annotations</Nullable>` context Roslyn runs
/// no flow analysis, so a `var` local initialized from a `T?` API and
/// "narrowed" only by `Assert.NotNull` or an earlier `x!` was left bare
/// at a later dereference. G# narrows neither, so gsc reported GS0159
/// (`Runtime.Channels.Tests`). The receiver is now asserted, as C# throws on
/// a null there too.
///
/// 3. Issue #4507: inferred local aliases share widened array-element status
/// with the local that owns the allocation.
open class Issue4500ElementWriteAndAnnotationsNarrowingTests {
    @Fact
    func ElementWriteOfMaybeNilValue_WidensTheElement_CompilesAndRuns() {
        let printed = Translate(`
public class Holder
{
    public string Name;

    private static Holder Find(int i) => i > 0 ? new Holder { Name = "h" + i } : null;

    public static string Run()
    {
        var names = new string[2];
        var members = new Holder[2];
        for (int i = 0; i < 2; i++)
        {
            Holder member = Find(i);
            names[i] = member?.Name;
            members[i] = member;
        }

        return (names[0] ?? "-") + (names[1] ?? "-") + (members[0] == null ? "N" : "Y") + members[1].Name;
    }
}`, NullableContextOptions.Disable)
        Assert.Contains("let names = [2]string?", printed)
        Assert.Contains("let members = [2]Holder?", printed)
        // The writes stay bare; a later dereference of a widened element is
        // asserted, as C# throws on a null there.
        Assert.DoesNotContain("member?.Name!!", printed)
        Assert.DoesNotContain("= member!!", printed)
        Assert.Contains("members[1]!!.Name", printed)
        Assert.Equal("-h1Nh1", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim())
    }

    /// Review of #4505: a parenthesized allocation widens like a bare one, and
    /// a widened write still gets the ordinary conversions (here the covariant
    /// array upcast G# requires).
    @Fact
    func ParenthesizedAndCovariantElementWrites_CompileAndRun() {
        let printed = Translate(`
public class Holder
{
    public static string Run()
    {
        var names = (new string[2]);
        names[0] = null;
        names[1] = "b";
        object[][] values = new object[2][];
        values[0] = null;
        values[1] = new string[] { "s" };
        return (names[0] ?? "-") + names[1] + (values[0] == null ? "N" : "Y") + values[1].Length;
    }
}`, NullableContextOptions.Disable)
        Assert.Equal("-bN1", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim())
    }

    // #4505 review: Roslyn reports `null!` as NotNull, but cs2gs erases it to
    // `nil`, so a literal or suppressed null write must still widen the element.
    @Theory
    @InlineData("null")
    @InlineData("null!")
    func LiteralOrSuppressedNullElementWrite_WidensTheElement_CompilesAndRuns(nullValue string) {
        let printed = Translate(`
public class Holder
{
    public static string Run()
    {
        var names = new string[2];
        names[0] = ` + nullValue + `;
        names[1] = "b";
        return (names[0] == null ? "N" : "Y") + names[1];
    }
}`, NullableContextOptions.Enable)
        Assert.Contains("[2]string?", printed)
        Assert.Equal("Nb", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim())
    }

    @Fact
    func WidenedArrayAliasRead_IsAsserted_CompilesAndRuns() {
        let printed = Translate(`
public class Holder
{
    public string Name;

    public static string Run()
    {
        var a = new Holder[2];
        a[0] = null;
        a[1] = new Holder { Name = "ok" };
        var b = a!;
        return (b[0] == null ? "N" : "Y") + b[1].Name;
    }
}`, NullableContextOptions.Disable)
        Assert.Contains("let a = [2]Holder?", printed)
        Assert.Contains("let b = a", printed)
        Assert.Contains("b[1]!!.Name", printed)
        Assert.Equal("Nok", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim())
    }

    @Fact
    func MaybeNilWriteThroughAliasChain_WidensOwnerAndAllReads() {
        let printed = Translate(`
public class Holder
{
    public string Name;

    public static string Run()
    {
        var a = new Holder[2];
        var (b, _) = (a, 0);
        var c = b;
        c[0] = null;
        c[1] = new Holder { Name = "ok" };
        return (a[0] == null ? "N" : "Y") + a[1].Name + b[1].Name;
    }
}`, NullableContextOptions.Disable)
        Assert.Contains("let a = [2]Holder?", printed)
        Assert.Contains("a[1]!!.Name", printed)
        Assert.Contains("b[1]!!.Name", printed)
        Assert.DoesNotContain("c[0] = nil!!", printed)
        Assert.Equal("Nokok", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim())
    }

    @Fact
    func ArrayAliasWithoutMaybeNilWrite_DoesNotWiden() {
        let printed = Translate(`
public class Holder
{
    public string Name;

    public static string Run()
    {
        var a = new Holder[1];
        a[0] = new Holder { Name = "ok" };
        var b = a;
        return b[0].Name;
    }
}`, NullableContextOptions.Disable)
        Assert.Contains("let a = [1]Holder", printed)
        Assert.DoesNotContain("[1]Holder?", printed)
        Assert.DoesNotContain("b[0]!!.Name", printed)
        Assert.Equal("ok", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim())
    }

    @Fact
    func AnnotationsContextLocal_NarrowedOnlyInCSharp_IsAsserted_CompilesAndRuns() {
        let printed = Translate(`
using System;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;

public static class Check
{
    public static void NotNull([NotNull] object value) { if (value == null) throw new Exception(); }
}

public class Holder
{
    private int field = 5;

    public static string Run()
    {
        var slot = typeof(Holder).GetField("field", BindingFlags.NonPublic | BindingFlags.Instance);
        Check.NotNull(slot);
        var h = new Holder();
        return slot.GetValue(h) == null ? "null" : "set";
    }
}`, NullableContextOptions.Annotations)
        Assert.Contains("slot!!.GetValue(h)", printed)
        Assert.Equal("set", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim())
    }

    shared {
        private func Translate(source string, options NullableContextOptions) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(options)
            )
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func CompileAndRun(printed string, callExpression string)(CompileOutput string, RunOutput string) {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-4500-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(
                    gsPath,
                    printed + Environment.NewLine + "Console.WriteLine($callExpression)" + Environment.NewLine
                )
                let (compileExit, compileOutput) = RunDotnet(compiler, "/target:exe", "/out:$dllPath", gsPath)
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet. Output:\n" + compileOutput + `

Translated G#:
` + printed
                )
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "Translated snippet must run. Output:\n" + runOutput)
                return (compileOutput, runOutput)
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string?)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            Assert.NotNull(process)
            let stdout = process!!.StandardOutput.ReadToEndAsync()
            let stderr = process!!.StandardError.ReadToEndAsync()
            if !process!!.WaitForExit(TimeSpan.FromMinutes(5)) {
                process!!.Kill(entireProcessTree: true)
                Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
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
