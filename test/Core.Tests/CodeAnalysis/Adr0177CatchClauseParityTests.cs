// <copyright file="Adr0177CatchClauseParityTests.cs" company="GSharp">
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

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0177 / issue #3897 (family 1): <c>catch</c> clause parity with C#. A
/// clause may name a type without binding a variable, may omit both, and may
/// carry a <c>when</c> filter that the emitter lowers to a real CLR filter
/// region — so matching order, first-pass filter timing, fall-through on a
/// false filter, and stack-trace preservation are the runtime's behaviour and
/// not something the compiler reproduces by hand.
/// </summary>
public class Adr0177CatchClauseParityTests
{
    /// <summary>
    /// ADR-0177 §A, the bug that motivated the ADR: before this change
    /// <c>catch (InvalidOperationException)</c> parsed as a clause binding a
    /// variable *named* <c>InvalidOperationException</c> of the implicit
    /// exception type, so it caught everything. The witness of discrimination
    /// is the type thrown: it is unrelated to the type named, so the pre-change
    /// compiler printed <c>caught</c> and this test failed.
    /// </summary>
    [Fact]
    public void TypeOnlyCatch_CatchesOnlyThatType()
    {
        const string source = @"
package P
import System

func run() string {
    try {
        throw FormatException(""boom"")
    } catch (InvalidOperationException) {
        return ""caught""
    }
}

try {
    Console.WriteLine(run())
} catch (e Exception) {
    Console.WriteLine(""escaped:"" + e.GetType().Name)
}
";
        Assert.Equal("escaped:FormatException", CompileLoadRun(source, "Adr0177-TypeOnly").Trim());
    }

    /// <summary>
    /// ADR-0177 §A: a bare <c>catch</c> is <c>catch (Exception)</c> with no
    /// binder — it handles anything and needs no synthetic name (#3897).
    /// </summary>
    [Fact]
    public void BareCatch_HandlesAnythingWithoutABinder()
    {
        const string source = @"
package P
import System

try {
    throw FormatException(""boom"")
} catch {
    Console.WriteLine(""bare"")
}
";
        Assert.Equal("bare", CompileLoadRun(source, "Adr0177-Bare").Trim());
    }

    /// <summary>
    /// ADR-0177 §C, verification item 2: a false filter declines, and the
    /// exception falls through to the next clause — the same clause type, so
    /// only the filter can be what distinguishes them. Pre-ADR-0177 cs2gs had
    /// to merge such siblings by hand precisely because this did not work
    /// (issues #1724, #2235).
    /// </summary>
    [Fact]
    public void FalseFilter_FallsThroughToTheNextSibling()
    {
        const string source = @"
package P
import System

try {
    throw FormatException(""boom"")
} catch (e FormatException) when e.Message == ""other"" {
    Console.WriteLine(""first"")
} catch (e FormatException) when e.Message == ""boom"" {
    Console.WriteLine(""second"")
} catch (e FormatException) {
    Console.WriteLine(""third"")
}
";
        Assert.Equal("second", CompileLoadRun(source, "Adr0177-FallThrough").Trim());
    }

    /// <summary>
    /// ADR-0177 §C, verification item 3 — the property that a hand-lowered
    /// filter can never have. A CLR filter runs in the <em>first pass</em>,
    /// before any intervening <c>finally</c> unwinds; a filter evaluated at the
    /// top of the handler necessarily runs after it. The log order is the
    /// witness: <c>filter</c> must precede <c>finally</c>.
    /// </summary>
    [Fact]
    public void Filter_RunsInTheFirstPassBeforeAnInterveningFinally()
    {
        const string source = @"
package P
import System

func note(text string) bool {
    Console.Write(text + "";"")
    return true
}

try {
    try {
        throw FormatException(""boom"")
    } finally {
        note(""finally"")
    }
} catch (e FormatException) when note(""filter"") {
    Console.Write(""handler"")
}
";
        Assert.Equal("filter;finally;handler", CompileLoadRun(source, "Adr0177-FirstPass").Trim());
    }

