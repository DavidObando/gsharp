// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Diagnostics
import System.IO
import Xunit

open class Issue5875EntryStateTranslationTests {
    @Theory
    @InlineData("class", false, "field")
    @InlineData("struct", false, "field")
    @InlineData("class", true, "field")
    @InlineData("struct", true, "field")
    @InlineData("class", false, "constant")
    @InlineData("struct", false, "constant")
    @InlineData("class", true, "constant")
    @InlineData("struct", true, "constant")
    @InlineData("class", false, "property")
    @InlineData("struct", false, "property")
    @InlineData("class", true, "property")
    @InlineData("struct", true, "property")
    @InlineData("class", false, "constructor")
    @InlineData("struct", false, "constructor")
    @InlineData("class", true, "constructor")
    @InlineData("struct", true, "constructor")
    @InlineData("class", false, "constructor-only")
    @InlineData("struct", false, "constructor-only")
    @InlineData("class", true, "constructor-only")
    @InlineData("struct", true, "constructor-only")
    func PrivateEntryState_PreservesInitializationAndRuntimeOutput(owner string, asyncMain bool, kind string) {
        let state = switch kind {
            case "field": "static int Seed = 42;"
            case "constant": "const int Seed = 42;"
            case "property": "static int Seed => 42;"
            case "constructor-only": "static P() { Console.WriteLine(\"initialized\"); }"
            default: "static int Seed; static P() { Seed = 42; Console.WriteLine(\"initialized\"); }"
        }
        let reader = if kind == "constructor-only" {
            "static int Read() => 42;"
        } else {
            "static int Read() => Seed;"
        }
        let main = if asyncMain {
            "public static async Task Main() { await Task.Delay(1); Console.WriteLine(Read()); }"
        } else {
            "public static void Main() => Console.WriteLine(Read());"
        }
        LiteralConstructionRuntimeParity.AssertMatches(
            "using System; using System.Threading.Tasks; public " + owner + " P { " + state + reader + main + " }",
            Issue5875ReadabilityCounters.AssertNoSynthetics
        )
    }
}

open class Issue5877UnderscoreLocalTranslationTests {
    @Fact
    func GenericNamedArgument_UsesTheDeclarationName() {
        LiteralConstructionRuntimeParity.AssertMatches(`using System;
public class P {
    static string Echo<T>(string _) { string underscore = "suffix"; return _ + underscore; }
    public static void Main() { Console.WriteLine(Echo<int>(_: "x")); }
}`, Issue5875ReadabilityCounters.AssertNoSynthetics)
    }

