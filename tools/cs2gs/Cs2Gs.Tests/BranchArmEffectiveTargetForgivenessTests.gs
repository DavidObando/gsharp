// <copyright file="BranchArmEffectiveTargetForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// A conditional or switch-expression arm flows into the target of the WHOLE
/// expression, so whether the arm needs `!!` depends on that target
/// rather than on the arm itself. cs2gs asserted a nullable arm unconditionally.
/// That turned `string emittedName = constructorIndex >= 0 ? null :
/// argument.Name;` into `… else { argument.Name!! }` inside a
/// `string?` local, and the migrated translator threw
/// `NullReferenceException` on every positional attribute argument
/// (`Name` is null). That was the nightly self-migration's
/// `Cs2Gs.Tests` test-parity failure in
/// `CSharpToGSharpTranslator.LibraryImport`. An arm whose target is
/// non-null keeps its `!!`.
open class BranchArmEffectiveTargetForgivenessTests {
    /// The exact LibraryImport shape, across projects as in the migration
    /// (the translator reads `AttributeArgument.Name` from
    /// `Cs2Gs.CodeModel`), compiled and run: a positional argument (null
    /// `Name`) takes the conditional's non-null arm, which must not
    /// assert.
    @Fact
    func LibraryImportShape_PositionalArgument_CompilesAndRuns() {
        const app = `
using System.Collections.Generic;
using System.Text;
using Model;

namespace App
{
    public static class Emitter
    {
        private static int ConstructorParameterIndex(string name) => name == null ? -1 : name == "libraryName" ? 0 : -1;

        public static string Emit(List<Arg> arguments)
        {
            var builder = new StringBuilder();
            foreach (Arg argument in arguments)
            {
                int constructorIndex = ConstructorParameterIndex(argument.Name);
                string emittedName = constructorIndex >= 0 ? null : argument.Name;
                builder.Append(emittedName == null ? argument.Value : emittedName + "=" + argument.Value).Append(';');
            }

            return builder.ToString();
        }

        public static string Run() => Emit(new List<Arg>
        {
            new Arg("libc"),
            new Arg("Lib", "libraryName"),
            new Arg("Utf8", "StringMarshalling"),
        });
    }
}`
        let (library, consumer) = TranslateBothProjects(app)
        Assert.Contains("prop Name string?", library)
        Assert.DoesNotContain("argument.Name!!", consumer)
        Assert.Equal(
            "libc;Lib;StringMarshalling=Utf8;",
            CompileAndRun([]string{library, consumer}, "App.Emitter.Run()").Trim()
        )
    }

