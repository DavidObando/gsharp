// <copyright file="Issue4180NullableSelectResultRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Issue #4180 (split from #4129's clustering work, umbrella #3501): six of
/// #4129's test-parity failures (all sharing the shared
/// `AssertImplementsGenericOf`/`AssertImplementsEnumerableOf` helper
/// pattern in `test/Compiler.Tests/Emit/Issue1489GenericAsyncIteratorEmitTests.cs`,
/// `Issue1481MapFunctionIteratorEmitTests.cs` and
/// `Issue813TupleSequenceReturnEmitTests.cs`) crashed under self-hosting
/// with a bare `System.NullReferenceException` raised INSIDE a
/// `.Select(i => i.FullName)` lambda (via
/// `System.Linq.Enumerable.ArraySelectIterator.MoveNext()`, invoked from
/// `String.Join`) — even though the same C# compiled and run natively
/// never throws, because (cref:Type.FullName) legitimately returns
/// `null` (not merely falsy) for a reified generic
/// interface row closed over an unresolved class type parameter — exactly
/// the shape these tests construct and reflect over.
///
/// Root cause: this is NOT a gsc emitter defect (the emitted state machines'
/// interface metadata is correct under both native and self-hosted gsc — see
/// the issue's investigation). It is a cs2gs TRANSLATOR defect:
/// `CSharpToGSharpTranslator.Expressions.LambdaResultFlowsToNullableSink`
/// (added by issue #4046 to keep a generic selector's result unasserted when
/// its fluent call chain "collapses back to the same scalar type" as a
/// nullable-tolerant terminal operator, e.g. `.Select(...).FirstOrDefault()`)
/// only recognised that shape — a Select result CHAINED into a further
/// scalar-returning call. It did not recognise the sibling shape where the
/// Select result flows WHOLE, as a collection, into an ordinary ARGUMENT
/// position whose parameter itself accepts a nullable-element sequence (e.g.
/// `string.Join(string?, IEnumerable<string?>)`). Its final
/// `sinkType == resultType` equality check compares the SCALAR lambda
/// result type against the whole COLLECTION parameter type, which can never
/// match, so the function reports "does not flow to a nullable sink" and
/// falls through to the general oblivious-forwarding bridge, which inserts a
/// G# `!!` — a RUNTIME assertion, unlike C#'s erased `!` — on
/// `i.FullName`. The fix teaches the function to also unwrap a single
/// generic type argument from the sink and compare ELEMENT-to-element,
/// matching when that element is already nullable-ANNOTATED (e.g. the
/// BCL-declared `IEnumerable<string?>` `string.Join` accepts).
///
/// Issue #4115 ("selfmig: generic iterator state-machine metadata
/// inspection throws NRE (6 parity failures)", split from #4045) describes
/// this exact same defect against the same three files
/// (`Issue1489GenericAsyncIteratorEmitTests.cs`,
/// `Issue1481MapFunctionIteratorEmitTests.cs`,
/// `Issue813TupleSequenceReturnEmitTests.cs`) with the same
/// `NullReferenceException`-while-inspecting-the-generated-interfaces
/// signature, and the same count: of those three files' seven reflection
/// tests — six sharing the `AssertImplementsGenericOf` helper
/// (`Issue1489GenericAsyncIteratorEmitTests.cs`, three tests) /
/// `AssertImplementsEnumerableOf` helper
/// (`Issue1481MapFunctionIteratorEmitTests.cs`, three tests), plus a
/// seventh in `Issue813TupleSequenceReturnEmitTests.cs`
/// (`StateMachineClass_TupleElement_ImplementsIEnumerableOfValueTuple`)
/// that performs the equivalent `smType.GetInterfaces()` scan inline
/// rather than through either shared helper — exactly six assert an
/// interface row closed over the state machine's own unresolved Var(0)
/// type parameter (so (cref:Type.FullName) is null on that row and
/// the stray `!!` throws); the seventh —
/// `StateMachineClass_MapOfListElement_StaysErased_AndVerifies`, one
/// of the `AssertImplementsEnumerableOf`-based three — asserts a
/// fully-closed, erased row (`Dictionary<string,
/// List<object>>`) whose `FullName` is never null, so it
/// was never among the failures. There is no defect left to fix for #4115
/// either — this class's `TranslatedSnippet_*` and
/// `SelfHostedNullableSelectResult_*` tests (four in total, two
/// shapes) already pin the exact translator defect, and
/// `test/Compiler.Tests`' 25 native tests across
/// `Issue1481MapFunctionIteratorEmitTests`,
/// `Issue1489GenericAsyncIteratorEmitTests`, and
/// `Issue813TupleSequenceReturnEmitTests` were never affected (native
/// gsc never hits this bug — it is purely a self-hosting translation-fidelity
/// issue; see #4180's PR description for the documented re-translation of
/// these exact three files confirming no `!!` remains on any
/// `i.FullName` selector). This provenance note is the same shape
/// #4199 used to record that #4195's regression test also pinned #4112's
/// rows.
class Issue4180NullableSelectResultRegressionTests {
    /// Translates the reproduction snippet and asserts the emitted G# no
    /// longer asserts the selector's nullable result — the cheap, syntactic
    /// guard that discriminates this PR's fix (reverting the production hunk
    /// turns this test red; see
    /// (cref:SelfHostedNullableSelectResult_DoesNotThrowWhenForwardedToStringJoin)
    /// for the full functional proof that the fixed shape survives
    /// self-hosted compilation and execution).
    @Fact
    func TranslatedSnippet_NoLongerAssertsTheSelectResultForwardedToStringJoin() {
        let printed = Translate(Source)
        Assert.DoesNotContain("t.FullName!!", printed, StringComparison.Ordinal)
        Assert.Contains("types.Select((t Type) -> t.FullName)", printed, StringComparison.Ordinal)
    }

