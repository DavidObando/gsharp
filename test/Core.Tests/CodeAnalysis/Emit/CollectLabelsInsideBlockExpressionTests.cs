// <copyright file="CollectLabelsInsideBlockExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

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
/// Issue #418 (P1-4): <c>CollectLabels</c> used to ignore labels living
/// inside a <c>BoundBlockExpression</c> (interpolated-string handler gate,
/// null-conditional capture, switch-expression spill, ...). Those labels
/// are registered in <c>this.labels</c> by <c>EmitBlockExpression</c>, but
/// the lexical label set for the enclosing <c>try</c> never saw them. A
/// <c>goto</c> whose source and target both lived inside the same protected
/// region therefore tripped <c>EmitBranch</c>'s <c>crossesRegion</c>
/// heuristic and emitted a CIL <c>leave</c> — illegal when the target is
/// inside the same region; the JIT rejects the method with
/// <see cref="System.InvalidProgramException"/>.
///
/// These tests reproduce the bug end-to-end by placing an interpolated
/// string that binds to the <c>GatedInterpolatedStringHandler</c> fixture
/// (an <c>[InterpolatedStringHandler]</c> whose constructor takes
/// <c>out bool shouldAppend</c>) inside a <c>try</c>. The lowering pass
/// emits a <c>BoundBlockExpression</c> whose statement list contains
/// per-append short-circuit <c>BoundConditionalGotoStatement</c> /
/// <c>BoundLabelStatement</c> pairs; pre-fix, the <c>goto</c>s were
/// translated to <c>leave</c> and the resulting method failed to JIT.
/// </summary>
public class CollectLabelsInsideBlockExpressionTests
{
    [Fact]
    public void Gated_Interpolated_String_Inside_Try_Catch_Is_Valid_IL()
    {
        const string Source = @"package CollectLabelsTryCatch
import System
import GSharp.Core.Tests.Fixtures

try {
    let msg = InterpolationHarness.Gated(true, ""y=${9}"")
    Console.WriteLine(msg)
} catch (e Exception) {
    Console.WriteLine(""caught"")
}
";
        var output = CompileAndRun(Source, "P1_4_TryCatch");
        Assert.Contains("y=9", output);
    }

    [Fact]
    public void Gated_Interpolated_String_Inside_Try_Finally_Is_Valid_IL()
    {
        const string Source = @"package CollectLabelsTryFinally
import System
import GSharp.Core.Tests.Fixtures

try {
    let msg = InterpolationHarness.Gated(true, ""z=${42}"")
    Console.WriteLine(msg)
} finally {
    Console.WriteLine(""done"")
}
";
        var output = CompileAndRun(Source, "P1_4_TryFinally");
        Assert.Contains("z=42", output);
        Assert.Contains("done", output);
    }

    [Fact]
    public void Gated_Interpolated_String_With_Many_Holes_Inside_Try_Is_Valid_IL()
    {
        // Multiple holes => multiple per-append BoundConditionalGoto/BoundLabel
        // pairs inside the same BoundBlockExpression. All of them must be
        // collected into the enclosing try's lexical label set so that the
        // emitter does not translate them to `leave`.
        const string Source = @"package CollectLabelsTryMultiHole
import System
import GSharp.Core.Tests.Fixtures

try {
    let msg = InterpolationHarness.Gated(true, ""a=${1} b=${2} c=${3}"")
    Console.WriteLine(msg)
} catch (e Exception) {
    Console.WriteLine(""caught"")
}
";
        var output = CompileAndRun(Source, "P1_4_MultiHole");
        Assert.Contains("a=1 b=2 c=3", output);
    }

    [Fact]
    public void Gated_Interpolated_String_Disabled_Inside_Try_Is_Valid_IL()
    {
        // shouldAppend = false: the gate short-circuits past every append.
        // Pre-fix, the conditional gotos inside the BoundBlockExpression
        // were emitted as `leave`, so the IL would fail to JIT even when
        // taking the disabled branch.
        const string Source = @"package CollectLabelsTryDisabled
import System
import GSharp.Core.Tests.Fixtures

try {
    let msg = InterpolationHarness.Gated(false, ""y=${9}"")
    Console.WriteLine(""len="" + msg.Length.ToString())
} catch (e Exception) {
    Console.WriteLine(""caught"")
}
";
        var output = CompileAndRun(Source, "P1_4_Disabled");
        Assert.Contains("len=0", output);
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

            var stdout = System.Console.Out;
            var captured = new StringWriter();
            System.Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                System.Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
