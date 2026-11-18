// <copyright file="Issue6113UnconstrainedNullableTypeParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #6113: cs2gs lowers open `T?` without a proven ADR-0224 kind to bare `T`
/// (and `default(T?)` to `default(T)`), while preserving `T?` for proven reference
/// and value constraints and keeping C# runtime semantics across callers and overrides.
open class Issue6113UnconstrainedNullableTypeParameterTests {
    @Fact
    func DefaultConstraintOverrideAndExplicitCallers_PreserveRuntimeSemantics() {
        const source = `#nullable enable
using System;

namespace Demo;

public abstract class MaybeShower
{
    public abstract string Show<T>(T? value);
}

public sealed class PlainShower : MaybeShower
{
    public override string Show<T>(T? value)
        where T : default
    {
        return value is null ? "null" : "value:" + value.ToString();
    }
}

public static class Probe
{
    public static string Run()
    {
        MaybeShower shower = new PlainShower();
        string? maybeNull = null;
        string? present = "y";
        return string.Join(
            "|",
            shower.Show("x"),
            shower.Show<string>(null),
            shower.Show<string>(maybeNull),
            shower.Show<string>(present),
            shower.Show<int>(0),
            shower.Show<int?>(null));
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain("T?", printed, StringComparison.Ordinal)
        Assert.Contains("open func Show[T](value T) string;", printed, StringComparison.Ordinal)
        Assert.Contains("override func Show[T](value T) string", printed, StringComparison.Ordinal)
        Assert.Equal("value:x|null|null|value:y|value:0|null", CompileAndRun(printed, "Demo.Probe.Run()"))
    }

    @Fact
    func GuardedAnalyzerDriverPattern_PreservesFallbackAndObjectNullableCalls() {
        const source = `#nullable enable
using System;
using System.Collections.Immutable;

namespace Demo;

public sealed class Driver
{
    public bool Disabled;

    public ImmutableHashSet<string> GetIds(bool disabled)
    {
        Disabled = disabled;
        return Guarded(() => ImmutableHashSet.Create("a"))
            ?? ImmutableHashSet<string>.Empty;
    }

    public string RunVoid(bool disabled)
    {
        Disabled = disabled;
        var ran = false;
        Guarded(() => { ran = true; });
        return ran.ToString();
    }

    private void Guarded(Action action)
        => Guarded<object?>(() =>
        {
            action();
            return null;
        });

    private T? Guarded<T>(Func<T> action)
    {
        if (Disabled)
        {
            return default;
        }
        try
        {
            return action();
        }
        catch (InvalidOperationException)
        {
            return default;
        }
    }
}

public static class Probe
{
    public static string Run()
    {
        var d = new Driver();
        return d.GetIds(false).Count + ":" + d.GetIds(true).Count + ":" + d.RunVoid(false) + ":" + d.RunVoid(true);
    }
}`
        let printed = Translate(source)
        Assert.Contains("private func Guarded[T](action () -> T) T", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("T?", printed, StringComparison.Ordinal)
        Assert.Equal("1:0:True:False", CompileAndRun(printed, "Demo.Probe.Run()"))
    }

    @Fact
    func OahuInterfaceConstrainedBoxAppleListAndFrameTransform_CompileAndRun() {
        const source = `#nullable enable
using System;
using System.IO;
using System.Threading.Tasks;

namespace Demo;

public interface IBox
{
    string Name { get; }
    T? GetChild<T>() where T : IBox;
}

public sealed class ChildBox(string name) : IBox
{
    public string Name { get; } = name;
    public T? GetChild<T>() where T : IBox => default;
}

public abstract class Box : IBox
{
    private readonly IBox? child;
    protected Box(IBox? child) => this.child = child;
    public string Name => "root";

    public T? GetChild<T>() where T : IBox
        => child is T match ? match : default;

    public T GetChildOrThrow<T>() where T : IBox
        => GetChild<T>() ?? throw new InvalidDataException("missing");
}

public sealed class ConcreteBox(IBox? child) : Box(child);

public interface IAppleData
{
    int Value { get; }
}

public sealed class TagData(int value) : IAppleData
{
    public int Value { get; } = value;
}

public sealed class AppleListBox
{
    public string EditOrAddTag<TData>(string name, TData? data) where TData : IAppleData
        => data is not null ? name + "=" + data.Value : name + "=nil";

    public TData? GetTagData<TData>(bool present, Func<TData> factory) where TData : IAppleData
        => !present ? default : factory();
}

public abstract class FrameTransformBase<TInput, TOutput>
{
    protected virtual TOutput? PerformFinalFiltering() => default;

    public string Flush()
    {
        if (PerformFinalFiltering() is TOutput filteredData)
        {
            return "flushed:" + filteredData;
        }
        return "empty";
    }
}

public sealed class StringTransform(string? next) : FrameTransformBase<string, string>
{
    protected override string? PerformFinalFiltering() => next;
}

public sealed class Mp4Operation<TOutput>
{
    private readonly Func<Task, TOutput?> continuationFunc;
    private Task<TOutput?>? continuation;

    public Mp4Operation(Func<Task, TOutput> continuationFunc)
        => this.continuationFunc = continuationFunc;

    public Task<TOutput?> OperationTask => continuation ?? Task.FromResult<TOutput?>(default);

    public async Task<TOutput?> RunAsync(bool start)
    {
        if (start)
        {
            continuation = Task.CompletedTask.ContinueWith(continuationFunc);
        }
        return await OperationTask;
    }
}

public static class Probe
{
    public static string Run()
    {
        var withChild = new ConcreteBox(new ChildBox("c"));
        var emptyBox = new ConcreteBox(null);
        var boxResult = withChild.GetChildOrThrow<ChildBox>().Name;
        string missingMsg;
        try
        {
            _ = emptyBox.GetChildOrThrow<ChildBox>();
            missingMsg = "unexpected";
        }
        catch (InvalidDataException ex)
        {
            missingMsg = ex.Message;
        }

        var listBox = new AppleListBox();
        TagData? absentTag = null;
        var tagCalls = listBox.EditOrAddTag<TagData>("a", null) + "," +
            listBox.EditOrAddTag("b", absentTag) + "," +
            listBox.EditOrAddTag("c", new TagData(7)) + "," +
            (listBox.GetTagData<TagData>(false, () => new TagData(1))?.Value.ToString() ?? "none");

        var t1 = new StringTransform(null).Flush();
        var t2 = new StringTransform("ok").Flush();
        var op1 = new Mp4Operation<string>(_ => "done").RunAsync(false).GetAwaiter().GetResult() ?? "nil";
        var op2 = new Mp4Operation<string>(_ => "done").RunAsync(true).GetAwaiter().GetResult() ?? "nil";
        return string.Join("|", boxResult, missingMsg, tagCalls, t1, t2, op1, op2);
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain("T?", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("TData?", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("TOutput?", printed, StringComparison.Ordinal)
        Assert.Equal(
            "c|missing|a=nil,b=nil,c=7,none|empty|flushed:ok|nil|done",
            CompileAndRun(printed, "Demo.Probe.Run()")
        )
    }

    @Fact
    func CodeExploderTupleResultPattern_TranslatesCompilesAndRuns() {
        const source = `#nullable enable
using System;
using System.Collections.Generic;

namespace Demo;

public sealed class JsonLlmCall
{
    public T Call<T>(bool succeed, T payload, Func<T, List<string>> validate)
    {
        var (result, errors) = Attempt(succeed, payload, validate);
        if (errors.Count == 0)
        {
            return result!;
        }
        throw new InvalidOperationException(string.Join(";", errors));
    }

    private (T? Value, List<string> Errors) Attempt<T>(bool succeed, T payload, Func<T, List<string>> validate)
    {
        if (!succeed)
        {
            return (default, new List<string> { "bad" });
        }
        if (payload is null)
        {
            return (default, new List<string> { "null" });
        }
        return (payload, validate(payload));
    }
}

public static class Probe
{
    public static string Run()
    {
        var llm = new JsonLlmCall();
        var s = llm.Call(true, "ok", _ => new List<string>());
        var n = llm.Call(true, 0, _ => new List<string>());
        string err;
        try
        {
            _ = llm.Call(false, "ignored", _ => new List<string>());
            err = "none";
        }
        catch (InvalidOperationException ex)
        {
            err = ex.Message;
        }
        return s + "|" + n + "|" + err;
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain("T?", printed, StringComparison.Ordinal)
        Assert.Equal("ok|0|bad", CompileAndRun(printed, "Demo.Probe.Run()"))
    }

    @Fact
    func KindProofMatrix_DistinguishesProvenKindsFromUnknownAndDependentClassFlag() {
        const source = `#nullable enable
using System;

namespace Demo;

public class Animal { }

public static class Matrix
{
    public static TClass? RefFlag<TClass>(TClass? value) where TClass : class => value ?? default(TClass?);
    public static TClassN? RefNullableFlag<TClassN>(TClassN? value) where TClassN : class? => value ?? default(TClassN?);
    public static TAnimal? ConcreteClass<TAnimal>(TAnimal? value) where TAnimal : Animal => value ?? default(TAnimal?);
    public static TDepAnimal? DependentClass<TBase, TDepAnimal>(TDepAnimal? value)
        where TBase : Animal
        where TDepAnimal : TBase => value ?? default(TDepAnimal?);
    public static TStruct? ValueFlag<TStruct>(TStruct? value) where TStruct : struct => value ?? default(TStruct?);
    public static TDepFlag? DependentBareClassFlag<TBare, TDepFlag>(TDepFlag? value)
        where TBare : class
        where TDepFlag : TBare => value ?? default(TDepFlag?);
    public static TNotNull? NotNullFlag<TNotNull>(TNotNull? value) where TNotNull : notnull => value;
    public static T? ConditionalAccess<T>(string? s, Func<T> f) => s?.Length > 0 ? f() : default;
    public static TClass? DirectConditionalMember<TClass>(BoxWithGet<TClass>? b) where TClass : class => b?.Get();
    public static T? OptionalDefault<T>(T? value = default) => value;
    public static T CoalesceAssign<T>(T? value, T fallback) => value ??= fallback;
    public static int CollectionShapes<T>(T?[] items, List<T?> list) => items.Length + list.Count;

    public sealed class BoxWithGet<T>(T value)
    {
        public T Get() => value;
    }

    public static string Run()
    {
        var a = new Animal();
        return string.Join(
            "|",
            RefFlag<string>(null) ?? "nil",
            RefNullableFlag<string?>(null) ?? "nil",
            ConcreteClass<Animal>(null) == null,
            DependentClass<Animal, Animal>(a) == a,
            ValueFlag<int>(null)?.ToString() ?? "nil",
            DependentBareClassFlag<object, int>(0),
            NotNullFlag<int>(7),
            ConditionalAccess<int>("hi", () => 5),
            ConditionalAccess<int>(null, () => 5),
            DirectConditionalMember<string>(new BoxWithGet<string>("hit")) ?? "nil",
            DirectConditionalMember<string>(null) ?? "nil",
            OptionalDefault<string>() ?? "nil",
            CoalesceAssign<string>(null, "fallback"),
            CoalesceAssign<int>(0, 99),
            CollectionShapes<string>(new string?[] { null }, new List<string?> { "a", null }));
    }
}
`
        let sourceWithList = "using System.Collections.Generic;" + Environment.NewLine + source
        let printed = Translate(sourceWithList)
        Assert.Contains("RefFlag[TClass class](value TClass?) TClass?", printed, StringComparison.Ordinal)
        Assert.Contains("RefNullableFlag[TClassN class?](value TClassN?) TClassN?", printed, StringComparison.Ordinal)
        Assert.Contains("ConcreteClass[TAnimal Animal](value TAnimal?) TAnimal?", printed, StringComparison.Ordinal)
        Assert.Contains(
            "DependentClass[TBase Animal, TDepAnimal TBase](value TDepAnimal?) TDepAnimal?",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("ValueFlag[TStruct struct](value TStruct?) TStruct?", printed, StringComparison.Ordinal)
        Assert.Contains(
            "DependentBareClassFlag[TBare class, TDepFlag TBare](value TDepFlag) TDepFlag",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("NotNullFlag[TNotNull notnull](value TNotNull) TNotNull", printed, StringComparison.Ordinal)
        Assert.Contains("ConditionalAccess[T](s string?, f () -> T) T", printed, StringComparison.Ordinal)
        Assert.Contains(
            "DirectConditionalMember[TClass class](b BoxWithGet[TClass]?) TClass?",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("OptionalDefault[T](value T = default(T)) T", printed, StringComparison.Ordinal)
        Assert.Contains("CoalesceAssign[T](value T, fallback T) T", printed, StringComparison.Ordinal)
        Assert.Contains("CollectionShapes[T](items []T, list List[T]) int", printed, StringComparison.Ordinal)
        Assert.Equal(
            "nil|nil|True|True|nil|0|7|5|0|hit|nil|nil|fallback|0|3",
            CompileAndRun(printed, "Demo.Matrix.Run()")
        )
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "C# snippet must bind cleanly: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(
                context.Diagnostics.Where(
                    (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported ||
                        (
                        d.Severity == TranslationSeverity.Warning &&
                            d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
                    )
                )
            )
            let printed = GSharpPrinter.Print(unit)
            let _ = TranslationTestValidation.AssertBinds(printed)
            return printed
        }

        private func CompileAndRun(printed string, entryExpr string) string {
            let result = EmittedOracle.Evaluate(printed + Environment.NewLine + entryExpr)
            Assert.True(
                !result.Diagnostics.Any((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError),
                "Emitted G# failed to compile: " + string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString())
                ) +
                    Environment.NewLine +
                    printed
            )
            Assert.Null(result.UnhandledException)
            return result.Value!!.ToString()!!
        }
    }
}
