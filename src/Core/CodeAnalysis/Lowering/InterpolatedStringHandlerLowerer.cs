// <copyright file="InterpolatedStringHandlerLowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Emit-time (IL-only) lowering of <see cref="BoundInterpolatedStringExpression"/>
/// to the C# 10 interpolated-string-handler pattern (issue #368, ADR-0055).
/// </summary>
/// <remarks>
/// Each interpolation node is rewritten into a <see cref="BoundBlockExpression"/>
/// that does the following.
/// <list type="number">
/// <item>declares a <c>System.Runtime.CompilerServices.DefaultInterpolatedStringHandler</c>
/// value-type local and constructs it with <c>(literalLength, formattedCount)</c>.</item>
/// <item>calls <c>AppendLiteral(string)</c> for each literal run and
/// <c>AppendFormatted&lt;T&gt;(value[, alignment][, format])</c> for each hole.</item>
/// <item>yields <c>ToStringAndClear()</c> as the block's result.</item>
/// </list>
/// The handler is a <c>ref struct</c>; in metadata it is an ordinary value type
/// (the <c>IsByRefLike</c> marker does not affect the local signature), so the
/// existing value-type local / instance-call emit paths handle it directly.
/// <para>
/// Value-type holes do <b>not</b> box: <c>AppendFormatted&lt;T&gt;</c> is closed
/// over the hole's concrete CLR type (or, for user-defined types lacking a
/// reflection <see cref="System.Type"/>, over an <c>object</c> placeholder while
/// the real type-argument symbol is encoded into the emitted MethodSpec), so the
/// hole value is passed by its natural representation.
/// </para>
/// This rewrite is applied only on the emit path; the tree-walk interpreter
/// renders <see cref="BoundInterpolatedStringExpression"/> directly.
/// </remarks>
internal sealed class InterpolatedStringHandlerLowerer : BoundTreeRewriter
{
    private static readonly System.Type HandlerType = typeof(DefaultInterpolatedStringHandler);
    private static readonly TypeSymbol HandlerTypeSymbol = TypeSymbol.FromClrType(HandlerType);
    private static readonly ConstructorInfo HandlerCtor = HandlerType.GetConstructor(new[] { typeof(int), typeof(int) });
    private static readonly MethodInfo AppendLiteralMethod = HandlerType.GetMethod("AppendLiteral", new[] { typeof(string) });
    private static readonly MethodInfo ToStringAndClearMethod = HandlerType.GetMethod("ToStringAndClear", System.Type.EmptyTypes);
    private static readonly MethodInfo AppendFormattedValue = FindAppendFormatted(genericArity: 1, valueOnly: true);
    private static readonly MethodInfo AppendFormattedAlign = FindAppendFormatted(secondParam: typeof(int));
    private static readonly MethodInfo AppendFormattedFormat = FindAppendFormatted(secondParam: typeof(string));
    private static readonly MethodInfo AppendFormattedAlignFormat = FindAppendFormatted(secondParam: typeof(int), thirdParam: typeof(string));

    private int counter;

    /// <summary>
    /// Produces a copy of <paramref name="program"/> in which every interpolated
    /// string has been lowered to the handler pattern. Returns the original
    /// instance unchanged when no interpolation is present.
    /// </summary>
    /// <param name="program">The bound program to lower.</param>
    /// <returns>The lowered program.</returns>
    public static BoundProgram Lower(BoundProgram program)
    {
        var lowerer = new InterpolatedStringHandlerLowerer();
        var changed = false;

        var functions = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        foreach (var pair in program.Functions)
        {
            var newBody = (BoundBlockStatement)lowerer.RewriteStatement(pair.Value);
            functions[pair.Key] = newBody;
            changed |= newBody != pair.Value;
        }

        var statement = program.Statement;
        if (statement != null)
        {
            var newStatement = (BoundBlockStatement)lowerer.RewriteStatement(statement);
            changed |= newStatement != statement;
            statement = newStatement;
        }

        if (!changed)
        {
            return program;
        }

        var result = new BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            functions.ToImmutable(),
            program.EntryPoint,
            statement,
            program.Structs,
            program.Interfaces,
            program.Enums,
            program.Globals)
        {
            Imports = program.Imports,
        };

