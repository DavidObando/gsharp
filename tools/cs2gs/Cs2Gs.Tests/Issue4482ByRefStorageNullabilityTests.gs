// <copyright file="Issue4482ByRefStorageNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Issue #4482: cs2gs widens an oblivious `out`/`ref` parameter that
/// is assigned `null` to `T?`. Since #4461, gsc requires the storage
/// passed to a by-ref parameter to match its nullability exactly (GS0612), so the
/// caller's storage must widen with it. Two shapes did not: an array ELEMENT
/// passed by `out` (`out failures[i]`, from
/// `CSharpToGSharpTranslator.Patterns`, which broke the hot-core guard),
/// and a local passed by `ref`. Declared, inline and inferred `out`
/// locals and a field already widened.
open class Issue4482ByRefStorageNullabilityTests {
    /// Every by-ref storage shape widens with its parameter: the translation
    /// compiles with no GS0612 and runs with C#'s result, the nils included.
    @Fact
    func ByRefStorage_WidensWithTheParameter_CompilesCleanAndRuns() {
        let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Snippet.cs", Source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("let failures = [2]string?", printed)
        Assert.Contains("let callerArray = []string?{\"x\"}", printed)
        Assert.Contains("var genericRefCallerArray = []string?{\"x\"}", printed)
        Assert.Contains("private func MakeArray() []string?", printed)
        Assert.Contains("private func MakeOutArray(out value []string?)", printed)
        Assert.Contains("private func ForwardParamArray(forwarded []string?) string", printed)
        Assert.Contains("private func UseRefParamArray(ref refParamArray []string?) string", printed)
        Assert.Contains("private func UseGenericRefParamArray[T](ref refParamArray []string?) string", printed)
        Assert.Contains("let a = [1]T?", printed)
        Assert.Contains("UseParamsJagged([]string{\"x\"})", printed)
        Assert.Contains("let dictKey = []string{\"k\"}", printed)
        Assert.Contains("var r string? = \"x\"", printed)
        let (compileOutput, runOutput) = CompileAndRun(printed, "Holder.Run()")
        Assert.DoesNotContain("GS0612", compileOutput)
        Assert.Equal("3-positive-positivepositive-----positive--------", runOutput.Trim())
    }

    shared {
        private const Source string = `
public class Holder
{
    public string Field;
    public string[] FieldArray = new string[1];

    private static int Find(int x, out string failureReason)
    {
        failureReason = null;
        if (x > 0) { failureReason = "positive"; return 1; }
        return 0;
    }

    private static void Swap(ref string s) { s = null; }

    private static void ClearRow(out string[] row) { row = null; }

    private static string[] MakeArray() => new string[] { "x" };

    private static void MakeOutArray(out string[] value)
    {
        value = new string[] { "x" };
    }

    private static string UseParamArray(string[] paramArray)
    {
        Find(0, out paramArray[0]);
        return paramArray[0] ?? "-";
    }

    private static string ForwardParamArray(string[] forwarded)
    {
        return UseParamArray(forwarded);
    }

    private static string UseRefParamArray(ref string[] refParamArray)
    {
        Find(0, out refParamArray[0]);
        return refParamArray[0] ?? "-";
    }

    private static string UseGenericRefParamArray<T>(ref string[] refParamArray)
    {
        Find(0, out refParamArray[0]);
        return refParamArray[0] ?? "-";
    }

    private static string UseParamsJagged(params string[][] rows)
    {
        ClearRow(out rows[0]);
        return rows[0] == null ? "-" : "x";
    }

    private static void WalkRecursiveParams<T>(int depth, params T[] xs) where T : class
    {
        if (depth > 0)
        {
            WalkRecursiveParams<T[]>(depth - 1, xs);
        }
    }

#nullable enable
    private static void ClearGeneric<T>(out T? value) where T : class
    {
        value = null;
    }

    private static string UseGenericElementArray<T>(T seed) where T : class
    {
        var a = new T[1];
        a[0] = seed;
        ClearGeneric<T>(out a[0]);
        return a[0] == null ? "-" : "x";
    }

    private static string UseDictionaryArrayValue(System.Collections.Generic.Dictionary<string[], string?[]> rows, string[] key)
    {
        Find(0, out rows[key][0]!);
        return rows[key][0] ?? "-";
    }
#nullable restore

    public static string Run()
    {
        WalkRecursiveParams(1, "x");
        var dictKey = new string[] { "k" };
        var dictRows = new System.Collections.Generic.Dictionary<string[], string?[]> { [dictKey] = new string?[1] { "v" } };
        string dictResult = UseDictionaryArrayValue(dictRows, dictKey);
        MakeOutArray(out var inlineOutArray);
        Find(0, out inlineOutArray[0]);
        string inlineOutResult = inlineOutArray[0] ?? "-";
        string genericElementResult = UseGenericElementArray("x");
        var failures = new string[2];
        int a = Find(0, out failures[0]);
        int b = Find(2, out string inline);
        int c = Find(0, out var inferred);
        string declared;
        int d = Find(3, out declared);
        var h = new Holder();
        int e = Find(4, out h.Field);
        string r = "x";
        Swap(ref r);
        var initialized = new string[1] { "x" };
        Find(0, out initialized[0]);
        var implicitArr = new[] { "x" };
        Swap(ref implicitArr[0]);
        string[] collectionArr = ["x"];
        Find(0, out collectionArr[0]);
        string[] bareInitArr = { "x" };
        Find(0, out bareInitArr[0]);
        string[] declaredThenAssigned;
        declaredThenAssigned = new string[1];
        Find(1, out declaredThenAssigned[0]);
        var rect = new string[1, 1];
        Find(0, out rect[0, 0]);
        Find(0, out h.FieldArray[0]);
        string paramResult = UseParamArray(new string[1]);
        var callerArray = new string[] { "x" };
        string forwardedResult = ForwardParamArray(callerArray);
        var refCallerArray = MakeArray();
        string refForwardedResult = UseRefParamArray(ref refCallerArray);
        var genericRefCallerArray = new string[] { "x" };
        string genericRefResult = UseGenericRefParamArray<int>(ref genericRefCallerArray);
        string paramsJaggedResult = UseParamsJagged(new string[] { "x" });
        return a + b + c + d + e + (failures[0] ?? "-") + (inline ?? "-") + (inferred ?? "-") + (declared ?? "-") + (h.Field ?? "-") + (r ?? "-") + (initialized[0] ?? "-") + (implicitArr[0] ?? "-") + (collectionArr[0] ?? "-") + (bareInitArr[0] ?? "-") + (declaredThenAssigned[0] ?? "-") + (rect[0, 0] ?? "") + (h.FieldArray[0] ?? "") + paramResult + forwardedResult + refForwardedResult + genericRefResult + paramsJaggedResult + dictResult + inlineOutResult + genericElementResult;
    }
}`

        private func CompileAndRun(printed string, callExpression string)(CompileOutput string, RunOutput string) {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-4482-e2e", Guid.NewGuid().ToString("N"))
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
