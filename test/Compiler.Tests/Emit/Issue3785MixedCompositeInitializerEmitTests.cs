// <copyright file="Issue3785MixedCompositeInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3785: emit coverage for mixed composite initializers — an ordered
/// mix of member initializers, bare content elements, and non-leading
/// content spreads in one named-target literal, all lowering to ordinary
/// field/property assignment and <c>Add(...)</c> calls in lexical order.
/// Traceability: ADR-0180.
/// </summary>
public class Issue3785MixedCompositeInitializerEmitTests
{
    [Fact]
    public void MembersAndMultipleSpreads_ObserveLexicalStateAndEnumerateExactlyOnce()
        => Assert.Equal(Issue3785MixedInitializerCases.LexicalOrderOutput, CompileAndRun(Issue3785MixedInitializerCases.LexicalOrder));

    [Fact]
    public void ExplicitMemberAndSameNamedKey_RemainIndependent()
        => Assert.Equal(Issue3785MixedInitializerCases.DistinctMemberAndKeyOutput, CompileAndRun(Issue3785MixedInitializerCases.DistinctMemberAndKey));

    [Fact]
    public void MembersOnly_NoContentElements_EmitsExactlyAsPlainStructLiteral()
    {
        // Regression: a composite literal with zero content elements/spreads
        // must behave exactly as the pre-ADR-0180 struct literal.
        var source = """
            package App
            import System

            class Point {
                var X int32 = 0
                var Y int32 = 0
            }

            let p = Point{ X: 3, Y: 4 }
            Console.WriteLine(p.X)
            Console.WriteLine(p.Y)
            """;

        Assert.Equal($"3{Environment.NewLine}4{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void MixedMembersElementsAndSpread_AddsInLexicalOrderOnUserDeclaredType()
    {
        // The issue's motivating shape: a user-declared G# type (not a CLR
        // collection) with both settable members and an owned Add(Node)
        // method (ADR-0079). Members, a bare content element, and a
        // non-leading content spread interleave in lexical (source) order.
        var source = """
            package App
            import System
            import System.Collections.Generic

            var trace = List[string]()

            class Node {
                var Name string = ""
                var Tag int32 = 0
                var Children List[Node] = List[Node]()
                func Add(child Node) {
                    trace.Add("add:" + child.Name)
                    Children.Add(child)
                }
            }

            func makeNode(name string) Node {
                trace.Add("make:" + name)
                return Node{ Name: name }
            }

            func setTag(value int32) int32 {
                trace.Add("tag:" + value.ToString())
                return value
            }

            var rows = List[Node]{ makeNode("r1"), makeNode("r2") }

            var root = Node{
                Name: "root",
                Tag: setTag(320),
                makeNode("first"),
                ...rows,
            }

            Console.WriteLine(root.Tag)
            Console.WriteLine(root.Children.Count)
            Console.WriteLine(root.Children[0].Name)
            Console.WriteLine(root.Children[1].Name)
            Console.WriteLine(root.Children[2].Name)
            for t in trace {
                Console.WriteLine(t)
            }
            """;

        var expected = string.Join(Environment.NewLine, new[]
        {
            "320",
            "3",
            "first",
            "r1",
            "r2",
            "make:r1",
            "make:r2",
            "tag:320",
            "make:first",
            "add:first",
            "add:r1",
            "add:r2",
        }) + Environment.NewLine;

        Assert.Equal(expected, CompileAndRun(source));
    }

    [Fact]
    public void SpreadContentElement_AddWithTrailingOptionalParameter_IsAccepted()
    {
        // Reviewer finding: HasUnaryCollectionAdd required exactly one
        // DECLARED parameter, so an Add overload with a trailing optional
        // parameter (callable with just one argument) was wrongly rejected
        // with GS0369 before overload resolution ever ran.
        var source = """
            package App
            import System
            import System.Collections.Generic

            class Node {
                var Name string = ""
                var Children List[Node] = List[Node]()
                func Add(child Node, trace bool = false) {
                    Children.Add(child)
                }
            }

            var rows = List[Node]{ Node{ Name: "a" }, Node{ Name: "b" } }
            var root = Node{ Name: "root", ...rows }
            Console.WriteLine(root.Children.Count)
            Console.WriteLine(root.Children[0].Name)
            Console.WriteLine(root.Children[1].Name)
            """;

        Assert.Equal($"2{Environment.NewLine}a{Environment.NewLine}b{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void BareContentElement_NoAddMethod_ReportsGs0369()
    {
        // A bare content element on a type with no accessible Add reuses
        // ADR-0117's GS0369 diagnostic rather than silently dropping the
        // element or reporting an internal-exception-class failure.
        var source = """
            package App

            class Plain {
                var Name string = ""
            }

            let p = Plain{ Name: "x", 42 }
            """;

        var (exit, diagnostics) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0369", diagnostics);
        Assert.DoesNotContain("GS9998", diagnostics);
    }

    [Fact]
    public void ContentSpread_ExplicitEmptyParens_StillLowersAsCollectionInitializer()
    {
        // Regression: Type(){ ...source } (no members) is unchanged ADR-0117
        // behavior — it must keep working exactly as before ADR-0180.
        var source = """
            package App
            import System
            import System.Collections.Generic

            class Node {
                var Name string = ""
                var Children List[Node] = List[Node]()
                func Add(child Node) {
                    Children.Add(child)
                }
            }

            var rows = List[Node]{ Node{ Name: "a" }, Node{ Name: "b" } }
            var container = Node(){ ...rows }
            Console.WriteLine(container.Children.Count)
            Console.WriteLine(container.Children[0].Name)
            Console.WriteLine(container.Children[1].Name)
            """;

        Assert.Equal($"2{Environment.NewLine}a{Environment.NewLine}b{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ExplicitMember_AfterLeadingSpread_LowersMemberAndAddInOrder()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            var trace = List[string]()

            class Node {
                var Name string = ""
                var Tag int32 = 0
                var Children List[Node] = List[Node]()
                func Add(child Node) {
                    trace.Add("add:" + child.Name)
                    Children.Add(child)
                }
            }

            var rows = List[Node]{ Node{ Name: "a" }, Node{ Name: "b" } }
            var root = Node(){ ...rows, .Tag: 7 }
            Console.WriteLine(root.Tag)
            Console.WriteLine(root.Children.Count)
            Console.WriteLine(root.Children[0].Name)
            Console.WriteLine(root.Children[1].Name)
            for t in trace {
                Console.WriteLine(t)
            }
            """;

        var expected = string.Join(Environment.NewLine, new[]
        {
            "7",
            "2",
            "a",
            "b",
            "add:a",
            "add:b",
        }) + Environment.NewLine;

        Assert.Equal(expected, CompileAndRun(source));
    }

    [Fact]
    public void ImportedClrType_MixedMemberAndElement_AppliesMemberAssignmentAndAddInOrder()
    {
        // Reviewer finding: an imported CLR collection with a writable member
        // AND a compatible Add (List[T].Capacity plus List[T].Add) must apply
        // member assignment and Add in lexical order, not report GS0369.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let xs = List[int32]{ Capacity: 10, 1, 2 }
            Console.WriteLine(xs.Capacity >= 10)
            Console.WriteLine(xs.Count)
            Console.WriteLine(xs[0])
            Console.WriteLine(xs[1])
            """;

        Assert.Equal($"True{Environment.NewLine}2{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void LeadingSpread_NoParens_StillLowersAsAdr0148StructuralProjection()
    {
        // Regression: Type{ ...source } (no explicit call parens) is
        // unchanged ADR-0148 structural projection — it must keep working
        // exactly as before ADR-0180, never reinterpreted as a content
        // spread.
        var source = """
            package App
            import System

            class Source {
                var Name string = ""
            }

            class Target {
                var Name string = ""
            }

            var src = Source{ Name: "z" }
            var proj = Target{ ...src }
            Console.WriteLine(proj.Name)
            """;

        Assert.Equal($"z{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void FunctionCallHead_LeadingSpreadThenKeyedEntry_StaysAdr0117CollectionInitializer()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            func makeMap() Dictionary[string, int32] {
                return Dictionary[string, int32]()
            }

            var pairs = Dictionary[string, int32]{ "a": 1 }
            var key = "b"
            var m = makeMap(){ ...pairs, key: 2 }
            Console.WriteLine(m.Count)
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        Assert.Equal($"2{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void TypedHead_LeadingSpreadThenNonMemberKeyedEntry_StaysAdr0117CollectionInitializer()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            var pairs = Dictionary[string, int32]{ "a": 1 }
            var key = "b"
            var m = Dictionary[string, int32](){ ...pairs, key: 2 }
            Console.WriteLine(m.Count)
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        Assert.Equal($"2{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ExplicitMember_OnImportedCollection_AssignsPropertyWithoutAddingAKey()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            var source = List[int32]{ 1, 2 }
            var xs = List[int32](){ ...source, .Capacity: 10 }
            Console.WriteLine(xs.Capacity >= 10)
            Console.WriteLine(xs.Count)
            Console.WriteLine(xs[0])
            Console.WriteLine(xs[1])
            """;

        Assert.Equal($"True{Environment.NewLine}2{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Theory]
    [InlineData("List[int32]()")]
    [InlineData("List[int32](4)")]
    [InlineData("List[int32](capacity: 4)")]
    [InlineData("System.Collections.Generic.List[int32](4)")]
    public void ExplicitMemberFirst_PreservesConstructorArgumentsAndQualification(string target)
    {
        var source = $$"""
            import System.Collections.Generic

            let values = {{target}}{ .Capacity: 10, 1, 2 }
            System.Console.WriteLine(values.Capacity)
            System.Console.WriteLine(values.Count)
            """;
        Assert.Equal($"10{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Theory]
    [InlineData("key")]
    [InlineData("Capacity")]
    public void UnmarkedKey_MemberNameCollisionDoesNotChangeInsertion(string keyName)
    {
        var source = $$"""
            import System.Collections.Generic

            let pairs = Dictionary[string, int32]{ "a": 1 }
            let {{keyName}} = "b"
            let values = SortedList[string, int32](){ ...pairs, {{keyName}}: 2 }
            System.Console.WriteLine(values.Count)
            System.Console.WriteLine(values["b"])
            """;
        Assert.Equal($"2{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Theory]
    [InlineData("key")]
    [InlineData("Count")]
    public void UnmarkedKey_ReadOnlyMemberNameDoesNotBecomeAssignment(string keyName)
    {
        var source = $$"""
            import System.Collections.Generic

            let pairs = Dictionary[string, int32]{ "a": 1 }
            let {{keyName}} = "b"
            let values = Dictionary[string, int32](){ ...pairs, {{keyName}}: 2 }
            System.Console.WriteLine(values.Count)
            System.Console.WriteLine(values["b"])
            """;
        Assert.Equal($"2{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Theory]
    [InlineData("")]
    [InlineData(".Capacity: 10,")]
    public void HeterogeneousKeyedIndexedAndSpreadEntries_KeepTheirOperations(string member)
    {
        var source = $$"""
            import System.Collections.Generic

            let pairs = Dictionary[string, int32]{ "a": 1 }
            let key = "b"
            let values = SortedList[string, int32](){
                ...pairs, {{member}} key: 2, "c": 3, [key] = 4,
            }
            System.Console.WriteLine(values.Count)
            System.Console.WriteLine(values["a"])
            System.Console.WriteLine(values["b"])
            System.Console.WriteLine(values["c"])
            """;
        Assert.Equal($"3{Environment.NewLine}1{Environment.NewLine}4{Environment.NewLine}3{Environment.NewLine}", CompileAndRun(source));
    }

    [Theory]
    [InlineData("struct Basket", "Basket{ Touches: 0, 1 }", 0)]
    [InlineData("struct Basket", "Basket{ Touches: 0, 1, Items: []int32{ 2 }, Counts: map[string, int32]{ \"final\": 3 } }", 1)]
    [InlineData("data struct Basket(seed int32)", "Basket(0){ .Touches: 0, 1 }", 0)]
    [InlineData("data struct Basket(seed int32)", "Basket(0){ .Touches: 0, 1, .Items: []int32{ 2 }, .Counts: map[string, int32]{ \"final\": 3 } }", 1)]
    public void StructContent_SeesSoundSliceAndMapZerosBeforeLaterAssignments(string declaration, string initializer, int finalLength)
    {
        var source = $$"""
            {{declaration}} {
                public var Items []int32
                public var Counts map[string, int32]
                public var Touches int32
                func Add(item int32) {
                    Touches = Touches + Items.Length + Counts.Count + item
                    Counts["seen"] = item
                }
            }

            let value = {{initializer}}
            System.Console.WriteLine(value.Touches)
            System.Console.WriteLine(value.Items.Length)
            System.Console.WriteLine(value.Counts.Count)
            """;
        Assert.Equal($"1{Environment.NewLine}{finalLength}{Environment.NewLine}1{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void MandatoryZeroSeeding_DoesNotRunSkippedFieldInitializerOrHoistExplicitValue()
    {
        const string source = """
            var defaults = 0
            func DefaultItems() []int32 {
                defaults++
                return []int32{ 9 }
            }
            func ExplicitItems() []int32 {
                System.Console.WriteLine("rhs")
                return []int32{ 2 }
            }
            struct Basket {
                public var Items []int32 = DefaultItems()
                public var Tag int32
                func Add(item int32) {
                    System.Console.WriteLine(Items.Length)
                }
            }
            let value = Basket{ Tag: 0, 1, Items: ExplicitItems() }
            System.Console.WriteLine(defaults)
            System.Console.WriteLine(value.Items.Length)
            """;
        Assert.Equal($"0{Environment.NewLine}rhs{Environment.NewLine}0{Environment.NewLine}1{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void FactoryReceiver_IsEvaluatedOnceAndPreservesExistingContents()
    {
        const string source = """
            import System.Collections.Generic
            var calls = 0
            func Make() List[int32] {
                calls++
                return List[int32]{ 42 }
            }
            let values = Make(){ .Capacity: 10, 7, ...[]int32{ 8 } }
            System.Console.WriteLine(calls)
            System.Console.WriteLine(values.Count)
            System.Console.WriteLine(values[0])
            """;
        Assert.Equal($"1{Environment.NewLine}3{Environment.NewLine}42{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void StructConstructor_InitializesReceiverBeforeOrderedElements()
    {
        const string source = """
            struct Basket {
                public var Items []int32
                public var Touches int32
                init() {
                    Items = []int32{ 9 }
                }
                func Add(item int32) {
                    Touches = Touches + Items.Length + item
                }
            }
            let value = Basket(){ .Touches: 0, 1, .Items: []int32{ 2, 3 } }
            System.Console.WriteLine(value.Touches)
            System.Console.WriteLine(value.Items.Length)
            """;
        Assert.Equal($"2{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void SynthesizedStructConstructor_IsNotOverwrittenByZeroSeeding()
    {
        const string source = """
            var calls = 0
            func Items() []int32 {
                calls++
                return []int32{ 9 }
            }
            struct Basket {
                private var hidden int32 = 1
                public var Values []int32 = Items()
                public var Tag int32
                func Add(item int32) {
                    System.Console.WriteLine(Values.Length + hidden)
                }
            }
            let value = Basket{ Tag: 0, 1, Values: []int32{ 2, 3 } }
            System.Console.WriteLine(calls)
            System.Console.WriteLine(value.Values.Length)
            """;
        Assert.Equal($"2{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void GenericAndNestedMixedNodes_PreserveTargetTyping()
    {
        const string source = """
            import System.Collections.Generic
            class Node[T any] {
                public var Value T
                public var Children List[Node[T]] = List[Node[T]]()
                public var Transform (T) -> T
                init(value T) {
                    Value = value
                    Transform = (x T) -> x
                }
                func Add(child Node[T]) {
                    Children.Add(child)
                }
            }
            let root = Node[int32](1){
                .Transform: x -> x + 1,
                Node[int32](2){ .Value: 3, Node[int32](4){ .Value: 5 } },
            }
            System.Console.WriteLine(root.Transform(root.Value))
            System.Console.WriteLine(root.Children[0].Value)
            System.Console.WriteLine(root.Children[0].Children[0].Value)
            """;
        Assert.Equal($"2{Environment.NewLine}3{Environment.NewLine}5{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void NestedMemberCollection_PopulatesExistingReadOnlyField()
    {
        const string source = """
            import System.Collections.Generic
            class Owner {
                public let Children List[int32] = List[int32]{ 42 }
            }
            let owner = Owner(){ .Children: { 1, ...[]int32{ 2 } } }
            System.Console.WriteLine(owner.Children.Count)
            System.Console.WriteLine(owner.Children[0])
            System.Console.WriteLine(owner.Children[2])
            """;
        Assert.Equal($"3{Environment.NewLine}42{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Theory]
    [InlineData("Factory.Make(1)")]
    [InlineData("Factory().Create(1)")]
    public void QualifiedFactory_PreservesCallAndReceiver(string target)
    {
        var source = $$"""
            import System.Collections.Generic
            class Factory {
                shared {
                    var Calls int32
                    func Make(seed int32) List[int32] {
                        Calls++
                        return List[int32]{ seed }
                    }
                }
                func Create(seed int32) List[int32] {
                    return Factory.Make(seed)
                }
            }
            let values = {{target}}{ .Capacity: 10, 2 }
            System.Console.WriteLine(Factory.Calls)
            System.Console.WriteLine(values[0])
            System.Console.WriteLine(values.Count)
            """;
        Assert.Equal($"1{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void QualifiedSourceConstructorAndTrailingAccess_PreserveReceiver()
    {
        const string source = """
            package MixedSource
            class Bag {
                var Total int32
                init(seed int32) { Total = seed }
                func Add(value int32) { Total = Total + value }
            }
            let value = MixedSource.Bag(1){ .Total: 10, 2 }.Total
            System.Console.WriteLine(value)
            let count = System.Collections.Generic.List[int32](4){ .Capacity: 10, 1, 2 }.Count
            System.Console.WriteLine(count)
            """;
        Assert.Equal($"12{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ExplicitMembersAndSpreads_UseOrdinaryUserDefinedConversions()
    {
        const string source = """
            import System.Collections.Generic
            struct Celsius { var Degrees float64 }
            func operator implicit(value Celsius) float64 { return value.Degrees }
            let values = List[float64](){
                .Capacity: 4,
                Celsius{ Degrees: 1.5 },
                ...[]Celsius{ Celsius{ Degrees: 2.5 } },
            }
            System.Console.WriteLine(values[0])
            System.Console.WriteLine(values[1])
            """;
        Assert.Equal($"1.5{Environment.NewLine}2.5{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var (exit, output, diagnostics) = Compile(source, run: true);
        Assert.True(exit == 0, $"compile/run failed ({exit}): {diagnostics}");
        return output;
    }

    private static (int Exit, string Diagnostics) CompileExpectingFailure(string source)
    {
        var (exit, _, diagnostics) = Compile(source, run: false);
        return (exit, diagnostics);
    }

    private static (int Exit, string Output, string Diagnostics) Compile(string source, bool run)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue3785_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            var diagnostics = compileOut.ToString() + compileErr.ToString();
            if (compileExit != 0 || !run)
            {
                return (compileExit, string.Empty, diagnostics);
            }

            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return (0, stdout.ReplaceLineEndings(Environment.NewLine), diagnostics);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }
}
