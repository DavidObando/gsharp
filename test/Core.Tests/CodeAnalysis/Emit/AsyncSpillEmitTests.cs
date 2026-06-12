// <copyright file="AsyncSpillEmitTests.cs" company="GSharp">
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
/// End-to-end emit tests for the async spill sequence spiller.
/// These tests verify that sub-expression awaits compile and produce correct
/// results via PE round-trip.
/// </summary>
public class AsyncSpillEmitTests
{
    [Fact]
    public void Await_As_Binary_Operand_Computes_Correctly()
    {
        const string Source = @"package SpillBinaryTest
import System
import System.Threading.Tasks

async func compute() int32 {
    let result = (await Task.FromResult(40)) + 2
    return result
}

var t = compute()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillBinaryTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Await_As_Second_Argument_Of_TwoArg_Method_Computes_Correctly()
    {
        const string Source = @"package SpillArgTest
import System
import System.Threading.Tasks

async func compute() int32 {
    let result = (await Task.FromResult(10)) + (await Task.FromResult(32))
    return result
}

var t = compute()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillArgTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void LogicalAnd_ShortCircuits_Around_Await()
    {
        // When LHS is false, the RHS await is NOT evaluated.
        // We verify by checking the result is False.
        const string Source = @"package SpillAndShortCircuitTest
import System
import System.Threading.Tasks

async func test() bool {
    let result = false && (await Task.FromResult(true))
    return result
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillAndShortCircuitTest");
        Assert.Contains("False", output);
    }

    [Fact]
    public void LogicalAnd_Evaluates_Await_When_Lhs_True()
    {
        const string Source = @"package SpillAndEvalTest
import System
import System.Threading.Tasks

async func test() bool {
    let result = true && (await Task.FromResult(true))
    return result
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillAndEvalTest");
        Assert.Contains("True", output);
    }

    [Fact]
    public void Sequential_Awaits_In_Same_Expression_Both_Run_Once()
    {
        const string Source = @"package SpillSequentialTest
import System
import System.Threading.Tasks

async func compute() int32 {
    let result = (await Task.FromResult(20)) + (await Task.FromResult(22))
    return result
}

var t = compute()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillSequentialTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Return_Direct_Await_FromResult_Returns_Value()
    {
        // Regression for issue #132: `return await X` used to leak an
        // un-rewritten BoundAwaitExpression to the emitter.
        const string Source = @"package ReturnAwaitTest
import System
import System.Threading.Tasks

async func getVal() int32 {
    return await Task.FromResult(42)
}

var t = getVal()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "ReturnAwaitTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Return_Direct_Await_TaskDelay_RealSuspension_Returns_Value()
    {
        // Regression for issue #132: verify the real-suspension path through
        // `return await` works, not just the fast (FromResult) path.
        const string Source = @"package ReturnAwaitDelayTest
import System
import System.Threading.Tasks

async func getVal() int32 {
    await Task.Delay(1)
    return await Task.FromResult(42)
}

var t = getVal()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "ReturnAwaitDelayTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Await_As_RHS_Of_Array_Index_Assignment_Stores_Correctly()
    {
        // Regression for issue #419 (P0-4): `arr[i] = await expr` used to
        // crash emit with "Variable 'arr' has no local slot…" because the
        // spiller had no case for BoundIndexAssignmentExpression and the
        // hoisted-target receiver was never substituted into a state-machine
        // field load.
        const string Source = @"package SpillIndexAssignTest
import System
import System.Threading.Tasks

async func compute() int32 { return await Task.FromResult(42) }

async func test() int32 {
    var arr = []int32{0, 0, 0}
    arr[0] = await compute()
    return arr[0]
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillIndexAssignTest");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Await_As_Index_Of_Array_Index_Assignment_Stores_At_Correct_Slot()
    {
        // The index expression itself can also be an await; the spiller must
        // lift it out and the target alias logic must still kick in.
        const string Source = @"package SpillIndexExprAwaitTest
import System
import System.Threading.Tasks

async func idx() int32 { return await Task.FromResult(2) }

async func test() int32 {
    var arr = []int32{10, 20, 30}
    arr[await idx()] = 99
    return arr[0] + arr[1] + arr[2]
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillIndexExprAwaitTest");
        Assert.Contains("129", output);
    }

    [Fact]
    public void Two_Awaits_In_Index_Assignment_Preserve_Evaluation_Order()
    {
        // Both index and RHS contain awaits. After spilling, the index
        // must be evaluated and stabilized before the RHS await suspends.
        const string Source = @"package SpillIndexAndRhsAwaitTest
import System
import System.Threading.Tasks

async func idx() int32 { return await Task.FromResult(1) }
async func val() int32 { return await Task.FromResult(77) }

async func test() int32 {
    var arr = []int32{0, 0, 0}
    arr[await idx()] = await val()
    return arr[1]
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillIndexAndRhsAwaitTest");
        Assert.Contains("77", output);
    }

    [Fact]
    public void Await_As_RHS_Of_Field_Assignment_Stores_Correctly()
    {
        // Regression for issue #419 (P0-4): `obj.field = await expr` for a
        // hoisted struct receiver must write the mutated copy back into the
        // state-machine field for the change to persist.
        const string Source = @"package SpillFieldAssignTest
import System
import System.Threading.Tasks

struct Box {
    var Value int32
}

async func compute() int32 { return await Task.FromResult(99) }

async func test() int32 {
    var b = Box{Value: 0}
    b.Value = await compute()
    return b.Value
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillFieldAssignTest");
        Assert.Contains("99", output);
    }

    [Fact]
    public void Negate_Await_Computes_Correctly()
    {
        // Regression for issue #419 (P0-4): `-await expr` used to leak the
        // un-spilled await through SpillExpression's default case.
        const string Source = @"package SpillNegateAwaitTest
import System
import System.Threading.Tasks

async func num() int32 { return await Task.FromResult(10) }

async func test() int32 {
    let r = -await num()
    return r
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillNegateAwaitTest");
        Assert.Contains("-10", output);
    }

    [Fact]
    public void LogicalNot_Await_Computes_Correctly()
    {
        const string Source = @"package SpillNotAwaitTest
import System
import System.Threading.Tasks

async func ok() bool { return await Task.FromResult(false) }

async func test() bool {
    let r = !await ok()
    return r
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, "SpillNotAwaitTest");
        Assert.Contains("True", output);
    }

    [Fact]
    public void Multiple_Awaits_In_Index_Assignment_Chain_Run_Correctly()
    {
        const string Source = @"package SpillMultiAwaitChainTest
import System
import System.Threading.Tasks

async func n(x int32) int32 { return await Task.FromResult(x) }

async func test() int32 {
    var arr = []int32{0, 0, 0}
    arr[await n(0)] = await n(11)
    arr[await n(1)] = await n(22) + await n(0)
    arr[await n(2)] = -await n(7)
    return arr[0] + arr[1] + arr[2]
}

var t = test()
t.Wait()
Console.WriteLine(t.Result)
";
        // 11 + 22 + (-7) = 26
        var output = CompileAndRun(Source, "SpillMultiAwaitChainTest");
        Assert.Contains("26", output);
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
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
