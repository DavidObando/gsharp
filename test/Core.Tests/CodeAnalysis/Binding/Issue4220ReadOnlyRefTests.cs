// <copyright file="Issue4220ReadOnlyRefTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class Issue4220ReadOnlyRefTests
{
    [Fact]
    public void ReadOnlyAliasesObserveMutation_AndLetRefStaysWritable()
    {
        var result = EmittedOracle.Evaluate("""
            func Read(in value int32) int32 { return value }
            func Run() int32 {
                var values = []int32{10}
                let ref writable = values[0]
                let ref readonly view = writable
                var ref readonly second = view
                writable = 42
                return Read(in second)
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Theory]
    [InlineData("view = 1")]
    [InlineData("view++")]
    [InlineData("view += 1")]
    [InlineData("Write(ref view)")]
    [InlineData("Fill(out view)")]
    [InlineData("let ref writable = view")]
    [InlineData("var pointer = &view")]
    [InlineData("Write(ref (true ? view : value))")]
    [InlineData("Fill(out (true ? view : value))")]
    public void WritePermissionCannotBeRecovered(string operation)
    {
        var result = EmittedOracle.Evaluate($$"""
            func Write(ref value int32) { value = 1 }
            func Fill(out value int32) { value = 1 }
            func Run() {
                var value = 10
                let ref readonly view = value
                {{operation}}
            }
            Run()
            """);
        Assert.NotEmpty(result.Diagnostics.Where(d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Theory]
    [InlineData("func Bad(value int32) ref readonly int32 { return ref value }")]
    [InlineData("func Bad() ref readonly int32 {\nvar value = 1\nreturn ref value\n}")]
    [InlineData("func Bad() ref readonly int32 {\nvar value = 1\nlet ref readonly view = value\nreturn ref view\n}")]
    [InlineData("func Bad(scoped ref value int32) ref readonly int32 { return ref value }")]
    public void ReadOnlyDoesNotExtendStorageLifetime(string declaration)
    {
        var result = EmittedOracle.Evaluate(declaration);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0005");
    }

    [Fact]
    public void ShallowReferenceMutationAllowed_StructMutationUsesDefensiveCopy()
    {
        var result = EmittedOracle.Evaluate("""
            class Box { var Value int32 }
            struct Counter {
                var Value int32
                func Bump() { Value = Value + 1 }
            }
            func Run() int32 {
                var box = Box{}
                let ref readonly view = box
                view.Value = 40
                var counter = Counter{Value: 2}
                let ref readonly count = counter
                count.Bump()
                return view.Value + counter.Value
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void GenericMethodAndPropertyReads_LoadReferent()
    {
        var result = EmittedOracle.Evaluate("""
            func View[T](ref value T) ref readonly T { return ref value }
            class Box {
                var values []int32 = []int32{40, 2}
                prop Value ref readonly int32 -> values[0]
                prop this[i int32] ref readonly int32 { get { return ref values[i] } }
            }
            func Run() int32 {
                var number = 42
                let box = Box{}
                return View(ref number) + box.Value + box[1]
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(84, result.ReadGlobals()["answer"]);
    }

    [Theory]
    [InlineData("ref")]
    [InlineData("ref readonly")]
    public void CallerLifetimeSurvivesAlias(string refKind)
    {
        var result = EmittedOracle.Evaluate($$"""
            func View(ref value int32) {{refKind}} int32 {
                let {{refKind}} alias = value
                return ref alias
            }
            var value = 42
            var answer = View(ref value)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void WritableReturnCannotExposeReadOnlyAlias()
    {
        var result = EmittedOracle.Evaluate("""
            func Bad(ref value int32) ref int32 {
                let ref readonly view = value
                return ref view
            }
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0253");
    }

    [Fact]
    public void NestedFieldAliasesAreLive_AndReadOnlyIsContextual()
    {
        var result = EmittedOracle.Evaluate("""
            struct Counter { var Value int32 }
            func Run() int32 {
                var readonly = Counter{Value: 10}
                let ref readonly view = readonly
                let ref readonly field = view.Value
                readonly.Value = 42
                return field
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Theory]
    [InlineData("view.Value = 1")]
    [InlineData("view.Value++")]
    [InlineData("let ref writable = view.Value")]
    [InlineData("Write(ref view.Value)")]
    [InlineData("var pointer = &(true ? view.Value : counter.Value)")]
    public void NestedStructFieldsDoNotRestoreWritePermission(string operation)
    {
        var result = EmittedOracle.Evaluate($$"""
            struct Counter { var Value int32 }
            func Write(ref value int32) { value = 1 }
            func Run() {
                var counter = Counter{Value: 10}
                let ref readonly view = counter
                {{operation}}
            }
            Run()
            """);
        Assert.NotEmpty(result.Diagnostics.Where(d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998" || d.Id == "GS0005");
    }

    [Fact]
    public void GenericPropertySubstitutionPreservesReadOnlyReturn()
    {
        var result = EmittedOracle.Evaluate("""
            class Box[T] {
                var Value T
                prop View ref readonly T -> Value
                prop this[i int32] ref readonly T -> Value
            }
            func Run() int32 {
                var box = Box[int32]{Value: 21}
                return box.View + box[0]
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Theory]
    [InlineData("ref readonly", true)]
    [InlineData("ref", false)]
    [InlineData("", false)]
    public void NativeOverrideRequiresExactReturnCapability(string kind, bool valid)
    {
        var result = EmittedOracle.Evaluate($$"""
            open class Base {
                open func View(ref value int32) ref readonly int32 { return ref value }
            }
            class Derived : Base {
                override func View(ref value int32) {{kind}} int32 {
                    return {{(kind.Length > 0 ? "ref " : "")}}value
                }
            }
            """);
        Assert.Equal(valid, !result.Diagnostics.Any(d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998" || d.Id == "GS0005");
    }

    [Fact]
    public void ConstrainedStructCallsUseDefensiveCopy()
    {
        var result = EmittedOracle.Evaluate("""
            interface ICounter { func Bump(); }
            struct Counter : ICounter {
                var Value int32
                func Bump() { Value++ }
            }
            func Bump[T ICounter](ref value T) {
                let ref readonly view = value
                view.Bump()
            }
            func Run() int32 {
                var counter = Counter{Value: 42}
                Bump(ref counter)
                return counter.Value
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void ImmutablePointerBindingDoesNotFreezePointee()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                var value = 10
                let pointer = &value
                let ref readonly view = *pointer
                *pointer = 42
                return view
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    // Issue #4224: aliasing a ref-readonly-returning call/property/indexer
    // result was the deferred limitation this test's name refers to — gsc's
    // lvalue checks accepted only a variable, field, array element, or
    // dereference, never a call/property result. Issue #4224 closes that gap
    // (ExpressionBinder.IsLvalue / StatementBinder.IsLvalueForRefReturn now
    // also accept a native ref-returning call/property), so these six forms
    // now bind as genuine LIVE references rather than being rejected — the
    // test proves liveness (not a snapshot) by mutating the source AFTER the
    // alias is taken and observing the mutation through the alias.
    [Theory]
    [InlineData("source.View", "view.Value")]
    [InlineData("source.GetView()", "view.Value")]
    [InlineData("source[0]", "view.Value")]
    [InlineData("source.View.Value", "view")]
    [InlineData("source.GetView().Value", "view")]
    [InlineData("source[0].Value", "view")]
    public void SourceRefResultAliasesObserveMutation_NeverBecomeSnapshots(string initializer, string readExpression)
    {
        var result = EmittedOracle.Evaluate($$"""
            struct Counter { var Value int32 }
            class Source {
                var value Counter
                prop View ref readonly Counter -> value
                prop this[i int32] ref readonly Counter -> value
                func GetView() ref readonly Counter { return ref value }
            }
            func Run() int32 {
                let source = Source{}
                let ref readonly view = {{initializer}}
                source.value.Value = 99
                return {{readExpression}}
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.ReadGlobals()["answer"]);
    }

    [Theory]
    [InlineData("map[string]int32{\"x\": 1}", "values[\"x\"]")]
    [InlineData("\"text\"", "values[0]")]
    public void ReadOnlyAliasesRequireAddressableElements(string initializer, string element)
    {
        var result = EmittedOracle.Evaluate($$"""
            func Run() {
                var values = {{initializer}}
                let ref readonly view = {{element}}
            }
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0256");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998" || d.Id == "GS0005");
    }

    [Fact]
    public void ReadOnlyReturnCannotExposeCopiedMapElement()
    {
        var result = EmittedOracle.Evaluate("""
            func Bad(values map[string]int32) ref readonly int32 {
                return ref values["x"]
            }
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0253");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998" || d.Id == "GS0005");
    }

    [Theory]
    [InlineData("ref")]
    [InlineData("ref readonly")]
    public void PointerParameterPointeeDoesNotHaveTheParameterSlotsLifetime(string refKind)
    {
        var result = EmittedOracle.Evaluate($$"""
            unsafe func View(pointer *int32) {{refKind}} int32 { return ref *pointer }
            unsafe func Run() int32 {
                var value = 42
                return View(&value)
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Theory]
    [InlineData("ref")]
    [InlineData("ref readonly")]
    public void ScopedPointerPointeeCannotEscape(string refKind)
    {
        var result = EmittedOracle.Evaluate($$"""
            unsafe func Bad(scoped pointer *int32) {{refKind}} int32 {
                return ref *pointer
            }
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998" || d.Id == "GS0005");
    }

    [Theory]
    [InlineData("Fill(out Value)")]
    [InlineData("Fill(out this.Value)")]
    [InlineData("Write(ref Value)")]
    [InlineData("Write(ref this.Value)")]
    [InlineData("System.Int32.TryParse(\"42\", out Value)")]
    public void ReadOnlyFieldInitializationKeepsConstructorWritePermission(string statement)
    {
        var result = EmittedOracle.Evaluate($$"""
            func Fill(out value int32) { value = 42 }
            func Write(ref value int32) { value = 42 }
            class Box {
                let Value int32 = 10
                init() { {{statement}} }
            }
            var answer = Box{}.Value
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Theory]
    [InlineData("class Box { let Value int32\nfunc Change() { Fill(out Value) } }")]
    [InlineData("class Box { let Value int32\ninit(other Box) { Fill(out other.Value) } }")]
    [InlineData("class Box { let Value int32\ninit() { let ref readonly view = Value\nFill(out view) } }")]
    [InlineData("open class Base { protected let Value int32 }\nclass Derived : Base { init() { Fill(out Value) } }")]
    public void ConstructorPermissionDoesNotGrantOtherReadOnlyWrites(string declaration)
    {
        var result = EmittedOracle.Evaluate("func Fill(out value int32) { value = 42 }\n" + declaration);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9005");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998" || d.Id == "GS0005");
    }
}