    /// <summary>
    /// ADR-0177 §E follow-up: the handler runs only after its filter returned
    /// true, so a pattern variable definitely assigned on that path is visible
    /// throughout the handler. Before this change the body reported GS0532 for
    /// <c>arg</c>, which is the witness of discrimination.
    /// </summary>
    [Fact]
    public void FilterPatternBinding_IsVisibleInTheHandler()
    {
        const string source = @"
package P
import System

try {
    throw InvalidOperationException(""outer"", ArgumentException(""inner"", ""value""))
} catch (e InvalidOperationException) when e.InnerException is ArgumentException arg {
    Console.WriteLine(arg.ParamName)
}
";
        Assert.Equal("value", CompileLoadRun(source, "Adr0177-FilterBinding").Trim());
    }

    /// <summary>
    /// The scope follows definite assignment, not mere syntax containment: a
    /// variable assigned only when the filter is false is unavailable in the
    /// handler, which is reached on the true path.
    /// </summary>
    [Fact]
    public void FilterPatternBinding_AssignedOnlyWhenFalse_IsNotVisible()
    {
        const string source = @"
package P
import System

try {
    throw InvalidOperationException(""outer"", ArgumentException(""inner""))
} catch (e InvalidOperationException) when !(e.InnerException is ArgumentException arg) {
    Console.WriteLine(arg.Message)
}
";
        Assert.Contains(Compile(source), d => d.Id == "GS0532");
    }

    /// <summary>
    /// ADR-0177 §C, verification item 4: an exception thrown out of a filter is
    /// swallowed by the runtime and the filter is treated as false — it neither
    /// propagates nor handles the original. The next sibling therefore runs.
    /// </summary>
    [Fact]
    public void ThrowingFilter_DeclinesWithoutPropagating()
    {
        const string source = @"
package P
import System

func boom() bool {
    throw InvalidOperationException(""filter blew up"")
}

try {
    throw FormatException(""original"")
} catch (e FormatException) when boom() {
    Console.WriteLine(""first"")
} catch (e Exception) {
    Console.WriteLine(""second:"" + e.Message)
}
";
        Assert.Equal("second:original", CompileLoadRun(source, "Adr0177-ThrowingFilter").Trim());
    }

    /// <summary>
    /// ADR-0177 §C, verification item 5: when every clause declines, the
    /// exception keeps travelling with its original throw site. The witness is
    /// the frame name in the stack trace — a <c>throw e</c>-style relowering
    /// would show the rethrow site instead.
    /// </summary>
    [Fact]
    public void DeclinedException_KeepsItsOriginalThrowSite()
    {
        const string source = @"
package P
import System

// Recursive so the JIT cannot inline the frame this test is about.
func thrower(depth int32) {
    if depth > 0 {
        thrower(depth - 1)
    }

    throw FormatException(""boom"")
}

func middle() {
    try {
        thrower(1)
    } catch (e InvalidOperationException) {
        Console.WriteLine(""wrong"")
    } catch (e FormatException) when false {
        Console.WriteLine(""wrong"")
    }
}

try {
    middle()
} catch (e Exception) {
    Console.WriteLine(e.StackTrace.Contains(""thrower""))
}
";
        Assert.Equal("True", CompileLoadRun(source, "Adr0177-StackTrace").Trim());
    }

    /// <summary>
    /// ADR-0177 §C, verification item 6: filters survive async lowering. The
    /// handler awaits (so the clause is rewritten onto the state machine's
    /// trampoline), and a pattern variable introduced by the filter remains
    /// available after that suspension.
    /// </summary>
    [Fact]
    public void FilteredClause_SurvivesAsyncLowering()
    {
        const string source = @"
package P
import System
import System.Threading.Tasks

async func run() Task[string] {
    try {
        throw InvalidOperationException(""outer"", ArgumentException(""inner""))
    } catch (e InvalidOperationException) when e.InnerException is ArgumentException arg {
        await Task.Yield()
        return arg.Message
    }
}

Console.WriteLine(run().GetAwaiter().GetResult())
";
        Assert.Equal("inner", CompileLoadRun(source, "Adr0177-Async").Trim());
    }

