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

/// <summary>Verifies that await spilling preserves call-site emission metadata.</summary>
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
        AssertImmutableArrayEqual(typeArguments, rewrittenCall.TypeArgumentSymbols);
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
        AssertImmutableArrayEqual(typeArguments, rewrittenCall.TypeArgumentSymbols);
        Assert.Same(constrainedReceiver, rewrittenCall.ConstrainedReceiverTypeParameter);
        Assert.Same(constrainedInterface, rewrittenCall.ConstrainedInterfaceType);
        Assert.True(rewrittenCall.IsNonVirtualBaseCall);
    }

    [Fact]
    public void UserInstanceCall_PreservesGenericAndDispatchMetadata()
    {
        var methodTypeParameter = new TypeParameterSymbol(
            "TMethod",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        var method = new FunctionSymbol(
            "Convert",
            ImmutableArray.Create(new ParameterSymbol("value", TypeSymbol.Int32)),
            TypeSymbol.String,
            declaration: null,
            package: null,
            Accessibility.Public,
            receiverType: TypeSymbol.Object)
        {
            TypeParameters = ImmutableArray.Create(methodTypeParameter),
        };
        var methodTypeArguments = ImmutableArray.Create<TypeSymbol>(TypeSymbol.String);
        var constrainedReceiver = new TypeParameterSymbol(
            "TReceiver",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        var constrainedInterface = TypeSymbol.Object;
        var receiver = new BoundVariableExpression(
            null,
            new LocalVariableSymbol("receiver", isReadOnly: true, TypeSymbol.Object));
        var call = new BoundUserInstanceCallExpression(
            null,
            receiver,
            method,
            ImmutableArray.Create<BoundExpression>(
                new BoundAwaitExpression(
                    null,
                    new BoundLiteralExpression(null, 0),
                    TypeSymbol.Int32)),
            TypeSymbol.String,
            constrainedReceiver,
            constrainedInterface)
        {
            MethodTypeArguments = methodTypeArguments,
        };

        var rewritten = RewriteInitializer(call);

        var rewrittenCall = Assert.IsType<BoundUserInstanceCallExpression>(rewritten);
        AssertImmutableArrayEqual(methodTypeArguments, rewrittenCall.MethodTypeArguments);
        Assert.Same(constrainedReceiver, rewrittenCall.ConstrainedReceiverTypeParameter);
        Assert.Same(constrainedInterface, rewrittenCall.ConstrainedInterfaceType);
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

    private static void AssertImmutableArrayEqual<T>(ImmutableArray<T> expected, ImmutableArray<T> actual)
    {
        Assert.Equal(expected.IsDefault, actual.IsDefault);
        if (!expected.IsDefault)
        {
            Assert.Equal(expected.ToArray(), actual.ToArray());
        }
    }
}
