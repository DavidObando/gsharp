// <copyright file="Issue2519SourceClassConstraintOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Binding regressions for issue #2519's source class-constraint ordering.</summary>
public sealed class Issue2519SourceClassConstraintOrderingTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CrossPackageSourceClassConstraint_ExposesCompleteMemberSurfaceInEitherTreeOrder(bool reverse)
    {
        var constrained = Parse(
            """
            package P.Audio
            import P
            import System
            class Holder2519[T Entry2519] {
                func Read(value T) int32 ->
                    value.Count + value.SamplesInFrame + value.Inherited() + value.VirtualValue()
                func Upcast(value T) Entry2519 -> value
                func Subscribe(value T, handler Action) {
                    value.Changed += handler
                }
            }
            """);
        var constraint = Parse(
            """
            package P
            import System
            open class Root2519 {
                public var SamplesInFrame int32
                public func Inherited() int32 -> 3
                public event Changed Action
            }
            open class Entry2519 : Root2519 {
                public prop Count int32 -> 2
                public open func VirtualValue() int32 -> 4
            }
            """);

        var trees = reverse
            ? new[] { constraint, constrained }
            : new[] { constrained, constraint };
        var result = new Compilation(trees)
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ExactDecryptConstraintShape_BindsBeforeOrAfterConstraintAndGenericBase(bool reverse)
    {
        var multipart = Parse(
            """
            package Oahu.Decrypt.FrameFilters.Audio
            import Oahu.Decrypt
            import Oahu.Decrypt.FrameFilters
            import System.Threading.Tasks

            open class MultipartFilterBase2519[
                TInput FrameEntry2519,
                TCallback Oahu.Decrypt.INewSplitCallback2519[TCallback]
            ] : FrameFinalBase2519[TInput] {
                protected open override func PerformFilteringAsync(input TInput) Task {
                    if input.Chunk == nil {
                        input.Notify += () -> { }
                    }
                    input.SamplesInFrame += 1
                    return Task.CompletedTask
                }
            }
            """);
        var dependencies = Parse(
            """
            package Oahu.Decrypt
            import System
            interface INewSplitCallback2519[T INewSplitCallback2519[T]] { }
            open class FrameEntryBase2519 {
                public var Chunk object?
                public var SamplesInFrame int32
                public event Notify Action
            }
            open class FrameEntry2519 : FrameEntryBase2519 { }
            """);
        var genericBase = Parse(
            """
            package Oahu.Decrypt.FrameFilters
            import System.Threading.Tasks
            open class FrameFinalBase2519[T] {
                protected open func PerformFilteringAsync(input T) Task -> Task.CompletedTask
            }
            """);

        var trees = reverse
            ? new[] { genericBase, dependencies, multipart }
            : new[] { multipart, dependencies, genericBase };
        var result = new Compilation(trees)
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("FrameEntry2519")
                || diagnostic.Message.Contains("Chunk")
                || diagnostic.Message.Contains("SamplesInFrame"));
    }

    [Fact]
    public void SameFileConstraintDeclaredLater_ResolvesToPublishedShell()
    {
        var tree = Parse(
            """
            package P
            class Holder2519[T Entry2519] {
                func Read(value T) int32 -> value.Count
            }
            class Entry2519 {
                public prop Count int32 -> 42
            }
            """);
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        var holder = Assert.Single(compilation.GlobalScope.Structs.Where(s => s.Name == "Holder2519"));
        var constraint = Assert.IsType<StructSymbol>(Assert.Single(holder.TypeParameters).ClassConstraint);
        Assert.Equal("Entry2519", constraint.Name);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructedClassConstraint_OnClassAndInterface_UsesLateGenericMemberProjections(bool reverse)
    {
        var consumers = Parse(
            """
            package P.Use
            import P.Model
            class Holder2519[T GenericEntry2519[int32]] {
                func Read(value T) int32 -> value.Value + value.BaseValue
            }
            interface Reader2519[T GenericEntry2519[int32]] {
                func Read(value T) int32;
            }
            """);
        var model = Parse(
            """
            package P.Model
            open class GenericBase2519[U] {
                public prop BaseValue U -> default(U)
            }
            class GenericEntry2519[U] : GenericBase2519[U] {
                public prop Value U -> default(U)
            }
            """);

        var trees = reverse
            ? new[] { model, consumers }
            : new[] { consumers, model };
        var result = new Compilation(trees)
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
    }

    private static SyntaxTree Parse(string source)
        => SyntaxTree.Parse(SourceText.From(source));
}
