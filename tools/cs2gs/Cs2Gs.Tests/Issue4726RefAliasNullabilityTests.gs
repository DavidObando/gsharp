package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Text
import Xunit

class Issue4726RefAliasNullabilityTests {
    @Fact
    func GuardedIteratorAlias_PreservesNullableStorageAndCSharpOutput() {
        const source = `using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        if (text != null) {
            ref string alias = ref text;
            alias = null;
            yield return (text, 1);
        }
    }
    public static string Run() {
        string output = "";
        foreach (var row in Rows(true)) { output += "unexpected"; }
        foreach (var row in Rows(false)) {
            output += (row.Text ?? "null") + ":" + row.Code;
        }
        return output;
    }
}`
        let printed = Translate(source)
        Assert.Contains("var ref alias string? = text", printed)
        Assert.Contains("sequence[(Text string?, Code int32)]", printed)
        Assert.DoesNotContain("text!!", printed)
        Assert.DoesNotContain("alias!!", printed)
        AssertParity(source, printed, "null:1")
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func NullStoreThroughAlias_PromotesReferentAndAliasChain(chain bool, wrapped bool) {
        let text = if wrapped {
            "(text!)"
        } else {
            "text"
        }
        let first = if wrapped {
            "(first!)"
        } else {
            "first"
        }
        let alias = if chain {
            "ref string first = ref $text; ref string alias = ref $first;"
        } else {
            "ref string alias = ref $text;"
        }
        let source = `public static class Obj {
    public static string Clear() {
        string text = "x";
        ` + alias + `
        alias = null;
        return text;
    }
    public static string Run() => Clear() ?? "null";
}`
        let printed = Translate(source)
        Assert.Contains("var text string? = \"x\"", printed)
        Assert.Contains("var ref alias string? =", printed)
        if chain {
            Assert.Contains("ref first string? = text", printed)
        }
        AssertParity(source, printed, "null")
    }

    @Fact
    func NullableFieldStorage_PromotesItsReadOnlyAlias() {
        const source = `public class Holder { public string Text = "x"; }
public static class Obj {
    public static void Clear(Holder holder) { holder.Text = null; }
    public static string Run() {
        var holder = new Holder();
        Clear(holder);
        ref readonly string alias = ref holder.Text;
        return alias ?? "null";
    }
}`
        let printed = Translate(source)
        Assert.Contains("var Text string?", printed)
        Assert.Contains("let ref readonly alias string? = holder.Text", printed)
        AssertParity(source, printed, "null")
    }

    @Fact
    func NonNullAlias_DoesNotWidenUnrelatedStorage() {
        const source = `public static class Obj {
    public static string Run() {
        string text = "x";
        ref string alias = ref text;
        alias = "keep";
        return text;
    }
}`
        let printed = Translate(source)
        Assert.Contains("var ref alias string = text", printed)
        Assert.DoesNotContain("string?", printed)
        AssertParity(source, printed, "keep")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CoalesceOnlyEvidence_PromotesBothSidesOfRefStorage(coalesceReferent bool) {
        let read = if coalesceReferent {
            "text"
        } else {
            "alias"
        }
        let source = `public static class Obj {
    public static string Run() {
        string text = "x";
        ref string alias = ref text;
        return ` + read + ` ?? "fallback";
    }
}`
        let printed = Translate(source)
        AssertParity(source, printed, "x")
        Assert.Contains("var text string? = \"x\"", printed)
        Assert.Contains("let ref alias string? = text", printed)
    }

    @Fact
    func CoalesceOnlyAliasEvidence_PromotesItsFieldStorage() {
        const source = `public class Holder { public string Text = "x"; }
public static class Obj {
    public static string Run() {
        var holder = new Holder();
        ref readonly string alias = ref holder.Text;
        return alias ?? "fallback";
    }
}`
        let printed = Translate(source)
        AssertParity(source, printed, "x")
        Assert.Contains("var Text string?", printed)
        Assert.Contains("let ref readonly alias string? = holder.Text", printed)
    }

    @Theory
    @InlineData("fixed-field")
    @InlineData("array")
    @InlineData("ref-return")
    func RefStorageBoundaries_CoalescingAliasMatchesCSharp(storage string) {
        let source = switch storage {
            case "fixed-field": `#nullable enable
public class Holder { public string Text = "x"; }
#nullable disable
public static class Obj {
    public static string Run() {
        var holder = new Holder();
        ref readonly string alias = ref holder.Text;
        return alias ?? "fallback";
    }
}`
            case "array": `public static class Obj {
    public static string Run() {
        var xs = new[] { "x" };
        ref string alias = ref xs[0];
        return alias ?? "fallback";
    }
}`
            default: `public static class Obj {
    private static string text = "x";
    public static ref string Borrow() => ref text;
    public static string Run() {
        ref string alias = ref Borrow();
        return alias ?? "fallback";
    }
}`
        }
        AssertParity(source, Translate(source), "x")
    }

    @Theory
    @InlineData("(string)null")
    @InlineData("null as string")
    @InlineData("default(string)")
    @InlineData("(string)default")
    func CastNullNestedIterator_KeepsOuterContractAndRuntimeParity(value string) {
        let source = `using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        IEnumerable<(string Text, int Code)> Missing() {
            yield return choose ? (` + value + `, 1) : ("x", 2);
        }
        int count = 0;
        foreach (var row in Missing()) {
            count++;
            if (choose) {
                if (row.Text != null || row.Code != 1) { throw new System.InvalidOperationException("nested tuple"); }
            } else {
                if (row.Text != "x" || row.Code != 2) { throw new System.InvalidOperationException("nested tuple"); }
            }
        }
        if (count != 1) { throw new System.InvalidOperationException("nested row count"); }
        if (choose) { yield break; }
        yield return ("keep", 2);
    }
    public static IEnumerable<(string Text, int Code)> MissingRows(bool choose) {
        yield return choose ? (` + value + `, 1) : ("x", 2);
    }
    public static string Run() {
        string output = "";
        foreach (var row in Rows(true)) { output += "unexpected"; }
        foreach (var row in Rows(false)) { output += row.Text + ":" + row.Code + "|"; }
        foreach (var row in MissingRows(true)) { output += (row.Text ?? "null") + ":" + row.Code + "|"; }
        foreach (var row in MissingRows(false)) { output += row.Text + ":" + row.Code; }
        return output;
    }
}`
        let printed = Translate(source)
        Assert.Contains("let Missing = func () IEnumerable[(Text string?, Code int32)]", printed)
        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed)
        Assert.Contains("func MissingRows(choose bool) sequence[(Text string?, Code int32)]", printed)
        AssertParity(source, printed, "keep:2|null:1|x:2")
    }

    shared {
        private func Translate(source string) string {
            let loaded = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", source)})
            Assert.True(loaded.BoundWithoutErrors, string.Join(Environment.NewLine, loaded.ErrorDiagnostics))
            Assert.Equal(NullableContextOptions.Disable, loaded.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(loaded.Documents)
            let context = TranslationContext(loaded.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }

        private func AssertParity(source string, printed string, expected string) {
            let loaded = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", source)})
            using let stream = MemoryStream()
            let emitted = loaded.Compilation.Emit(stream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            stream.Position = 0
            let context = AssemblyLoadContext("issue4726-oracle", isCollectible: true)
            var oracle string
            try {
                let assembly = context.LoadFromStream(stream)
                let method = assembly.GetType("Obj")!!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!!
                oracle = Assert.IsType[string](method.Invoke(nil, nil))
            } finally {
                context.Unload()
            }
            Assert.Equal(expected, oracle)
            let root = GsharpTestProjectRunner.FindRepoRootAbove(AppContext.BaseDirectory)
            Assert.NotNull(root)
            let compiler = Path.Combine(root!!, "out", "bin", "Release", "Compiler", "gsc.dll")
            Assert.True(File.Exists(compiler), "Build gsc before running this test.")
            let directory = Path.Combine(AppContext.BaseDirectory, "issue4726", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let input = Path.Combine(directory, "Source.gs")
                let output = Path.Combine(directory, "Source.dll")
                File.WriteAllText(input, printed + Environment.NewLine + "System.Console.WriteLine(Obj.Run())")
                let (compileExit, compileLog) = RunDotnet(
                    compiler,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/out:" + output,
                    input
                )
                Assert.True(compileExit == 0, compileLog + Environment.NewLine + printed)
                Assert.DoesNotContain("GS0612", compileLog)
                let (runExit, stdout) = RunDotnet(output)
                Assert.True(runExit == 0, stdout)
                Assert.Equal(Encoding.UTF8.GetBytes(oracle + Environment.NewLine), Encoding.UTF8.GetBytes(stdout))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(120_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                throw TimeoutException("The compiler or translated program did not finish.")
            }
            return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
        }
    }
}