    /// <summary>
    /// ADR-0177 §C: a <c>rethrow</c> inside a filtered clause's handler behaves
    /// per ADR-0176 — the exception continues outward with its identity intact
    /// after the filter accepted it.
    /// </summary>
    [Fact]
    public void RethrowFromAFilteredHandler_PropagatesTheSameException()
    {
        const string source = @"
package P
import System

func inner() {
    try {
        throw FormatException(""boom"")
    } catch (e FormatException) when e.Message == ""boom"" {
        Console.Write(""filtered;"")
        rethrow
    }
}

try {
    inner()
} catch (e FormatException) {
    Console.Write(""outer:"" + e.Message)
}
";
        Assert.Equal("filtered;outer:boom", CompileLoadRun(source, "Adr0177-Rethrow").Trim());
    }

    /// <summary>
    /// ADR-0177 §D: GS0572. A filter runs in the first pass, on the throwing
    /// thread, before unwinding — there is no suspension point available, so
    /// <c>await</c> in one is rejected rather than mis-lowered.
    /// </summary>
    [Fact]
    public void AwaitInsideAFilter_ReportsGs0572()
    {
        const string source = @"
package P
import System
import System.Threading.Tasks

async func run() Task {
    try {
        throw FormatException(""boom"")
    } catch (e FormatException) when await Task.FromResult(true) {
        Console.WriteLine(""x"")
    }
}

run().GetAwaiter().GetResult()
";
        Assert.Contains(Compile(source), d => d.Id == "GS0572");
    }

    /// <summary>
    /// ADR-0177 §D: GS0573. A clause after an unfiltered clause that already
    /// catches the same type can never run. The negative half is the witness:
    /// the identical shape with a <c>when</c> on the earlier clause is
    /// perfectly reachable and must NOT be reported.
    /// </summary>
    [Fact]
    public void ClauseShadowedByAnUnfilteredPredecessor_ReportsGs0573()
    {
        const string shadowed = @"
package P
import System

try {
    throw FormatException(""boom"")
} catch (e Exception) {
    Console.WriteLine(""a"")
} catch (e FormatException) {
    Console.WriteLine(""b"")
}
";
        Assert.Contains(Compile(shadowed), d => d.Id == "GS0573");

        const string reachable = @"
package P
import System

try {
    throw FormatException(""boom"")
} catch (e Exception) when e.Message == ""other"" {
    Console.WriteLine(""a"")
} catch (e FormatException) {
    Console.WriteLine(""b"")
}
";
        Assert.DoesNotContain(Compile(reachable), d => d.Id == "GS0573");
    }

    /// <summary>
    /// ADR-0177 §D / ADR-0176: a filter is not a handler, so <c>rethrow</c> in
    /// one has no exception in flight to resume and is rejected with GS0570.
    /// </summary>
    [Fact]
    public void RethrowInsideAFilter_ReportsGs0570()
    {
        const string source = @"
package P
import System

func check() bool {
    rethrow
}

try {
    throw FormatException(""boom"")
} catch (e FormatException) when check() {
    Console.WriteLine(""x"")
}
";
        Assert.Contains(Compile(source), d => d.Id == "GS0570");
    }

    /// <summary>
    /// ADR-0177 §B: a filter must be a <c>bool</c>. Anything else is a type
    /// error, not an implicit truthiness conversion.
    /// </summary>
    [Fact]
    public void NonBooleanFilter_IsATypeError()
    {
        const string source = @"
package P
import System

try {
    throw FormatException(""boom"")
} catch (e FormatException) when e.Message {
    Console.WriteLine(""x"")
}
";
        Assert.NotEmpty(Compile(source));
    }

    private static System.Collections.Immutable.ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic>
        Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(new MemoryStream()).Diagnostics;
    }

    private static string CompileLoadRun(string source, string contextName)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);

        using var peStream = new MemoryStream();
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
