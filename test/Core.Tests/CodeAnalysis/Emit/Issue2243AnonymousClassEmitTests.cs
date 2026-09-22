// <copyright file="Issue2243AnonymousClassEmitTests.cs" company="GSharp">
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
/// ADR-0146 (issue #2243): end-to-end emission of the richer anonymous-object
/// literal. A <c>data object { ... }</c> reuses the value-type
/// data-struct pipeline (Equals/GetHashCode/ToString/with). A plain
/// <c>object : Interface { ... }</c> / <c>object : Base(args) { ... }</c> with
/// methods or events is desugared to a synthesized reference-type class routed
/// through the ordinary named-class binder/emitter (interface-implementation
/// verification, virtual/override checking, TypeDef/MethodDef emission) — no
/// bespoke emission code. These tests exercise that the emitted IL actually
/// runs.
/// </summary>
public class Issue2243AnonymousClassEmitTests
{
    [Fact]
    public void ImplementsInterface_MethodCallableThroughInterfaceReference_EmitsAndRuns()
    {
        const string source = """
            package Corpus.Issue2243

            import System

            interface MouseListener {
                func onClick() string;
                func onHover() string;
            }

            let listener = object : MouseListener {
                func onClick() string -> "Button clicked!"
                func onHover() string -> "Button hovered!"
            }
            Console.WriteLine(listener.onClick())
            Console.WriteLine(listener.onHover())
            let asIface MouseListener = listener
            Console.WriteLine(asIface.onClick())
            """;

        var output = CompileAndRun("Issue2243Interface", source);
        var lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("Button clicked!", lines[0]);
        Assert.Equal("Button hovered!", lines[1]);
        Assert.Equal("Button clicked!", lines[2]);
    }

    [Fact]
    public void ExtendsBaseClass_OverriddenMethodRuns_EmitsAndRuns()
    {
        const string source = """
            package Corpus.Issue2243

            import System

            open class Animal(Name string) {
                open func SaySomething() string -> "generic"
            }

            let dog = object : Animal("Fluffy") {
                override func SaySomething() string -> "woof!"
            }
            Console.WriteLine(dog.SaySomething())
            """;

        var output = CompileAndRun("Issue2243Base", source);
        Assert.Equal("woof!", output.Trim());
    }

    [Fact]
    public void DataObject_With_ProducesIndependentCopy_EmitsAndRuns()
    {
        const string source = """
            package Corpus.Issue2243

            import System

            let mydata = data object { let Name = "David"; let Language = "GSharp" }
            let other = mydata with { Name = "Amelia" }
            Console.WriteLine(mydata.Name)
            Console.WriteLine(other.Name)
            Console.WriteLine(other.Language)
            """;

        var output = CompileAndRun("Issue2243With", source);
        var lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("David", lines[0]);
        Assert.Equal("Amelia", lines[1]);
        Assert.Equal("GSharp", lines[2]);
    }

    [Fact]
    public void RichObject_InferredFieldAndLexicalCapture_EmitsAndRuns()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface Reader { func Read() int32; }
            let value = 40
            let reader = object : Reader {
                let Snapshot = value + 1
                func Read() int32 -> value + Snapshot
            }
            Console.WriteLine(reader.Snapshot)
            Console.WriteLine(reader.Read())
            """;

        var output = CompileAndRun("Issue4329Capture", source);
        var lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("41", lines[0]);
        Assert.Equal("81", lines[1]);
    }

    [Fact]
    public void RichObject_BaseArgumentsAndFields_AreEvaluatedAtLiteralSite()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            open class Base(Value int32) {
                open func Read() int32 -> Value
            }

            let seed = 20
            let reader = object : Base(seed + 1) {
                let Extra = seed + 2
                override func Read() int32 -> base.Read() + Extra
            }
            Console.WriteLine(reader.Read())
            """;

