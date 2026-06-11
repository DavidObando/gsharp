// <copyright file="Issue377InterpolatedFollowupsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #377 regression coverage for the five follow-ups to PRs #372/#374:
/// (1) byref handler-parameter shape, (2) once-evaluated forwarded
/// constructor arguments, (3) await-in-hole spilling under the gated user
/// handler, (4) <c>M(object)</c> vs <c>M(FormattableString)</c> tie-break,
/// and (5) named-argument-wrapped interpolations target-typed to
/// <c>FormattableString</c>.
/// </summary>
public class Issue377InterpolatedFollowupsTests
{
    // --- Sub-item 1: byref handler parameter (ref / in) -------------------

    [Fact]
    public void Sub1_RefHandlerParameter_BindsAndRunsThroughHandler()
    {
        const string Source = @"package Issue377Ref
import System
import GSharp.Core.Tests.Fixtures

let msg = ByRefHandlerHarness.AppendRef(""R:"", ""x=${40 + 2}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "Issue377Ref");
        Assert.Contains("R:x=42", output);
    }

    [Fact]
    public void Sub1_InHandlerParameter_BindsAndRunsThroughHandler()
    {
        const string Source = @"package Issue377In
import System
import GSharp.Core.Tests.Fixtures

let msg = ByRefHandlerHarness.AppendIn(""I:"", ""y=${7 * 6}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "Issue377In");
        Assert.Contains("I:y=42", output);
    }

    [Fact]
    public void Sub1_ByValueHandler_StillWorks_NoRegression()
    {
        const string Source = @"package Issue377ByVal
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format(""V:"", ""z=${3 + 4}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "Issue377ByVal");
        Assert.Contains("V:z=7", output);
    }

    // --- Sub-item 2: forwarded arg evaluated exactly once -----------------

    [Fact]
    public void Sub2_ForwardedArgumentEvaluatedExactlyOnce()
    {
        const string Source = @"package Issue377Once
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format(ForwardCounter.IncrementAndReturn(""K:""), ""v=${9}"")
Console.WriteLine(msg)
";
        GSharp.Core.Tests.Fixtures.ForwardCounter.Reset();
        var output = CompileAndRun(Source, "Issue377Once");
        Assert.Contains("K:v=9", output);
        Assert.Equal(1, GSharp.Core.Tests.Fixtures.ForwardCounter.InvocationCount);
    }

    // --- Sub-item 3: await inside hole + gated user handler ---------------

    /// <summary>
    /// Deeper await-in-hole regression: a binary expression with an await
    /// operand inside the hole, plus a gated handler. The gate must skip
    /// the hole-and-append entirely when disabled (matching #418) and run
    /// the spilled await exactly once when enabled (no double evaluation).
    /// </summary>
    [Fact]
    public void Sub3_AwaitInsideBinaryHole_GatedHandler_EnabledRunsOnce()
    {
        const string Source = @"package Issue377AwaitGated
import System.Threading.Tasks
import GSharp.Core.Tests.Fixtures

InterpolationHarness.ResetHoleEvaluations()

async func runEnabled() string {
    return InterpolationHarness.Gated(true, ""sum=${(await InterpolationHarness.BumpAndReturnAsync(40)) + 2}"")
}

var t = runEnabled()
t.Wait()
";
        GSharp.Core.Tests.Fixtures.InterpolationHarness.ResetHoleEvaluations();
        CompileAndRun(Source, "Issue377AwaitGated");
        Assert.Equal(1, GSharp.Core.Tests.Fixtures.InterpolationHarness.HoleEvaluations);
    }

    [Fact]
    public void Sub3_AwaitInsideBinaryHole_GatedHandler_DisabledDoesNotEvaluate()
    {
        const string Source = @"package Issue377AwaitGatedOff
import System.Threading.Tasks
import GSharp.Core.Tests.Fixtures

InterpolationHarness.ResetHoleEvaluations()

async func runDisabled() string {
    return InterpolationHarness.Gated(false, ""sum=${(await InterpolationHarness.BumpAndReturnAsync(40)) + 2}"")
}

var t = runDisabled()
t.Wait()
";
        GSharp.Core.Tests.Fixtures.InterpolationHarness.ResetHoleEvaluations();
        CompileAndRun(Source, "Issue377AwaitGatedOff");
        Assert.Equal(0, GSharp.Core.Tests.Fixtures.InterpolationHarness.HoleEvaluations);
    }

    // --- Sub-item 4: M(object) vs M(FormattableString) tie-break ---------

    [Fact]
    public void Sub4_FormattableStringOverloadBeatsObject()
    {
        const string Source = @"package Issue377Overload
import System
import GSharp.Core.Tests.Fixtures

FormattableOverloadHarness.Reset()
let _ = FormattableOverloadHarness.ChooseObject(""value=${42}"")
Console.WriteLine(FormattableOverloadHarness.LastChosen)
";
        GSharp.Core.Tests.Fixtures.FormattableOverloadHarness.Reset();
        var output = CompileAndRun(Source, "Issue377Overload");
        Assert.Contains("formattable:value={0}", output);
        Assert.DoesNotContain("object:", output);
    }

    // --- Sub-item 5: named-argument wrapped interpolation target-typing --

    [Fact]
    public void Sub5_NamedArgumentInterpolationTargetTypesToFormattableString()
    {
        // Sanity: positional call (works without SI5).
        const string PositionalSource = @"package Issue377NamedSanity
import System
import GSharp.Core.Tests.Fixtures

FormattableNamedArgHarness.Reset()
let _ = FormattableNamedArgHarness.AcceptNamed(""value=${1 + 2}"")
Console.WriteLine(FormattableNamedArgHarness.LastFormat)
";
        GSharp.Core.Tests.Fixtures.FormattableNamedArgHarness.Reset();
        var positionalOutput = CompileAndRun(PositionalSource, "Issue377NamedSanity");
        Assert.Contains("value={0}", positionalOutput);

        const string Source = @"package Issue377Named
import System
import GSharp.Core.Tests.Fixtures

FormattableNamedArgHarness.Reset()
let _ = FormattableNamedArgHarness.AcceptNamed(f: ""value=${1 + 2}"")
Console.WriteLine(FormattableNamedArgHarness.LastFormat)
";
        GSharp.Core.Tests.Fixtures.FormattableNamedArgHarness.Reset();
        var output = CompileAndRun(Source, "Issue377Named");
        Assert.Contains("value={0}", output);
    }

    private static string CompileAndRun(string source, string contextName)
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
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
