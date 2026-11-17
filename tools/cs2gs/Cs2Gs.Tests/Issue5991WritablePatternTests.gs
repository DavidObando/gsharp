// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import Xunit

class Issue5991WritablePatternTests {
    @Theory
    @InlineData("(p, i) = Next(empty);")
    @InlineData("p = Next(empty).Item; i = 0;")
    @InlineData("Replace(ref p, BeforeWrite(p, empty)); i = 0;")
    @InlineData("ReplaceOut(out p, Next(empty)); i = 0;")
    func FallbackCaptures_KeepWritableStorageAndInvalidateOnlyCompletedWrites(write string) {
        let source = `
#nullable disable
using System;
public class Node { public override string ToString() => "node"; }
public record Entry(Node Item, int Id);
public static class P {
    static int reads;
    static Entry Next(bool empty) { reads++; return new Entry(empty ? null : new Node(), 0); }
#nullable enable
    static Entry BeforeWrite(Node? value, bool empty) {
        if (value!.ToString() != "node") throw new Exception("read changed");
        return Next(empty);
    }
    static void Replace(ref Node? target, Entry value) { target = value.Item; }
    static void ReplaceOut(out Node? target, Entry value) { target = value.Item; }
#nullable disable
    static string Read(Entry entry, bool empty, bool write) {
        if (entry is { Item: Node p }) {
            string before = p.ToString();
            if (write) {
                int i;
                WRITE
                object value = p;
                return before + ":" + (value == null) + ":" + i;
            } else {
                return p.ToString();
            }
        }
        return "miss";
    }
    static string Dereference(Entry entry, bool empty) {
        if (entry is { Item: Node p }) {
            int i;
            WRITE
            try { return p.ToString(); }
            catch (NullReferenceException) { return "nil"; }
        }
        return "miss";
    }
    public static void Main() {
        var entry = new Entry(new Node(), 7);
        Console.Write(Read(entry, true, true) + "|" + Read(entry, false, true) + "|" +
            Read(entry, true, false) + "|" + Dereference(entry, true) + "|" +
            Dereference(entry, false) + "|" + reads);
    }
}
`.Replace("WRITE", write)
        AssertParity(
            source,
            "node:True:0|node:False:0|node|nil|node|4",
            (printed string) -> {
                Assert.DoesNotContain("p!! =", printed)
                Assert.Contains("let value object? = p\n", printed)
                if write.StartsWith("Replace(ref", StringComparison.Ordinal) {
                    Assert.Contains("Replace(&p, BeforeWrite(p!!, empty))", printed)
                }
            }
        )
    }

