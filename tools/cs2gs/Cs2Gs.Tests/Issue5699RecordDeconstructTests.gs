package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

class Issue5699RecordDeconstructTests {
    @Theory
    @InlineData("record", false)
    @InlineData("record class", false)
    @InlineData("record struct", false)
    @InlineData("record", true)
    @InlineData("record class", true)
    @InlineData("record struct", true)
    func BodyRecord_CustomDeconstruct_PreservesAllConsumersAndValueSemantics(kind string, properties bool) {
        let members = if properties {
            "public int X { get; init; } public int Y { get; init; }"
        } else {
            "public int X; public int Y;"
        }
        Verify((`
using System;
namespace RecordDeconstruction {
    public RECORD_KIND R {
        MEMBERS
        public static int Calls;
        public void Deconstruct(out int x, out int y) {
            Calls++;
            x = Y * 10;
            y = X;
        }
    }
    public static class Probe {
        public static string Run() {
            var r = new R { X = 2, Y = 3 };
            var equal = r == new R { X = 2, Y = 3 };
            var copy = r with { X = 5 };
            var (a, b) = r;
            int c = 0, d = 0;
            (c, d) = r;
            var total = 0;
            foreach (var (e, f) in new[] { r, copy }) total += e + f;
            var typed = r is R(var g, var h) ? g + h : -1;
            var bare = r is (var i, var j) ? i + j : -1;
            var arm = r switch { R(30, 2) => 1, _ => 0 };
            var statement = 0;
            switch (r) { case (30, 2): statement = 1; break; }
            var discarded = r is (_, _);
            r.Deconstruct(out var directX, out var directY);
            object absent = null;
            var nil = absent is R(_, _);
            return $"{a},{b}|{c},{d}|{total}|{typed},{bare},{arm},{statement},{discarded},{nil}" +
                $"|{directX},{directY}|{equal},{r == copy}|{copy}|{R.Calls}";
        }
    }
}
`).Replace("RECORD_KIND", kind).Replace("MEMBERS", members))
    }

    @Theory
    @InlineData("record", false)
    @InlineData("record class", false)
    @InlineData("record struct", false)
    @InlineData("record", true)
    @InlineData("record class", true)
    @InlineData("record struct", true)
    func PositionalRecord_CustomAndOverloadedDeconstruct_PreservesSelectedArity(kind string, replacePrimary bool) {
        let custom = if replacePrimary {
            "public void Deconstruct(out int u, out int v) { Calls++; u = Y * 10; v = X; }"
        } else {
            ""
        }
        Verify((`
namespace RecordDeconstruction {
    public RECORD_KIND R(int X, int Y) {
        public static int Calls;
        CUSTOM
        public void Deconstruct(out int u, out int v, out int w) {
            Calls++;
            u = Y * 10;
            v = X;
            w = X + Y;
        }
    }
    public static class Probe {
        public static string Run() {
            var r = new R(2, 3);
            var copy = r with { X = 5 };
            var (a, b) = r;
            var (c, d, e) = r;
            int f = 0, g = 0, h = 0;
            (f, g, h) = r;
            var total = 0;
            foreach (var (i, j, k) in new[] { r, copy }) total += i + j + k;
            var typed = r is R(var l, var m, var n) ? l + m + n : -1;
            var bare = r is (var o, var p, var q) ? o + p + q : -1;
            var arm = r switch { R(30, 2, 5) => 1, _ => 0 };
            var primary = r switch { R(var s, var t) => s + t };
            r.Deconstruct(out var directX, out var directY, out var directZ);
            return $"{a},{b}|{c},{d},{e}|{f},{g},{h}|{total}|{typed},{bare},{arm},{primary}" +
                $"|{directX},{directY},{directZ}|{r == new R(2, 3)},{r == copy}|{copy}|{R.Calls}";
        }
    }
}
`).Replace("RECORD_KIND", kind).Replace("CUSTOM", custom))
    }

    @Fact
    func MutableRecordStruct_DeconstructionUsesCopiesButDirectCallMutatesOriginal() {
        Verify(`
namespace RecordDeconstruction {
    public record struct R {
        public int X;
        public void Deconstruct(out int a, out int b) { a = ++X; b = X * 10; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R { X = 1 };
            var (a, b) = r;
            int c = 0, d = 0;
            (c, d) = r;
            r.Deconstruct(out var e, out var f);
            return $"{a},{b},{c},{d},{e},{f},{r.X}";
        }
    }
}`)
    }

    @Fact
    func PartialGenericRecord_NestedDeconstructionAndNameCollisions() {
        Verify(`
namespace RecordDeconstruction {
    public partial record R<T>(T Value) {
        public int __cs2gsDeconstruct;
        public void __cs2gsRecordDeconstruct_R_2_0() { }
    }
    public partial record R<T> {
        public void Deconstruct(out int count, out T item) { count = 7; item = Value; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R<string>("hi");
            var ((a, b), c) = (r, 2);
            ((a, b), c) = (r, 3);
            return $"{a},{b},{c}|{r == new R<string>("hi")}|{r with { Value = "bye" }}";
        }
    }
}`)
    }

