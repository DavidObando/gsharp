package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5426WarningPromotionDriverTests {
    @Theory
    @InlineData("", "warning")
    @InlineData("/warnaserror-", "warning")
    @InlineData("/warnaserror|/warnaserror-", "warning")
    @InlineData("/warnaserror|/warnaserror-:", "warning")
    @InlineData("/warnaserror-|/warnaserror", "error")
    @InlineData("/warnaserror|/warnaserror-|/warnaserror|/warnaserror-", "warning")
    @InlineData("/warnaserror|/warnaserror-:GS0166", "warning")
    @InlineData("/warnaserror|/warnaserror-:GS0001", "error")
    @InlineData("/warnaserror+:GS0166|/warnaserror|/warnaserror-", "error")
    @InlineData("/warnaserror|/warnaserror-|/warnaserror:0166", "error")
    @InlineData("/warnaserror+:GS0166|/warnaserror-:GS0166|/warnaserror-", "error")
    @InlineData("/warnaserror|/warnaserror-|/nowarn:;166;GS0001", "")
    @InlineData("/nowarn:GS0166|/warnaserror-|/warnaserror", "")
    @InlineData("/gsdiag:GS0166=error|/warnaserror|/warnaserror-", "error")
    func GlobalMinus_ResetsOnlyGlobalPromotion(options string, severity string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Path.Combine(fixture.Directory, "Warning.gs")
        let image = Path.Combine(fixture.Directory, "Warning.dll")
        let reference = Path.Combine(fixture.Directory, "Warning.ref.dll")
        let pdb = Path.ChangeExtension(image, ".pdb")
        File.WriteAllText(source, "Console.Write(\"tls5426\")\nfunc Main() { }\n")
        let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
            .Split(Path.PathSeparator)
            .Where((path string) -> Path.GetDirectoryName(path) == runtimeDirectory)
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        Assert.NotEmpty(references)
        let arguments = List[string]{
            typeof(Program).Assembly.Location,
            source,
            "/target:exe",
            "/targetframework:net10.0",
            "/deterministic+",
            "/debug:portable",
            "/out:" + image,
            "/refout:" + reference,
            "/nowarn:GS9100"
        }
        arguments.AddRange(references.Select((path string) -> "/r:" + path))
        arguments.AddRange(options.Split('|', StringSplitOptions.RemoveEmptyEntries))
        let result = Run(arguments)
        let diagnostics = Encoding.UTF8.GetString(result.Output)
        Assert.Equal(
            if severity == "error" {
                1
            } else {
                0
            },
            result.Code
        )
        Assert.Equal(
            if severity == "error" {
                "Failed.\n"
            } else {
                ""
            },
            result.Error.ReplaceLineEndings("\n")
        )
        let located = Regex.Matches(diagnostics, `(?m)^([^\r\n]+)\((\d+,\d+,\d+,\d+)\): (warning|error) (GS\d+):`)
        if severity.Length == 0 {
            Assert.Empty(located)
        } else {
            let diagnostic = Assert.Single(located)
            Assert.Equal(source, diagnostic.Groups[1].Value)
            Assert.Equal("2,6,2,10", diagnostic.Groups[2].Value)
            Assert.Equal(severity, diagnostic.Groups[3].Value)
            Assert.Equal("GS0166", diagnostic.Groups[4].Value)
        }
        Assert.DoesNotContain("GS9100", diagnostics)
        if severity == "error" {
            Assert.False(File.Exists(image))
            Assert.False(File.Exists(reference))
            Assert.False(File.Exists(pdb))
            Assert.False(File.Exists(Path.ChangeExtension(image, ".runtimeconfig.json")))
            return
        }
        Assert.True(File.Exists(image), diagnostics)
        let bytes = File.ReadAllBytes(image)
        let refBytes = File.ReadAllBytes(reference)
        let pdbBytes = File.ReadAllBytes(pdb)
        Assert.NotEmpty(bytes)
        Assert.NotEmpty(refBytes)
        Assert.NotEmpty(pdbBytes)
        let verify = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
        for path in references {
            verify.Add("-r")
            verify.Add(path)
        }
        let verified = Run(verify)
        Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Output) + verified.Error)
        Assert.Empty(verified.Error)
        let executed = Run([]string{image})
        Assert.Equal(0, executed.Code)
        Assert.Empty(executed.Error)
        Assert.Equal(Encoding.UTF8.GetBytes("tls5426"), executed.Output)
        let repeated = Run(arguments)
        Assert.Equal(0, repeated.Code)
        Assert.Equal(result.Output, repeated.Output)
        Assert.Equal(result.Error, repeated.Error)
        Assert.Equal(bytes, File.ReadAllBytes(image))
        Assert.Equal(refBytes, File.ReadAllBytes(reference))
        Assert.Equal(pdbBytes, File.ReadAllBytes(pdb))
    }

    shared {
        private func Run(arguments IEnumerable[string])(Code int32, Output[]uint8, Error string) {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let output = MemoryStream()
            let read = process.StandardOutput.BaseStream.CopyToAsync(output)
            let error = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("Warning promotion driver exceeded 30 seconds.")
            }
            read.GetAwaiter().GetResult()
            return (process.ExitCode, output.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
