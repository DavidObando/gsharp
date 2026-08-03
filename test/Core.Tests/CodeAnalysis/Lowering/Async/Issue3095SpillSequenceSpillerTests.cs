// <copyright file="Issue3095SpillSequenceSpillerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>Verifies that await spilling preserves imported-call emission metadata.</summary>
public sealed class Issue3095SpillSequenceSpillerTests
{
    [Fact]
    public void ImportedStaticCall_PreservesGenericArgumentsAndContainer()
    {
        var method = typeof(Enumerable)
            .GetMethods()
            .Single(candidate =>
                candidate.Name == nameof(Enumerable.ToList)
                && candidate.GetParameters().Length == 1)
            .MakeGenericMethod(typeof(object));
        var function = new ImportedFunctionSymbol(
            method.Name,
            new ImportedClassSymbol(typeof(Enumerable), null),
            method,
            null);
        var typeArguments = ImmutableArray.Create<TypeSymbol>(TypeSymbol.String);
        var staticContainerType = TypeSymbol.Object;
        var call = new BoundImportedCallExpression(
            null,
            function,
            ImmutableArray.Create<BoundExpression>(
                new BoundAwaitExpression(
                    null,
                    new BoundLiteralExpression(null, 0),
                    TypeSymbol.FromClrType(typeof(IEnumerable<object>)))),
            typeArgumentSymbols: typeArguments,
            staticContainerType: staticContainerType);

        var rewritten = RewriteInitializer(call);

        var rewrittenCall = Assert.IsType<BoundImportedCallExpression>(rewritten);
        Assert.Equal(typeArguments, rewrittenCall.TypeArgumentSymbols);
        Assert.Same(staticContainerType, rewrittenCall.StaticContainerType);
    }

    [Fact]
    public void ImportedInstanceCall_PreservesGenericAndDispatchMetadata()
    {
        var method = typeof(List<object>)
            .GetMethod(nameof(List<object>.ConvertAll))!
            .MakeGenericMethod(typeof(object));
        var typeArguments = ImmutableArray.Create<TypeSymbol>(TypeSymbol.String);
        var constrainedReceiver = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        var constrainedInterface = ImportedTypeSymbol.Get(typeof(IComparable<object>));
        var receiver = new BoundVariableExpression(
            null,
            new LocalVariableSymbol(
                "items",
                isReadOnly: true,
                TypeSymbol.FromClrType(typeof(List<object>))));
        var call = new BoundImportedInstanceCallExpression(
            null,
            receiver,
            method,
            TypeSymbol.FromClrType(typeof(List<object>)),
            ImmutableArray.Create<BoundExpression>(
                new BoundAwaitExpression(
                    null,
                    new BoundLiteralExpression(null, 0),
                    TypeSymbol.FromClrType(typeof(Converter<object, object>)))),
            typeArgumentSymbols: typeArguments,
            constrainedReceiverTypeParameter: constrainedReceiver,
            constrainedInterfaceType: constrainedInterface,
            isNonVirtualBaseCall: true);

        var rewritten = RewriteInitializer(call);

        var rewrittenCall = Assert.IsType<BoundImportedInstanceCallExpression>(rewritten);
        Assert.Equal(typeArguments, rewrittenCall.TypeArgumentSymbols);
        Assert.Same(constrainedReceiver, rewrittenCall.ConstrainedReceiverTypeParameter);
        Assert.Same(constrainedInterface, rewrittenCall.ConstrainedInterfaceType);
        Assert.True(rewrittenCall.IsNonVirtualBaseCall);
    }

    private static BoundExpression RewriteInitializer(BoundExpression initializer)
    {
        var result = new LocalVariableSymbol("result", isReadOnly: true, initializer.Type);
        var body = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
                new BoundVariableDeclaration(null, result, initializer)));

        var rewritten = SpillSequenceSpiller.Rewrite(body);

        return Assert.IsType<BoundVariableDeclaration>(rewritten.Statements[^1]).Initializer;
    }
}