    /// Every branching form whose whole-expression target accepts nil leaves
    /// the arm bare when the member is declared in another project of the run:
    /// a conditional or switch into a widened local, a return from a widened
    /// method, an expression-bodied member, an assignment, the left operand of
    /// `??`, a `?.` receiver, and a `== null` / `is null`
    /// test (including a wrapped `(null!)`).
    @Fact
    func NullableEffectiveTarget_ArmsStayBare() {
        const app = `
namespace App
{
    public static class Use
    {
        public static string Local(Model.Arg argument, int i)
        {
            string emittedName = i >= 0 ? null : argument.Name;
            return emittedName;
        }

        public static string Switch(Model.Arg argument, int i)
        {
            string e = i switch { 0 => null, _ => argument.Name };
            return e;
        }

        public static string Arrow(Model.Arg argument, int i) => i >= 0 ? null : argument.Name;

        public static string Returns(Model.Arg argument, int i)
        {
            if (i > 3) { return i >= 0 ? null : argument.Name; }
            return i switch { 0 => null, _ => argument.Name };
        }

        public static string Assigned(Model.Arg argument, int i)
        {
            string e;
            e = i >= 0 ? null : argument.Name;
            return e;
        }

        public static string Coalesced(Model.Arg argument, int i) => (i >= 0 ? null : argument.Name) ?? "fallback";

        public static string SwitchCoalesced(Model.Arg argument, int i) => (i switch { 0 => null, _ => argument.Name }) ?? "fallback";

        public static int? Accessed(Model.Arg argument, int i) => (i >= 0 ? null : argument.Name)?.Length;

        public static int? SwitchAccessed(Model.Arg argument, int i) => (i switch { 0 => argument.Value, _ => argument.Name })?.Length;

        public static bool Compared(Model.Arg argument, int i) => (i >= 0 ? argument.Value : argument.Name) == null;

        public static bool Tested(Model.Arg argument, int i) => (i switch { 0 => argument.Value, _ => argument.Name }) is null;

        public static bool ComparedWrapped(Model.Arg argument, int i) => (i >= 0 ? argument.Value : argument.Name) == (null!);

        public static void Params(params string[] values) { }

        public static void ParamsSeed() => Params("head", null);

        public static void ParamsConditional(Model.Arg argument, int i) => Params(i >= 0 ? argument.Value : argument.Name);

        public static void ParamsSwitch(Model.Arg argument, int i) => Params("head", i switch { 0 => argument.Value, _ => argument.Name });

        public static void ParamsNested(Model.Arg argument, int i) => Params(i >= 0 ? (i > 1 ? argument.Value : argument.Name) : "x");

        public static void ObjectParams(params object[] values) { }

        public static void ObjectParamsSeed() => ObjectParams("head", null);

        public static void ObjectParamsConditional(Model.Arg a, Model.Arg b, bool flag) => ObjectParams(flag ? a.Objects : b.Objects, "tail");

        public static void ObjectParamsCastConditional(Model.Arg argument, int i) => ObjectParams((object)(i >= 0 ? argument.Value : argument.Name), "tail");

        public static void ExtensionParams(this Model.Arg receiver, params string[] values) { }

        public static void ExtensionParamsSeed(Model.Arg receiver) => receiver.ExtensionParams("head", null);

        public static void ExtensionParamsConditional(Model.Arg argument, int i) => argument.ExtensionParams(i >= 0 ? argument.Value : argument.Name, argument.Name);

        public static void ExtensionParamsSwitch(Model.Arg argument, int i) => argument.ExtensionParams("head", i switch { 0 => argument.Value, _ => argument.Name });

        public sealed class TaintedBag
        {
            public int this[params string[] keys] => 0;
        }

        public static int BagSeed(TaintedBag bag) => bag["head", null];

        public static int BagConditional(TaintedBag bag, Model.Arg argument, int i) => bag[i >= 0 ? argument.Value : argument.Name, i switch { 0 => argument.Name, _ => argument.Value }];
    }
}`
        let printed = TranslateCrossProject(app)
        // No assertion anywhere: not on an arm, and not moved around the
        // whole branching expression either.
        Assert.DoesNotContain("!!", printed)
    }

