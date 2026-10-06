// <copyright file="BoundStructLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Linq;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A struct composite literal: <c>Point{X: 1, Y: 2}</c> (Phase 3.B.1).
/// </summary>
public sealed class BoundStructLiteralExpression : BoundExpression
{
    public BoundStructLiteralExpression(SyntaxNode? syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers)
        : this(syntax, structType, initializers, null)
    {
    }

    public BoundStructLiteralExpression(SyntaxNode? syntax, StructSymbol structType, ImmutableArray<BoundFieldInitializer> initializers, BoundExpression? copySource)
        : base(syntax)
    {
        if (copySource != null && (!structType.IsData || !initializers.IsEmpty))
        {
            throw new System.ArgumentException("A copy literal must be a data type without member initializers.", nameof(copySource));
        }

        StructType = structType;
        CopySource = copySource;
        IsZeroInitialization = isZeroInitialization;
        Initializers = CallsPrimaryConstructor
            ? PreparePrimaryArguments(syntax, structType, initializers)
            : initializers;
    }

    public StructSymbol StructType { get; }

    public ImmutableArray<BoundFieldInitializer> Initializers { get; }

    /// <summary>
    /// Gets the whole-value copy or class-clone source, when this expression
    /// materializes a native data copy rather than constructing a new value.
    /// </summary>
    public BoundExpression? CopySource { get; }

    public override TypeSymbol Type => StructType;

    public override BoundNodeKind Kind => BoundNodeKind.StructLiteralExpression;

    internal bool CallsPrimaryConstructor => !IsZeroInitialization && CopySource == null
        && StructType.ClrType == null
        && (StructType.Definition ?? StructType).IsData
        && (StructType.Definition ?? StructType).HasPrimaryConstructor;

    internal static ImmutableArray<BoundFieldInitializer> PreparePrimaryArguments(
        SyntaxNode? syntax,
        StructSymbol type,
        ImmutableArray<BoundFieldInitializer> initializers)
    {
        ImmutableArray<BoundFieldInitializer>.Builder? builder = null;
        foreach (var parameter in type.PrimaryConstructorParameters)
        {
            var member = Invariant.Required(GetPrimaryMember(type, parameter.Name), "a primary argument has an own field or property");
            if (initializers.Any(initializer => initializer.Field == member || initializer.Property == member))
            {
                continue;
            }

            // Defaults are children of the bound literal, so rewriting and
            // slot planning see exactly the nodes that emission will consume.
            var value = MagicCollectionZeroValue.TrySynthesizeEmptyInstance(syntax, parameter.Type)
                ?? new BoundDefaultExpression(syntax, parameter.Type);
            builder ??= initializers.ToBuilder();
            builder.Add(member is FieldSymbol field
                ? new BoundFieldInitializer(field, value)
                : new BoundFieldInitializer(Invariant.Required(member as PropertySymbol, "a primary member is a field or property"), value));
        }

        return builder?.ToImmutable() ?? initializers;
    }

    internal BoundFieldInitializer? GetPrimaryArgument(string name)
    {
        var member = GetPrimaryMember(StructType, name);
        foreach (var initializer in Initializers)
        {
            if ((initializer.Property != null && initializer.Property == member)
                || (initializer.Field != null && initializer.Field == member))
            {
                return initializer;
            }
        }

        return null;
    }

    internal static Symbol? GetPrimaryMember(StructSymbol type, string name)
    {
        foreach (var parameter in type.PrimaryConstructorParameters)
        {
            if (parameter.Name == name)
            {
                return TypeMemberModel.LookupMember(
                    type,
                    name,
                    new MemberQuery(includeInstance: true, includeStatic: false, includeInherited: false, MemberKinds.Property | MemberKinds.Field));
            }
        }

        return null;
    }

    internal static bool IsStagedConstruction(BoundBlockExpression block)
    {
        if (block.Expression is not BoundStructLiteralExpression { CopySource: null } literal
            || literal.StructType.ClrType != null
            || !literal.StructType.IsData || !literal.StructType.HasPrimaryConstructor
            || block.Statements.Length != literal.Initializers.Length)
        {
            return false;
        }

        for (int i = 0; i < block.Statements.Length; i++)
        {
            if (block.Statements[i] is not BoundVariableDeclaration { Initializer: not null } declaration
                || literal.Initializers[i].Value is not BoundVariableExpression value
                || value.Variable != declaration.Variable)
            {
                return false;
            }
        }

        return true;
    }
}
