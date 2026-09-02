// <copyright file="Issue3255ChannelTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3255: channels are first-class CLR-backed types and remain legal
/// when they contain an open type parameter or appear as an enclosing generic
/// type argument.
/// </summary>
public class Issue3255ChannelTypeArgumentTests
{
    [Fact]
    public void ChannelAsEnclosingTypeArgument_EmitsWithReifiedElementType()
    {
        var result = EmittedOracle.Evaluate("""
            package Issue3255Enclosing


            class Box[T] {}
            class Owner[T] {
                class Payload[U] {}
            }

            func Reify[T]() int32 {
                let value = Box[Owner[chan[T]].Payload[string]]()
                let channelType = value.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
                return channelType.GetGenericTypeDefinition().FullName == "System.Threading.Channels.Channel`1"
                    && channelType.GenericTypeArguments[0].FullName == "System.Int32" ? 42 : 0
            }

            Reify[int32]()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ChannelAsEnclosingTypeArgument_SubstitutesNestedMemberType()
    {
        var result = EmittedOracle.Evaluate("""
            package Issue3255NestedMember


            class Owner[T] {
                class Payload[U] {
                    var Value T
                }
            }

            func Make[T](value T) Owner[chan[T]].Payload[T] {
                let ch = chan[T](1)
                ch <- value
                return Owner[chan[T]].Payload[T]{Value: ch}
            }

            let payload = Make[int32](42)
            <-payload.Value
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void OpenChannelType_SubstitutesAcrossCallsFieldsAndInterfaces()
    {
        var result = EmittedOracle.Evaluate("""
            package Issue3255Substitution


            interface Reader[T] {
                func Read(ch chan[T]) T;
            }

            class Box[T] : Reader[T] {
                var Value chan[T] = chan[T](1)
                func Read(ch chan[T]) T { return <-ch }
            }

            func Relay[T](reader Reader[T], ch chan[T]) T {
                return reader.Read(ch)
            }

            let box = Box[int32]()
            box.Value <- 20
            let first = <-box.Value
            let ch = chan[int32](1)
            ch <- 22
            first + Relay[int32](box, ch)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void OpenChannelIteratorElement_EmitsAndRuns()
    {
        var result = EmittedOracle.Evaluate("""
            package Issue3255Iterator


            func Channels[T](value T) sequence[chan[T]] {
                let ch = chan[T](1)
                ch <- value
                yield ch
            }

            var result = 0
            for ch in Channels[int32](42) {
                result = <-ch
            }
            result
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void OpenChannelType_UsesElementParameterIdentityInFunctionTypeCache()
    {
        var t = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var unrelatedT = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var channelOfT = ChannelTypeSymbol.Get(t);
        var channelOfUnrelatedT = ChannelTypeSymbol.Get(unrelatedT);

        Assert.True(TypeSymbol.ContainsTypeParameter(channelOfT));

        var first = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(channelOfT),
            TypeSymbol.Void);
        var second = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(channelOfUnrelatedT),
            TypeSymbol.Void);

        Assert.NotSame(first, second);
    }

    [Fact]
    public void InternalDiagnostic_WithChannelAnchor_UsesOffendingTypeSpan()
    {
        const string Source = """
            package Issue3255Anchor
            class Box[T] {}
            class Owner[T] { class Payload[U] {} }
            func Reify[T]() {
                let value = Box[Owner[chan[T]].Payload[string]]()
            }
            """;
        var tree = SyntaxTree.Parse(SourceText.From(Source, "issue3255.gs"));
        var channel = Descendants(tree.Root)
            .OfType<TypeClauseSyntax>()
            .Single(type => type.IsChannel);
        var exception = new EmitDiagnosticException(
            "channel type failure",
            channel,
            new ArgumentNullException("key"));

        var diagnostic = Compilation.CreateInternalErrorDiagnostic(exception);

        Assert.Equal("GS9998", diagnostic.Id);
        Assert.Equal("ArgumentNullException: Value cannot be null. (Parameter 'key')", diagnostic.Message);
        Assert.Equal("issue3255.gs", diagnostic.Location.FileName);
        Assert.Equal(4, diagnostic.Location.StartLine);
        Assert.Equal(26, diagnostic.Location.StartCharacter);
        Assert.Equal(4, diagnostic.Location.EndLine);
        Assert.Equal(33, diagnostic.Location.EndCharacter);
    }

    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in Descendants(child))
            {
                yield return descendant;
            }
        }
    }
}