    /// The arm stays bare for an inferred generic parameter and for a widened
    /// local reached through a C# `!`. The translated `!` into the
    /// widened local is erased too. Only the inferred-generic argument bridge
    /// still emits a whole-value `!!` (left open on #4452), so for that
    /// call this test pins only the arm.
    @Fact
    func InferredGenericAndSuppressedLocal_ArmsStayBare() {
        const app = `
namespace App
{
    public static class Use
    {
        public static T Id<T>(T value) => value;

        public static T ParamsId<T>(params T[] values) => values[0];

        public static T SpanParamsId<T>(params System.ReadOnlySpan<T> values) => values[0];

        public static string Inferred(Model.Arg argument, int i) => Id(i > 0 ? argument.Value : argument.Name);

        public static string InferredParams(Model.Arg argument, int i) => ParamsId(i > 0 ? argument.Value : argument.Name);

        public static string InferredParamsSwitch(Model.Arg argument, int i) => ParamsId("head", i switch { 0 => argument.Value, _ => argument.Name });

        public static string InferredSpanParams(Model.Arg argument, int i) => SpanParamsId(i > 0 ? argument.Value : argument.Name, "tail");

        public static string InferredSpanParamsSwitch(Model.Arg argument, int i) => SpanParamsId("head", i switch { 0 => argument.Value, _ => argument.Name });

        public static T FixedByListOrNullParams<T>(System.Collections.Generic.List<T> fixedValues, params System.ReadOnlySpan<T> values) => values[0];

        public static T PromotedReceiverParams<T>(this System.Collections.Generic.List<T> receiver, params System.ReadOnlySpan<T> values) => values[0];

        public static string NullListAllowsInference(Model.Arg argument, int i) => FixedByListOrNullParams(null, i > 0 ? argument.Value : argument.Name, "tail");

#nullable enable annotations
        public static T NestedInnerParams<T>(ObLib.Outer<int>.Inner<T> inner, params System.ReadOnlySpan<T> values) => values[0];

        public static string PromotedListArgumentAllowsInference(Model.Arg argument, int i)
        {
            string[] lines;
            lines = ObLib.Node.Holes();
            var list = new System.Collections.Generic.List<string>(lines);
            return FixedByListOrNullParams(list, i > 0 ? argument.Value : argument.Name, "tail");
        }

        public static string PromotedCheckedListArgumentAllowsInference(Model.Arg argument, int i)
        {
            string[] lines;
            lines = ObLib.Node.Holes();
            var list = new System.Collections.Generic.List<string>(lines);
            return FixedByListOrNullParams(checked(list), i > 0 ? argument.Value : argument.Name, "tail");
        }

        public static string PromotedReceiverAllowsInference(Model.Arg argument, int i)
        {
            string[] lines;
            lines = ObLib.Node.Holes();
            var list = new System.Collections.Generic.List<string>(lines);
            return list.PromotedReceiverParams(i > 0 ? argument.Value : argument.Name, "tail");
        }

        public static string PromotedCheckedReceiverAllowsInference(Model.Arg argument, int i)
        {
            string[] lines;
            lines = ObLib.Node.Holes();
            var list = new System.Collections.Generic.List<string>(lines);
            return unchecked(list).PromotedReceiverParams(i > 0 ? argument.Value : argument.Name, "tail");
        }

        public static string PromotedNestedInnerArgumentAllowsInference(Model.Arg argument, int i)
        {
            ObLib.Outer<int>.Inner<string> inner;
            inner = ObLib.Node.NestedInner();
            return NestedInnerParams(inner, i > 0 ? argument.Value : argument.Name, "tail");
        }

#nullable enable
        public static string? ExplicitNullableParams(Model.Arg argument, int i) => ParamsId<string?>(i > 0 ? argument.Value : argument.Name);

        public static string? ExplicitNullableParamsSwitch(Model.Arg argument, int i) => ParamsId<string?>("head", i switch { 0 => argument.Value, _ => argument.Name });

        public static void JoinExtension(this Model.Arg receiver, params string?[] values) { }

        public static void ExtensionJoined(Model.Arg argument, int i) =>
            argument.JoinExtension(i == 0 ? argument.Name : argument.Value, argument.Name);

        public sealed class Bag
        {
            public string? this[params string?[] keys] => keys[0];
        }

        public static string? IndexerJoined(Bag bag, Model.Arg argument, int i) =>
            bag[i == 0 ? argument.Name : argument.Value, i switch { 0 => argument.Name, _ => argument.Value }];
#nullable restore

        public static int Suppressed(Model.Arg argument, bool flag)
        {
            string chosen = (flag ? argument.Name : argument.Value)!;
            return chosen == null ? 0 : chosen.Length;
        }

        public static string[] DefaultArm(Model.Arg argument, int i) => new[] { i > 0 ? default(string) : argument.Name };
    }
}`
        let printed = TranslateCrossProject(app)
        Assert.Contains("List[string?](lines)", printed)
        Assert.DoesNotContain("argument.Name!!", printed)
        Assert.DoesNotContain("argument.Value!!", printed)
        // Issue #4452: the translated C# `!` into the widened `chosen` is erased
        // rather than asserted, so no `!!` wraps the whole branch either.
        Assert.Contains("let chosen string? = (if flag { argument.Name } else { argument.Value })", printed)
        Assert.DoesNotContain("argument.Value })!!", printed)
    }

