// <copyright file="RelationalPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Regression coverage for issue #421 (P2-4): relational patterns must
/// emit unsigned/unordered comparison opcodes for unsigned-integer,
/// char, and floating-point discriminants. Previously the emitter
/// hard-coded <c>Clt</c>/<c>Cgt</c>, which yields wrong answers for
/// <c>uint32</c>/<c>uint64</c>/<c>nuint</c>/<c>char</c> boundary values
/// and disagrees with IEEE NaN semantics for <c>float32</c>/<c>float64</c>.
/// </summary>
public class RelationalPatternEmitTests
{
    [Fact]
    public void RelationalPattern_UInt32_Boundary_UsesUnsignedComparison()
    {
        // 0xFFFFFFFFu is uint.MaxValue. Treated as signed it is -1 and
        // would NOT satisfy `> 1u`; with unsigned Cgt_un it does.
        const string Source = @"package P
import System
let v = 4294967295u
let r = switch v { case > 1u -> ""hi"" default -> ""lo"" }
Console.WriteLine(r)
";
        Assert.Contains("hi", CompileLoadInvokeCaptureStdout(Source, "RelPatUInt32"));
    }

    [Fact]
    public void RelationalPattern_UInt32_GreaterOrEqual_UsesUnsignedComparison()
    {
        const string Source = @"package P
import System
let v = 4294967295u
let r = switch v { case >= 2u -> ""ge"" default -> ""lt"" }
Console.WriteLine(r)
";
        Assert.Contains("ge", CompileLoadInvokeCaptureStdout(Source, "RelPatUInt32Ge"));
    }

    [Fact]
    public void RelationalPattern_UInt64_Boundary_UsesUnsignedComparison()
    {
        // 0xFFFFFFFFFFFFFFFF is ulong.MaxValue. Signed Clt would mis-order.
        const string Source = @"package P
import System
let v = 18446744073709551615UL
let r = switch v { case > 1UL -> ""hi"" default -> ""lo"" }
Console.WriteLine(r)
";
        Assert.Contains("hi", CompileLoadInvokeCaptureStdout(Source, "RelPatUInt64"));
    }

    [Fact]
    public void RelationalPattern_UInt64_LessOrEqual_UsesUnsignedComparison()
    {
        // 1UL <= ulong.MaxValue must hold. With signed Cgt this evaluates
        // wrong because ulong.MaxValue is sign-interpreted as -1.
        const string Source = @"package P
import System
let v = 1UL
let r = switch v { case <= 18446744073709551615UL -> ""le"" default -> ""gt"" }
Console.WriteLine(r)
";
        Assert.Contains("le", CompileLoadInvokeCaptureStdout(Source, "RelPatUInt64Le"));
    }

    [Fact]
    public void RelationalPattern_Char_HighCodepoint_UsesUnsignedComparison()
    {
        // '\uFFFE' compared against 'A' (0x41). Signed Clt would view it
        // as negative when widened — must compare as unsigned 16-bit.
        const string Source = @"package P
import System
let c = '\uFFFE'
let r = switch c { case > 'A' -> ""hi"" default -> ""lo"" }
Console.WriteLine(r)
";
        Assert.Contains("hi", CompileLoadInvokeCaptureStdout(Source, "RelPatChar"));
    }

    [Fact]
    public void RelationalPattern_Float64_NaN_UsesUnorderedComparison()
    {
        // IEEE-754: every ordered relation involving NaN must be false.
        // For strict <, >: signed Clt/Cgt already return false on NaN.
        // For <=, >=: must use Cgt_un/Clt_un so the negation flips to false.
        const string Source = @"package P
import System
let v = 0.0 / 0.0
let g  = switch v { case >  0.0 -> ""gt"" default -> ""nope"" }
let l  = switch v { case <  0.0 -> ""lt"" default -> ""nope"" }
let ge = switch v { case >= 0.0 -> ""ge"" default -> ""nope"" }
let le = switch v { case <= 0.0 -> ""le"" default -> ""nope"" }
Console.WriteLine(g)
Console.WriteLine(l)
Console.WriteLine(ge)
Console.WriteLine(le)
";
        var output = CompileLoadInvokeCaptureStdout(Source, "RelPatFloat64NaN");
        Assert.Equal("nope\nnope\nnope\nnope\n", output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void RelationalPattern_Float32_NaN_UsesUnorderedComparison()
    {
        const string Source = @"package P
import System
let v = 0.0f / 0.0f
let g  = switch v { case >  0.0f -> ""gt"" default -> ""nope"" }
let ge = switch v { case >= 0.0f -> ""ge"" default -> ""nope"" }
let le = switch v { case <= 0.0f -> ""le"" default -> ""nope"" }
Console.WriteLine(g)
Console.WriteLine(ge)
Console.WriteLine(le)
";
        var output = CompileLoadInvokeCaptureStdout(Source, "RelPatFloat32NaN");
        Assert.Equal("nope\nnope\nnope\n", output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void RelationalPattern_Float64_NormalValues_StillWork()
    {
        const string Source = @"package P
import System
let v = 1.5
let r = switch v { case > 1.0 -> ""hi"" default -> ""lo"" }
Console.WriteLine(r)
";
        Assert.Contains("hi", CompileLoadInvokeCaptureStdout(Source, "RelPatFloat64Pos"));
    }

    [Fact]
    public void RelationalPattern_Int32_Signed_StillUsesSignedComparison()
    {
        // Negative signed values must still satisfy `< 0`. Regression
        // guard ensuring we did not accidentally flip *signed* discriminants
        // to unsigned opcodes.
        const string Source = @"package P
import System
let v = -5
let r = switch v { case < 0 -> ""neg"" default -> ""nn"" }
Console.WriteLine(r)
";
        Assert.Contains("neg", CompileLoadInvokeCaptureStdout(Source, "RelPatInt32Signed"));
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, parameters: null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