    @Theory
    @InlineData("let p = 1", "2", "(3,7,3,8): error GS0127:")
    @InlineData("var p int32 = 1", "nil", "(3,9,3,12): error GS0155:")
    func InvalidNativeWrites_KeepTheirDiagnosticsAndEmitNoAssembly(
        declaration string,
        value string,
        diagnostic string
    ) {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue-5991", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let source = Path.Combine(directory, "Rejected.gs")
            let assembly = Path.Combine(directory, "Rejected.dll")
            File.WriteAllText(source, "func Main() {\n    " + declaration + "\n    p = " + value + "\n}\n")
            let result = ProcessRunner.Run(
                "dotnet",
                []string{BuildTool("Compiler", "gsc.dll"), "/target:exe", "/out:" + assembly, source},
                IlVerifyRunner().RepoRoot
            )
            Assert.False(result.TimedOut, result.Output)
            Assert.NotEqual(0, result.ExitCode)
            Assert.Contains(diagnostic, result.Output)
            Assert.Equal(2, result.Output.Split("error GS").Length)
            Assert.DoesNotContain("warning GS", result.Output)
            Assert.False(File.Exists(assembly))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData("Node p", "new Node()")
    @InlineData("Node { } p", "new Node()")
    @InlineData("{ Item: Node p }", "new Box(new Node(), 0)")
    @InlineData("Box { Item: Node p }", "new Box(new Node(), 0)")
    @InlineData("Box(Node p, _)", "new Box(new Node(), 0)")
    @InlineData("var p", "new Node()")
    func MutableSwitchCaptures_UseBodyLocalsInCasesArmsAndDiscardedResults(pattern string, receiver string) {
        let source = `
#nullable disable
using System;
public class Node { public override string ToString() => "node"; }
public record Entry(Node Item, int Id);
public record Box(Node Item, int Id);
public static class P {
    static int reads;
    static RECEIVERTYPE Receiver() { reads++; return RECEIVER; }
    static Entry Next() { reads++; return new Entry(new Node(), 7); }
    static string Case() {
        switch (Receiver()) {
            case PATTERN when p.ToString() == "node":
                int i;
                (p, i) = Next();
                return p.ToString() + i;
        }
        return "miss";
    }
    static int Arm() => Receiver() switch {
        PATTERN when p.ToString() == "node" => ((p, _) = Next()).Item2,
        _ => -1
    };
    static void Discard() {
        _ = Receiver() switch {
            PATTERN when p.ToString() == "node" => ((p, _) = Next()).Item2,
            _ => -1
        };
    }
    public static void Main() {
        Discard();
        Console.Write(Case() + "|" + Arm() + "|" + reads);
    }
}
`.Replace(
            "PATTERN",
            pattern
        ).Replace(
            "RECEIVERTYPE",
            if pattern.StartsWith("{", StringComparison.Ordinal) {
                "Box"
            } else {
                "object"
            }
        ).Replace("RECEIVER", receiver)
        AssertParity(source, "node7|7|6")
    }

    @Fact
    func MutableCaptures_KeepDistinctSymbolsAndEvaluateReceiversAndGettersOnce() {
        AssertParity(`
#nullable disable
using System;
public class Node { public override string ToString() => "node"; }
public record Entry(Node Item, int Id);
public class Holder {
    public Node Item { get { P.properties++; return new Node(); } }
}
public static class P {
    public static int properties;
    static int receivers, values;
    static Holder Receiver() { receivers++; return new Holder(); }
    static Entry Next(bool empty) { values++; return new Entry(empty ? null : new Node(), 0); }
    static string Read() {
        string first = "miss", second = "miss";
        {
            if (Receiver() is { Item: Node p }) {
                int i;
                (p, i) = Next(true);
                object value = p;
                first = (value == null).ToString();
            }
        }
        {
            switch (Receiver().Item) {
                case Node p when p.ToString() == "node":
                    int i;
                    (p, i) = Next(false);
                    second = p.ToString() + i;
                    break;
            }
        }
        return first + "|" + second;
    }
    public static void Main() {
        Console.Write(Read() + "|" + receivers + ":" + properties + ":" + values);
    }
}
`, "True|node0|2:2:2")
    }

    @Theory
    @InlineData("int i; (p, i) = Empty();", "False|True")
    @InlineData("", "False|False")
    func DeferredPatternReads_ObserveTheCurrentStorageInsteadOfTheOriginalMatch(write string, expected string) {
        let source = `
#nullable disable
using System;
public class Node { }
public record Entry(Node Item, int Id);
public static class P {
    static Entry Empty() => new Entry(null, 0);
#nullable enable
    static string Read(Entry entry) {
        if (entry is { Item: Node p }) {
            Func<Node?> read = () => p;
            bool before = read() == null;
            WRITE
            return before + "|" + (read() == null);
        }
        return "miss";
    }
    public static void Main() { Console.Write(Read(new Entry(new Node(), 7))); }
}
`.Replace("WRITE", write)
        AssertParity(source, expected)
    }

    @Theory
    @InlineData("int", "7", "", "7|7")
    @InlineData("Counter", "new Counter { Value = 7 }", "", "7|7")
    @InlineData("int", "7", "x = 9;", "7|9")
    @InlineData("Counter", "new Counter { Value = 7 }", "x.Value = 9;", "7|9")
    func AddressedFallbackCaptures_RetainIndependentStorage(type string, value string, write string, expected string) {
        AssertParity(`
using System;
public struct Counter {
    public int Value;
    public override string ToString() => Value.ToString();
}
public static class P {
    static string Read() {
        TYPE x = VALUE;
        bool matched = x is var p;
        ref readonly TYPE alias = ref p;
        WRITE
        return alias.ToString() + "|" + x.ToString();
    }
    public static void Main() { Console.Write(Read()); }
}
`.Replace("TYPE", type).Replace("VALUE", value).Replace("WRITE", write), expected)
    }

    @Theory
    @InlineData("new Reset(out p)", "Value = p", "True|1")
    @InlineData("new(out p)", "Value = p", "True|1")
    @InlineData("new Reset(out p)", "p", "True|1")
    @InlineData("new(out p)", "p", "True|1")
    @InlineData("new Reset(out p, p.ToString())", "Value = p", "True|1")
    @InlineData("new(out p, p.ToString())", "p", "True|1")
    func ConstructorWrites_CompleteBeforeObjectAndCollectionInitializers(
        creation string,
        initializer string,
        expected string
    ) {
        AssertParity(`
#nullable disable
using System;
using System.Collections;
public class Node { public override string ToString() => "ok"; }
public class Holder { public Node Item; }
public class Reset : IEnumerable {
    public Node Value;
    public Reset(out Node target, string before = "ok") {
        if (before != "ok") throw new Exception("argument read changed");
        P.calls++;
        target = null;
    }
#nullable enable
    public void Add(Node? value) { Value = value; }
#nullable disable
    public IEnumerator GetEnumerator() => Array.Empty<object>().GetEnumerator();
}
public static class P {
    public static int calls;
    public static void Main() {
        var holder = new Holder { Item = new Node() };
        if (holder is { Item: Node p }) {
            Reset reset = CREATION { INITIALIZER };
            Console.Write((reset.Value == null) + "|" + calls);
        }
    }
}
`.Replace("CREATION", creation).Replace("INITIALIZER", initializer), expected)
    }

    @Theory
    @InlineData("case", "Remember", "p = \"new\";", "new|1")
    @InlineData("arm", "Remember", "(p = \"new\")", "new|1")
    @InlineData("discard", "Remember", "(p = \"new\")", "new|1")
    @InlineData("case", "Immediate", "p = \"new\";", "old|1")
    @InlineData("arm", "Immediate", "(p = \"new\")", "old|1")
    @InlineData("discard", "Immediate", "(p = \"new\")", "old|1")
    @InlineData("case", "Remember", "", "old|1")
    @InlineData("arm", "Remember", "p", "old|1")
    @InlineData("discard", "Remember", "p", "old|1")
    func GuardClosures_SharePatternStorageWithTheSelectedBody(
        form string,
        callback string,
        write string,
        expected string
    ) {
        let body = switch form {
            case "case": `switch (Input()) {
            case string p when CALLBACK(() => p):
                WRITE
                break;
        }`
            case "arm": `string result = Input() switch {
            string p when CALLBACK(() => p) => WRITE,
            _ => "miss"
        };`
            default: `_ = Input() switch {
            string p when CALLBACK(() => p) => WRITE,
            _ => "miss"
        };`
        }
        AssertParity(`
using System;
public static class P {
    static int calls;
    static Func<string> saved = () => "unset";
    static object Input() { calls++; return "old"; }
    static bool Remember(Func<string> read) { saved = read; return true; }
    static bool Immediate(Func<string> read) {
        string value = read();
        saved = () => value;
        return true;
    }
    public static void Main() {
        BODY
        Console.Write(saved() + "|" + calls);
    }
}
`.Replace("BODY", body.Replace("CALLBACK", callback).Replace("WRITE", write)), expected)
    }

    @Theory
    @InlineData("string p", "object", "\"v\" + i")
    @InlineData("Box { Item: string p }", "Box", "new Box(\"v\" + i)")
    @InlineData("{ Item: string p }", "Box", "new Box(\"v\" + i)")
    @InlineData("Box(string p)", "Box", "new Box(\"v\" + i)")
    func GuardClosures_KeepFalseMatchesDistinctAcrossArmsAndLoopEvaluations(
        pattern string,
        inputType string,
        input string
    ) {
        AssertParity(`
using System;
using System.Collections.Generic;
public record Box(string Item);
public static class P {
    static int calls, guards;
    static List<Func<string>> saved = new();
    static INPUTTYPE Input(int i) { calls++; return INPUT; }
    static bool Remember(Func<string> read, bool accept) {
        guards++;
        saved.Add(read);
        return accept;
    }
    static string Read() {
        string result = "";
        for (int i = 0; i < 2; i++) {
            result += Input(i) switch {
                PATTERN when Remember(() => p, false) => (p += "?"),
                PATTERN when Remember(() => p, true) => (p += "!"),
                _ => "miss"
            };
        }
        return result;
    }
    public static void Main() {
        Console.Write(Read() + "|" + saved[0]() + "|" + saved[1]() + "|" +
            saved[2]() + "|" + saved[3]() + "|" + calls + ":" + guards);
    }
}
`.Replace("INPUTTYPE", inputType).Replace("INPUT", input).Replace("PATTERN", pattern), "v0!v1!|v0|v0!|v1|v1!|2:4")
    }

    @Theory
    @InlineData("in x, in p", "int", "7")
    @InlineData("x, p", "int", "7")
    @InlineData("right: in p, left: in x", "int", "7")
    @InlineData("in x, in p", "string", "\"value\"")
    @InlineData("x, p", "object", "null")
    func ReadonlyArguments_KeepPatternCopyAddressIdentity(arguments string, type string, value string) {
        AssertParity(`
using System;
using System.Runtime.CompilerServices;
public static class P {
    static bool Same(in TYPE left, in TYPE right) =>
        Unsafe.AreSame(ref Unsafe.AsRef(in left), ref Unsafe.AsRef(in right));
    static string Read() {
        TYPE x = VALUE;
        bool matched = x is var p;
        return Same(ARGUMENTS) + "|" + Same(in x, in x);
    }
    public static void Main() { Console.Write(Read()); }
}
`.Replace("ARGUMENTS", arguments).Replace("TYPE", type).Replace("VALUE", value), "False|True")
    }

    @Fact
    func AddressedNullableMemberCapture_PreservesTheReadBeforeItsAlias() {
        AssertParity(`
#nullable disable
using System;
public class Holder { public object Item = null; }
public static class P {
    static string Read(object input) {
        var holder = new Holder { Item = input };
        bool matched = holder.Item is var p;
        object value = p;
        ref readonly object alias = ref p;
        return (value == null) + "|" + (alias == null);
    }
    public static void Main() { Console.Write(Read(null) + ";" + Read("live")); }
}
`, "True|True;False|False")
    }

    @Theory
    @InlineData("Remember", "string p", "string", "\"new\"", "First(2) + \"|\" + saved()", "new|new")
    @InlineData("Immediate", "string p", "string", "\"new\"", "First(2) + \"|\" + saved()", "new|old")
    @InlineData("Remember", "var p", "object?", "null", "(First(2) == null) + \"|\" + saved()", "True|nil")
    @InlineData("Immediate", "var p", "object?", "null", "(First(2) == null) + \"|\" + saved()", "True|old")
    func LiftedRecursiveFunctions_UseSharedGuardStorageAndTheirOwnCaptureParameters(
        callback string,
        pattern string,
        captureType string,
        write string,
        result string,
        expected string
    ) {
        AssertParity(`
#nullable enable
using System;
public static class P {
    static Func<string> saved = () => "unset";
    static bool Remember(Func<string> read) { saved = read; return true; }
    static bool Immediate(Func<string> read) {
        string value = read();
        saved = () => value;
        return true;
    }
    static string Read(object input) {
        switch (input) {
            case PATTERN when CALLBACK(() => p as string ?? "nil"):
                return RESULT;
                CAPTURETYPE First(int n) {
                    if (n == 0) { p = WRITE; return p; }
                    return Second<int>(n - 1);
                }
                CAPTURETYPE Second<T>(int n) { return n == 0 ? p : First(n - 1); }
        }
        return "miss";
    }
    public static void Main() { Console.Write(Read("old")); }
}
`.Replace(
                "CALLBACK",
                callback
            ).Replace(
                "PATTERN",
                pattern
            ).Replace("CAPTURETYPE", captureType).Replace("WRITE", write).Replace("RESULT", result), expected)
    }

    shared {
        private func AssertParity(source string, expected string, verifyTranslation Action[string]? = nil) {
            let root = IlVerifyRunner().RepoRoot ?? throw DirectoryNotFoundException("Repository root not found.")
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5991", Guid.NewGuid().ToString("N"))
            let input = Path.Combine(directory, "input")
            let output = Path.Combine(directory, "output")
            Directory.CreateDirectory(input)
            try {
                GsharpTestProjectRunner.WriteIsolationBoundary(input)
                File.WriteAllText(Path.Combine(input, "Probe.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>`)
                File.WriteAllText(Path.Combine(input, "Probe.cs"), source)
                Run("git", []string{"init", "--quiet", input}, root)
                Run(
                    "dotnet",
                    []string{
                        "build",
                        Path.Combine(input, "Probe.csproj"),
                        "-c",
                        "Release",
                        "--nologo",
                        "-nodeReuse:false",
                        "-p:UseSharedCompilation=false"
                    },
                    root
                )
                let native = RunProgram(Path.Combine(input, "bin", "Release", "net10.0", "Probe.dll"))
                Assert.NotEmpty(native)
                Assert.Equal(Encoding.UTF8.GetBytes(expected), native)
                Run(
                    "dotnet",
                    []string{
                        BuildTool("Cs2Gs.Cli", "cs2gs.dll"),
                        "migrate",
                        "--corpus",
                        input,
                        "--out",
                        output,
                        "--artifacts",
                        Path.Combine(directory, "migration"),
                        "--translate-only",
                        "--no-format",
                        "--sdk-version",
                        SdkPin.ReadGlobalJsonPin(root)!!
                    },
                    root
                )
                verifyTranslation?.Invoke(File.ReadAllText(Path.Combine(output, "Probe.gs")))
                let assembly = Path.Combine(directory, "Translated.dll")
                Run(
                    "dotnet",
                    []string{
                        BuildTool("Compiler", "gsc.dll"),
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/out:" + assembly,
                        Path.Combine(output, "Probe.gs")
                    },
                    root
                )
                VerifyStrictIL(assembly)
                Assert.Equal(native, RunProgram(assembly))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func BuildTool(project string, file string) string -> Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", project, file)
        )

        private func Run(executable string, arguments[]string, directory string) {
            let result = ProcessRunner.Run(executable, arguments, directory)
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
        }

        private func RunProgram(assembly string)[]uint8 {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            start.ArgumentList.Add(assembly)
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let output = MemoryStream()
            let stdout = process.StandardOutput.BaseStream.CopyToAsync(output)
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(120000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("dotnet process timed out.")
            }
            stdout.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, stderr.GetAwaiter().GetResult())
            return output.ToArray()
        }

        private func VerifyStrictIL(assembly string) {
            let arguments = List[string]{"tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib"}
            for reference in Directory.EnumerateFiles(
                Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
                "*.dll"
            ) {
                arguments.Add("-r")
                arguments.Add(reference)
            }
            let result = ProcessRunner.Run("dotnet", arguments, IlVerifyRunner().RepoRoot)
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
        }
    }
}