    /// Issue #4452: a branch whose whole value C# takes as a possibly-null value
    /// (an interpolation hole, a string concatenation operand, the operand of
    /// `as`, a switch scrutinee) leaves its arms bare. Compiled with gsc and
    /// run with a null `Name`: each form reproduces C#'s result instead of
    /// throwing.
    @Fact
    func NilAcceptingParents_ArmsStayBare_CompileAndRun() {
        const app = `
using Model;

namespace App
{
    public static class Use
    {
        public static string Interpolated(Arg a, bool f) => $"[{(f ? a.Name : a.Value)}]";

        public static string Concatenated(Arg a, bool f) => "<" + (f ? a.Name : a.Value) + ">";

        public static string Cast(Arg a, bool f) => ((f ? a.Name : a.Value) as string) ?? "none";

        public static string Switched(Arg a, bool f) => (f ? a.Name : a.Value) switch { null => "null", var s => s };

        public static string Appended(Arg a, bool f)
        {
            string s = "{";
            s += f ? a.Name : a.Value;
            return s + "}";
        }

        public static string SwitchStatement(Arg a, bool f)
        {
            switch (f ? a.Name : a.Value)
            {
                case null: return "N";
                default: return "V";
            }
        }

#nullable enable
        public static string JoinParams(params string?[] values) => (values[0] ?? "0") + ":" + (values[1] ?? "1");

        public static string ParamsJoined(Arg a, int i) =>
            JoinParams(i == 0 ? a.Name : a.Value, i switch { 0 => a.Name, _ => a.Value });

        public static string JoinObjects(params object?[] values) => (values[0] == null ? "0" : "1") + ":" + values[1];

        public static string ObjectsJoined(Arg a, Arg b, bool flag) =>
            JoinObjects(flag ? a.Objects : b.Objects, "tail");

        public static string CastObjectsJoined(Arg a, bool flag) =>
            JoinObjects((object?)(flag ? a.Name : a.Value), "tail");
#nullable restore

        public static string Run()
        {
            var a = new Arg("v");
            return Interpolated(a, true) + Concatenated(a, true) + Cast(a, true) + Switched(a, true) + Appended(a, true) + SwitchStatement(a, true) + ParamsJoined(a, 0) + ObjectsJoined(a, a, true) + CastObjectsJoined(a, true);
        }
    }
}`
        let (library, consumer) = TranslateBothProjects(app)
        Assert.DoesNotContain("a.Name!!", consumer)
        Assert.DoesNotContain("a.Objects!!", consumer)
        Assert.DoesNotContain("b.Objects!!", consumer)
        Assert.Equal(
            "[]<>nonenull{}N0:10:tail0:tail",
            CompileAndRun([]string{library, consumer}, "App.Use.Run()").Trim()
        )
    }

