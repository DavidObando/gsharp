// <copyright file="Issue3785MixedCompositeInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
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
    public void ExplicitEmptyParens_LeadingSpreadThenMember_LowersMemberAndAddInOrder()
    {
        // ADR-0180 §B's explicit-parens marker: Type(){ ...source, Member: v }
        // promotes the literal from an ADR-0117 collection initializer to a
        // composite literal, lowering the spread's Add(...) calls before the
        // member assignment that follows it lexically.
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
            var root = Node(){ ...rows, Tag: 7 }
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
        // Reviewer finding: `makeMap(){ ...pairs, key: value }` shares the
        // exact "comma, Identifier ':'" token shape ADR-0180 §B reserves for
        // `Type(){ ...source, Member: value }`, but `makeMap` is a function,
        // not a type — the parser cannot tell the two apart, so the binder
        // must fall back to ADR-0117's collection initializer (a keyed
        // `Add(key, value)` entry) instead of inventing a nonexistent
        // `makeMap` struct type.
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
