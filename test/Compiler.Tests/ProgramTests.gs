// <copyright file="ProgramTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Versioning
import System.Text
import System.Text.RegularExpressions
import Xunit

open class ProgramTests {
    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    func Driver_TypeForwarders_RequireOnlyActualMetadataDependencies(required bool, useForwardedType bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dependency = fixture.CompileCSharp("public class Forwarded5420 { }", "Optional5420")
        let contract = if required {
            "public static class Contract5420 { public static void Accept(Forwarded5420 value) { } }"
        } else {
            ""
        }
        let facade = fixture.CompileCSharp(
            "[assembly: System.Runtime.CompilerServices.TypeForwardedTo(typeof(Forwarded5420))]\n" + contract,
            "Facade5420",
            dependency
        )
        File.Delete(dependency)
        let source = Path.Combine(fixture.Directory, "Forwarder.gs")
        File.WriteAllText(
            source,
            if useForwardedType {
                "let value = Forwarded5420()\n"
            } else {
                "Console.Write(\"ran5420\")\n"
            }
        )
        let output = Path.Combine(fixture.Directory, "Forwarder.dll")
        let reference = Path.Combine(fixture.Directory, "Forwarder.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Forwarder.pdb")
        let (exit, diagnostics) = RunReferenceWarningDriver(
            fixture.Directory,
            source,
            facade,
            "/warnaserror+",
            "/out:" + output,
            "/refout:" + reference,
            "/pdb:" + pdb
        )
        Assert.DoesNotContain("GS9998", diagnostics)
        if required {
            Assert.Contains("$source(1,1,1,1): error GS9100:", diagnostics)
            Assert.Contains("Optional5420", diagnostics)
        } else {
            Assert.DoesNotContain("GS9100", diagnostics)
            if useForwardedType {
                let error = Assert.Single(Regex.Matches(diagnostics, `(?m)^.*\berror GS\d+:[^\r\n]*`))
                Assert.Equal("$source(1,13,1,26): error GS0130: Function 'Forwarded5420' doesn't exist.", error.Value)
            }
        }
        if required || useForwardedType {
            Assert.NotEqual(0, exit)
            Assert.Contains("error GS", diagnostics)
            Assert.False(File.Exists(output))
            Assert.False(File.Exists(reference))
            Assert.False(File.Exists(pdb))
        } else {
            Assert.True(exit == 0, diagnostics)
            Assert.True(File.Exists(reference))
            Assert.True(File.Exists(pdb))
            IlVerifier.Verify(output)
            Assert.Equal(Encoding.UTF8.GetBytes("ran5420"), fixture.RunBytes(output))
        }
    }

    @Fact
    func Main_NoArgs_ReturnsError() {
        using let err = StringWriter()
        let prevErr = Console.Error
        Console.SetError(err)
        try {
            let exit = Program.Main(Array.Empty[string]())
            Assert.NotEqual(0, exit)
            Assert.Contains("Must specify", err.ToString())
        } finally {
            Console.SetError(prevErr)
        }
    }

    @Fact
    func Main_Help_PrintsUsageAndReturnsSuccess() {
        using let outWriter = StringWriter()
        let prevOut = Console.Out
        Console.SetOut(outWriter)
        try {
            let exit = Program.Main([]string{"/?"})
            Assert.Equal(0, exit)
            Assert.Contains("Usage: gsc", outWriter.ToString())
            Assert.Contains("/help", outWriter.ToString())
        } finally {
            Console.SetOut(prevOut)
        }
    }

    @Fact
    func Main_UnrecognizedSwitch_ReturnsError() {
        using let err = StringWriter()
        let prevErr = Console.Error
        Console.SetError(err)
        try {
            let exit = Program.Main([]string{"--badswitch"})
            Assert.NotEqual(0, exit)
            Assert.Contains("Unrecognized option", err.ToString())
        } finally {
            Console.SetError(prevErr)
        }
    }

    @Fact
    func Main_MissingFile_ReturnsError() {
        using let err = StringWriter()
        let prevErr = Console.Error
        Console.SetError(err)
        try {
            let exit = Program.Main([]string{"/nonexistent/does-not-exist.gs"})
            Assert.NotEqual(0, exit)
            Assert.Contains("Unable to find", err.ToString())
        } finally {
            Console.SetError(prevErr)
        }
    }

