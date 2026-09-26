// <copyright file="Adr0186PlatformTypeBindingTests.PositionAudit.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0186 §4/§5 — the receiver and value-position audit (issues #4323,
/// #4324, #4325, tracked under #4363).
/// <para>
/// Each of those issues was one instance of the same defect: <em>one binder
/// path where a receiver or value can be a <see cref="PlatformTypeSymbol"/>
/// forgot the unwrap or the check</em>. Fixing the reported repro and nothing
/// else is how the family kept coming back, so this fixture enumerates the
/// positions rather than the repros. Every row is compiled and run against the
/// csc-emitted oblivious library, with a nil source and a live source.
/// </para>
/// <para>
/// A nil row must fail with §4's <b>attributed</b> message — the whole
/// argument for a call-site check over the CLR's own is the message, so an
/// unattributed <see cref="NullReferenceException"/> from inside a lowered
/// construct fails the row. A live row must compile wherever the plain
/// <c>T</c> form compiles and print the same thing.
/// </para>
/// </summary>
public sealed partial class Adr0186PlatformTypeBindingTests
{
    /// <summary>
    /// A nil platform value used as non-null fails with §4's attributed
    /// message, at every receiver and value position.
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="site">The position the row covers.</param>
    [Theory]

    // Index write, read and compound write — #4323's family.
    [InlineData("    Ob.NilStrings()[0] = \"q\"", "index write, call-result receiver")]
    [InlineData("    let l = Ob.NilStrings()\n    l[0] = \"q\"", "index write, local receiver")]
    [InlineData("    Ob.NilArr()[0] = \"q\"", "array element store")]
    [InlineData("    let t = Ob.NilTable()\n    t[\"k\"] = 1", "dictionary index write")]
    [InlineData("    Console.WriteLine(Ob.NilTable()[\"k\"])", "dictionary index read")]
    [InlineData("    Console.WriteLine(Ob.Nil()[0])", "string char index read")]
    [InlineData("    let l = Ob.NilNumbers()\n    l[0] += 1", "compound index write, list")]
    [InlineData("    let t = Ob.NilTable()\n    t[\"k\"] += 1", "compound index write, dictionary")]
    [InlineData("    let a = Ob.NilArr()\n    a[0] += \"x\"", "compound array element write")]

    // Member write and compound write — #4325 position 2's family.
    [InlineData("    Ob.NilNest().Num += 1", "compound property write, call-result receiver")]
    [InlineData("    let n = Ob.NilNest()\n    n.Prop += \"x\"", "compound property write, string")]
    [InlineData("    let n = Ob.NilNest()\n    n.Prop ??= \"x\"", "coalescing property write")]
    [InlineData("    Ob.NilSlot().Text = \"x\"", "field store")]
    [InlineData("    let s = Ob.NilSlot()\n    s.Count += 1", "compound field write")]
    [InlineData("    Console.WriteLine(Ob.NilSlot().Text)", "field read")]

    // Invocation — #4325 position 1's family.
    [InlineData("    Console.WriteLine(Ob.NilThunk()())", "invoking a call result")]
    [InlineData("    Console.WriteLine(Ob.NilThunk().Invoke())", "explicit Invoke")]
    [InlineData("    let x = Ob.EmptyFns()\n    Console.WriteLine(x.F())", "invoking a delegate-typed field")]
    [InlineData("    let x = Ob.EmptyFns()\n    Console.WriteLine(x.P())", "invoking a delegate-typed property")]
    [InlineData("    Console.WriteLine(Ob.NilFns().F())", "invoking a delegate-typed field through a nil receiver")]
    [InlineData("    Console.WriteLine(Ob.StaticFn())", "invoking a static delegate-typed field")]
    [InlineData("    let g = GsFns()\n    Console.WriteLine(g.F())", "invoking an @Oblivious G# delegate field")]
    [InlineData("    let g = GsFns()\n    Console.WriteLine(g.G())", "invoking an @Oblivious G# function-typed field")]

    // Deconstruction — #4325 position 3's family.
    [InlineData("    var (a, b) = Ob.NilPt()\n    Console.WriteLine(a + b)", "var deconstruction")]

