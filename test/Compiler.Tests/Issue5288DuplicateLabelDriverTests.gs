package GSharp.Compiler.Tests

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5288DuplicateLabelDriverTests {
    @Fact
    func ReservedRangeRecovery_PreservesLocatedSourceErrorsWithoutEmitting() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(MalformedSource, "range5288", false)
        Assert.NotEqual(0, code)
        Assert.DoesNotContain("GS9998", output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "range5288.dll")))
        Assert.Equal(
            []string{
                "GS0100@5,6,5,11",
                "GS0005@6,6,6,11",
                "GS0005@6,6,6,11",
                "GS0005@6,6,6,11",
                "GS0125@6,12,6,14",
                "GS0159@7,29,7,39",
                "GS0005@7,39,7,44",
                "GS0005@7,39,7,44",
                "GS0005@7,39,7,44",
                "GS0005@7,39,7,44",
                "GS0005@7,44,7,45",
                "GS0005@7,45,7,46",
                "GS0159@8,29,8,39",
                "GS0005@8,39,8,44",
                "GS0005@8,39,8,44",
                "GS0005@8,39,8,44",
                "GS0005@8,39,8,44",
                "GS0005@8,44,8,45",
                "GS0005@8,45,8,46",
                "GS0470@8,47,8,52",
                "GS0285@9,2,9,2",
                "GS0005@9,2,9,3",
                "GS0005@11,1,11,2"
            },
            DiagnosticLocations(output)
        )
    }

    @Fact
    func ExplicitDuplicates_ReportEachRepeatedDeclarationWithoutEmitting() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`func Build() int32 {
 goto Color
 Color:
 let first = 1
 {
  Color:
  let second = 2
 }
 Color:
 return 3
}`, "labels5288", false)
        Assert.NotEqual(0, code)
        Assert.DoesNotContain("GS9998", output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "labels5288.dll")))
        Assert.Equal([]string{"GS0470@6,3,6,8", "GS0470@9,2,9,7"}, DiagnosticLocations(output))
    }

    @Fact
    func RenamedRangeAndCanonicalGotoTargets_EmitVerifiedExactRuntimeBytes() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = "import System\n" + MalformedSource.Replace("range", "index") + `
func Main() {
 Console.Write(Build([]int32{0}))
 var count = 0
 goto Start
 Console.Write("skipped")
 Start:
 count += 1
 if count < 3 { goto Start }
 outer: for index in []int32{0, 1, 2} {
  if index == 0 { continue outer }
  Console.Write(index)
  break outer
 }
 goto Done
 Console.Write("skipped")
 Done:
 Console.Write(count)
}
`
        let assembly = fixture.Compile(source, "control5288", true)
        IlVerifier.Verify(assembly)
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = fixture.Directory
        }
        start.ArgumentList.Add(assembly)
        using let process = Process.Start(start) ?? throw InvalidOperationException("could not start label control")
        using let bytes = MemoryStream()
        let stdout = process.StandardOutput.BaseStream.CopyToAsync(bytes)
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(30_000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            Assert.Fail("Label control exceeded 30 seconds.")
        }
        stdout.GetAwaiter().GetResult()
        Assert.True(process.ExitCode == 0, stderr.GetAwaiter().GetResult())
        Assert.Equal(Encoding.UTF8.GetBytes("013"), bytes.ToArray())
    }

    shared {
        private const MalformedSource string = `class Text {
 public var Content string
 public var Color int32
}
func Build(values []int32) int32 {
 for range in values {
  let a = Text{Content: "a".Substring(range), Color: 1}
  let b = Text{Content: "b".Substring(range), Color: 2}
 }
 return 0
}`

        private func DiagnosticLocations(output string)[]string {
            let matches = Regex.Matches(output, `\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
            Assert.NotEmpty(matches)
            return matches.Select((match Match) -> match.Groups[2].Value + "@" + match.Groups[1].Value).ToArray()
        }
    }
}
