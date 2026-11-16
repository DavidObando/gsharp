package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5949DeclaredRefStorageTests {
    @Theory
    @InlineData("Replace(&s)", "Replace(ref s)")
    @InlineData("Replace(&{ s })", "Replace(ref s)")
    @InlineData("Replacer().Replace(&s)", "new Replacer().Replace(ref s)")
    @InlineData("let sink = Sink(&s)", "var sink = new Sink(ref s)")
    func NullableDeclaredStorage_WithNarrowedRead_CompilesVerifiesAndRuns(call string, nativeCall string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Repro.Replace("Replace(&s)", call) + `
class Replacer {
    func Replace(ref s string?) { s = nil }
}
class Sink {
    init(ref s string?) { s = nil }
}
Console.Write(Read(nil) == nil)
Console.Write(Read("seed") == nil)
`
        let native = `using System;
class Replacer {
    public void Replace(ref string? s) { s = null; }
}
class Sink {
    public Sink(ref string? s) { s = null; }
}
class Program {
    static void Replace(ref string? s) { s = null; }
    static char? Read(string? seed) {
        string? s = seed;
        s = "a";
        ` + nativeCall + `;
        return s?[0];
    }
    static void Main() {
        Console.Write(Read(null) == null);
        Console.Write(Read("seed") == null);
    }
}`
        Check(fixture, source, native, "TrueTrue")
    }

    @Theory
    @InlineData("ref")
    @InlineData("out")
    func NonNullableDeclaredStorage_StillReportsTheWritableMismatch(refKind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = "func Replace($refKind s string?) { s = nil }\n" +
            "func Run() {\n    var s string = \"a\"\n    Replace(&s)\n}\n"
        let (code, log) = fixture.TryCompile(source, "UnsafeStorage", false, "--nullability=platform-types")
        Assert.True(code == 0, log)
        AssertDiagnostic(fixture, "UnsafeStorage", log, "warning", "GS0612", "4,13,4,15")
        Assert.Contains("the callee may store nil into storage declared non-null", log, StringComparison.Ordinal)
        Assert.Contains("has type 'string'", log, StringComparison.Ordinal)
        IlVerifier.Verify(Path.Combine(fixture.Directory, "UnsafeStorage.dll"))
    }

    @Theory
    @InlineData("let value string = s", "GS0155", "8,24,8,25")
    @InlineData("let value = s.Length", "GS0158", "8,19,8,25")
    func RefWrite_InvalidatesThePriorReadProof(read string, diagnostic string, location string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Repro.Replace("return s?[0]", read).Replace("char? {", "{")
        let (code, log) = fixture.TryCompile(source, "InvalidatedRead", false, "--nullability=platform-types")
        Assert.NotEqual(0, code)
        AssertDiagnostic(fixture, "InvalidatedRead", log, "error", diagnostic, location)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "InvalidatedRead.dll")))
    }

    shared {
        private const Repro string = `func Replace(ref s string?) {
    s = nil
}
func Read(seed string?) char? {
    var s string? = seed
    s = "a"
    Replace(&s)
    return s?[0]
}
`

        private func Check(fixture NativeSliceLanguageTests.Fixture, source string, native string, expected string) {
            let (code, log) = fixture.TryCompile(source, "Storage", true, "--nullability=platform-types")
            Assert.True(code == 0, log)
            Assert.Empty(Regex.Matches(log, `(?m)^.*\): (warning|error) GS\d+:`))
            let image = Path.Combine(fixture.Directory, "Storage.dll")
            IlVerifier.Verify(image)
            let actual = Run(image)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), actual)
            let nativeImage = fixture.CompileCSharpExecutable(native, "Native")
            File.Copy(
                Path.ChangeExtension(image, ".runtimeconfig.json"),
                Path.ChangeExtension(nativeImage, ".runtimeconfig.json")
            )
            IlVerifier.Verify(nativeImage)
            Assert.Equal(actual, Run(nativeImage))
        }

        private func AssertDiagnostic(
            fixture NativeSliceLanguageTests.Fixture,
            name string,
            log string,
            severity string,
            diagnostic string,
            location string
        ) {
            let located = Regex.Matches(log, `(?m)^([^\r\n]+)\((\d+,\d+,\d+,\d+)\): (warning|error) (GS\d+):`)
            let actual = Assert.Single(located)
            Assert.Equal(Path.Combine(fixture.Directory, name + ".gs"), actual.Groups[1].Value)
            Assert.Equal(location, actual.Groups[2].Value)
            Assert.Equal(severity, actual.Groups[3].Value)
            Assert.Equal(diagnostic, actual.Groups[4].Value)
        }

        private func Run(image string)[]uint8 {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            start.ArgumentList.Add(image)
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let output = MemoryStream()
            let read = process.StandardOutput.BaseStream.CopyToAsync(output)
            let error = process.StandardError.ReadToEndAsync()
            var exited bool
            try {
                exited = process.WaitForExit(30_000)
            } finally {
                if !process.HasExited {
                    process.Kill(entireProcessTree: true)
                }
                process.WaitForExit()
                try {
                    read.GetAwaiter().GetResult()
                } finally {
                    error.GetAwaiter().GetResult()
                }
            }
            Assert.True(exited, "Ref-storage witness exceeded 30 seconds.")
            Assert.Equal(0, process.ExitCode)
            Assert.Empty(error.GetAwaiter().GetResult())
            return output.ToArray()
        }
    }
}