    // Statements that require a non-null subject.
    [InlineData("    for (k, v) in Ob.NilTable() {\n        Console.WriteLine(k)\n    }", "foreach over a dictionary")]
    [InlineData("    Console.WriteLine(awaitNil())", "await operand")]
    [InlineData("    Console.WriteLine(sumNilAsync().GetAwaiter().GetResult())", "await for source")]
    [InlineData("    let { X = x, Y = y } = nilNPt()\n    Console.WriteLine(x + y)", "named deconstruction")]
    [InlineData("    let (a, b) = nilDPt()\n    Console.WriteLine(a + b)", "positional deconstruction of a data class")]

    // A value flowing into a non-null destination from a lambda.
    [InlineData("    let f = func() string { return Ob.Nil() }\n    Console.WriteLine(f())", "lambda return")]

    // Interpolation holes are receivers only when they dereference.
    [InlineData("    Console.WriteLine(\"[${Ob.NilNest().Prop}]\")", "member receiver inside an interpolation")]
    public void PositionAudit_ANilPlatformValue_Fails_With_Attribution(string body, string site)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes, AuditHelpers);
        Assert.True(compiled.Success, site + ": " + Describe(compiled));

        var failure = Assert.ThrowsAny<Exception>(
            () => world.Run(body, NullabilityMode.PlatformTypes, AuditHelpers));
        var message = Unwrap(failure).Message;
        Assert.True(
            message.Contains("nullability-oblivious", StringComparison.Ordinal),
            site + ": unattributed failure: " + Unwrap(failure).GetType().Name + ": " + message);
    }

    /// <summary>
    /// The live half of the audit, plus §4's "and nowhere else": positions
    /// that tolerate nil (interpolation, string concatenation, <c>using</c>,
    /// a <c>switch</c> scrutinee, <c>as</c>) get no check, and every checked position runs
    /// normally on a non-nil value.
    /// </summary>
    /// <param name="body">The probe body.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]

    // Live counterparts of the checked rows.
    [InlineData("    let l = Ob.Strings()\n    l[0] = \"q\"\n    Console.WriteLine(l[0])", "q")]
    [InlineData("    Ob.Strings()[0] = \"q\"\n    Console.WriteLine(\"ok\")", "ok")]
    [InlineData("    let t = Ob.Table()\n    t[\"k\"] += 1\n    Console.WriteLine(t[\"k\"])", "8")]
    [InlineData("    let l = Ob.Numbers()\n    l[0] += 1\n    Console.WriteLine(l[0])", "2")]
    [InlineData("    let a = Ob.ArrWithNil()\n    a[0] += \"x\"\n    Console.WriteLine(a[0])", "x")]
    [InlineData("    Console.WriteLine(Ob.Value()[0])", "V")]
    [InlineData("    let n = Ob.Nest2()\n    n.Prop += \"x\"\n    Console.WriteLine(n.Prop)", "Vx")]
    [InlineData("    let n = Ob.Nest2()\n    n.Prop ??= \"x\"\n    Console.WriteLine(n.Prop)", "V")]
    [InlineData("    let s = Ob.Slot2()\n    s.Count += 2\n    s.Text = \"t\"\n    Console.WriteLine(s.Text)\n    Console.WriteLine(s.Count)", "t\n2")]
    [InlineData("    Console.WriteLine(Ob.Thunk()())", "V")]
    [InlineData("    Console.WriteLine(Ob.Thunk().Invoke())", "V")]
    [InlineData("    let x = Ob.LiveFns()\n    Console.WriteLine(x.F() + x.P())", "FP")]
    [InlineData("    var (a, b) = Ob.Pt2()\n    Console.WriteLine(a + b)", "ab")]
    [InlineData("    for (k, v) in Ob.Table() {\n        Console.WriteLine(\"${k}${v}\")\n    }", "k7")]
    [InlineData("    Console.WriteLine(awaitLive())", "T")]
    [InlineData("    Console.WriteLine(sumLiveAsync().GetAwaiter().GetResult())", "3")]
    [InlineData("    let { X = x, Y = y } = liveNPt()\n    Console.WriteLine(x + y)", "ab")]
    [InlineData("    let (a, b) = liveDPt()\n    Console.WriteLine(a + b)", "ab")]
    [InlineData("    Console.WriteLine(\"[${Ob.Nest2().Prop}]\")", "[V]")]

    [InlineData("    Ob.StaticFn = func() string { return \"s\" }\n    Console.WriteLine(Ob.StaticFn())", "s")]
    [InlineData("    let g = GsFns()\n    g.F = func() string { return \"f\" }\n    g.G = func() string { return \"g\" }\n    Console.WriteLine(g.F() + g.G())", "fg")]

    // Positions that tolerate nil: no check, no failure.
    [InlineData("    Console.WriteLine(\"[${Ob.Nil()}]\")", "[]")]
    [InlineData("    Console.WriteLine(\"[${Ob.NilObj()}]\")", "[]")]
    [InlineData("    var s = Ob.Nil()\n    s += Ob.Nil()\n    Console.WriteLine(\"[\" + s + \"]\")", "[]")]
    [InlineData("    Console.WriteLine(Ob.Nil() == \"x\")", "False")]
    [InlineData("    let r = switch Ob.Nil() { case \"a\": \"a\" default: \"other\" }\n    Console.WriteLine(r)", "other")]
    [InlineData("    using let r = Ob.NilDisposable()\n    Console.WriteLine(\"body\")", "body")]
    [InlineData("    using let r = Ob.Res2()\n    Console.WriteLine(\"body\")", "body\ndisposed")]
    [InlineData("    let s = Ob.Nil()\n    let o = s as object\n    Console.WriteLine(o == nil)", "True")]
    public void PositionAudit_ALivePlatformValue_Runs_And_NilTolerantPositions_Do_Not_Check(string body, string expected)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes, AuditHelpers);
        Assert.True(compiled.Success, Describe(compiled));

        Assert.Equal(
            expected,
            world.Run(body, NullabilityMode.PlatformTypes, AuditHelpers).Trim().ReplaceLineEndings("\n"));
    }

    /// <summary>
    /// Issue #4287, against a real imported class: invoking a delegate-typed
    /// FIELD or PROPERTY through a receiver stated <c>Fns?</c> reports GS0159,
    /// like an imported method call on it. The delegate-member fallback runs
    /// after instance-method selection, so it needs the gate too. A live
    /// <c>?.</c> call runs.
    /// </summary>
    /// <param name="body">The probe body.</param>
    [Theory]
    [InlineData("    let x Fns? = Ob.LiveFns()\n    Console.WriteLine(x.F())")]
    [InlineData("    let x Fns? = Ob.LiveFns()\n    Console.WriteLine(x.P())")]
    public void StatedNullableReceiver_DelegateMemberInvocation_Reports(string body)
    {
        using var world = new World();

        var compiled = world.Compile(body, NullabilityMode.PlatformTypes);
        Assert.Contains(compiled.Diagnostics, d => d.Id == "GS0159" && d.Message.Contains("may be nil", StringComparison.Ordinal));

        Assert.Equal(
            "F",
            world.Run("    let x Fns? = Ob.LiveFns()\n    Console.WriteLine(x?.F())", NullabilityMode.PlatformTypes).Trim());
    }

    private const string AuditHelpers = """
        @Oblivious
        class GsFns {
            var F Func[string]
            var G (() -> string)
        }

        data class DPt(X string, Y string)

        @Oblivious
        func nilDPt() DPt {
            return nil
        }

        @Oblivious
        func liveDPt() DPt {
            return DPt("a", "b")
        }

        // Named deconstruction reads declared FIELDS, which a positional
        // `data class` does not have, so it needs its own shape.
        data class NPt {
            var X string
            var Y string
        }

        @Oblivious
        func nilNPt() NPt {
            return nil
        }

        @Oblivious
        func liveNPt() NPt {
            return NPt{X: "a", Y: "b"}
        }

        async func sumNilAsync() int32 {
            var n = 0
            await for v in Ob.NilStream() {
                n += v
            }
            return n
        }

        async func sumLiveAsync() int32 {
            var n = 0
            await for v in Ob.LiveStream() {
                n += v
            }
            return n
        }

        async func awaitNilAsync() string {
            return await Ob.NilTask()
        }

        func awaitNil() string {
            return awaitNilAsync().GetAwaiter().GetResult()
        }

        async func awaitLiveAsync() string {
            return await Ob.LiveTask()
        }

        func awaitLive() string {
            return awaitLiveAsync().GetAwaiter().GetResult()
        }
        """;
}