    @Fact
    func InheritedVirtualDeconstruct_PreservesDispatchAndMethodGroups() {
        Verify(`
namespace RecordDeconstruction {
    public delegate void Parts(out int x, out int y);
    public record Base(int X, int Y) {
        public virtual void Deconstruct(out int x, out int y) { x = X; y = Y; }
    }
    public record R(int A, int B) : Base(A, B) {
        public override void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public static class Probe {
        public static string Run() {
            Base r = new R(2, 3);
            var (a, b) = r;
            Parts parts = r.Deconstruct;
            parts(out var c, out var d);
            var pattern = r is Base(var e, var f) ? e + f : -1;
            return $"{a},{b},{c},{d},{pattern}|{r with { X = 5 }}";
        }
    }
}`)
    }

    @Fact
    func UserRecordDeconstruct_RemovesByReferenceNarrowingFacts() {
        Verify(`
#nullable enable
namespace RecordDeconstruction {
    public record R(int X, int Y) {
        public void Deconstruct(out int a, out int b) { a = Y * 10; b = X; }
    }
    public static class Probe {
        public static int Decl(ref string? text, R r) {
            if (text == null) return 0;
            var (a, b) = r;
            return text.Length + a + b;
        }
        public static int Assign(ref string? text, R r) {
            if (text == null) return 0;
            int a = 0, b = 0;
            (a, b) = r;
            return text.Length + a + b;
        }
        public static int Pattern(ref string? text, R r) {
            if (text == null) return 0;
            return r is R(var a, var b) ? text.Length + a + b : -1;
        }
        public static int Arm(ref string? text, R r) {
            if (text == null) return 0;
            return r switch { R(var a, var b) => text.Length + a + b };
        }
        public static string Run() {
            string? text = "hi";
            var r = new R(2, 3);
            return $"{Decl(ref text, r)},{Assign(ref text, r)},{Pattern(ref text, r)},{Arm(ref text, r)}";
        }
    }
}`)
    }

    @Fact
    func SwitchArms_ShareDeconstructOutputsAndResetOnEveryEvaluation() {
        Verify(`
namespace RecordDeconstruction {
    public record R(int X, int Y) {
        public static int Calls;
        public void Deconstruct(out int a, out int b) { Calls++; a = Y * 10; b = X; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R(2, 3);
            var total = 0;
            for (var i = 0; i < 3; i++) {
                if (r is R(0, _) or R(30, 2)) total += 1;
                total += r switch { R(0, _) => 10, R(var a, var b) when a == 30 => a + b, _ => 0 };
                switch (r) {
                    case R(0, _): total += 10; break;
                    case R(var c, var d): total += c + d; break;
                }
            }
            return $"{total},{R.Calls}";
        }
    }
}`)
    }

    shared {
        private func Verify(source string) {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            using let image = MemoryStream()
            let baseline = project.Compilation.WithAssemblyName("Baseline" + Guid.NewGuid().ToString("N")).Emit(image)
            Assert.True(baseline.Success, string.Join("\n", baseline.Diagnostics))
            let expected = cast[string](
                Assembly.Load(image.ToArray()).GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(
                    nil,
                    nil
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) ->
                diagnostic.Severity == TranslationSeverity.Unsupported
            )
            Assert.Contains("data ", printed)
            Assert.Equal(expected + "\n", CompileAndRun(printed).Replace("\r\n", "\n"))
        }

        private func CompileAndRun(printed string) string {
            var root DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while root != nil && !File.Exists(Path.Combine(root.FullName, "GSharp.slnx")) {
                root = root.Parent
            }
            Assert.NotNull(root)
            let configuration = if AppContext.BaseDirectory.Contains(
                Path.DirectorySeparatorChar + "Release" + Path.DirectorySeparatorChar
            ) {
                "Release"
            } else {
                "Debug"
            }
            let compiler = Path.Combine(root!!.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
            Assert.True(File.Exists(compiler), compiler)
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5699", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let source = Path.Combine(directory, "Snippet.gs")
                let output = Path.Combine(directory, "Snippet.dll")
                File.WriteAllText(source, printed + "\nSystem.Console.WriteLine(Probe.Run())\n")
                let compile = RunDotnet([]string{compiler, "/target:exe", "/out:" + output, source})
                Assert.True(compile.Exit == 0, compile.Output + "\n" + printed)
                let run = RunDotnet([]string{output})
                Assert.True(run.Exit == 0, run.Output)
                return run.Output
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func RunDotnet(arguments[]string)(Exit int32, Output string) {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start)!!
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            let completed = process.WaitForExit(120000)
            if !completed {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
            }
            Assert.True(completed, "Process exceeded two minutes.")
            return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
        }
    }
}