    /// The functional proof that the fixed shape actually survives
    /// self-hosting: translates the SAME reproduction snippet, compiles the
    /// result with the REAL `gsc.dll`, and runs it. Before the fix this
    /// throws (cref:NullReferenceException) from inside the
    /// `Select` lambda (exactly the crash reported in #4180's gate
    /// runs); after the fix it prints `OK:` with an empty joined
    /// segment for the null `FullName`, the same as running the
    /// original C# natively.
    @Fact
    func SelfHostedNullableSelectResult_DoesNotThrowWhenForwardedToStringJoin() {
        let printed = Translate(Source)
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let workDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4180NullableSelectResultRegressionTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(workDir)
        try {
            let gsPath = Path.Combine(workDir, "Probe.gs")
            let dllPath = Path.Combine(workDir, "Probe.dll")
            File.WriteAllText(gsPath, printed)
            let (compileExit, compileOutput) = RunDotnet(
                "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
            )
            Assert.True(compileExit == 0, "gsc must compile the translated probe. Output:\n" + compileOutput + `

Translated G#:
` + printed)
            let (runExit, output) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "the compiled probe must run without throwing. Output:\n" + output)
            Assert.Equal("OK:", output.Trim())
        } finally {
            TryDelete(workDir)
        }
    }

    /// Translates the covariant reproduction snippet and asserts the emitted
    /// G# no longer asserts the selector's nullable result — the cheap,
    /// syntactic guard that discriminates the review fix (reverting the
    /// element-conversion check back to exact identity turns this test red;
    /// see
    /// (cref:SelfHostedNullableSelectResult_DoesNotThrowWhenForwardedThroughCovariantSink)
    /// for the full functional proof).
    @Fact
    func TranslatedSnippet_NoLongerAssertsTheSelectResultForwardedThroughCovariantSink() {
        let printed = Translate(CovariantSource)
        Assert.DoesNotContain("t.FullName!!", printed, StringComparison.Ordinal)
        Assert.Contains("types.Select((t Type) -> t.FullName)", printed, StringComparison.Ordinal)
    }

    /// The functional proof that the covariant shape actually survives
    /// self-hosting: translates the covariant reproduction snippet, compiles
    /// the result with the REAL `gsc.dll`, and runs it. With the
    /// pre-review exact-identity check this throws
    /// (cref:NullReferenceException) from inside the `Select`
    /// lambda (the same shape of crash as #4180's report, but through a
    /// covariant sink rather than an identical one); after the fix it prints
    /// `OK:` with an empty joined segment for the null `FullName`.
    @Fact
    func SelfHostedNullableSelectResult_DoesNotThrowWhenForwardedThroughCovariantSink() {
        let printed = Translate(CovariantSource)
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let workDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4180NullableSelectResultRegressionTests",
            Guid.NewGuid().ToString("N") + "-covariant"
        )
        Directory.CreateDirectory(workDir)
        try {
            let gsPath = Path.Combine(workDir, "Probe.gs")
            let dllPath = Path.Combine(workDir, "Probe.dll")
            File.WriteAllText(gsPath, printed)
            let (compileExit, compileOutput) = RunDotnet(
                "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
            )
            Assert.True(compileExit == 0, "gsc must compile the translated probe. Output:\n" + compileOutput + `

Translated G#:
` + printed)
            let (runExit, output) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "the compiled probe must run without throwing. Output:\n" + output)
            Assert.Equal("OK:", output.Trim())
        } finally {
            TryDelete(workDir)
        }
    }

    @Fact
    func SelfHostedNullableSelectResult_RemainsNullableForNullFilteringOperators() {
        let printed = Translate(NullFilteringSource)
        Assert.DoesNotContain("t.FullName!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("t.FullName as string!!", printed, StringComparison.Ordinal)
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let workDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4180NullableSelectResultRegressionTests",
            Guid.NewGuid().ToString("N") + "-filters"
        )
        Directory.CreateDirectory(workDir)
        try {
            let gsPath = Path.Combine(workDir, "Probe.gs")
            let dllPath = Path.Combine(workDir, "Probe.dll")
            File.WriteAllText(gsPath, printed)
            let (compileExit, compileOutput) = RunDotnet(
                "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
            )
            Assert.True(compileExit == 0, "gsc must compile the translated probe. Output:\n" + compileOutput + `

Translated G#:
` + printed)
            let (runExit, output) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "the compiled probe must run. Output:\n" + output)
            Assert.Equal("OK:0:0:0:0", output.Trim())
        } finally {
            TryDelete(workDir)
        }
    }

    @Theory
    @InlineData("Build(() => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("Build(() => { return type.FullName; }).OfType<int>().Count()", true, "1")
    @InlineData("Build(((Func<string>)(() => type.FullName))).OfType<int>().Count()", true, "1")
    @InlineData("BuildGeneric(() => type.FullName, () => 42).OfType<int>().Count()", true, "1")
    @InlineData("BuildGeneric(selector: () => 42, get: () => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("BuildArray(() => type.FullName).OfType<string>().Count()", false, "0")
    @InlineData("BuildNestedArray(() => type.FullName).OfType<string[]>().Count()", false, "1")
    @InlineData("BuildNestedList(() => type.FullName).OfType<List<string>>().Count()", false, "1")
    @InlineData("BuildNestedValues(() => type.FullName).OfType<string>().Count()", false, "0")
    @InlineData("BuildUnrelatedValues(() => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("BuildKeyedValues(() => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("BuildIntRows(() => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("BuildObjectRows(() => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("BuildUnrelatedParams(42, () => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("BuildTask(async () => type.FullName).OfType<string>().Count()", false, "0")
    @InlineData(
        "BuildTask(async () => { await Task.Yield(); return type.FullName; }).OfType<string>().Count()",
        false,
        "0"
    )
    @InlineData("BuildValueTask(async () => type.FullName).OfType<string>().Count()", false, "0")
    @InlineData(
        "BuildValueTask(async () => { await Task.Yield(); return type.FullName; }).OfType<string>().Count()",
        false,
        "0"
    )
    @InlineData("BuildFixedTask(42, async () => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("BuildFixedValueTask(42, async () => type.FullName).OfType<int>().Count()", true, "1")
    @InlineData("BuildTaskParams(async () => type.FullName).OfType<string>().Count()", false, "0")
    @InlineData("BuildValueTaskParams(async () => type.FullName).OfType<string>().Count()", false, "0")
    @InlineData("BuildDirect(async () => type.FullName).OfType<string>().Count()", true, "0")
    @InlineData(
        "BuildDirect(async () => { await Task.Yield(); return type.FullName; }).OfType<string>().Count()",
        true,
        "0"
    )
    @InlineData("BuildDirectParams(async () => type.FullName).OfType<string>().Count()", true, "0")
    @InlineData("BuildDirect((() => type.FullName)).OfType<string>().Count()", false, "0")
    @InlineData("BuildDirect((((() => type.FullName)))).OfType<string>().Count()", false, "0")
    @InlineData("BuildTask((async () => type.FullName)).OfType<string>().Count()", false, "0")
    @InlineData("BuildValueTask((async () => type.FullName)).OfType<string>().Count()", false, "0")
    @InlineData(
        "BuildGeneric(selector: (() => type.FullName), get: (() => \"fixed\")).OfType<string>().Count()",
        false,
        "0"
    )
    @InlineData("BuildGeneric(selector: (() => 42), get: (() => type.FullName)).OfType<int>().Count()", true, "1")
    @InlineData("BuildDirect((async () => type.FullName)).OfType<string>().Count()", true, "0")
    @InlineData("BuildTaskParams((async () => type.FullName)).OfType<string>().Count()", false, "0")
    @InlineData("BuildDirectParams((() => type.FullName)).OfType<string>().Count()", false, "0")
    func CallbackResult_BeforeOfType_PreservesRequiredBridgesAndRuns(
        invocation string,
        requiresBridge bool,
        expectedOutput string
    ) {
        let printed = Translate(`using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

public class IntRows<T> : List<int> { }
public class ObjectRows<T> : System.Collections.ArrayList { }

public static class Probe
{
    static IEnumerable<int> Build(Func<string> get) => new[] { get().Length };

    static IEnumerable<T> BuildGeneric<T>(Func<string> get, Func<T> selector)
    {
        _ = get().Length;
        return new[] { selector() };
    }

    static T[] BuildArray<T>(Func<T> selector) => new[] { selector() };

    static IEnumerable<T> BuildDirect<T>(Func<T> selector) => new[] { selector() };

    static IEnumerable<T> BuildDirectParams<T>(params Func<T>[] selectors) =>
        new[] { selectors[0]() };

    static IEnumerable<T[]> BuildNestedArray<T>(Func<T> selector) =>
        new[] { new[] { selector() } };

    static IEnumerable<List<T>> BuildNestedList<T>(Func<T> selector) =>
        new[] { new List<T> { selector() } };

    static Dictionary<int, T>.ValueCollection BuildNestedValues<T>(Func<T> selector) =>
        new Dictionary<int, T> { { 0, selector() } }.Values;

    static Dictionary<T, int>.ValueCollection BuildKeyedValues<T>(Func<T> selector) =>
        new Dictionary<T, int> { { selector(), 42 } }.Values;

    static IntRows<T> BuildIntRows<T>(Func<T> selector)
    {
        selector();
        var rows = new IntRows<T>();
        rows.Add(42);
        return rows;
    }

    static ObjectRows<T> BuildObjectRows<T>(Func<T> selector)
    {
        selector();
        var rows = new ObjectRows<T>();
        rows.Add(42);
        return rows;
    }

    static Dictionary<int, int>.ValueCollection BuildUnrelatedValues<T>(Func<T> selector)
    {
        selector();
        return new Dictionary<int, int> { { 0, 42 } }.Values;
    }

    static IEnumerable<T> BuildUnrelatedParams<T>(T value, params Func<string>[] selectors)
    {
        _ = selectors[0]().Length;
        return new[] { value };
    }

    static IEnumerable<T> BuildTask<T>(Func<Task<T>> selector) =>
        new[] { selector().GetAwaiter().GetResult() };

    static IEnumerable<T> BuildValueTask<T>(Func<ValueTask<T>> selector) =>
        new[] { selector().AsTask().GetAwaiter().GetResult() };

    static IEnumerable<T> BuildFixedTask<T>(T value, Func<Task<string>> selector)
    {
        _ = selector().GetAwaiter().GetResult().Length;
        return new[] { value };
    }

    static IEnumerable<T> BuildFixedValueTask<T>(T value, Func<ValueTask<string>> selector)
    {
        _ = selector().AsTask().GetAwaiter().GetResult().Length;
        return new[] { value };
    }

    static IEnumerable<T> BuildTaskParams<T>(params Func<Task<T>>[] selectors) =>
        new[] { selectors[0]().GetAwaiter().GetResult() };

    static IEnumerable<T> BuildValueTaskParams<T>(params Func<ValueTask<T>>[] selectors) =>
        new[] { selectors[0]().AsTask().GetAwaiter().GetResult() };

    static int Run(Type type) => INVOCATION;

    public static void Main() => Console.WriteLine(Run(TYPE));
}`.Replace("INVOCATION", invocation, StringComparison.Ordinal)
                .Replace(
                "TYPE",
                if requiresBridge {
                    "typeof(string)"
                } else {
                    "typeof(List<>).GetGenericArguments()[0]"
                },
                StringComparison.Ordinal
            ))
        AssertCompilesAndRuns(printed, expectedOutput, requiresBridge)
    }

    @Theory
    @InlineData("Func<T>[]")
    @InlineData("List<Func<T>>")
    @InlineData("IEnumerable<Func<T>>")
    @InlineData("ICollection<Func<T>>")
    @InlineData("IList<Func<T>>")
    @InlineData("IReadOnlyList<Func<T>>")
    @InlineData("IReadOnlyCollection<Func<T>>")
    @InlineData("Span<Func<T>>")
    @InlineData("ReadOnlySpan<Func<T>>")
    func ExpandedParamsSelectorResult_RemainsNullableAndRuns(carrier string) {
        let printed = Translate(`using System;
using System.Collections.Generic;
using System.Linq;

public static class Probe
{
    static IEnumerable<T> Build<T>(params CARRIER selectors)
    {
        var results = new List<T>();
        foreach (var selector in selectors)
        {
            results.Add(selector());
        }

        return results;
    }

    static int Run(Type type) =>
        Build(() => type.FullName, () => type.FullName).OfType<string>().Count();

    public static void Main() =>
        Console.WriteLine(Run(typeof(List<>).GetGenericArguments()[0]));
}`.Replace("CARRIER", carrier, StringComparison.Ordinal))
        AssertCompilesAndRuns(printed, "0", requiresBridge: false)
    }

    @Theory
    @InlineData("List", "Task", "")
    @InlineData("Span", "Task", "")
    @InlineData("ReadOnlySpan", "Task", "")
    @InlineData("List", "ValueTask", ".AsTask()")
    @InlineData("Span", "ValueTask", ".AsTask()")
    @InlineData("ReadOnlySpan", "ValueTask", ".AsTask()")
    func AsyncExpandedParamsSelectorResult_RemainsNullableAndRuns(
        carrier string,
        envelope string,
        taskConversion string
    ) {
        let printed = Translate(`using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

public static class Probe
{
    static IEnumerable<T> Build<T>(params CARRIER<Func<ENVELOPE<T>>> selectors) =>
        new[] { selectors[0]()CONVERSION.GetAwaiter().GetResult() };

    static int Run(Type type) =>
        Build(async () => type.FullName).OfType<string>().Count();

    public static void Main() =>
        Console.WriteLine(Run(typeof(List<>).GetGenericArguments()[0]));
}`.Replace(
                "CARRIER",
                carrier,
                StringComparison.Ordinal
            ).Replace(
                "ENVELOPE",
                envelope,
                StringComparison.Ordinal
            ).Replace("CONVERSION", taskConversion, StringComparison.Ordinal))
        AssertCompilesAndRuns(printed, "0", requiresBridge: false)
    }

    @Fact
    func ParenthesizedSelectorResult_RemainsNullableAtScalarSinkAndRuns() {
        let printed = Translate(`using System;
using System.Collections.Generic;
using System.Linq;

public static class Probe
{
    static IEnumerable<T> Build<T>(Func<T> selector) => new[] { selector() };
    static string? Find(Type type) => Build((() => type.FullName)).FirstOrDefault();

    public static void Main() =>
        Console.WriteLine(Find(typeof(List<>).GetGenericArguments()[0]) == null ? 0 : 1);
}`)
        AssertCompilesAndRuns(printed, "0", requiresBridge: false)
    }

    @Fact
    func SynchronousTaskSelector_KeepsTaskObjectBridge() {
        let printed = Translate(`#nullable enable annotations
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

public static class Probe
{
    static Task<string>? pending;
    static IEnumerable<T> Build<T>(Func<Task<T>> selector) =>
        new[] { selector().GetAwaiter().GetResult() };
    public static int Run() => Build(() => pending).OfType<string>().Count();
}`)
        Assert.Contains("pending!!", printed, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("Outer<T>.Rows", false)
    @InlineData("Outer<T>.Middle.Rows", false)
    @InlineData("Outer<int>.Rows", true)
    func NestedContainingTypeSelectorResult_PreservesRequiredBridge(returnType string, requiresBridge bool) {
        let printed = Translate(`using System;
using System.Collections.Generic;
using System.Linq;

public class Outer<T>
{
    public class Rows : List<T> { }

    public class Middle
    {
        public class Rows : List<T> { }
    }
}

public static class Probe
{
    static RETURN_TYPE Build<T>(Func<T> selector) => throw new NotImplementedException();
    public static int Run(Type type) => Build(() => type.FullName).OfType<string>().Count();
}`.Replace("RETURN_TYPE", returnType, StringComparison.Ordinal))
        if requiresBridge {
            Assert.Contains("type.FullName!!", printed, StringComparison.Ordinal)
        } else {
            Assert.DoesNotContain("type.FullName!!", printed, StringComparison.Ordinal)
        }
    }

    @Theory
    @InlineData("IEnumerable<T[]>, IEnumerable<int>")
    @InlineData("IEnumerable<int>, IEnumerable<T[]>")
    func AmbiguousEnumerableSelectorResult_KeepsBridgeRegardlessOfInterfaceOrder(interfaces string) {
        let printed = Translate(`using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;

public class Rows<T> : INTERFACES
{
    IEnumerator<T[]> IEnumerable<T[]>.GetEnumerator() => throw new NotImplementedException();
    IEnumerator<int> IEnumerable<int>.GetEnumerator() => throw new NotImplementedException();
    IEnumerator IEnumerable.GetEnumerator() => throw new NotImplementedException();
}

public static class Probe
{
    static Rows<T> Build<T>(Func<T> selector) => throw new NotImplementedException();
    public static int Run(Type type) => Build(() => type.FullName).OfType<int>().Count();
}`.Replace("INTERFACES", interfaces, StringComparison.Ordinal))
        Assert.Contains("type.FullName!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func UserDefinedNullFilteringNames_DoNotSuppressRequiredAssertion() {
        let printed = Translate(`using System;

public sealed class Flow<T>
{
    public Flow<TResult> Select<TResult>(Func<T, TResult> selector) => null;
    public Flow<TResult> OfType<TResult>() => null;
    public Flow<T> Where(Func<T, bool> predicate) => null;
}

public static class Probe
{
    public static Flow<string> RunOfType(Flow<Type> types) =>
        types.Select(t => t.FullName).OfType<string>();

    public static Flow<string> RunWhere(Flow<Type> types) =>
        types.Select(t => t.AssemblyQualifiedName)
            .Where(name => name is not null);
}`)
        Assert.Contains("t.FullName!!", printed, StringComparison.Ordinal)
        Assert.Contains("t.AssemblyQualifiedName!!", printed, StringComparison.Ordinal)
    }

    shared {
        // The minimal reproduction of the mistranslated shape: an oblivious file
        // (no `<Nullable>` setting — exactly test/Compiler.Tests.csproj's own
        // condition) whose `Describe` forwards a `.Select(t => t.FullName)`
        // result WHOLE into `string.Join`'s `IEnumerable<string?> values`
        // parameter, never chaining into a further scalar-returning call. `Main`
        // feeds it a genuinely null-FullName `Type` (an unbound generic type
        // parameter, `List<>`'s own `T` — issue #4180 does not require building a
        // full reified state machine to exhibit the same defect).
        private const Source string = `using System;
using System.Collections.Generic;
using System.Linq;

public static class Probe
{
    public static string Describe(IEnumerable<Type> types)
    {
        return string.Join(", ", types.Select(t => t.FullName));
    }

    public static void Main()
    {
        Type[] typeParameters = typeof(List<>).GetGenericArguments();
        string described = Describe(typeParameters);
        Console.WriteLine("OK:" + described);
    }
}`

        // The COVARIANT sibling shape flagged on this PR's own review (Copilot,
        // on the original `SymbolEqualityComparer.Default.Equals(resultType,
        // sinkElement...)` fix): the sink's nullable-annotated element type need
        // not be IDENTICAL to the selector's result type, only ASSIGNABLE to it
        // through an implicit reference conversion. `Consume(IEnumerable<object?>
        // values)` accepts `types.Select(t => t.FullName)`'s `IEnumerable<string?>`
        // through `IEnumerable<T>`'s covariance — `string` is not symbol-equal to
        // `object`, but every `string` IS an `object`. Exact-identity missed this:
        // the selector result stayed `!!`-asserted and threw on a null
        // `FullName` even though the sink tolerates it exactly like #4180's
        // `string.Join` case.
        private const CovariantSource string = `using System;
using System.Collections.Generic;
using System.Linq;

public static class Probe
{
    public static string Consume(IEnumerable<object?> values)
    {
        return string.Join(", ", values);
    }

    public static string Describe(IEnumerable<Type> types)
    {
        return Consume(types.Select(t => t.FullName));
    }

    public static void Main()
    {
        Type[] typeParameters = typeof(List<>).GetGenericArguments();
        string described = Describe(typeParameters);
        Console.WriteLine("OK:" + described);
    }
}`

        private const NullFilteringSource string = `using System;
using System.Collections.Generic;
using System.Linq;

public static class Probe
{
    public static void Main()
    {
        Type[] types = typeof(List<>).GetGenericArguments();
        int ofTypeCount = types.Select(t => t.FullName).OfType<string>().Count();
        string cast = types.Select(t => t.FullName as string)
            .FirstOrDefault(name => name != null && name.Length > 0);
        int guardedCount = types.Select(t => t.FullName)
            .Where(name => name?.Length > 0)
            .Select(name => name.Length)
            .Count();
        int patternCount = types.Select(t => t.FullName)
            .Where(name => name is not null)
            .Count();
        Console.WriteLine(
            $"OK:{ofTypeCount}:{(cast == null ? 0 : 1)}:{guardedCount}:{patternCount}");
    }
}`

        private func AssertCompilesAndRuns(printed string, expectedOutput string, requiresBridge bool) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4180NullableSelectResultRegressionTests",
                Guid.NewGuid().ToString("N") + "-selector-result"
            )
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Probe.gs")
                let dllPath = Path.Combine(workDir, "Probe.dll")
                File.WriteAllText(gsPath, printed)
                let (compileExit, compileOutput) = RunDotnet(
                    "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
                )
                Assert.True(compileExit == 0, "gsc must compile the translated probe. Output:\n" + compileOutput + `

Translated G#:
` + printed)
                let (runExit, output) = RunDotnet("\"$dllPath\"")
                Assert.True(runExit == 0, "the compiled probe must run. Output:\n" + output)
                Assert.Equal(expectedOutput, output.Trim())
                if requiresBridge {
                    Assert.Contains("type.FullName!!", printed, StringComparison.Ordinal)
                } else {
                    Assert.DoesNotContain("type.FullName!!", printed, StringComparison.Ordinal)
                }
            } finally {
                TryDelete(workDir)
            }
        }

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Issue4180.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