    /// Precision: an arm whose whole-expression target is a non-null
    /// parameter still asserts, for a conditional and for a switch, and so
    /// does an arm into a generic parameter whose type argument is explicit.
    @Fact
    func NonNullEffectiveTarget_ArmsKeepAssertion() {
        const app = `
namespace App
{
    public static class Use
    {
        public static int Index(string name) => name == "x" ? 0 : -1;

#nullable enable
        public static int ParamsIndex(params string[] names) => names[0] == "x" ? 0 : -1;

        public static int ObjectParamsCount(params object?[] values) => values.Length;

        public sealed class NonNullBag
        {
            public int this[params string[] keys] => keys.Length;

            public int this[int tag, params object?[] values] => values.Length;
        }
#nullable restore

        public static int Conditional(Model.Arg argument, int i) => Index(i > 0 ? argument.Name : "x");

        public static int Switch(Model.Arg argument, int i) => Index(i switch { 0 => argument.Name, _ => "y" });

        public static int ParamsConditional(Model.Arg argument, int i) => ParamsIndex(i > 0 ? argument.Name : "x");

        public static int ParamsSwitch(Model.Arg argument, int i) => ParamsIndex("head", i switch { 1 => argument.Name, _ => "y" });

        public static int ObjectParamsDirect(Model.Arg a, Model.Arg b, bool flag) => ObjectParamsCount(flag ? a.Objects : b.Objects);

        public static int BagNonNullExpanded(NonNullBag bag, Model.Arg argument, int i) =>
            bag[i > 2 ? argument.Name : "z", "tail"];

        public static int BagNormalForm(NonNullBag bag, Model.Arg a, Model.Arg b, bool flag) =>
            bag[0, flag ? a.Objects : b.Objects];

        public static T Id<T>(T value) => value;

        public static T ParamsId<T>(params T[] values) => values[0];

        public static T SpanParamsId<T>(params System.ReadOnlySpan<T> values) => values[0];

        public static T ConstrainedSpanParams<T>(params System.ReadOnlySpan<T> values) where T : class => values[0];

        public static T FixedByListParams<T>(System.Collections.Generic.List<T> fixedValues, params System.ReadOnlySpan<T> values) => values[0];

        public static T FixedByReceiverParams<T>(this System.Collections.Generic.List<T> receiver, params System.ReadOnlySpan<T> values) => values[0];

        public static T FixedByActionParams<T>(System.Action<T> consume, params System.ReadOnlySpan<T> values) => values[0];

        public static T FixedByListArrayParams<T>(System.Collections.Generic.List<T>[] lists, params System.ReadOnlySpan<T> values) => values[0];

        public static T FixedByInParams<T>(in T fixedValue, params System.ReadOnlySpan<T> values) => values[0];

        public static T FixedByIListParams<T>(System.Collections.Generic.IList<T> fixedValues, params System.ReadOnlySpan<T> values) => values[0];

        public static T FixedByArrayParams<T>(T[] fixedValues, params System.ReadOnlySpan<T> values) => values[0];

        public static T FixedByActionIListParams<T>(System.Action<System.Collections.Generic.IList<T>> action, params System.ReadOnlySpan<T> values) => values[0];

        public delegate void PairConsumer<T>(T first, T second);

        public static T FixedByPairConsumerParams<T>(PairConsumer<T> consume, params System.ReadOnlySpan<T> values) => values[0];

        public static void Consume(string s) { }

        public static void Consume(int n) { }

#nullable enable
        public static void ConsumePair(string? first, string second) { }
#nullable restore

        public static int CountAll<T>(params System.Collections.Generic.IEnumerable<T> values) => 0;

        public static int NormalFormGenericParams(Model.Arg a, Model.Arg b, bool flag) =>
            CountAll(flag ? a.Objects : b.Objects);

        public static string ConstrainedSpanParamsCall(Model.Arg argument, int i) =>
            ConstrainedSpanParams(i > 4 ? "a" : argument.Name, "tail");

        public static string FixedByListParamsCall(System.Collections.Generic.List<string> list, Model.Arg argument, int i) =>
            FixedByListParams(list, i > 5 ? "b" : argument.Name, "tail");

        public static string FixedByReceiverParamsCall(System.Collections.Generic.List<string> list, Model.Arg argument, int i) =>
            list.FixedByReceiverParams(i > 6 ? "c" : argument.Name, "tail");

        public static string FixedByActionParamsCall(System.Action<string> consume, Model.Arg argument, int i) =>
            FixedByActionParams(consume, i > 7 ? "d" : argument.Name, "tail");

        public static string FixedByListArrayParamsCall(System.Collections.Generic.List<string>[] lists, Model.Arg argument, int i) =>
            FixedByListArrayParams(lists, i > 8 ? "e" : argument.Name, "tail");

        public static string FixedByExplicitInParamsCall(string text, Model.Arg argument, int i) =>
            FixedByInParams(in text, i > 9 ? "f" : argument.Name, "tail");

        public static string FixedByImplicitInParamsCall(string text, Model.Arg argument, int i) =>
            FixedByInParams(text, i > 10 ? "g" : argument.Name, "tail");

        public static string FixedByDefaultListParamsCall(Model.Arg argument, int i) =>
            FixedByListParams(default, i > 11 ? "h" : argument.Name, "tail");

        public static string FixedByAnonymousMethodParamsCall(Model.Arg argument, int i) =>
            FixedByActionParams(delegate (string s) { }, i > 12 ? "j" : argument.Name, "tail");

        public static string FixedByMethodGroupParamsCall(Model.Arg argument, int i) =>
            FixedByActionParams(Consume, i > 13 ? "k" : argument.Name, "tail");

        public static string FixedByConstrainedTypeParameterCall<U>(U list, Model.Arg argument, int i) where U : System.Collections.Generic.IList<string> =>
            FixedByIListParams(list, i > 14 ? "m" : argument.Name, "tail");

        public static string FixedByTypedNullImportedListParamsCall(Model.Arg argument, int i) =>
            ObLib.Node.ImportedListParams(null!, i > 15 ? "n" : argument.Name, "tail");

        public static string FixedByArrayParamsCall(string[] array, Model.Arg argument, int i) =>
            FixedByArrayParams(array, i > 16 ? "p" : argument.Name, "tail");

        public static string FixedByContravariantHierarchyParamsCall(System.Action<System.Collections.Generic.IEnumerable<string>> action, Model.Arg argument, int i) =>
            FixedByActionIListParams(action, i > 17 ? "q" : argument.Name, "tail");

        public static string FixedByReconciledMethodGroupParamsCall(Model.Arg argument, int i) =>
            FixedByPairConsumerParams(ConsumePair, i > 18 ? "r" : argument.Name, "tail");

        public static string Explicit(Model.Arg argument, int i) => Id<string>(i > 0 ? argument.Value : argument.Name);

        public static string ExplicitParams(Model.Arg argument, int i) => ParamsId<string>(i > 0 ? argument.Value : argument.Name);

        public static string ExplicitSpanParams(Model.Arg argument, int i) => SpanParamsId<string>(i > 3 ? argument.Value : argument.Name, "tail");

        public sealed class Dest
        {
            public static explicit operator Dest(string s) => new Dest();
        }

        public static Dest Converted(Model.Arg argument, bool flag)
        {
            Dest d = (Dest)(flag ? argument.Name : "x");
            if (d == null) { return null; }
            return d;
        }
    }
}`
        let printed = TranslateCrossProject(app)
        Assert.Contains("Index(if i > 0 { argument.Name!! } else { \"x\" })", printed)
        Assert.Contains("case 0: argument.Name!!", printed)
        Assert.Contains("ParamsIndex(if i > 0 { argument.Name!! } else { \"x\" })", printed)
        Assert.Contains("case 1: argument.Name!!", printed)
        Assert.Contains("ObjectParamsCount(if flag { a.Objects!! } else { b.Objects!! })", printed)
        Assert.Contains("bag[if i > 2 { argument.Name!! } else { \"z\" }, \"tail\"]", printed)
        Assert.Contains("bag[0, if flag { a.Objects!! } else { b.Objects!! }]", printed)
        Assert.Contains("CountAll(if flag { a.Objects!! } else { b.Objects!! })", printed)
        Assert.Contains("ConstrainedSpanParams(if i > 4 { \"a\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains("FixedByListParams(list, if i > 5 { \"b\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains("list.FixedByReceiverParams(if i > 6 { \"c\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains("FixedByActionParams(consume, if i > 7 { \"d\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains("FixedByListArrayParams(lists, if i > 8 { \"e\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains("FixedByInParams(in text, if i > 9 { \"f\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains("FixedByInParams(in text, if i > 10 { \"g\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains("if i > 11 { \"h\" } else { argument.Name!! }", printed)
        Assert.Contains("if i > 12 { \"j\" } else { argument.Name!! }", printed)
        Assert.Contains("if i > 13 { \"k\" } else { argument.Name!! }", printed)
        Assert.Contains("FixedByIListParams(list, if i > 14 { \"m\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains("if i > 15 { \"n\" } else { argument.Name!! }", printed)
        Assert.Contains("FixedByArrayParams(array, if i > 16 { \"p\" } else { argument.Name!! }, \"tail\")", printed)
        Assert.Contains(
            "FixedByActionIListParams(action, if i > 17 { \"q\" } else { argument.Name!! }, \"tail\")",
            printed
        )
        Assert.Contains("if i > 18 { \"r\" } else { argument.Name!! }", printed)
        Assert.Contains("Id[string](if i > 0 {", printed)
        Assert.Contains("ParamsId[string](if i > 0 {", printed)
        Assert.Contains("SpanParamsId[string](", printed)
        Assert.Contains("if i > 3 {", printed)
        Assert.Contains("else { argument.Name!! })", printed)
        // A user-defined conversion is an invocation boundary: the arm feeds
        // the operator's non-null parameter, not the widened local `d`.
        Assert.Contains("if flag { argument.Name!! } else { \"x\" }", printed)
    }

    /// A `var` local is not a nil-accepting target, even though
    /// nullable-enabled C# annotates it: G# infers it from the emitted value.
    /// This is the Oahu `CoreAuthService.ToSession` shape. The flow-narrowed
    /// `a` arm keeps its `!!`, so `alias` stays `string`
    /// and can initialize a non-null member.
    @Fact
    func ImplicitlyTypedLocal_IsNotANilAcceptingTarget() {
        const source = `
#nullable enable
using System.Collections.Generic;

public sealed class Session { public string Alias { get; set; } = ""; }

public static class C
{
    public static Session Make(IReadOnlyDictionary<string, string> aliases, string id, string? name)
    {
        var alias = aliases.TryGetValue(id, out var a) && !string.IsNullOrWhiteSpace(a)
            ? a
            : name ?? id;
        return new Session { Alias = alias };
    }

#nullable enable annotations
    public static IEnumerable<string>? Maybe() => null;

    public static IEnumerable<string> Fallback() => System.Array.Empty<string>();

    public static int Count<T>(params IEnumerable<T> xs) => 0;

    public static int CallDirect() => Count(Maybe());

    public static int CallConditional(bool flag) => Count(flag ? Maybe() : Fallback());

    public static int UseSpan<T>(params System.ReadOnlySpan<T> xs) => xs.Length;

    public static int CallExplicitSpanConditional(bool flag)
    {
        var p = default(string);
        return UseSpan<string>(flag ? p : "a");
    }
#nullable restore
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("{ a!! } else { name ?? id }", printed)
        Assert.Contains("Count(Maybe()!!)", printed)
        Assert.Contains("Count(if flag { Maybe()!! } else { Fallback() })", printed)
        Assert.Contains("UseSpan[string](if flag { p!! } else { \"a\" })", printed)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(result!!.Success, string.Join("\n", result!!.Errors) + `

` + printed)
    }

    shared {
        private const Model string = `
namespace Model
{
    public sealed class Arg
    {
        public Arg(string value, string name = null, object[] objects = null) { Value = value; Name = name; Objects = objects; }
        public string Name { get; }
        public string Value { get; }
        public object[] Objects { get; }
    }

    public static class Printer
    {
        public static string Print(Arg a) => a.Name == null ? a.Value : a.Name + ": " + a.Value;
    }
}`

        private const ObLibSource string = `
namespace ObLib
{
    public sealed class Outer<TOuter>
    {
        public sealed class Inner<TInner> { }
    }

    public static class Node
    {
        public static string[] Holes() => new string[] { null };
        public static Outer<int>.Inner<string> NestedInner() => new Outer<int>.Inner<string>();
#nullable enable
        public static T ImportedListParams<T>(System.Collections.Generic.List<T> fixedValues, params T[] values) => values[0];
#nullable restore
    }
}`

        private func TranslateCrossProject(app string) string -> TranslateBothProjects(app).Consumer

        private func TranslateBothProjects(app string)(Library string, Consumer string) {
            let (_, obImage) = Compile(ObLibSource, "ObLib", Array.Empty[MetadataReference]())
            let (library, image) = Compile(Model, "Model", Array.Empty[MetadataReference]())
            let (consumer, _) = Compile(app, "App", []MetadataReference{image, obImage})
            let repository = []CSharpCompilation{library, consumer}
            return (Translate(library, repository), Translate(consumer, repository))
        }

        private func Translate(compilation CSharpCompilation, repository IReadOnlyList[CSharpCompilation]) string {
            let tree = Assert.Single(compilation.SyntaxTrees)
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument(tree.FilePath, tree, model)
            let context = TranslationContext(
                compilation,
                model,
                document.FilePath,
                siblingCompilations: repository,
                repositoryCompilations: repository
            )
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func Compile(source string, assemblyName string, references IReadOnlyList[MetadataReference])(
            Compilation CSharpCompilation,
            Image MetadataReference
        ) {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Concat(references),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let peStream = MemoryStream()
            let emit = compilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return (compilation, MetadataReference.CreateFromStream(peStream))
        }

        private func CompileAndRun(printedFiles IReadOnlyList[string], callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "branch-arm-effective-target-e2e",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(workDir)
            try {
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                let arguments = List[string]{compiler!!, "/target:exe", "/out:$dllPath"}
                for var i = 0; i < printedFiles.Count; i++ {
                    let gsPath = Path.Combine(workDir, "Unit$i.gs")
                    File.WriteAllText(gsPath, printedFiles[i])
                    arguments.Add(gsPath)
                }
                let entryPath = Path.Combine(workDir, "Main.gs")
                File.WriteAllText(
                    entryPath,
                    "import System${Environment.NewLine}${Environment.NewLine}Console.WriteLine($callExpression)${Environment.NewLine}"
                )
                arguments.Add(entryPath)
                let (compileExit, compileOutput) = RunDotnet(arguments.ToArray())
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet with zero errors. Output:\n" + compileOutput + `

Translated G#:
` + string.Join(Environment.NewLine, printedFiles)
                )
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOutput)
                return runOutput
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            Assert.NotNull(process)
            // Drain both streams concurrently so neither pipe can fill and block
            // the child, and bound the wait so a hung child fails the test.
            let stdout = process!!.StandardOutput.ReadToEndAsync()
            let stderr = process!!.StandardError.ReadToEndAsync()
            if !process!!.WaitForExit(TimeSpan.FromMinutes(5)) {
                process!!.Kill(entireProcessTree: true)
                Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