    @Fact
    func RecordPrimaryParameter_PreservesPropertyReflection() {
        LiteralConstructionRuntimeParity.AssertMatches(`using System;
public record R(int _) { public int Copy { get; } = _; }
public class P {
    public static void Main() {
        var value = new R(42);
        Console.WriteLine(value.Copy);
        Console.WriteLine(typeof(R).GetProperty("_")?.GetValue(value) ?? "missing");
    }
}`, Issue5875ReadabilityCounters.AssertNoSynthetics)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CompilationReferenceNamedArgument_UsesTheOwningAllocator(referenced bool) {
        let library = if referenced {
            "namespace Library { public static class Lib { public static int Echo(int _) => _; } }"
        } else {
            "namespace Library { public static class Lib { public static int Echo(int _) => 42; } }"
        }
        LiteralConstructionRuntimeParity.AssertMatches(
            "using System; public class P { public static void Main() { Console.WriteLine(Library.Lib.Echo(_: 42)); } }",
            Issue5875ReadabilityCounters.AssertNoSynthetics,
            library
        )
    }

    @Theory
    @InlineData("local")
    @InlineData("ref")
    @InlineData("in")
    @InlineData("assignment")
    @InlineData("foreach")
    @InlineData("catch")
    @InlineData("pattern")
    @InlineData("out-declaration")
    @InlineData("out-variable")
    @InlineData("deconstruction")
    @InlineData("capture")
    @InlineData("capture-collision")
    @InlineData("collision")
    @InlineData("parameter")
    @InlineData("parameter-out")
    @InlineData("named-argument")
    @InlineData("lambda")
    @InlineData("lambda-write")
    func RealUnderscoreBindings_PreserveWritesReadsAndRuntimeOutput(position string) {
        let body = switch position {
            case "local": "string _ = \"x\"; Clear(out _); return _ ?? \"null\";"
            case "ref": "string _ = \"x\"; Change(ref _); return _;"
            case "in": "string _ = \"input\"; return Read(in _);"
            case "assignment": "string _ = \"before\"; _ = \"after\"; return _;"
            case "foreach": "foreach (var _ in new[] { \"item\" }) { return _; } return \"empty\";"
            case "catch": "try { throw new Exception(\"caught\"); } catch (Exception _) { return _.Message; }"
            case "pattern": "object value = \"pattern\"; if (value is string @_) { return @_; } return \"empty\";"
            case "out-declaration": "string _ = \"kept\"; Clear(out string _); return _;"
            case "out-variable": "Clear(out string @_); return @_ ?? \"null\";"
            case "deconstruction": "string _; int number; (_, number) = (\"tuple\", 2); return _ + number;"
            case "capture": "string _ = \"captured\"; Func<string> read = () => _; return read();"
            case "capture-collision": "string _ = \"outer\"; Func<string> read = () => { " +
                "string underscore = \"inner\"; string underscore_2 = \"other\"; return _ + \":\" + underscore + \":\" + underscore_2; }; return read();"
            case "collision": "string underscore = \"first\"; string underscore_2 = \"second\"; " +
                "string _ = \"third\"; Clear(out _); return underscore + \":\" + underscore_2 + \":\" + (_ ?? \"null\");"
            case "lambda": "Func<string, string> echo = _ => _; return echo(\"lambda\");"
            case "lambda-write": "Func<string, string> change = _ => { _ = \"changed\"; return _; }; return change(\"before\");"
            case "parameter-out": "Clear(out _); return _ ?? \"null\";"
            default: "return _;"
        }
        let parameters = if position == "parameter" || position == "parameter-out" || position == "named-argument" {
            "string _"
        } else {
            ""
        }
        let arguments = if position == "named-argument" {
            "_: \"parameter\""
        } else if position == "parameter" || position == "parameter-out" {
            "\"parameter\""
        } else {
            ""
        }
        LiteralConstructionRuntimeParity.AssertMatches(
            "using System; public static class Obj { " +
                "private static void Clear(out string value) { value = null; } " +
                "private static void Change(ref string value) { value = \"changed\"; } " +
                "private static string Read(in string value) => value; " +
                "public static string Run(" +
                parameters +
                ") { " +
                body +
                " } } " +
                "public class P { public static void Main() { Console.WriteLine(Obj.Run(" +
                arguments +
                ")); } }",
            Issue5875ReadabilityCounters.AssertNoSynthetics
        )
    }

    @Fact
    func TrueDiscardsAndUnusedBindings_KeepTheBlankSpelling() {
        LiteralConstructionRuntimeParity.AssertMatches(`using System;
public class P {
    static void Clear(out string value) { value = "discarded"; }
    static void Drop() { Clear(out _); }
    static void Ignore(string _) { Console.WriteLine("ignored"); }
    public static void Main() {
        Drop();
        Ignore("argument");
        string _ = "unused";
        Console.WriteLine("done");
    }
}`, (
                printed string
            ) -> {
                Assert.Contains(
                    "out _",
                    printed,
                    StringComparison.Ordinal
                )
                Assert.DoesNotContain(
                    "underscore",
                    printed,
                    StringComparison.Ordinal
                )
                Issue5875ReadabilityCounters.AssertNoSynthetics(
                    printed
                )
            })
    }
}

internal shared class Issue5875ReadabilityCounters {
    func AssertNoSynthetics(printed string) {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue-5875-counters", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            File.WriteAllText(Path.Combine(directory, "Translated.gs"), printed)
            let root = GsharpTestProjectRunner.FindRepoRoot()
            Assert.NotNull(root)
            let start = ProcessStartInfo("bash"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in[]string{
                "-c",
                `source "$1"; cs2gs_raw_lines "$2" | cs2gs_extract_synthetics | wc -l`,
                "counters",
                Path.Combine(root!!, "build", "cs2gs-counters.sh"),
                directory
            } {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start counters.")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(120000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("Readability counters timed out.")
            }
            Assert.Equal(0, process.ExitCode)
            Assert.Equal("", stderr.GetAwaiter().GetResult())
            Assert.Equal("0", stdout.GetAwaiter().GetResult().Trim())
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }
}