    @Fact
    func Main_ValidSample_ReturnsSuccess() {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, `package P

func Main() {
}
`)
        let originalCwd = Directory.GetCurrentDirectory()
        let tempCwd = Directory.CreateTempSubdirectory("gsc_test_").FullName
        Directory.SetCurrentDirectory(tempCwd)
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            let exit = Program.Main([]string{sample})
            Assert.Equal(0, exit)
            Assert.Contains("Success", outWriter.ToString())
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            Directory.SetCurrentDirectory(originalCwd)
            try {
                Directory.Delete(tempCwd, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_WithOut_EmitsAssemblyAndRuntimeConfig() {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, `package HelloWorld
import System
Console.WriteLine("hi from gsc")
`)
        let tempDir = Directory.CreateTempSubdirectory("gsc_emit_").FullName
        let outPath = Path.Combine(tempDir, "HelloWorld.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", sample})
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath), "expected output assembly to exist")
            IlVerifier.Verify(outPath)
            let runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json")
            Assert.True(File.Exists(runtimeConfig), "expected runtimeconfig.json beside output")
            Assert.Contains("Microsoft.NETCore.App", File.ReadAllText(runtimeConfig))
            let assembly = EmittedFixture.Load(outPath)
            let targetFramework TargetFrameworkAttribute? = assembly.GetCustomAttribute[TargetFrameworkAttribute]()
            Assert.Equal(".NETCoreApp,Version=v10.0", targetFramework?.FrameworkName)
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_WithOut_LibraryTarget_DoesNotEmitRuntimeConfig() {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package MyLib\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_lib_").FullName
        let outPath = Path.Combine(tempDir, "MyLib.dll")
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", sample})
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath))
            IlVerifier.Verify(outPath)
            Assert.False(File.Exists(Path.ChangeExtension(outPath, ".runtimeconfig.json")))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_WithResource_EmbedsNamedManagedResource() {
        let name = "ResourceLib${Guid.NewGuid():N}"
        let sample = Path.Combine(Path.GetTempPath(), name + ".gs")
        let resource = Path.Combine(Path.GetTempPath(), name + ".txt")
        let tempDir = Directory.CreateTempSubdirectory("gsc_resource_").FullName
        let outPath = Path.Combine(tempDir, name + ".dll")
        File.WriteAllText(sample, (`package ` + "$name" + `
`))
        File.WriteAllText(resource, "embedded by gsc")
        try {
            let exit = Program.Main(
                []string{"/out:" + outPath, "/target:library", "/resource:$resource,Demo.Payload,private", sample}
            )
            Assert.Equal(0, exit)
            let assembly = EmittedFixture.Load(outPath)
            using let stream Stream? = assembly.GetManifestResourceStream("Demo.Payload")
            Assert.NotNull(stream)
            using let reader = StreamReader(stream!!)
            Assert.Equal("embedded by gsc", reader.ReadToEnd())
            using let peReader = PEReader(File.OpenRead(outPath))
            let metadata = peReader.GetMetadataReader()
            let manifestResource = metadata.GetManifestResource(metadata.ManifestResources.Single())
            Assert.Equal(ManifestResourceAttributes.Private, manifestResource.Attributes)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
            try {
                File.Delete(resource)
            } catch { }
        }
    }

    @Fact
    func Main_WithResponseFile_ParsesArgs() {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_rsp_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        let rspPath = Path.Combine(tempDir, "args.rsp")
        File.WriteAllLines(rspPath, []string{"/out:" + outPath, "/target:library", sample})
        try {
            let exit = Program.Main([]string{"@" + rspPath})
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath))
            IlVerifier.Verify(outPath)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func TokenizeResponseFileLine_SplitsOnWhitespace() {
        let tokens = Program.TokenizeResponseFileLine("/out:foo.dll /target:library a.gs")
        Assert.Equal([]string{"/out:foo.dll", "/target:library", "a.gs"}, tokens)
    }

    @Fact
    func TokenizeResponseFileLine_RespectsDoubleQuotes() {
        let tokens = Program.TokenizeResponseFileLine("/out:\"bin/my app.dll\" a.gs")
        Assert.Equal([]string{"/out:bin/my app.dll", "a.gs"}, tokens)
    }

    @Fact
    func TokenizeResponseFileLine_QuotedTokenContainingSpaces() {
        let tokens = Program.TokenizeResponseFileLine("\"path with spaces/foo.gs\"")
        Assert.Equal([]string{"path with spaces/foo.gs"}, tokens)
    }

    @Fact
    func TokenizeResponseFileLine_EmptyAndWhitespaceLines() {
        Assert.Empty(Program.TokenizeResponseFileLine(string.Empty))
        Assert.Empty(Program.TokenizeResponseFileLine("   \t  "))
    }

    @Fact
    func TokenizeResponseFileLine_EscapedDoubleQuoteInsideQuotes() {
        // Inside a quoted segment, "" represents a literal quote.
        let tokens = Program.TokenizeResponseFileLine("\"a\"\"b\" c")
        Assert.Equal([]string{"a\"b", "c"}, tokens)
    }

    @Fact
    func TokenizeResponseFileLine_AdjacentQuotedAndUnquoted() {
        // /out:"my app.dll" should yield a single token /out:my app.dll.
        let tokens = Program.TokenizeResponseFileLine("/out:\"my app.dll\"")
        Assert.Single(tokens)
        Assert.Equal("/out:my app.dll", tokens[0])
    }

    @Fact
    func TokenizeResponseFileLine_MultipleSpacesAndTabs() {
        let tokens = Program.TokenizeResponseFileLine("  a\tb   c  ")
        Assert.Equal([]string{"a", "b", "c"}, tokens)
    }

    @Fact
    func TokenizeResponseFileLine_EmptyQuotedStringYieldsEmptyToken() {
        // "" on its own is a deliberate empty argument.
        let tokens = Program.TokenizeResponseFileLine("a \"\" b")
        Assert.Equal([]string{"a", string.Empty, "b"}, tokens)
    }

    @Fact
    func Main_WithResponseFile_HandlesQuotedPathWithSpaces() {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_rsp_quoted_").FullName
        let spaceDir = Path.Combine(tempDir, "out put")
        Directory.CreateDirectory(spaceDir)
        let outPath = Path.Combine(spaceDir, "P.dll")
        let rspPath = Path.Combine(tempDir, "args.rsp")
        File.WriteAllLines(rspPath, []string{"/out:\"$outPath\" /target:library", "\"$sample\""})
        try {
            let exit = Program.Main([]string{"@" + rspPath})
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath), "expected output at '$outPath'")
            IlVerifier.Verify(outPath)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_WithSyntaxError_ReturnsErrorExitCode() {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        // Missing closing brace — GS0005 unexpected token
        File.WriteAllText(sample, `package P
func Broken(
`)
        let tempDir = Directory.CreateTempSubdirectory("gsc_err_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", sample})
            Assert.NotEqual(0, exit)
            Assert.False(File.Exists(outPath), "output assembly should not exist on error")
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_NowarnFlag_Accepted() {
        // /nowarn with an unknown ID should not crash gsc.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_nowarn_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/nowarn:GS0001,GS0002", sample})
            Assert.Equal(0, exit)
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_WarnAsErrorFlag_Accepted() {
        // /warnaserror without IDs should be accepted without crashing.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_wae_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/warnaserror", sample})
            Assert.Equal(0, exit)
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_WarnAsErrorPlusFlag_Accepted() {
        // /warnaserror+:<ids> should be accepted without crashing.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_waep_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/warnaserror+:GS0001", sample})
            Assert.Equal(0, exit)
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_WarnAsErrorMinusFlag_Accepted() {
        // /warnaserror-:<ids> should be accepted without crashing.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_waem_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/warnaserror-:GS0001", sample})
            Assert.Equal(0, exit)
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_NowarnFlag_AcceptsSemicolonDelimitedList() {
        // Issue #1665: MSBuild forwards NoWarn as a semicolon-delimited list
        // (e.g. "/nowarn:;NU5131;GS0001,GS0002") since $(NoWarn) conventionally
        // starts with an empty/leading separator (see Sdk.props: "$(NoWarn);NU5131").
        // gsc must split on ';' as well as ',' or the IDs after the first ';' are
        // never recognised.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_nowarn_semi_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            let exit = Program.Main(
                []string{"/out:" + outPath, "/target:library", "/nowarn:;NU5131;GS0001,GS0002", sample}
            )
            Assert.Equal(0, exit)
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_UnderReferencedClosure_SemicolonNoWarnSuppressesGs9100() {
        // Issue #1665: reproduces the exact SDK-forwarded shape (leading empty
        // token + semicolon separators) and confirms the previously-broken
        // suppression now works end to end.
        let refDir = Directory.CreateTempSubdirectory("gsc_ref1665n_").FullName
        let libPath = BuildLibraryWithMissingDependency(refDir)
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, `package P

func Main() {
}
`)
        let tempDir = Directory.CreateTempSubdirectory("gsc_outn1665_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        let prevOut = Console.Out
        Console.SetOut(outWriter)
        try {
            let exit = Program.Main(
                []string{"/out:" + outPath, "/target:library", "/nowarn:;NU5131;GS9100", "/r:" + libPath, sample}
            )
            Assert.Equal(0, exit)
            Assert.DoesNotContain("GS9100", outWriter.ToString())
        } finally {
            Console.SetOut(prevOut)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                Directory.Delete(refDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_SemicolonWarnAsErrorPromotesRealWarningToError() {
        // Issue #1665: the WarningsAsErrors counterpart of the NoWarn tests —
        // a semicolon-delimited /warnaserror+ value (as MSBuild forwards it,
        // e.g. "$(WarningsAsErrors);GS0166") must promote the targeted
        // warning to an error and fail the build. GS0166 (ADR-0066 D6: TLS +
        // explicit Main coexistence) is a real warning emitted through the
        // normal diagnostics pipeline.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, `package P
import System

Console.WriteLine("tls")

func Main() {
}
`)
        let tempDir = Directory.CreateTempSubdirectory("gsc_wae1665_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        let prevOut = Console.Out
        Console.SetOut(outWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:exe", "/warnaserror+:;GS0166", sample})
            Assert.NotEqual(0, exit)
            Assert.Contains("error GS0166", outWriter.ToString())
        } finally {
            Console.SetOut(prevOut)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Diagnostic_HasStableId_AndSeverity() {
        // Verify that a compile error produces a diagnostic with a stable GS#### ID and Error severity.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        // Unterminated string: should produce GS0003
        File.WriteAllText(sample, `package P
var x = "unterminated
`)
        let tree = SyntaxTree.Load(sample)
        try {
            Assert.True(tree.Diagnostics.Any(), "expected parse diagnostics")
            let d = tree.Diagnostics.First()
            Assert.NotNull(d.Id)
            Assert.StartsWith("GS", d.Id)
            Assert.Equal(DiagnosticSeverity.Error, d.Severity)
            Assert.True(d.IsError)
        } finally {
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Theory
    @InlineData("/debug", true)
    @InlineData("/debug+", true)
    @InlineData("/debug:portable", true)
    @InlineData("/debug:full", true)
    @InlineData("/debug:pdbonly", true)
    @InlineData("/debug:embedded", false)
    @InlineData("/debug:none", false)
    @InlineData("/debug-", false)
    func Main_DebugFlag_CreatesPdbWhenPortable(debugFlag string, expectPdb bool) {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package DbgLib\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_dbg_").FullName
        let outPath = Path.Combine(tempDir, "DbgLib.dll")
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", debugFlag, sample})
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath))
            IlVerifier.Verify(outPath)
            let pdbPath = Path.ChangeExtension(outPath, ".pdb")
            Assert.Equal(expectPdb, File.Exists(pdbPath))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_PdbFlag_ImpliesPortableAndUsesExplicitPath() {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package DbgPath\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_pdb_").FullName
        let outPath = Path.Combine(tempDir, "DbgPath.dll")
        let pdbPath = Path.Combine(tempDir, "custom-name.pdb")
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/pdb:" + pdbPath, sample})
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath))
            IlVerifier.Verify(outPath)
            Assert.True(File.Exists(pdbPath), "explicit /pdb:<path> sidecar should exist")
            // The default {PE}.pdb should NOT have been written when /pdb redirected it.
            Assert.False(File.Exists(Path.ChangeExtension(outPath, ".pdb")))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_DebugMinusOverridesPdbFlag() {
        // /debug- should win over an earlier /pdb:<path>: no PDB written.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package DbgOff\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_off_").FullName
        let outPath = Path.Combine(tempDir, "DbgOff.dll")
        let pdbPath = Path.Combine(tempDir, "DbgOff.pdb")
        try {
            let exit = Program.Main(
                []string{"/out:" + outPath, "/target:library", "/pdb:" + pdbPath, "/debug-", sample}
            )
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath))
            IlVerifier.Verify(outPath)
            Assert.False(File.Exists(pdbPath))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_UnknownDebugValue_ReturnsErrorExitCode() {
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_bad_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let errWriter = StringWriter()
        let prevErr = Console.Error
        Console.SetError(errWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/debug:bogus", sample})
            Assert.NotEqual(0, exit)
            Assert.Contains("/debug", errWriter.ToString())
        } finally {
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_UnderReferencedClosure_EmitsGs9100Warning() {
        // Issue #340: when a /r: reference depends on an assembly that was not
        // also supplied, gsc must not crash; it emits an advisory GS9100 naming
        // the missing assembly while the resolver degrades gracefully.
        let refDir = Directory.CreateTempSubdirectory("gsc_ref340_").FullName
        let libPath = BuildLibraryWithMissingDependency(refDir)
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, `package P

func Main() {
}
`)
        let tempDir = Directory.CreateTempSubdirectory("gsc_out340_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        let prevOut = Console.Out
        Console.SetOut(outWriter)
        try {
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/r:" + libPath, sample})
            Assert.Equal(0, exit)
            let output = outWriter.ToString()
            Assert.Contains("warning GS9100", output)
            Assert.Contains("DepAsmB", output)
        } finally {
            Console.SetOut(prevOut)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                Directory.Delete(refDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_UnderReferencedClosure_NoWarnSuppressesGs9100() {
        let refDir = Directory.CreateTempSubdirectory("gsc_ref340n_").FullName
        let libPath = BuildLibraryWithMissingDependency(refDir)
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, `package P

func Main() {
}
`)
        let tempDir = Directory.CreateTempSubdirectory("gsc_outn340_").FullName
        let outPath = Path.Combine(tempDir, "P.dll")
        using let outWriter = StringWriter()
        let prevOut = Console.Out
        Console.SetOut(outWriter)
        try {
            let exit = Program.Main(
                []string{"/out:" + outPath, "/target:library", "/nowarn:GS9100", "/r:" + libPath, sample}
            )
            Assert.Equal(0, exit)
            Assert.DoesNotContain("GS9100", outWriter.ToString())
        } finally {
            Console.SetOut(prevOut)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                Directory.Delete(refDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Theory
    @InlineData("/warnaserror", "", "error")
    @InlineData("/warnaserror+", "", "error")
    @InlineData("/warnaserror:GS9100", "", "error")
    @InlineData("/warnaserror+:GS9100", "", "error")
    @InlineData("/gsdiag:GS9100=error", "", "error")
    @InlineData("", "", "warning")
    @InlineData("/warnaserror+:GS0166", "", "warning")
    @InlineData("/warnaserror+", "/warnaserror-:GS9100", "warning")
    @InlineData("/warnaserror+", "/nowarn:GS9100", "")
    @InlineData("/warnaserror+", "/gsdiag:GS9100=none", "")
    func Driver_UnderReferencedClosure_UsesDiagnosticPolicy(firstOption string, secondOption string, severity string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = BuildReferenceWarningLibrary(fixture)
        let source = Path.Combine(fixture.Directory, "Warning.gs")
        File.WriteAllText(source, "let value = 1\nConsole.Write(\"ran5420\")\n")
        let output = Path.Combine(fixture.Directory, "Warning.dll")
        let reference = Path.Combine(fixture.Directory, "Warning.ref.dll")
        let pdb = Path.Combine(fixture.Directory, "Warning.pdb")
        let documentation = Path.Combine(fixture.Directory, "Warning.xml")
        let (exit, diagnostics) = RunReferenceWarningDriver(
            fixture.Directory,
            source,
            library,
            "/out:" + output,
            "/refout:" + reference,
            "/pdb:" + pdb,
            "/doc:" + documentation,
            firstOption,
            secondOption
        )
        if severity.Length == 0 {
            Assert.DoesNotContain("GS9100", diagnostics)
        } else {
            let warnings = Regex.Matches(diagnostics, `(?m)^.*\(1,1,1,1\): (?:warning|error) GS9100:.*$`)
            let warning = Assert.Single(warnings)
            Assert.StartsWith("$source(1,1,1,1): $severity GS9100: ", warning.Value)
            Assert.Contains("Missing5420", warning.Value)
        }
        Assert.DoesNotContain("GS9998", diagnostics)
        if severity == "error" {
            Assert.NotEqual(0, exit)
            Assert.Contains("Failed.", diagnostics)
            for path in[]string{
                output,
                reference,
                pdb,
                documentation,
                Path.ChangeExtension(output, ".runtimeconfig.json")
            } {
                Assert.False(File.Exists(path), "Rejected compilation wrote $path")
            }
        } else {
            Assert.True(exit == 0, diagnostics)
            Assert.True(File.Exists(reference))
            Assert.True(File.Exists(pdb))
            Assert.True(File.Exists(documentation))
            IlVerifier.Verify(output)
            Assert.Equal(Encoding.UTF8.GetBytes("ran5420"), fixture.RunBytes(output))
        }
    }

    @Fact
    func Main_WithRelativeOut_And_Debug_EmitsAbsolutePdbPathInCodeView() {
        // Regression for #421 (P2-8): a relative /out:<path> used to default
        // the PDB sidecar to a relative path too, which then flowed into the
        // CodeView debug directory entry verbatim. vsdbg/coreclr require an
        // absolute PDB path to bind breakpoints — a relative one leaves the
        // sidecar unresolvable from the debugger's working directory.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, `package RelOut

func Main() {
}
`)
        let originalCwd = Directory.GetCurrentDirectory()
        let tempCwd = Directory.CreateTempSubdirectory("gsc_relout_").FullName
        Directory.SetCurrentDirectory(tempCwd)
        try {
            const relativeOut = "RelOut.dll"
            let exit = Program.Main([]string{"/out:" + relativeOut, "/target:library", "/debug:portable", sample})
            Assert.Equal(0, exit)
            let absoluteOut = Path.Combine(tempCwd, relativeOut)
            let absolutePdb = Path.ChangeExtension(absoluteOut, ".pdb")
            Assert.True(File.Exists(absoluteOut), "expected output assembly to exist")
            Assert.True(File.Exists(absolutePdb), "expected sidecar PDB to exist")
            using let peReader = PEReader(MemoryStream(File.ReadAllBytes(absoluteOut)))
            let cv = peReader.ReadDebugDirectory().Single(
                (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.CodeView
            )
            let data = peReader.ReadCodeViewDebugDirectoryData(cv)
            Assert.True(Path.IsPathRooted(data.Path), "expected absolute CodeView PDB path, got: ${data.Path}")
            Assert.EndsWith("RelOut.pdb", data.Path, StringComparison.Ordinal)
        } finally {
            Directory.SetCurrentDirectory(originalCwd)
            try {
                Directory.Delete(tempCwd, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_OutputPathInUnwritableLocation_ReportsErrorAndExitsNonZero() {
        // Direct /out at a path whose containing directory cannot be created
        // (an existing FILE acts as a non-directory parent). On every OS this
        // makes Directory.CreateDirectory throw IOException, which previously
        // propagated out of Main and crashed gsc. The fix wraps Main with a
        // catch that reports GS9997 and returns Error.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let blocker = Path.Combine(Path.GetTempPath(), "gs_blocker_${Guid.NewGuid():N}")
        File.WriteAllText(blocker, "not a directory")
        let outPath = Path.Combine(blocker, "sub", "P.dll")
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            var exit = -42
            let ex = Record.Exception(
                () -> {
                    exit = Program.Main([]string{"/out:" + outPath, "/target:library", sample})
                }
            )
            Assert.Null(ex)
            Assert.NotEqual(0, exit)
            let stderr = errWriter.ToString()
            Assert.Contains("GS9997", stderr)
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                File.Delete(blocker)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    @Fact
    func Main_OutputPathIsExistingDirectory_ReportsErrorAndExitsNonZero() {
        // Pointing /out at an existing directory makes File.Create throw
        // UnauthorizedAccessException (Windows) or IOException (Unix). Both
        // must be caught and surfaced as a structured GS9997 error.
        let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
        File.WriteAllText(sample, "package P\n")
        let tempDir = Directory.CreateTempSubdirectory("gsc_io_err_").FullName
        using let outWriter = StringWriter()
        using let errWriter = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(outWriter)
        Console.SetError(errWriter)
        try {
            var exit = -42
            let ex = Record.Exception(
                () -> {
                    // /out: points at the directory itself (not a file inside it).
                    exit = Program.Main([]string{"/out:" + tempDir, "/target:library", sample})
                }
            )
            Assert.Null(ex)
            Assert.NotEqual(0, exit)
            let stderr = errWriter.ToString()
            Assert.Contains("GS9997", stderr)
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
            try {
                File.Delete(sample)
            } catch { }
        }
    }

    shared {
        private func BuildReferenceWarningLibrary(fixture NativeSliceLanguageTests.Fixture) string {
            let dependency = fixture.CompileCSharp("public class MissingMarker { }", "Missing5420")
            let library = fixture.CompileCSharp(
                "public static class Contract5420 { public static void Accept(MissingMarker value) { } }",
                "Contract5420",
                dependency
            )
            File.Delete(dependency)
            return library
        }

        private func RunReferenceWarningDriver(directory string, source string, library string, options ...string)(
            Exit int32,
            Diagnostics string
        ) {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = directory
            }
            start.ArgumentList.Add(typeof(Program).Assembly.Location)
            start.ArgumentList.Add(source)
            start.ArgumentList.Add("/targetframework:net10.0")
            start.ArgumentList.Add("/r:" + library)
            let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)
            for path in ReferenceResolver.HostTrustedPlatformAssemblyPaths().Where(
                (path string) -> Path.GetDirectoryName(path) == runtimeDirectory
            ) {
                start.ArgumentList.Add("/r:" + path)
            }
            for option in options.Where((option string) -> option.Length > 0) {
                start.ArgumentList.Add(option)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start gsc.")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("Reference warning driver exceeded 30 seconds.")
            }
            return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
        }

        private func BuildLibraryWithMissingDependency(dir string) string {
            let coreAssembly = typeof(object).Assembly
            let depName = AssemblyName("DepAsmB"){Version = Version(1, 0, 0, 0)}
            let depBuilder = PersistedAssemblyBuilder(depName, coreAssembly)
            let depModule = depBuilder.DefineDynamicModule("DepAsmB")
            let marker = depModule.DefineType("Dep.Marker", TypeAttributes.Public | TypeAttributes.Class)
            marker.CreateType()
            depBuilder.Save(Path.Combine(dir, "DepAsmB.dll"))
            let libName = AssemblyName("LibAsmA"){Version = Version(1, 0, 0, 0)}
            let libBuilder = PersistedAssemblyBuilder(libName, coreAssembly)
            let libModule = libBuilder.DefineDynamicModule("LibAsmA")
            let widget = libModule.DefineType("Lib.Widget", TypeAttributes.Public | TypeAttributes.Class)
            let method = widget.DefineMethod(
                "M",
                MethodAttributes.Public | MethodAttributes.Static,
                typeof(Void),
                cast[[]Type]([]TypeBuilder{marker})
            )
            method.GetILGenerator().Emit(OpCodes.Ret)
            widget.CreateType()
            let libPath = Path.Combine(dir, "LibAsmA.dll")
            libBuilder.Save(libPath)
            // The DepAsmB.dll is deliberately left in 'dir' but NOT passed via /r:,
            // so the closure handed to gsc is incomplete.
            return libPath
        }
    }
}