        var output = CompileAndRun("Issue4329Base", source);
        Assert.Equal("43", output.Trim());
    }

    [Fact]
    public void RichObject_BaseVirtualCallSeesSnapshotAndCaptureEnvironment()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            open class Base {
                var Observed int32
                init() { Observed = Read() }
                open func Read() int32 -> -1
            }

            var value = 40
            let reader = object : Base() {
                let Snapshot = value + 2
                override func Read() int32 -> value + Snapshot
            }
            Console.WriteLine(reader.Observed)
            value = 41
            Console.WriteLine(reader.Read())
            """;

        var output = CompileAndRun("Issue4329BaseVirtual", source);
        Assert.Equal("82\n83\n".Replace("\n", Environment.NewLine), output);
    }

    [Fact]
    public void StructuralAdaptation_ForwardsAndAllocatesFreshWrapper()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface Reader { func Read() int32; }
            class Source(Value int32) { func Read() int32 -> Value }

            let source = Source(42)
            let first = adapt[Reader](source)
            let second = adapt[Reader](source)
            Console.WriteLine(first.Read())
            Console.WriteLine(Object.ReferenceEquals(first, source))
            Console.WriteLine(Object.ReferenceEquals(first, second))
            Console.WriteLine(first.GetType() == source.GetType())
            """;

        var output = CompileAndRun("Issue4329Adapt", source);
        Assert.Equal(
            "42" + Environment.NewLine
            + "False" + Environment.NewLine
            + "False" + Environment.NewLine
            + "False" + Environment.NewLine,
            output);
    }

    [Fact]
    public void StructuralAdaptation_ForwardsPropertyAccessors()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface Box { prop Value int32 { get; set; } }
            class Source {
                var storage int32
                prop Value int32 { get -> storage; set { storage = value } }
            }

            let adapted = adapt[Box](Source())
            adapted.Value = 17
            Console.WriteLine(adapted.Value)
            """;

        var output = CompileAndRun("Issue4329AdaptProperty", source);
        Assert.Equal("17", output.Trim());
    }

    [Fact]
    public void StructuralAdaptation_MutableStructOwnsOnePersistentCopy()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface Counter { func Increment(); func Read() int32; }
            struct Source {
                var Value int32
                func Increment() { Value += 1 }
                func Read() int32 -> Value
            }

            var original = Source{Value: 1}
            let adapted = adapt[Counter](original)
            adapted.Increment()
            adapted.Increment()
            Console.WriteLine(adapted.Read())
            Console.WriteLine(original.Value)
            """;

        var output = CompileAndRun("Issue4329AdaptStruct", source);
        Assert.Equal("3" + Environment.NewLine + "1" + Environment.NewLine, output);
    }

    [Fact]
    public void StructuralAdaptation_ForwardsEventAddAndRemove()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface Changes { event Changed (int32) -> void }
            class Source {
                event Changed (int32) -> void
                func Raise(value int32) { Changed(value) }
            }

            var observed = 0
            let source = Source()
            let adapted = adapt[Changes](source)
            let removed = (value int32) -> { observed = value }
            let retained = (value int32) -> { observed = value + 100 }
            adapted.Changed += removed
            adapted.Changed += retained
            adapted.Changed -= removed
            source.Raise(10)
            Console.WriteLine(observed)
            """;

        var output = CompileAndRun("Issue4329AdaptEvent", source);
        Assert.Equal("110", output.Trim());
    }

    [Fact]
    public void StructuralAdaptation_ForwardsGenericInheritedAndDefaultMethods()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface BaseReader { func Read() int32; }
            interface Reader : BaseReader {
                func Identity[T](value T) T;
                func Label() string { return "default" }
            }
            class Source {
                func Read() int32 -> 42
                func Identity[T](value T) T -> value
            }

            let adapted = adapt[Reader](Source())
            Console.WriteLine(adapted.Read())
            Console.WriteLine(adapted.Identity[string]("generic"))
            Console.WriteLine(adapted.Label())
            """;

        var output = CompileAndRun("Issue4329AdaptGeneric", source);
        Assert.Equal(
            "42" + Environment.NewLine
            + "generic" + Environment.NewLine
            + "default" + Environment.NewLine,
            output);
    }

    [Fact]
    public void StructuralAdaptation_RefResultRemainsLiveAlias()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface Slots { func Slot() ref int32; }
            class Source {
                var Value int32
                func Slot() ref int32 { return ref Value }
            }

            func Run() {
                let source = Source()
                let adapted = adapt[Slots](source)
                let ref alias = adapted.Slot()
                alias = 23
                Console.WriteLine(source.Value)
            }
            Run()
            """;

        var output = CompileAndRun("Issue4329AdaptRef", source);
        Assert.Equal("23", output.Trim());
    }

    [Fact]
    public void StructuralAdaptation_ForwardsIndexerAccessors()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface Values { prop this[index int32] int32 { get; set; } }
            class Source {
                var items []int32 = []int32{1, 2, 3}
                prop this[index int32] int32 {
                    get -> items[index]
                    set { items[index] = value }
                }
            }

            let adapted = adapt[Values](Source())
            adapted[1] = 17
            Console.WriteLine(adapted[1])
            """;

        var output = CompileAndRun("Issue4329AdaptIndexer", source);
        Assert.Equal("17", output.Trim());
    }

    [Fact]
    public void StructuralAdaptation_EvaluatesSourceOnceAndDoesNotRetarget()
    {
        const string source = """
            package Corpus.Issue4329

            import System

            interface Reader { func Read() int32; }
            class Source(Value int32) { func Read() int32 -> Value }

            var evaluations = 0
            func Make() Source {
                evaluations += 1
                return Source(evaluations)
            }

            var current = Source(5)
            let retained = adapt[Reader](current)
            current = Source(9)
            let evaluated = adapt[Reader](Make())
            Console.WriteLine(retained.Read())
            Console.WriteLine(evaluations)
            Console.WriteLine(evaluated.Read())
            """;

        var output = CompileAndRun("Issue4329AdaptEvaluation", source);
        Assert.Equal("5\n1\n1\n".Replace("\n", Environment.NewLine), output);
    }

    [Fact]
    public void CapturingRichObjectsAndAdaptersSupportRepeatedCompilationEmit()
    {
        const string source = """
            package Corpus.Issue4329
            interface Reader { func Read() int32; }
            class Source(Value int32) { func Read() int32 -> Value }
            func Build(value int32) Reader {
                let rich = object : Reader {
                    let Snapshot = value
                    func Read() int32 -> value + Snapshot
                }
                let adapted = adapt[Reader](Source(rich.Read()))
                return adapted
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var first = new MemoryStream();
        using var second = new MemoryStream();
        var firstResult = compilation.Emit(first);
        var secondResult = compilation.Emit(second);
        Assert.True(firstResult.Success, string.Join("; ", firstResult.Diagnostics.Select(d => d.Message)));
        Assert.True(secondResult.Success, string.Join("; ", secondResult.Diagnostics.Select(d => d.Message)));
        Assert.Equal(first.ToArray(), second.ToArray());
    }

    /// <summary>
    /// Compiles and emits <paramref name="source"/>, loads the resulting PE,
    /// invokes its entry point, and returns captured console output.
    /// </summary>
    /// <param name="contextName">The collectible load-context name.</param>
    /// <param name="source">The G# source to compile.</param>
    /// <returns>The captured console output.</returns>
    private static string CompileAndRun(string contextName, string source)
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
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
                throw agg.InnerException ?? agg;
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
