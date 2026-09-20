// <copyright file="ManagedReferenceReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Gsharp.Values;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceReviewTests
{
    [Fact]
    public void EmitTreeAndLoweredTreesPrintPersistentLocations()
    {
        const string source = """
            package ManagedPrinting
            func Make() managed[int32] {
                var value = 42
                let view = readonly managed(value)
                return managed(value)
            }
            """;
        using var references = ReferenceResolver.WithRuntimeReferences(new[] { typeof(ManagedRef<>).Assembly.Location });
        var compilation = new Compilation(references, SyntaxTree.Parse(source)) { IsLibrary = true };
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
        using var before = new StringWriter();
        compilation.EmitTree(before);
        Assert.Contains("managed(value)", before.ToString());
        Assert.Contains("readonly managed(value)", before.ToString());

        var boxed = CaptureBoxingRewriter.Lower(compilation.BoundProgram, references.MapClrTypeToReferences);
        var lowered = ManagedReferenceLowerer.Lower(boxed, references);
        using var after = new StringWriter();
        foreach (var method in lowered.Functions)
        {
            method.Key.WriteTo(after);
            method.Value.WriteTo(after);
        }

        Assert.Contains("managedFieldKey(", after.ToString());
        Assert.Contains(".Value", after.ToString());
        Assert.Contains("GetLocation", after.ToString());
    }

    [Theory]
    [InlineData("func Escape(scoped p managed[int32]) map[string, managed[int32]] { return map[string, managed[int32]]{\"x\": p} }")]
    [InlineData("func Escape(scoped p managed[int32]) map[managed[int32], int32] { return map[managed[int32], int32]{p: 7} }")]
    [InlineData("func Escape(scoped p managed[int32]) { var items = map[managed[int32], int32]{}; items[p] = 7 }")]
    [InlineData("func Escape(scoped p managed[int32]) { var items = map[string, managed[int32]]{}; items[\"x\"] = p }")]
    [InlineData("func Escape(scoped p managed[int32]) sequence[managed[int32]] { yield p }")]
    [InlineData("func Escape(scoped p managed[int32], action (managed[int32]) -> void) { action(p) }")]
    [InlineData("func Escape(scoped p managed[int32]) { let action = func (value managed[int32]) { }; action(p) }")]
    [InlineData("func Escape(scoped p managed[int32], ref target managed[int32]) { target = p }")]
    [InlineData("func Escape(scoped p managed[int32]?, out target managed[int32]?) { target = p }")]
    [InlineData("func Escape(scoped p managed[int32]?, ref target managed[int32]) { target = p!! }")]
    [InlineData("func Escape(scoped p managed[int32], ref target managed[int32]) { let ref alias = target; alias = p }")]
    [InlineData("func Escape(scoped p managed[int32]) { var value = 0; var local = managed(value); let ref alias = local; alias = p }")]
    [InlineData("func Escape(scoped p managed[int32], ref target managed[int32]) { let pointer = &target; *pointer = p }")]
    [InlineData("func Escape(scoped p managed[int32], out target object) { target = p }")]
    public void ScopedValuesCannotEscapeThroughAdditionalSinks(string declaration)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile("package ManagedSinks\n" + declaration, "ManagedSinks", executable: false);
        Assert.NotEqual(0, code);
        Assert.True(output.Contains("error GS0604:", StringComparison.Ordinal), output);
    }

    [Theory]
    [InlineData("ref")]
    [InlineData("out")]
    public void RejectedCallerStoreDoesNotRewriteParameterContract(string kind)
    {
        var source = $"package ManagedContract\nfunc Escape(scoped p managed[int32], {kind} target managed[int32]) {{ target = p }}";
        using var references = ReferenceResolver.WithRuntimeReferences(new[] { typeof(ManagedRef<>).Assembly.Location });
        var compilation = new Compilation(references, SyntaxTree.Parse(source)) { IsLibrary = true };
        var program = compilation.BoundProgram;
        Assert.Contains(program.Diagnostics, d => d.Id == "GS0604");
        var function = Assert.Single(program.Functions.Keys, f => f.Name == "Escape");
        Assert.False(function.Parameters[1].IsScoped);
        Assert.Equal(kind == "ref" ? RefKind.Ref : RefKind.Out, function.Parameters[1].RefKind);
    }

    [Fact]
    public void StoredScalarResultsAndScopePreservingLocalCopiesRemainValid()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package ManagedSinkCopies
            import System
            func Copy(scoped p managed[int32], out result int32) map[int32, int32] {
                var local managed[int32]? = nil
                local = p
                result = *(local!!)
                var items = map[int32, int32]{*p: *p}
                items[*p] = 7
                return items
            }
            func Values(scoped p managed[int32]) sequence[int32] { yield *p }
            func Indirect(scoped p managed[int32]) int32 {
                let action = func (value int32) int32 { return value }
                return action(*p)
            }
            func Main() {
                var value = 42
                let p = managed(value)
                var copied = 0
                let items = Copy(p, out copied)
                Console.WriteLine(items[42])
                for item in Values(p) { Console.WriteLine(item) }
                Console.WriteLine(Indirect(p))
                value = 99
                Console.WriteLine(copied)
            }
            """, "ManagedSinkCopies", executable: true);
        IlVerifier.Verify(dll);
        Assert.Equal("7\n42\n42\n42\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("(*p).Update(await Next())")]
    [InlineData("(*p).Value = await Next()")]
    [InlineData("(*p).Number = await Next()")]
    [InlineData("let ref alias = p.Borrow()\nalias.Value = await Next()")]
    [InlineData("let ref alias = p.Borrow()\nalias.Update(await Next())")]
    public void BorrowedStructReceiversCannotCrossSuspension(string operation)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = $$"""
            package ManagedReceiverReject
            import System.Threading.Tasks
            struct Counter {
                var Value int32
                prop Number int32 {
                    get { return this.Value }
                    set { this.Value = value }
                }
                func Update(value int32) { this.Value = value }
            }
            async func Next() int32 {
                await Task.Delay(1)
                return 42
            }
            async func Bad(p managed[Counter]) {
                {{operation}}
            }
            """;
        var (code, output) = fixture.TryCompile(source, "ManagedReceiverReject", executable: false);
        Assert.NotEqual(0, code);
        Assert.True(output.Contains("error GS0604:", StringComparison.Ordinal), output);
    }

    [Theory]
    [InlineData("(*p).X = await Next()")]
    [InlineData("(*p).Offset(await Next(), 0)")]
    public void ImportedBorrowedStructReceiversCannotCrossSuspension(string operation)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = $$"""
            package ManagedImportedReceiverReject
            import System.Drawing
            import System.Threading.Tasks
            async func Next() int32 {
                await Task.Delay(1)
                return 42
            }
            async func Bad(p managed[Point]) { {{operation}} }
            """;
        var (code, output) = fixture.TryCompile(source, "ManagedImportedReceiverReject", executable: false);
        Assert.NotEqual(0, code);
        Assert.True(output.Contains("error GS0604:", StringComparison.Ordinal), output);
    }

    [Fact]
    public void ScalarArgumentsObjectReceiversAndPostAwaitBorrowsPreserveSemantics()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package ManagedReceiverCopies
            import System
            import System.Threading.Tasks
            struct Counter {
                var Value int32
                func Update(value int32) { this.Value = value }
            }
            class Box {
                var Value int32
                func Update(value int32) { this.Value = value }
            }
            async func Next() int32 {
                await Task.Delay(1)
                return 42
            }
            func Add(a int32, b int32) int32 { return a + b }
            async func Use(value managed[int32], counter managed[Counter], box managed[Box]) int32 {
                let result = Add(*value, await Next())
                let next = await Next()
                (*counter).Value = next
                (*counter.AsReadOnly()).Update((await Next()) + 1)
                (*box).Update(await Next())
                return result
            }
            func Main() {
                var value = 1
                var counter = Counter{Value: 0}
                var box = Box{Value: 0}
                let result = Use(managed(value), managed(counter), managed(box)).GetAwaiter().GetResult()
                Console.WriteLine(result)
                Console.WriteLine(counter.Value)
                Console.WriteLine(box.Value)
            }
            """, "ManagedReceiverCopies", executable: true);
        IlVerifier.Verify(dll);
        Assert.Equal("43\n42\n42\n", fixture.Run(dll));
    }
}