        return result;
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteInterpolatedStringExpression(BoundInterpolatedStringExpression node)
    {
        var literalLength = 0;
        var formattedCount = 0;
        foreach (var part in node.Parts)
        {
            if (part.IsLiteral)
            {
                literalLength += part.Literal.Length;
            }
            else
            {
                formattedCount++;
            }
        }

        var handlerLocal = new LocalVariableSymbol($"<>interp{this.counter++}", isReadOnly: false, HandlerTypeSymbol);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        var construct = new BoundClrConstructorCallExpression(
            node.Syntax,
            HandlerType,
            HandlerCtor,
            ImmutableArray.Create<BoundExpression>(
                new BoundLiteralExpression(null, literalLength),
                new BoundLiteralExpression(null, formattedCount)),
            HandlerTypeSymbol);
        statements.Add(new BoundVariableDeclaration(node.Syntax, handlerLocal, construct));

        foreach (var part in node.Parts)
        {
            if (part.IsLiteral)
            {
                if (part.Literal.Length == 0)
                {
                    continue;
                }

                var append = new BoundImportedInstanceCallExpression(
                    node.Syntax,
                    new BoundVariableExpression(null, handlerLocal),
                    AppendLiteralMethod,
                    TypeSymbol.Void,
                    ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(null, part.Literal)));
                statements.Add(new BoundExpressionStatement(node.Syntax, append));
                continue;
            }

            var value = this.RewriteExpression(part.Value);
            var (method, typeArguments) = CloseAppendFormatted(part, value.Type);

            var arguments = ImmutableArray.CreateBuilder<BoundExpression>();
            arguments.Add(value);
            if (part.Alignment.HasValue)
            {
                arguments.Add(new BoundLiteralExpression(null, part.Alignment.Value));
            }

            if (part.Format != null)
            {
                arguments.Add(new BoundLiteralExpression(null, part.Format));
            }

            var appendFormatted = new BoundImportedInstanceCallExpression(
                node.Syntax,
                new BoundVariableExpression(null, handlerLocal),
                method,
                TypeSymbol.Void,
                arguments.ToImmutable(),
                argumentRefKinds: default,
                typeArgumentSymbols: typeArguments);
            statements.Add(new BoundExpressionStatement(node.Syntax, appendFormatted));
        }

        var result = new BoundImportedInstanceCallExpression(
            node.Syntax,
            new BoundVariableExpression(null, handlerLocal),
            ToStringAndClearMethod,
            TypeSymbol.String,
            ImmutableArray<BoundExpression>.Empty);

        return new BoundBlockExpression(node.Syntax, statements.ToImmutable(), result);
    }

    private static (MethodInfo Method, ImmutableArray<TypeSymbol> TypeArguments) CloseAppendFormatted(
        BoundInterpolatedStringPart part, TypeSymbol holeType)
    {
        MethodInfo open;
        if (part.Alignment.HasValue && part.Format != null)
        {
            open = AppendFormattedAlignFormat;
        }
        else if (part.Alignment.HasValue)
        {
            open = AppendFormattedAlign;
        }
        else if (part.Format != null)
        {
            open = AppendFormattedFormat;
        }
        else
        {
            open = AppendFormattedValue;
        }

        var clrType = holeType?.ClrType;
        if (clrType != null)
        {
            // Primitive / BCL / reference holes close over their concrete CLR
            // type, so a value-type hole is passed without boxing.
            return (open.MakeGenericMethod(clrType), default);
        }

        // A user-defined type has no reflection Type; close over an object
        // placeholder and carry the real type-argument symbol so the emitter
        // encodes the user TypeDef into the MethodSpec (issue #320 path).
        return (open.MakeGenericMethod(typeof(object)), ImmutableArray.Create(holeType));
    }

    private static MethodInfo FindAppendFormatted(
        System.Type secondParam = null, System.Type thirdParam = null, int genericArity = 1, bool valueOnly = false)
    {
        foreach (var method in HandlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (method.Name != "AppendFormatted" || !method.IsGenericMethodDefinition)
            {
                continue;
            }

            if (method.GetGenericArguments().Length != genericArity)
            {
                continue;
            }

            var parameters = method.GetParameters();
            if (!parameters[0].ParameterType.IsGenericMethodParameter)
            {
                continue;
            }

            if (valueOnly)
            {
                if (parameters.Length == 1)
                {
                    return method;
                }

                continue;
            }

            if (thirdParam != null)
            {
                if (parameters.Length == 3 && parameters[1].ParameterType == secondParam && parameters[2].ParameterType == thirdParam)
                {
                    return method;
                }

                continue;
            }

            if (parameters.Length == 2 && parameters[1].ParameterType == secondParam)
            {
                return method;
            }
        }

        return HandlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .First(m => m.Name == "AppendFormatted" && m.IsGenericMethodDefinition);
    }
}
