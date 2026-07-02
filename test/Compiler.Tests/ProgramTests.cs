// <copyright file="ProgramTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using Xunit;

namespace GSharp.Compiler.Tests;

public class ProgramTests
{
    [Fact]
    public void Main_NoArgs_ReturnsError()
    {
        using var err = new StringWriter();
        var prevErr = Console.Error;
        Console.SetError(err);
        try
        {
            var exit = Program.Main(System.Array.Empty<string>());
            Assert.NotEqual(0, exit);
            Assert.Contains("Must specify", err.ToString());
        }
        finally
        {
            Console.SetError(prevErr);
        }
    }

    [Fact]
    public void Main_Help_PrintsUsageAndReturnsSuccess()
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var exit = Program.Main(new[] { "/?" });
            Assert.Equal(0, exit);
            Assert.Contains("Usage: gsc", outWriter.ToString());
            Assert.Contains("/help", outWriter.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
        }
    }

    [Fact]
    public void Main_UnrecognizedSwitch_ReturnsError()
    {
        using var err = new StringWriter();
        var prevErr = Console.Error;
        Console.SetError(err);
        try
        {
            var exit = Program.Main(new[] { "--badswitch" });
            Assert.NotEqual(0, exit);
            Assert.Contains("Unrecognized option", err.ToString());
        }
        finally
        {
            Console.SetError(prevErr);
        }
    }

    [Fact]
    public void Main_MissingFile_ReturnsError()
    {
        using var err = new StringWriter();
        var prevErr = Console.Error;
        Console.SetError(err);
        try
        {
            var exit = Program.Main(new[] { "/nonexistent/does-not-exist.gs" });
            Assert.NotEqual(0, exit);
            Assert.Contains("Unable to find", err.ToString());
        }
        finally
        {
            Console.SetError(prevErr);
        }
    }

    [Fact]
    public void Main_ValidSample_ReturnsSuccess()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n\nfunc Main() {\n}\n");
        var originalCwd = Directory.GetCurrentDirectory();
        var tempCwd = Directory.CreateTempSubdirectory("gsc_test_").FullName;
        Directory.SetCurrentDirectory(tempCwd);
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { sample });
            Assert.Equal(0, exit);
            Assert.Contains("Success", outWriter.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            Directory.SetCurrentDirectory(originalCwd);
            try { Directory.Delete(tempCwd, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_WithOut_EmitsAssemblyAndRuntimeConfig()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package HelloWorld\nimport System\nConsole.WriteLine(\"hi from gsc\")\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_emit_").FullName;
        var outPath = Path.Combine(tempDir, "HelloWorld.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:exe", "/targetframework:net10.0", sample });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath), "expected output assembly to exist");
            IlVerifier.Verify(outPath);
            var runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json");
            Assert.True(File.Exists(runtimeConfig), "expected runtimeconfig.json beside output");
            Assert.Contains("Microsoft.NETCore.App", File.ReadAllText(runtimeConfig));
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_WithOut_LibraryTarget_DoesNotEmitRuntimeConfig()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package MyLib\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_lib_").FullName;
        var outPath = Path.Combine(tempDir, "MyLib.dll");
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", sample });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath));
            IlVerifier.Verify(outPath);
            Assert.False(File.Exists(Path.ChangeExtension(outPath, ".runtimeconfig.json")));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_WithResponseFile_ParsesArgs()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_rsp_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");
        var rspPath = Path.Combine(tempDir, "args.rsp");
        File.WriteAllLines(rspPath, new[] { "/out:" + outPath, "/target:library", sample });
        try
        {
            var exit = Program.Main(new[] { "@" + rspPath });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath));
            IlVerifier.Verify(outPath);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void TokenizeResponseFileLine_SplitsOnWhitespace()
    {
        var tokens = GSharp.Compiler.Program.TokenizeResponseFileLine("/out:foo.dll /target:library a.gs");
        Assert.Equal(new[] { "/out:foo.dll", "/target:library", "a.gs" }, tokens);
    }

    [Fact]
    public void TokenizeResponseFileLine_RespectsDoubleQuotes()
    {
        var tokens = GSharp.Compiler.Program.TokenizeResponseFileLine("/out:\"bin/my app.dll\" a.gs");
        Assert.Equal(new[] { "/out:bin/my app.dll", "a.gs" }, tokens);
    }

    [Fact]
    public void TokenizeResponseFileLine_QuotedTokenContainingSpaces()
    {
        var tokens = GSharp.Compiler.Program.TokenizeResponseFileLine("\"path with spaces/foo.gs\"");
        Assert.Equal(new[] { "path with spaces/foo.gs" }, tokens);
    }

    [Fact]
    public void TokenizeResponseFileLine_EmptyAndWhitespaceLines()
    {
        Assert.Empty(GSharp.Compiler.Program.TokenizeResponseFileLine(string.Empty));
        Assert.Empty(GSharp.Compiler.Program.TokenizeResponseFileLine("   \t  "));
    }

    [Fact]
    public void TokenizeResponseFileLine_EscapedDoubleQuoteInsideQuotes()
    {
        // Inside a quoted segment, "" represents a literal quote.
        var tokens = GSharp.Compiler.Program.TokenizeResponseFileLine("\"a\"\"b\" c");
        Assert.Equal(new[] { "a\"b", "c" }, tokens);
    }

    [Fact]
    public void TokenizeResponseFileLine_AdjacentQuotedAndUnquoted()
    {
        // /out:"my app.dll" should yield a single token /out:my app.dll.
        var tokens = GSharp.Compiler.Program.TokenizeResponseFileLine("/out:\"my app.dll\"");
        Assert.Single(tokens);
        Assert.Equal("/out:my app.dll", tokens[0]);
    }

    [Fact]
    public void TokenizeResponseFileLine_MultipleSpacesAndTabs()
    {
        var tokens = GSharp.Compiler.Program.TokenizeResponseFileLine("  a\tb   c  ");
        Assert.Equal(new[] { "a", "b", "c" }, tokens);
    }

    [Fact]
    public void TokenizeResponseFileLine_EmptyQuotedStringYieldsEmptyToken()
    {
        // "" on its own is a deliberate empty argument.
        var tokens = GSharp.Compiler.Program.TokenizeResponseFileLine("a \"\" b");
        Assert.Equal(new[] { "a", string.Empty, "b" }, tokens);
    }

    [Fact]
    public void Main_WithResponseFile_HandlesQuotedPathWithSpaces()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_rsp_quoted_").FullName;
        var spaceDir = Path.Combine(tempDir, "out put");
        Directory.CreateDirectory(spaceDir);
        var outPath = Path.Combine(spaceDir, "P.dll");
        var rspPath = Path.Combine(tempDir, "args.rsp");
        File.WriteAllLines(rspPath, new[]
        {
            $"/out:\"{outPath}\" /target:library",
            $"\"{sample}\"",
        });
        try
        {
            var exit = GSharp.Compiler.Program.Main(new[] { "@" + rspPath });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath), $"expected output at '{outPath}'");
            IlVerifier.Verify(outPath);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_WithSyntaxError_ReturnsErrorExitCode()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        // Missing closing brace — GS0005 unexpected token
        File.WriteAllText(sample, "package P\nfunc Broken(\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_err_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", sample });
            Assert.NotEqual(0, exit);
            Assert.False(File.Exists(outPath), "output assembly should not exist on error");
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_NowarnFlag_Accepted()
    {
        // /nowarn with an unknown ID should not crash gsc.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_nowarn_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/nowarn:GS0001,GS0002", sample });
            Assert.Equal(0, exit);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_WarnAsErrorFlag_Accepted()
    {
        // /warnaserror without IDs should be accepted without crashing.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_wae_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/warnaserror", sample });
            Assert.Equal(0, exit);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_WarnAsErrorPlusFlag_Accepted()
    {
        // /warnaserror+:<ids> should be accepted without crashing.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_waep_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/warnaserror+:GS0001", sample });
            Assert.Equal(0, exit);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_WarnAsErrorMinusFlag_Accepted()
    {
        // /warnaserror-:<ids> should be accepted without crashing.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_waem_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/warnaserror-:GS0001", sample });
            Assert.Equal(0, exit);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_NowarnFlag_AcceptsSemicolonDelimitedList()
    {
        // Issue #1665: MSBuild forwards NoWarn as a semicolon-delimited list
        // (e.g. "/nowarn:;NU5131;GS0001,GS0002") since $(NoWarn) conventionally
        // starts with an empty/leading separator (see Sdk.props: "$(NoWarn);NU5131").
        // gsc must split on ';' as well as ',' or the IDs after the first ';' are
        // never recognised.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_nowarn_semi_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/nowarn:;NU5131;GS0001,GS0002", sample });
            Assert.Equal(0, exit);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_UnderReferencedClosure_SemicolonNoWarnSuppressesGs9100()
    {
        // Issue #1665: reproduces the exact SDK-forwarded shape (leading empty
        // token + semicolon separators) and confirms the previously-broken
        // suppression now works end to end.
        var refDir = Directory.CreateTempSubdirectory("gsc_ref1665n_").FullName;
        var libPath = BuildLibraryWithMissingDependency(refDir);

        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n\nfunc Main() {\n}\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_outn1665_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");

        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/nowarn:;NU5131;GS9100", "/r:" + libPath, sample });
            Assert.Equal(0, exit);
            Assert.DoesNotContain("GS9100", outWriter.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { Directory.Delete(refDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_SemicolonWarnAsErrorPromotesRealWarningToError()
    {
        // Issue #1665: the WarningsAsErrors counterpart of the NoWarn tests —
        // a semicolon-delimited /warnaserror+ value (as MSBuild forwards it,
        // e.g. "$(WarningsAsErrors);GS0166") must promote the targeted
        // warning to an error and fail the build. GS0166 (ADR-0066 D6: TLS +
        // explicit Main coexistence) is a real warning emitted through the
        // normal diagnostics pipeline, unlike the advisory GS9100.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\nimport System\n\nConsole.WriteLine(\"tls\")\n\nfunc Main() {\n}\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_wae1665_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");

        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:exe", "/warnaserror+:;GS0166", sample });
            Assert.NotEqual(0, exit);
            Assert.Contains("error GS0166", outWriter.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Diagnostic_HasStableId_AndSeverity()
    {
        // Verify that a compile error produces a diagnostic with a stable GS#### ID and Error severity.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        // Unterminated string: should produce GS0003
        File.WriteAllText(sample, "package P\nvar x = \"unterminated\n");
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Load(sample);
        try
        {
            Assert.True(tree.Diagnostics.Any(), "expected parse diagnostics");
            var d = tree.Diagnostics.First();
            Assert.NotNull(d.Id);
            Assert.StartsWith("GS", d.Id);
            Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error, d.Severity);
            Assert.True(d.IsError);
        }
        finally
        {
            try { File.Delete(sample); } catch { }
        }
    }

    [Theory]
    [InlineData("/debug", true)]
    [InlineData("/debug+", true)]
    [InlineData("/debug:portable", true)]
    [InlineData("/debug:full", true)]
    [InlineData("/debug:pdbonly", true)]
    [InlineData("/debug:embedded", false)]
    [InlineData("/debug:none", false)]
    [InlineData("/debug-", false)]
    public void Main_DebugFlag_CreatesPdbWhenPortable(string debugFlag, bool expectPdb)
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package DbgLib\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_dbg_").FullName;
        var outPath = Path.Combine(tempDir, "DbgLib.dll");
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", debugFlag, sample });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath));
            IlVerifier.Verify(outPath);
            var pdbPath = Path.ChangeExtension(outPath, ".pdb");
            Assert.Equal(expectPdb, File.Exists(pdbPath));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_PdbFlag_ImpliesPortableAndUsesExplicitPath()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package DbgPath\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_pdb_").FullName;
        var outPath = Path.Combine(tempDir, "DbgPath.dll");
        var pdbPath = Path.Combine(tempDir, "custom-name.pdb");
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/pdb:" + pdbPath, sample });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath));
            IlVerifier.Verify(outPath);
            Assert.True(File.Exists(pdbPath), "explicit /pdb:<path> sidecar should exist");
            // The default {PE}.pdb should NOT have been written when /pdb redirected it.
            Assert.False(File.Exists(Path.ChangeExtension(outPath, ".pdb")));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_DebugMinusOverridesPdbFlag()
    {
        // /debug- should win over an earlier /pdb:<path>: no PDB written.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package DbgOff\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_off_").FullName;
        var outPath = Path.Combine(tempDir, "DbgOff.dll");
        var pdbPath = Path.Combine(tempDir, "DbgOff.pdb");
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/pdb:" + pdbPath, "/debug-", sample });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath));
            IlVerifier.Verify(outPath);
            Assert.False(File.Exists(pdbPath));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_UnknownDebugValue_ReturnsErrorExitCode()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_bad_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");
        using var errWriter = new StringWriter();
        var prevErr = Console.Error;
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/debug:bogus", sample });
            Assert.NotEqual(0, exit);
            Assert.Contains("/debug", errWriter.ToString());
        }
        finally
        {
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_UnderReferencedClosure_EmitsGs9100Warning()
    {
        // Issue #340: when a /r: reference depends on an assembly that was not
        // also supplied, gsc must not crash; it emits an advisory GS9100 naming
        // the missing assembly while the resolver degrades gracefully.
        var refDir = Directory.CreateTempSubdirectory("gsc_ref340_").FullName;
        var libPath = BuildLibraryWithMissingDependency(refDir);

        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n\nfunc Main() {\n}\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_out340_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");

        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/r:" + libPath, sample });
            Assert.Equal(0, exit);

            var output = outWriter.ToString();
            Assert.Contains("warning GS9100", output);
            Assert.Contains("DepAsmB", output);
        }
        finally
        {
            Console.SetOut(prevOut);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { Directory.Delete(refDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_UnderReferencedClosure_NoWarnSuppressesGs9100()
    {
        var refDir = Directory.CreateTempSubdirectory("gsc_ref340n_").FullName;
        var libPath = BuildLibraryWithMissingDependency(refDir);

        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n\nfunc Main() {\n}\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_outn340_").FullName;
        var outPath = Path.Combine(tempDir, "P.dll");

        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var exit = Program.Main(new[] { "/out:" + outPath, "/target:library", "/nowarn:GS9100", "/r:" + libPath, sample });
            Assert.Equal(0, exit);
            Assert.DoesNotContain("GS9100", outWriter.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { Directory.Delete(refDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    private static string BuildLibraryWithMissingDependency(string dir)
    {
        var coreAssembly = typeof(object).Assembly;

        var depName = new AssemblyName("DepAsmB") { Version = new Version(1, 0, 0, 0) };
        var depBuilder = new PersistedAssemblyBuilder(depName, coreAssembly);
        var depModule = depBuilder.DefineDynamicModule("DepAsmB");
        var marker = depModule.DefineType("Dep.Marker", TypeAttributes.Public | TypeAttributes.Class);
        marker.CreateType();
        depBuilder.Save(Path.Combine(dir, "DepAsmB.dll"));

        var libName = new AssemblyName("LibAsmA") { Version = new Version(1, 0, 0, 0) };
        var libBuilder = new PersistedAssemblyBuilder(libName, coreAssembly);
        var libModule = libBuilder.DefineDynamicModule("LibAsmA");
        var widget = libModule.DefineType("Lib.Widget", TypeAttributes.Public | TypeAttributes.Class);
        var method = widget.DefineMethod(
            "M",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(void),
            new[] { marker });
        method.GetILGenerator().Emit(OpCodes.Ret);
        widget.CreateType();
        var libPath = Path.Combine(dir, "LibAsmA.dll");
        libBuilder.Save(libPath);

        // The DepAsmB.dll is deliberately left in 'dir' but NOT passed via /r:,
        // so the closure handed to gsc is incomplete.
        return libPath;
    }

    [Fact]
    public void Main_WithRelativeOut_And_Debug_EmitsAbsolutePdbPathInCodeView()
    {
        // Regression for #421 (P2-8): a relative /out:<path> used to default
        // the PDB sidecar to a relative path too, which then flowed into the
        // CodeView debug directory entry verbatim. vsdbg/coreclr require an
        // absolute PDB path to bind breakpoints — a relative one leaves the
        // sidecar unresolvable from the debugger's working directory.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package RelOut\n\nfunc Main() {\n}\n");
        var originalCwd = Directory.GetCurrentDirectory();
        var tempCwd = Directory.CreateTempSubdirectory("gsc_relout_").FullName;
        Directory.SetCurrentDirectory(tempCwd);
        try
        {
            const string relativeOut = "RelOut.dll";
            var exit = Program.Main(new[]
            {
                "/out:" + relativeOut,
                "/target:library",
                "/debug:portable",
                sample,
            });
            Assert.Equal(0, exit);

            var absoluteOut = Path.Combine(tempCwd, relativeOut);
            var absolutePdb = Path.ChangeExtension(absoluteOut, ".pdb");
            Assert.True(File.Exists(absoluteOut), "expected output assembly to exist");
            Assert.True(File.Exists(absolutePdb), "expected sidecar PDB to exist");

            using var peReader = new System.Reflection.PortableExecutable.PEReader(
                new MemoryStream(File.ReadAllBytes(absoluteOut)));
            var cv = peReader.ReadDebugDirectory()
                .Single(e => e.Type == System.Reflection.PortableExecutable.DebugDirectoryEntryType.CodeView);
            var data = peReader.ReadCodeViewDebugDirectoryData(cv);

            Assert.True(
                Path.IsPathRooted(data.Path),
                $"expected absolute CodeView PDB path, got: {data.Path}");
            Assert.EndsWith("RelOut.pdb", data.Path, StringComparison.Ordinal);
        }
        finally
        {
            Directory.SetCurrentDirectory(originalCwd);
            try { Directory.Delete(tempCwd, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_OutputPathInUnwritableLocation_ReportsErrorAndExitsNonZero()
    {
        // Direct /out at a path whose containing directory cannot be created
        // (an existing FILE acts as a non-directory parent). On every OS this
        // makes Directory.CreateDirectory throw IOException, which previously
        // propagated out of Main and crashed gsc. The fix wraps Main with a
        // catch that reports GS9999 and returns Error.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var blocker = Path.Combine(Path.GetTempPath(), $"gs_blocker_{System.Guid.NewGuid():N}");
        File.WriteAllText(blocker, "not a directory");
        var outPath = Path.Combine(blocker, "sub", "P.dll");
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            int exit = -42;
            var ex = Record.Exception(() =>
            {
                exit = Program.Main(new[] { "/out:" + outPath, "/target:library", sample });
            });
            Assert.Null(ex);
            Assert.NotEqual(0, exit);
            var stderr = errWriter.ToString();
            Assert.Contains("GS9999", stderr);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { File.Delete(blocker); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }

    [Fact]
    public void Main_OutputPathIsExistingDirectory_ReportsErrorAndExitsNonZero()
    {
        // Pointing /out at an existing directory makes File.Create throw
        // UnauthorizedAccessException (Windows) or IOException (Unix). Both
        // must be caught and surfaced as a structured GS9999 error.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n");
        var tempDir = Directory.CreateTempSubdirectory("gsc_io_err_").FullName;
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            int exit = -42;
            var ex = Record.Exception(() =>
            {
                // /out: points at the directory itself (not a file inside it).
                exit = Program.Main(new[] { "/out:" + tempDir, "/target:library", sample });
            });
            Assert.Null(ex);
            Assert.NotEqual(0, exit);
            var stderr = errWriter.ToString();
            Assert.Contains("GS9999", stderr);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }
}
