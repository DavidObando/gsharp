// <copyright file="Issue3471SiblingStaticQualificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Core.CodeAnalysis

// Issue #3471: a bare C# reference to a sibling static member used to be
// re-qualified through the owning type on every line (`Agent.IsEnabled(...)`
// inside `Agent`). gsc resolves bare sibling `shared` references from
// anywhere inside the declaring aggregate's body, so the qualifier is only
// required where the emitted body leaves the type scope (lifted extension
// funcs), or where gsc genuinely cannot see the member bare (nested type →
// outer statics, derived type → inherited statics).
class Issue3471SiblingStaticQualificationTests {
    @Fact
    func InstanceMethod_SiblingSharedMembers_EmitBare() {
        let printed = Translate(`public class Agent
{
    public static int Count { get; set; }

    public string Name = "x";

    public string Describe()
    {
        if (IsEnabled("1"))
        {
            Count = Count + 1;
            return Name + Count;
        }

        return Name;
    }

    private static bool IsEnabled(string value) => value == "1";
}`)
        Assert.DoesNotContain("Agent.IsEnabled", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Agent.Count", printed, StringComparison.Ordinal)
        Assert.Contains("IsEnabled(\"1\")", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func SharedMethod_SiblingSharedFieldAndCall_Evaluate() {
        let printed = Translate(`public static class Obj
{
    private static int seed = 40;

    public static int Run()
    {
        Bump(2);
        return seed;
    }

    private static int Bump(int by) => seed += by;
}`)
        Assert.DoesNotContain("Obj.Bump", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Obj.seed", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NestedType_OuterSharedMember_StaysQualified() {
        let printed = Translate(`public class Outer
{
    public static string Tag() => "outer";

    public class Inner
    {
        public string From() => Tag();
    }
}`)
        Assert.Contains("Outer.Tag()", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func DerivedType_InheritedSharedMember_StaysQualified() {
        let printed = Translate(`public class BaseCls
{
    public static string BaseTag() => "base";
}

public class DerivedCls : BaseCls
{
    public string From() => BaseTag();
}`)
        Assert.Contains("BaseCls.BaseTag()", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func LiftedExtensionBody_SiblingStatic_StaysQualified() {
        let printed = Translate(`public static class Ext
{
    public static int Twice(this int value) => Add(value, value);

    public static int Add(int a, int b) => a + b;
}`)
        Assert.Contains("Ext.Add(", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func LiftedStaticLocalFunction_SameTypeCall_EmitsBare() {
        // Issue #4302: a mixed generic/non-generic recursion group keeps
        // the readable member-lift fallback, and same-type calls remain
        // bare rather than acquiring a redundant owner qualification.
        let printed = Translate(`public class Labels
{
    public int Make(int value)
    {
        return NewLabel(value);

        static int NewLabel(int i)
        {
            return i == 0 ? 0 : Other<int>(i - 1);
        }

        static int Other<T>(int i)
        {
            return NewLabel(i);
        }
    }
}`)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        Assert.Contains("return NewLabel(value)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Labels.NewLabel(value)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func GenericOwner_SiblingSharedMember_EmitsBare() {
        let printed = Translate(`public class Box<T>
{
    public static int Total { get; set; }

    public int Touch()
    {
        Total = Total + 1;
        return Total;
    }
}`)
        Assert.DoesNotContain("Box[T].Total", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Box.Total", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func GenericOwner_LiftedHelper_KeepsEnclosingInstantiation() {
        // Issue #4302: inside `Second<T>` the spelling `Box[T]` names the
        // method's `T`, so a qualified helper call would read
        // `Box<string>.Marker` from `Box<int>`. Bare sibling calls keep
        // the enclosing instantiation.
        let printed = Translate(`public class Box<T>
{
    public static int Marker;

    public static int Run(int value)
    {
        return Second<string>(value);

        static int First(int i) =>
            i == 0 ? Marker : Second<int>(i - 1);

        static int Second<T>(int i) => First(i);
    }
}`)
        Assert.DoesNotContain("Box[T].First", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, `Box[int32].Marker = 1
Box[string].Marker = 2
Console.WriteLine(Box[int32].Run(1))`, "1")
    }

    @Fact
    func StructOwner_SiblingSharedMember_EmitsBare() {
        let printed = Translate(`public struct Pt
{
    public static int Zero => 0;

    public int X;

    public int Shift() => X + Zero;
}`)
        Assert.DoesNotContain("Pt.Zero", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    // gsc issue #3487 (fixed): bare sibling statics resolve from lambda
    // bodies inside shared members just as they do in instance members,
    // so both lambda sites go bare.
    @Fact
    func LambdaBody_InStaticMember_EmitsBare() {
        let printed = Translate(`using System;

public class Events
{
    private static int Hidden() => 3;

    public static int Shown() => 4;

    public static int Run()
    {
        Func<int> mixed = () => Hidden() + Shown();
        return mixed();
    }
}`)
        Assert.DoesNotContain("Events.Hidden()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Events.Shown()", printed, StringComparison.Ordinal)
        Assert.Contains("Hidden() + Shown()", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func LambdaBody_InInstanceMember_EmitsBare() {
        let printed = Translate(`using System;

public class Events
{
    private static int Hidden() => 3;

    public int Run()
    {
        Func<int> f = () => Hidden();
        return f();
    }
}`)
        Assert.DoesNotContain("Events.Hidden()", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    // gsc issue #3489 (fixed): a bare shared member works as the base
    // receiver of a member STORE, so store positions go bare like every
    // other sibling static reference.
    @Fact
    func SiblingStaticStoreReceiver_EmitsBare() {
        let printed = Translate(`public class Logging
{
    private bool flush;

    private static Logging Instance = new Logging();

    public static bool InstantFlush
    {
        get => Instance.flush;
        set => Instance.flush = value;
    }

    public static void Apply(bool value)
    {
        Instance.Set(value);
    }

    public static int Run()
    {
        InstantFlush = true;
        Apply(true);
        return InstantFlush ? 1 : 0;
    }

    private void Set(bool value) => this.flush = value;
}`)
        Assert.Contains("set -> Instance.flush = value", printed, StringComparison.Ordinal)
        Assert.Contains("get -> Instance.flush", printed, StringComparison.Ordinal)
        Assert.Contains("Instance.Set(value)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Logging.Instance", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Logging.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(1, result.Value)
    }

    // gsc issue #3490 (fixed): a bare sibling call whose argument
    // subtree carries an inline `out var` declaration binds cleanly, so
    // it goes bare like every other sibling static call.
    @Fact
    func SiblingStaticCall_WithOutVarArgument_EmitsBare() {
        let printed = Translate(`using System.Collections.Generic;
using System.Linq;

public class Writer
{
    public string Row(IReadOnlyDictionary<string, object?> row, List<string> keys)
    {
        return string.Join(",", keys.Select(k => Format(row.TryGetValue(k, out var v) ? v : null)));
    }

    public static string Plain(object? value) => Format(value);

    private static string Format(object? value) => value?.ToString() ?? "";
}`)
        Assert.Contains("Format(if row.TryGetValue(k, out var v)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Writer.Format(", printed, StringComparison.Ordinal)
        Assert.Contains("string -> Format(value)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    shared {
        private func Translate(source string, additionalReferences ...MetadataReference) string {
            let references IReadOnlyList[MetadataReference]? = if additionalReferences.Length == 0 {
                default(List[MetadataReference]?)
            } else {
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Concat(additionalReferences)
                    .GroupBy((reference MetadataReference) -> reference.Display!!, StringComparer.Ordinal)
                    .Select((group IGrouping[string, MetadataReference]) -> group.First())
                    .ToList()
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
